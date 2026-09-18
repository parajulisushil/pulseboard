# Pulseboard

Pulseboard is an operations dashboard for checking daily test machines, engineering infrastructure availability, deployed Venio versions, Windows service state, and GitLab/TeamCity activity. The Node API serves the compiled React application, so production needs only one process and one port.

## Local development

Requires Node.js 22 or newer.

```powershell
npm ci
npm run setup:browser
Copy-Item .env.example .env
npm run api
```

In a second terminal:

```powershell
npm run dev
```

Open `http://localhost:5173`. Authentication defaults to `none` outside production; set `AUTH_MODE=basic` locally to test the production login flow.

For the compiled single-port application on Windows, double-click `start-pulseboard.bat` or create a shortcut to it. The launcher starts `npm run api` in a separate **Pulseboard API** console, waits for the health check, and opens `http://localhost:3001` through Windows' default browser. Keep the Pulseboard API console open while using the dashboard; closing it stops the API.

Run the complete verification suite with:

```powershell
npm run check
```

## Runtime configuration

Copy `.env.example` to `.env` and replace every placeholder used by your deployment. Restart the API after changing runtime settings; rebuilding the frontend is not required.

| Setting | Required | Purpose |
| --- | --- | --- |
| `AUTH_MODE` | Production | `basic` in production; `none` is accepted only outside production |
| `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` | With basic auth | Protect all `/api/*` routes; password must contain at least 16 characters |
| `API_HOST` / `API_PORT` | No | Listen address and port; defaults to `0.0.0.0:3001` |
| `AUTO_REFRESH_SECONDS` | No | Runtime dashboard refresh interval, from 10 to 3600 seconds; defaults to 30 |
| `DISK_WARNING_PERCENT_FREE` | No | Marks a fixed volume as low; defaults to 20% free |
| `DISK_CRITICAL_PERCENT_FREE` | No | Marks a fixed volume as critical; defaults to 10% free and must be lower than the warning threshold |
| `INVENTORY_PATH` | No | Inventory path relative to the project root; defaults to `config/servers.json` |
| `INFRASTRUCTURE_INVENTORY_PATH` | No | Engineering infrastructure inventory path relative to the project root; defaults to `config/infrastructure-servers.json` |
| `SERVICE_CHECKS_ENABLED` | No | Enables direct PowerShell service checks when TeamCity service control is unavailable |
| `SQL_ERROR_CHECKS_ENABLED` | No | Enables a read-only latest PCD exception query for each test machine |
| `SQL_USERNAME` / `SQL_PASSWORD` / `SQL_PCD_DATABASE` | When SQL checks are enabled | Shared read-only SQL login and PCD database name; the SQL host is each test machine's inventory IP |
| `SQL_SERVER` / `SQL_SERVER_DEV_QC01`…`SQL_SERVER_DEV_QC04` | No | Optional shared or per-machine SQL DNS hostname; per-machine values take precedence over the shared value and inventory IP |
| `SQL_PORT` / `SQL_ENCRYPT` / `SQL_TRUST_SERVER_CERTIFICATE` | No | SQL Server port and TLS settings; defaults are `1433`, `true`, and `false`. Use a DNS hostname when encryption is enabled |
| `SQL_ERROR_LIMIT` | No | Recent PCD exceptions shown per machine, from 1 to 50; defaults to 5 |
| `SQL_ERROR_TIME_COLUMN` | No | Exact exception timestamp column when it cannot be detected from a date/time-like column name |
| `SERVICE_USERNAME` / `SERVICE_PASSWORD` | Direct checks only | Windows remoting account; never returned to the browser |
| `CURRENT_RELEASE` | TeamCity activity | Exact TeamCity branch checked and triggered, for example `v11.8.5.0` |
| `CURRENT_RELEASE_PIPELINE` / `CURRENT_RELEASE_ENVIRONMENT` | No | Optional pipeline and environment values shown in the summary |
| `GITLAB_URL` / `GITLAB_PROJECT_ID` / `GITLAB_TOKEN` | No | Latest GitLab pipeline |
| `GITLAB_APPROVAL_TOKEN` | No | Personal token for listing and approving MRs; falls back to `GITLAB_TOKEN`. Approval actions require `api` scope |
| `GITLAB_APPROVAL_PROJECT_IDS` | GitLab approvals | Comma-separated numeric project IDs, for example `177,178,179`; independent of the pipeline's `GITLAB_PROJECT_ID` |
| `GITLAB_APPROVAL_TARGET_BRANCH` | No | Comma-separated exact GitLab target branches to check; empty checks all target branches in the approval projects |
| `AI_PROVIDER` | No | AI review provider: `openai` or `groq`; inferred when only one provider key is configured |
| `AI_ERROR_SUMMARIES_ENABLED` | No | Sends the newest PCD exception to the configured AI provider and shows an operator-focused summary; defaults to `false` |
| `AI_ERROR_SUMMARY_MODEL` / provider-specific equivalent | No | Optional model override for PCD error summaries; otherwise uses the configured review model |
| `OPENAI_API_KEY` / `OPENAI_REVIEW_MODEL` | No | Enables OpenAI review; the model defaults to `gpt-5.6-sol` |
| `GROQ_API_KEY` / `GROQ_REVIEW_MODEL` | No | Enables Groq review; the model defaults to `openai/gpt-oss-120b` |
| `AI_REVIEW_MODEL` | No | Optional shared model override; the provider-specific model setting takes precedence |
| `TEAMCITY_URL` / `TEAMCITY_TOKEN` | TeamCity activity | Authenticated build, dependency, and pending-change REST access |
| `TEAMCITY_CONSOLE_BUILD_TYPE_ID` / `TEAMCITY_ONDEMAND_BUILD_TYPE_ID` / `TEAMCITY_WEB_BUILD_TYPE_ID` | No | Component configurations; defaults match the Venio Console, API, and Web setup builds |
| `TEAMCITY_SERVICE_BUILD_TYPE_ID` | No | Dedicated build used to query/start/stop Windows services and restart IIS |
| `TEAMCITY_SERVICE_STATUS_TIMEOUT_MS` | No | Maximum wait for a status build; defaults to 180000 ms |
| `SCHEDULED_JOBS_PATH` | No | Persistent scheduled-job state; defaults to `data/scheduled-jobs.json` |
| `SCHEDULED_JOB_TIMEOUT_MS` | No | Maximum runtime for each local script; defaults to 900000 ms (15 minutes) |
| `PYTHON_BIN` / `POWERSHELL_BIN` | No | Optional interpreter paths; platform-appropriate Python and PowerShell defaults are used |
| `TZ` | No | IANA timezone for recurring scheduled jobs; the container defaults to `Asia/Kathmandu` |
| `SCHEDULED_JOB_TIME_ZONE` | No | Explicit IANA timezone used to calculate scheduled jobs; defaults to `TZ`, then `Asia/Kathmandu` |
| `TRUST_PROXY` | No | Trusts `X-Forwarded-Proto` for HSTS only when set to `true` |

