# syntax=docker/dockerfile:1

# ClearPing probe agent: takes readings from the machine it runs on for a
# ClearPing dashboard somewhere else (Settings, Probe agents). Not the
# dashboard; that is docker/Dockerfile.
#
# Build from the repository root, which is the build context:
#
#   docker build -f docker/probe-agent.Dockerfile -t clearping-probe-agent .
#   docker run -d -p 7380:7380 -e CLEARPING_PROBE_AGENT_TOKEN=cpa_… \
#     -v clearping-probe-agent:/data clearping-probe-agent
#
# It is the dashboard's own probe code, bundled into one file by
# scripts/build-probe-agent.mjs, on the same Debian and the same ping and
# traceroute the dashboard's image has, so a reading taken here is the same
# measurement the dashboard would take, from somewhere else. No database, no
# web app, no Apprise.

# ── Build ────────────────────────────────────────────────────────────────────
FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS build
WORKDIR /app

# Only esbuild is needed, and none of the install scripts: sqlite3 and the
# rest are never built into the agent.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

COPY tsconfig.json ./
COPY scripts/build-probe-agent.mjs scripts/
COPY probe-agent probe-agent
COPY src/lib src/lib
COPY src/types src/types

ARG CLEARPING_VERSION=""
RUN CLEARPING_VERSION="${CLEARPING_VERSION}" node scripts/build-probe-agent.mjs

# ── The standalone binary ────────────────────────────────────────────────────
# Not part of the image. The same bundle made into one program with this
# image's Node (a single executable application), for machines without
# Docker; CI takes it out with:
#
#   docker buildx build -f docker/probe-agent.Dockerfile --target binary \
#     --output type=local,dest=out .
FROM build AS binary-build
ARG CLEARPING_VERSION=""
RUN CLEARPING_VERSION="${CLEARPING_VERSION}" node scripts/build-probe-agent.mjs --sea \
 && ./dist/probe-agent/clearping-probe-agent --version

FROM scratch AS binary
COPY --from=binary-build /app/dist/probe-agent/clearping-probe-agent /clearping-probe-agent

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends iputils-ping iputils-arping traceroute \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    CLEARPING_PROBE_AGENT_DATA=/data \
    CLEARPING_PROBE_AGENT_LISTEN=0.0.0.0:7380

WORKDIR /app
COPY --from=build --chown=node:node /app/dist/probe-agent/clearping-probe-agent.cjs ./

# The certificate the dashboard pins is kept here, so replacing the container
# keeps it, and the dashboard goes on trusting the agent.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 7380

# Alive and listening is healthy, whatever it answers: /healthz only answers
# this machine, and with a listen address of its own (a tailnet address, on
# the host's network) this machine is not where it is listening. Connecting is
# enough to say so, and bash can do that: starting a whole Node every half a
# minute only to ask is a spike of its own, and a probe agent can be a very
# small machine. The address is read as main.ts reads it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bash -c 'l=${CLEARPING_PROBE_AGENT_LISTEN:-0.0.0.0:7380}; if [[ $l =~ ^\[(.+)\]:([0-9]+)$ || $l =~ ^([^:]+):([0-9]+)$ ]]; then h=${BASH_REMATCH[1]}; p=${BASH_REMATCH[2]}; elif [[ $l =~ ^[0-9]+$ ]]; then h=0.0.0.0; p=$l; else h=$l; p=7380; fi; [[ $h == 0.0.0.0 || $h == :: ]] && h=127.0.0.1; exec 3<>/dev/tcp/$h/$p'

CMD ["node", "clearping-probe-agent.cjs"]
