# syntax=docker/dockerfile:1

# ClearPing: the web app and the probe scheduler in one container.
#
# Build from the repository root, which is the build context:
#
#   docker build -f docker/Dockerfile -t clearping .
#   docker run -d -p 3000:3000 -v clearping-data:/data clearping
#
# Debian rather than Alpine on purpose. Probing shells out to `ping` and
# `traceroute` and reads what they print; the parsers are tested against the
# iputils and traceroute builds Debian ships, not BusyBox's.

ARG NODE_VERSION=24

# ── Dependencies ─────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app

# sqlite3 downloads a prebuilt binary and only compiles when there is none for
# the platform. The toolchain is here for that case and stays in this stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# ── Build ────────────────────────────────────────────────────────────────────
FROM deps AS build

COPY . .

# Standalone output: a self-contained server with only the modules it uses,
# instead of the whole of node_modules. See next.config.ts.
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT=standalone
RUN npm run build

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

# The programs the probes run. Nothing else is needed at run time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends iputils-ping traceroute \
 && rm -rf /var/lib/apt/lists/*

# HOSTNAME is what the server binds to. Docker sets it to the container's id,
# which would leave the app listening where the published port cannot reach.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    CLEARPING_DB_PATH=/data/clearping.db

WORKDIR /app

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

# The database lives outside the image, so replacing the container keeps the
# measurement history. Created here so a fresh volume is writable by `node`.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/scheduler/status').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