The dashboard reads `AUTO_REFRESH_SECONDS` through the authenticated `/api/config` endpoint. This keeps the setting runtime-configurable in Docker instead of baking it into the Vite bundle.

## Inventory

Machine inventory belongs in `config/servers.json`. It is deliberately outside `public/`, so internal names and IP addresses are not copied into the static production bundle.

```json
{
  "name": "Dev-QC01",
  "ip": "172.31.38.222",
  "remoteHost": "Dev-QC01",
  "checkPort": 443,
  "group": "Test machines",
  "environment": "QA",
  "location": "East US",
  "deploymentBuildTypeId": "VenioUS_DeployInQC01_NewDeploy",
  "services": [
    { "name": "Search service", "serviceKey": "VenioSearchService" }
  ]
}
```

`serviceKey` is optional when the visible service name is also the Windows service name. `deploymentBuildTypeId` is optional and identifies the TeamCity pipeline queued by the machine's **Deploy latest** action. Omitting it keeps a machine manual-only, as with QC04. `releaseBranch` is an optional override; normally Pulseboard derives it from the version reported by the machine. Inventory is validated on each read; duplicate names and invalid ports cause readiness to fail instead of producing ambiguous controls.

### Engineering infrastructure inventory

The separate **Infrastructure status** page reads `config/infrastructure-servers.json`. Each entry has a display name, an IP address or hostname, and an explicit panel:

```json
{
  "name": "FS02",
  "ip": "172.31.43.227",
  "panel": "Other Servers"
}
```

