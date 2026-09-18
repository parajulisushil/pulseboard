FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
	API_HOST=0.0.0.0 \
	PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
	PYTHON_BIN=/opt/pulseboard-python/bin/python \
	PYTHONPATH=/app/scripts \
	TZ=Asia/Kathmandu
RUN apt-get update \
	&& apt-get install -y --no-install-recommends wget ca-certificates iputils-ping libcap2-bin python3 python3-venv \
	&& wget -q https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb \
	&& dpkg -i packages-microsoft-prod.deb \
	&& rm packages-microsoft-prod.deb \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends powershell \
	&& rm -rf /var/lib/apt/lists/*
COPY requirements-scheduled-jobs.txt ./requirements-scheduled-jobs.txt
RUN python3 -m venv /opt/pulseboard-python \
	&& /opt/pulseboard-python/bin/pip install --no-cache-dir --requirement requirements-scheduled-jobs.txt \
	&& /opt/pulseboard-python/bin/python -c "import gitlab, humanize; from gitlab.v4.objects import GroupMergeRequest, ProjectMergeRequestNote; from slack_webhook import Slack"
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
RUN npx playwright install --with-deps --only-shell chromium
RUN setcap -r /usr/bin/ping \
	&& test -z "$(getcap /usr/bin/ping)"
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/config ./config
COPY --chown=node:node --from=build /app/server/index.mjs ./server/index.mjs
COPY --chown=node:node --from=build /app/server/gitlab-approvals.mjs ./server/gitlab-approvals.mjs
COPY --chown=node:node --from=build /app/server/ai-code-review.mjs ./server/ai-code-review.mjs
COPY --chown=node:node --from=build /app/server/ai-error-summary.mjs ./server/ai-error-summary.mjs
COPY --chown=node:node --from=build /app/server/ad-passwords.mjs ./server/ad-passwords.mjs
COPY --chown=node:node --from=build /app/server/deployment-schedules.mjs ./server/deployment-schedules.mjs
COPY --chown=node:node --from=build /app/server/deployment-verification.mjs ./server/deployment-verification.mjs
COPY --chown=node:node --from=build /app/server/sql-errors.mjs ./server/sql-errors.mjs
COPY --chown=node:node --from=build /app/server/check-sql-error.mjs ./server/check-sql-error.mjs
COPY --chown=node:node --from=build /app/server/infrastructure-status.mjs ./server/infrastructure-status.mjs
COPY --chown=node:node --from=build /app/server/scheduled-jobs.mjs ./server/scheduled-jobs.mjs
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3001/healthz || exit 1
STOPSIGNAL SIGTERM
CMD ["node", "server/index.mjs"]
