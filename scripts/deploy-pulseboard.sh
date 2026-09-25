#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: deploy-pulseboard.sh [--repair-dns CONNECTION_NAME] [IMAGE_TAG]

Pull and deploy Pulseboard with Docker Compose. IMAGE_TAG defaults to "latest"
and may also be an exact commit SHA published by the Docker workflow.
If the image pull fails, prints DNS troubleshooting steps without changing
the server's network settings.

--repair-dns NAME       Set an active Ethernet/Wi-Fi NetworkManager profile to
                        DNS 1.1.1.1 and 8.8.8.8, ignoring DHCP DNS. If Tailscale
                        manages resolv.conf, disable its DNS management too
                        (this host will no longer use MagicDNS/private DNS).
                        Requires sudo/root, nmcli, nslookup, and timeout.

Environment variables:
  PULSEBOARD_DIR          Compose project directory (default: /home/sus/apps/pulseboard)
  DEPLOY_TIMEOUT_SECONDS  Health-check timeout in seconds (default: 180)
  PULSEBOARD_IMAGE        Docker image without a tag (default comes from Compose)
EOF
}

print_pull_help() {
  cat >&2 <<'EOF'
Image pull failed; the running service has not been changed.

If the error contains "lookup" and "i/o timeout", DNS on the Docker host
is timing out. Run these commands on that host:
  cat /etc/resolv.conf
  nslookup registry-1.docker.io 1.1.1.1
  nmcli -f NAME,DEVICE,TYPE connection show --active

For Docker Hub, test registry-1.docker.io; for another registry, use its host.
If the public DNS lookup succeeds, replace CONNECTION_NAME and DEVICE_NAME
below with the active Ethernet/Wi-Fi profile NAME and DEVICE (not tailscale0
or a Docker bridge):
  sudo nmcli connection modify "CONNECTION_NAME" ipv4.ignore-auto-dns yes ipv4.dns "1.1.1.1 8.8.8.8"
  sudo nmcli device reapply DEVICE_NAME
  getent hosts registry-1.docker.io

If /etc/resolv.conf still lists Tailscale DNS (100.100.100.100 or
fd7a:115c:a1e0::53), and this host does not need MagicDNS/private DNS, run:
  sudo tailscale set --accept-dns=false
This keeps Tailscale connected but disables its DNS configuration on this host.

Rerun this deployment after DNS resolution works. For authentication errors
or a missing image/tag, check registry credentials and the published image
instead of changing DNS.
EOF
}

repair_dns() {
  local connection="$1" device device_type tool
  local -a elevate=()
  for tool in nmcli nslookup timeout getent; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "DNS repair requires $tool; install it or repair DNS manually." >&2
      return 1
    fi
  done
  device=$(nmcli -g GENERAL.DEVICES connection show "$connection")
  if [[ -z "$device" || "$device" == "--" || "$device" == *','* || "$device" == *$'\n'* ]]; then
    echo "Choose a connection active on exactly one Ethernet/Wi-Fi device." >&2
    return 1
  fi
  device_type=$(nmcli -g GENERAL.TYPE device show "$device")
  if [[ "$device_type" != "ethernet" && "$device_type" != "wifi" ]]; then
    echo "DNS repair only supports Ethernet/Wi-Fi profiles, not $device_type." >&2
    return 1
  fi
  if ! timeout 10 nslookup registry-1.docker.io 1.1.1.1 >/dev/null 2>&1; then
    echo "Public DNS lookup failed; network settings have not been changed." >&2
    return 1
  fi
  local tailscale_dns=false
  if grep -Eq '^nameserver[[:space:]]+(100\.100\.100\.100|fd7a:115c:a1e0::53)([[:space:]]|$)' /etc/resolv.conf; then
    tailscale_dns=true
    if ! command -v tailscale >/dev/null 2>&1; then
      echo "Tailscale DNS is configured but the tailscale command is unavailable." >&2
      return 1
    fi
  fi
  if (( EUID != 0 )); then
    elevate=(sudo)
  fi
  echo "Setting DNS for $connection ($device) to 1.1.1.1 and 8.8.8.8..."
  "${elevate[@]}" nmcli connection modify "$connection" ipv4.ignore-auto-dns yes ipv4.dns "1.1.1.1 8.8.8.8"
  "${elevate[@]}" nmcli device reapply "$device"
  if [[ "$tailscale_dns" == true ]]; then
    echo "Disabling Tailscale-managed DNS on this host; Tailscale stays connected."
    "${elevate[@]}" tailscale set --accept-dns=false
  fi
  if ! timeout 10 getent hosts registry-1.docker.io; then
    echo "DNS settings were updated, but resolution still fails. Check /etc/resolv.conf before retrying." >&2
    return 1
  fi
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

repair_connection=""
if [[ "${1:-}" == "--repair-dns" ]]; then
  if (( $# < 2 )) || [[ -z "$2" || "$2" == -* ]]; then
    echo "--repair-dns requires an active NetworkManager connection name." >&2
    usage >&2
    exit 2
  fi
  repair_connection="$2"
  shift 2
fi

if (( $# > 1 )); then
  usage >&2
  exit 2
fi

image_tag="${1:-${IMAGE_TAG:-latest}}"
project_dir="${PULSEBOARD_DIR:-/home/sus/apps/pulseboard}"
deploy_timeout="${DEPLOY_TIMEOUT_SECONDS:-180}"

if [[ ! "$image_tag" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid image tag: $image_tag" >&2
  exit 2
fi

if [[ ! "$deploy_timeout" =~ ^[0-9]+$ ]] || (( deploy_timeout < 10 || deploy_timeout > 600 )); then
  echo "DEPLOY_TIMEOUT_SECONDS must be an integer from 10 to 600." >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or is not available on PATH." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required (the 'docker compose' command)." >&2
  exit 1
fi

if [[ ! -f "$project_dir/docker-compose.yml" ]]; then
  echo "docker-compose.yml was not found in $project_dir." >&2
  exit 1
fi

if [[ ! -f "$project_dir/.env" ]]; then
  echo ".env was not found in $project_dir." >&2
  exit 1
fi

cd -- "$project_dir"
export IMAGE_TAG="$image_tag"

echo "Validating the Pulseboard Compose configuration..."
docker compose config --quiet

if [[ -n "$repair_connection" ]]; then
  repair_dns "$repair_connection"
fi

echo "Pulling Pulseboard image tag: $IMAGE_TAG"
if ! docker compose pull pulseboard; then
  print_pull_help
  exit 1
fi

echo "Starting Pulseboard and waiting for its health check..."
if ! docker compose up -d --remove-orphans --wait --wait-timeout "$deploy_timeout" pulseboard; then
  echo "Pulseboard did not become healthy within ${deploy_timeout} seconds." >&2
  docker compose ps >&2 || true
  docker compose logs --tail 100 pulseboard >&2 || true
  exit 1
fi

docker compose ps
echo "Pulseboard deployment completed successfully with image tag: $IMAGE_TAG"
