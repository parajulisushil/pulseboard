#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: deploy-pulseboard.sh [IMAGE_TAG]

Pull and deploy Pulseboard with Docker Compose. IMAGE_TAG defaults to "latest"
and may also be an exact commit SHA published by the Docker workflow.

Environment variables:
  PULSEBOARD_DIR          Compose project directory (default: /home/sus/apps/pulseboard)
  DEPLOY_TIMEOUT_SECONDS  Health-check timeout in seconds (default: 180)
  PULSEBOARD_IMAGE        Docker image without a tag (default comes from Compose)
EOF
}

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

echo "Pulling Pulseboard image tag: $IMAGE_TAG"
docker compose pull pulseboard

echo "Starting Pulseboard and waiting for its health check..."
if ! docker compose up -d --remove-orphans --wait --wait-timeout "$deploy_timeout" pulseboard; then
  echo "Pulseboard did not become healthy within ${deploy_timeout} seconds." >&2
  docker compose ps >&2 || true
  docker compose logs --tail 100 pulseboard >&2 || true
  exit 1
fi

docker compose ps
echo "Pulseboard deployment completed successfully with image tag: $IMAGE_TAG"