Pulseboard sends one ICMP echo request to every entry, with a one-second response timeout, and caches the completed snapshot for 60 seconds. A manual refresh bypasses that cache. Checks run on the Pulseboard API host; it must have network routes to these addresses and permission to execute `ping`. The Docker image includes `iputils-ping` with its raw-socket file capability removed, and Compose grants its unprivileged `node` user access to ICMP datagram sockets through the container-scoped `net.ipv4.ping_group_range` sysctl. This retains the dropped-capability and no-new-privileges restrictions. This inventory is independent of the daily test-machine inventory, so infrastructure entries never receive service, deployment, SQL-error, or TeamCity controls. The authenticated endpoint is `GET /api/infrastructure-status`; add `?refresh=1` to force a new check.

Set `teamCityAgent: true` on an infrastructure inventory entry that represents a TeamCity build-agent host. Pulseboard then matches all TeamCity agent instances by the entry's `ip` and uses TeamCity's `connected` state instead of probing TCP port 443. The card also shows the number of connected instances and any current builds.

For every test application machine, the API reads the installed release version from `BootstrapService.asmx/GetBaseSettings` and component build numbers from `https://<machine>.veniosystems.com/venioweb/build.html`. Each server card displays these values in a separate, prominent **Deployed version** panel. It converts a version such as `11.8.5.0` to the TeamCity branch `v11.8.5.0`, then compares Console, OnDemand, and Web only with the latest successful, non-personal builds on that branch. A mismatch is shown as a deployment update; matching numbers are shown as current. Venio-Next is displayed when the machine reports it but is not compared separately because it is covered by Web.

When `SQL_ERROR_CHECKS_ENABLED=true`, each test-machine refresh reads the newest rows from `tbl_ex_exceptionloginfo`, ordered by its first column descending. `SQL_ERROR_LIMIT` controls the number of rows from 1 to 50 and defaults to 5. The server IP comes from `config/servers.json`; the SQL login and database name stay in `.env` and are never returned to the browser or logs. Give this login read-only access to the PCD exception table. Each row, its detected local-time timestamp, and up to 30 columns are displayed as a collapsed entry in the **Recent PCD database errors** panel. Values are capped at 4,000 characters and binary values are omitted. Missing configuration, connection errors, an empty table, and an unidentified timestamp are shown explicitly rather than treated as a clean result. Set `AI_ERROR_SUMMARIES_ENABLED=true` to send only the newest displayed exception (capped at 20,000 characters) to the configured AI provider. Its plain-language summary, likely cause, suggested action, and confidence appear above the raw errors. Summaries are cached by machine and error content; failed requests cool down for one minute. This is advisory output and must be verified before acting.

To diagnose a database failure directly from the API host, run `npm run check:sql -- Dev-QC03` (or another inventory test-server name). The command reads `.env`, tests the configured TCP port, connects to PCD, runs the same fixed query, and prints the SQL error code, number, state, and a targeted hint. It never prints `SQL_PASSWORD`.

## Deployment readiness and control

The comparison is read-only during dashboard refresh. When an update is available, **Deploy latest** shows the release branch and exact installed-to-available changes, then requires browser confirmation before it queues that machine's `deploymentBuildTypeId`. Pulseboard tracks that TeamCity build until it completes. Duplicate deployment submissions for the same machine are rejected while its deployment is active. Machines without a deployment build type never expose this action.

### Checks after deployment

Every immediate or scheduled deployment submitted through Pulseboard is tracked on the API host. After TeamCity confirms that the exact deployment build succeeded, Pulseboard opens the machine's login URL in a fresh headless Chromium session and waits for a visible password field. This checks the rendered JavaScript login page; no credentials are entered and no login is submitted. The configured URL for QC03 is `https://dev-qc03.veniosystems.com/VenioWeb/OnDemand/AppPlus/#/login`; the other QC machines use the same path on their own hostname. Set `loginUrl` in the machine's inventory entry to override it.

At the same time, Pulseboard requests fresh status for every application service listed in the machine's `services` inventory. It uses the existing TeamCity status pipeline or direct PowerShell fallback, without starting or stopping services. These are the configured application services, not every Windows service on the host. Missing service readings remain **unknown**. A deployment is **verified** only when the login form appears and every configured service is running.

On Windows, run `npm run setup:browser` once as the account that runs the API, and again after updating Playwright. Linux hosts need `npx playwright install --with-deps --only-shell chromium`; the Docker image installs Chromium and its dependencies automatically. See [Playwright browser installation](https://playwright.dev/docs/browsers). The API host must be able to reach the test application and trust its HTTPS certificate. If Chromium cannot start, the login check reports **unknown**, not success.

### Delayed deployments and waiting for a specific build

Each configured machine now has **Schedule deployment**, including when its installed builds are currently up to date. Choose **After a delay** (1–1440 minutes) or **After a specific TeamCity build succeeds**. For the latter, enter the numeric build ID from the TeamCity URL, then click **Check build** to review its name, branch, and status. The build number displayed with `#` may differ from its ID. The schedule waits for that exact build to succeed; failure or cancellation stops the schedule without deploying.

The API checks schedules every 10 seconds and submits the machine's existing deployment pipeline after the selected condition is met. It also waits for another active deployment of the same machine to finish. This controls when the deployment pipeline starts; its existing artifact selection stays in effect, and the selected prerequisite's artifacts are not pinned or substituted. TeamCity's [build state and result](https://www.jetbrains.com/help/teamcity/rest/get-build-details.html) determine when a prerequisite succeeds.

Pending schedules show their time or prerequisite build and can be cancelled before submission. Once queued, the panel links to TeamCity for managing the actual build. A schedule survives closing the browser and restarting the API; the API must be running to submit it. A delay missed while the API is stopped is processed when it restarts. Requests for a second schedule or immediate deployment of the same machine are rejected while its schedule is active.

Schedule state is saved atomically in `data/deployment-schedules.json` (override with `DEPLOYMENT_SCHEDULE_PATH`). Docker Compose mounts the persistent `pulseboard_data` volume at `/app/data`; retain it across deployments. Run one Pulseboard API process against this schedule file. Keep the directory private, writable by the API, and included in operational backups. The file retains active schedules and the last 100 completed schedules.

If TeamCity cannot confirm submission, or the API restarts during submission, the schedule is marked **Submission needs review** and is not automatically retried. Check TeamCity for the matching deployment before choosing **Clear after checking TeamCity**. Clearing that record does not cancel a build already submitted. Changes to the configured TeamCity URL or the machine's deployment pipeline stop pending schedules for review. Temporary failures to read prerequisites leave the schedule waiting.

Scheduling and cancellation use dashboard authentication and the existing request verification header. Endpoints are `GET /api/deployment-schedules?server=<name>`, `POST /api/servers/<name>/deployment-schedule` with `{ "mode": "delay", "delayMinutes": 15 }` or `{ "mode": "after_build", "afterBuildId": "123456" }`, and `POST /api/deployment-schedules/<id>/cancel`. No actual TeamCity build is queued while creating a schedule; submission happens in the API worker after checking the condition.

## Scheduled Python and PowerShell jobs

The **Scheduled jobs** page runs scripts on the same host and under the same operating-system account as the Pulseboard API. A job can reference an existing `.py` or `.ps1` file, or store script text entered in the UI. Supported schedules are a single date/time, hourly at a selected minute, daily, and weekdays only. Recurring times are calculated explicitly in `SCHEDULED_JOB_TIME_ZONE` (falling back to `TZ`, then `Asia/Kathmandu`), and the page shows the effective timezone beside the controls. Existing recurring jobs are recalculated automatically when this setting changes. Jobs can be edited, are checked every 10 seconds, do not overlap with another run of the same job, and can also be started manually.

Job definitions and the latest 16 KB of output are persisted atomically in `data/scheduled-jobs.json`. Inline script text is stored in that file, so keep the data volume private and backed up. Each run is terminated after `SCHEDULED_JOB_TIMEOUT_MS` (15 minutes by default). API restarts mark an interrupted run as failed and calculate the next recurring run rather than silently retrying it.

With Docker Compose, put path-based scripts in the repository's `scripts` directory and use `/app/scripts/<name>.py` or `/app/scripts/<name>.ps1` in the UI. Compose mounts that directory read-only; Python 3, `python-gitlab`, `slack-webhook`, `humanize`, and PowerShell are included in the image. `/app/scripts` is also on `PYTHONPATH`, so pasted scripts can import companion modules such as `/app/scripts/vpn.py`. To use another host directory, replace that bind mount while retaining a read-only container path. Without Docker, enter a path readable by the account running `npm run api`.

Creating, editing, manually running, and deleting jobs are authenticated and audit-logged. The endpoints are `GET/POST /api/scheduled-jobs`, `GET/PUT/DELETE /api/scheduled-jobs/<id>`, and `POST /api/scheduled-jobs/<id>/run`; mutation requests require the dashboard verification header. This feature intentionally grants dashboard operators code execution as the constrained API service account, so access to Pulseboard must remain tightly controlled.

## TeamCity pending builds

The **Build & pipeline activity** card checks Console, API, and Web for pending changes on the exact branch in `CURRENT_RELEASE`. API and Web are checked directly. For Console, Pulseboard reads the setup configuration's snapshot-dependency graph and checks the setup plus every dependency configuration, so changes hidden from the parent configuration are still shown. Duplicate commits present in more than one dependency are counted once. Console trigger requests also pass the numeric release version as both `reverse.dep.*.system.Version` and `system.Version` TeamCity properties.

**Trigger build** appears only when that component has pending changes and no queued or running build on the release branch. The browser confirms the operation, and the API maps the component to its configured build type and supplies `CURRENT_RELEASE` as TeamCity's `branchName`; neither value can be overridden by the browser. Console triggers the setup build, allowing TeamCity to run its required dependency chain. Duplicate submissions are rejected and the dashboard polls the queued build through completion.

The TeamCity token therefore needs read access to build configurations, snapshot dependencies, changes, and builds, plus permission to queue the three component configurations and configured deployment pipelines. Pulseboard never sends TeamCity credentials or tokens to the browser.

## GitLab merge request approvals

The **Approvals** navigation item opens the list below the overview summary. Set `GITLAB_APPROVAL_PROJECT_IDS` in `.env` to the comma-separated numeric IDs of all projects to check, then restart the API. Pipeline monitoring continues to use its separate `GITLAB_PROJECT_ID`. Every page of open requests is checked for each approval project, and each row identifies its project. Requests with the same MR number in different projects remain separate.

The list shows only requests where another user has already completed the normal required approval (`any_approver`), and the token owner is eligible for a still-pending additional regular rule named **Code Freeze Approval Rule**, optionally followed by a version suffix such as `11.8.4.0`. Matching is case-insensitive. Requests with only the normal approval rule, unrelated rules, incomplete normal approvals, satisfied Code Freeze rules, or the operator's existing approval are excluded. Group eligibility is supported. The same conditions are rechecked before an approval is submitted.

GitLab's current MR rules determine whether the Code Freeze rule applies; Pulseboard does not infer a freeze date or assume the TeamCity branch is the GitLab target branch. Set `GITLAB_APPROVAL_TARGET_BRANCH` to one branch or a comma-separated list, such as `release/11.8.5,release/11.8.6`, if the list should cover only particular release branches.

Use a personal access token belonging to the approver, with `api` scope for the **Approve** action. Set it in `GITLAB_APPROVAL_TOKEN` to keep pipeline monitoring on a separate read-only `GITLAB_TOKEN`, or use the existing token if it already belongs to the approver and has that scope. The page displays the actual account used. This is a single-operator dashboard: anyone with dashboard access can approve as that configured account. Tokens remain on the server.

Each row links to the merge request for review and shows the author, source and target branches, commit, and outstanding rules. Clicking **Approve** asks for confirmation of that request, commit, and account. The API rechecks identity, eligibility, branch, and current commit before submitting approval with the reviewed SHA. It records approval only; it never merges a request. Drafts and requests still being processed cannot be approved from the list. GitLab re-authentication requirements must be completed in GitLab.

Set `AI_PROVIDER=openai` with `OPENAI_API_KEY`, or `AI_PROVIDER=groq` with `GROQ_API_KEY`, to add an AI review to each approval candidate. If `AI_PROVIDER` is omitted and only one provider key is configured, Pulseboard selects that provider automatically. It fetches the merge-request diff, sends it to the selected provider's Responses API with `store: false`, and displays only high-confidence critical suggestions: issues likely to cause a security vulnerability, data loss or corruption, a production outage, or materially incorrect production behavior. Style, maintainability, optimization, test coverage, documentation, speculative concerns, and lower-severity findings are excluded. Reviews are cached by project, merge request, commit SHA, provider, and model, so normal dashboard refreshes do not repeat a review unless the commit changes. Temporary rate limits are retried up to twice using `Retry-After` or bounded exponential backoff; quota, credit, and spend-limit errors are reported without futile retries. Failed reviews have a one-minute cooldown to prevent auto-refresh from amplifying a limit. Diff truncation and unavailable reviews are shown explicitly. AI review is advisory; the operator remains responsible for reviewing the merge request and deciding whether to approve it.

The list refreshes automatically and after approval. Failed or incomplete checks are shown explicitly, rather than being presented as an empty queue. Approval actions use the existing dashboard authentication and request verification header, reject concurrent duplicate actions, and produce structured audit logs. Approval-rule inspection requires GitLab Premium or Ultimate; see the [GitLab approval API](https://docs.gitlab.com/api/merge_request_approvals/).

## Active Directory passwords

Open **AD passwords** in the navigation for these actions:

1. **Expired / expiring within 7 days** lists enabled users with expired passwords first, then users required to change their password at next sign-in, then passwords expiring within the following seven days. Dated expiries are sorted earliest first. Filter by name, username, or email. Disabled accounts and passwords that never expire are excluded from this view.
2. **Find a user / reset password** searches by partial first name, surname, display name, username, UPN, or email. It shows expiry date, days remaining (rounded up for future expiry), and last password change. Expired, never-expiring, unavailable, and change-at-next-sign-in states are shown explicitly. Disabled users are included and labeled. Both list views have a **Show expired users** toggle, enabled by default. Turning it off immediately hides expired rows and updates the displayed count; users required to change their password at next sign-in remain visible.
3. Select **Reset password** on one user. Leave the new password blank to generate 12 random characters including uppercase, lowercase, numbers, and symbols. To override, enter and confirm a custom password of exactly 12 characters. Confirm the selected account, then show or copy the successful password before dismissing or leaving the page. AD still enforces its own complexity, history, and minimum-length policy; a policy requiring more than 12 characters will reject the reset.

Configure these server-side settings in `.env`, then restart the API:

| Setting | Purpose |
| --- | --- |
| `AD_SERVER` / `AD_BASE_DN` | Domain controller hostname (without a URL scheme) and user search base; the example uses the domain from the standalone script |
| `AD_BIND_USER` / `AD_BIND_PASSWORD` | Account used for directory reads and delegated password resets; use a UPN such as `operator@ad.veniosystems.com` |
| `AD_AUTH` / `AD_USE_SSL` / `AD_PORT` | `SIMPLE`, `true`, and `636` by default; this feature requires LDAPS and does not use NTLM |
| `LDAP_VERIFY_CERT` | Defaults to `true`; `false` supports the standalone script's self-signed test setup |
| `LDAP_CA_CERT_FILE` | Optional PEM CA certificate file trusted for LDAPS; use a path readable by the API, or a read-only mount in Docker |
| `FORCE_CHANGE_AT_NEXT_LOGON` | Defaults to `false`, matching the standalone script |
| `UNLOCK_ACCOUNT_AFTER_RESET` | Defaults to `true`, matching the standalone script |

The API host needs network access to the domain controller. No Python or AD PowerShell module is required. Credentials stay on the server. As with the other controls, anyone with dashboard access acts through the configured account, which needs directory read access and delegated **Reset Password** permissions (plus write permissions for `pwdLastSet` / `lockoutTime` when those options are enabled). Keep the dashboard behind its configured authentication and HTTPS.

Queries read all LDAP result pages within a bounded timeout. Successful user-list results are cached by view and search for 24 hours; **Refresh users** bypasses the cache, and a confirmed password reset clears it. The seven-day window is evaluated locally using AD's [computed per-user password expiry](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-adts/f9e9b7e2-c7ac-4db6-ba38-71d9696981e9), which incorporates the effective password policy. Dates are returned in UTC and displayed in the browser's time zone. Missing expiry values and referrals are reported as incomplete results. Password values are never cached.

Resets resolve the selected user's `objectGUID` again within the configured search base using a binary equality filter that preserves all 16 ID bytes, then verify the account name before writing. Multiple name-search matches do not prevent resetting the selected account. Resets use AD's [password reset encoding over LDAPS](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-adts/6e803168-f140-4d23-b2d3-c3a8ab5917d2). Concurrent resets for the same user are rejected. A confirmed reset remains successful if a subsequent unlock or change-at-next-sign-in operation fails; the result includes the password and an explicit warning. Connection failures during the password write report an unconfirmed outcome and are never automatically retried. Passwords are returned only in the reset response with `Cache-Control: no-store`, held only in page memory, and excluded from audit logs.

API endpoints: `GET /api/ad/users?view=expiring&q=...`, `GET /api/ad/users?view=search&q=...`, and `POST /api/ad/reset-password` with JSON `{ "userId": "<selected objectGUID hex>", "accountName": "<selected username>", "password": "" }`. The reset endpoint requires the existing `X-Pulseboard-Request: 1` verification header and dashboard authentication.

In `.env`, a domain-qualified AD username uses one literal backslash (`DOMAIN\username`), not the doubled backslash used in Python string literals. Certificate trust, expired certificates, hostname mismatches, DNS failures, and refused or blocked connections now have distinct error messages.

## Service control

When `TEAMCITY_SERVICE_BUILD_TYPE_ID` is configured, status queries and actions are queued through that dedicated TeamCity build. Add [server/teamcity-service-control.ps1](server/teamcity-service-control.ps1) as a Windows PowerShell build step and store `env.SERVICE_USERNAME` and `env.SERVICE_PASSWORD` as secure TeamCity parameters.

The API sends these build parameters:

- `env.PULSEBOARD_SERVICE_ACTION`: `status`, `start`, `stop`, or `restart_iis`
- `env.PULSEBOARD_TARGET_SERVER`, `env.PULSEBOARD_SERVER_NAME`, and `env.PULSEBOARD_SERVICE_NAME` for an action
- `env.PULSEBOARD_SERVICE_INVENTORY` for a batched status query

The script emits `PULSEBOARD_SERVICE_STATUS|server|service|status` markers and `PULSEBOARD_DISK_STATUS|server|volume|totalBytes|freeBytes` markers for fixed disks. The `restart_iis` action runs `iisreset.exe /restart /timeout:60` on the selected test server. Successful status results are cached for 30 seconds. Service and IIS actions are audit-logged, confirmed in the UI, and duplicate requests are temporarily rejected.

The TeamCity step should execute the canonical script file from this repository. Service lists are serialized to JSON before `Invoke-Command` and explicitly flattened after deserialization. This extra flattening is required because Windows PowerShell 5.1 returns a top-level JSON array as one nested `Object[]`, while PowerShell 7 enumerates it. Without it, multiple services and server names collapse into space-separated values.

Without TeamCity service control, the API can use direct PowerShell remoting when `SERVICE_CHECKS_ENABLED=true` and the service account credentials are configured.

## Production with Docker

```powershell
docker compose up --build -d
docker compose ps
```

Compose binds to `127.0.0.1` by default. Put an HTTPS reverse proxy or load balancer in front of it. If direct network exposure is intentional, set `PULSEBOARD_BIND_ADDRESS` explicitly and enforce firewall rules. Basic credentials must never travel over plain HTTP.

The runtime container:

- runs as the unprivileged `node` user;
- uses a read-only filesystem with a bounded temporary filesystem;
- drops Linux capabilities and prevents privilege escalation;
- includes a `/healthz` image health check;
- handles `SIGTERM` with a bounded graceful shutdown;
- rotates local JSON logs through Compose.

Long-running status checks may wait for a TeamCity agent. Pulseboard allows the configured TeamCity status timeout plus a 60-second response margin. If a reverse proxy is used, set its upstream response/read timeout to at least the same value (240 seconds with the default TeamCity setting). The API keeps upstream HTTP connections alive for 65 seconds and allows 70 seconds for complete request headers to avoid proxy connection-reuse races.

Useful probes:

```powershell
Invoke-RestMethod http://localhost:3001/healthz
Invoke-RestMethod http://localhost:3001/readyz
```

`/healthz` reports process liveness. `/readyz` validates that both private inventory files can be read. Both are intentionally unauthenticated for orchestrator probes; all `/api/*` endpoints require the configured dashboard authentication.

For a service query from PowerShell:

```powershell
$credential = Get-Credential
Invoke-RestMethod `
  -Uri 'https://pulseboard.example.com/api/servers/Dev-QC01/services/VenioSearchService?refresh=1' `
  -Authentication Basic `
  -Credential $credential
```

## Deployment checklist

- Replace all example passwords and access tokens; use your platform secret store where possible.
- Terminate TLS before Pulseboard and keep the container port private.
- Grant the Windows service account only the remoting and service permissions it needs.
- Use read-only GitLab access for pipeline monitoring; use the approver's personal token with `api` scope for approval actions and restrict dashboard access to that operator. Grant the TeamCity token only the queue permissions required by component builds, service control, and the configured deployment pipelines.
- Confirm `/healthz` and `/readyz`, then run a non-destructive service status query.
- Forward the structured JSON stdout/stderr logs to the production log platform.
- Back up and review `config/servers.json` and `config/infrastructure-servers.json` as controlled operational configuration.
