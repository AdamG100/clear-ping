# syntax=docker/dockerfile:1

# ClearPing: the web app, the probe scheduler and Apprise in one container.
#
# Build from the repository root, which is the build context:
#
#   docker build -f docker/Dockerfile -t clearping .
#   docker run -d -p 3000:3000 -v clearping-data:/data clearping
#
# It builds for x64 and for 64-bit ARM, and for whichever of the two the
# machine is unless told otherwise:
#
#   docker build --platform linux/arm64 -f docker/Dockerfile -t clearping .
#
# Nothing below names an architecture: the base image, the Debian packages and
# the sqlite3 binary all come in both. 32-bit ARM is the exception, because
# Next.js has no compiler for it.
#
# Debian rather than Alpine on purpose. Probing shells out to `ping` and
# `traceroute` and reads what they print; the parsers are tested against the
# iputils and traceroute builds Debian ships, not BusyBox's.
#
# Debian 13 (trixie) rather than 12, because of sqlite3: its prebuilt binary
# is linked against glibc 2.38, and Debian 12 stops at 2.36. The build and
# runtime stages must stay on the same release for the same reason.
#
# The base image is pinned by digest, so a tag that is moved or replaced cannot
# change what is built. Dependabot proposes the new digest as a pull request;
# the tag in the FROM line says which Node and Debian it is.

# ── Dependencies ─────────────────────────────────────────────────────────────
FROM node:26-trixie-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4 AS deps
WORKDIR /app

# sqlite3 downloads a prebuilt binary and only compiles when there is none for
# the platform. The toolchain is here for that case and stays in this stage.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# The binary has to load on this image's C library. Checked here, where the
# reason is obvious, rather than surfacing as a stack trace at the end of the
# build; and if the prebuilt one does not fit, it is compiled instead.
RUN node -e "require('sqlite3')" \
 || ( echo "The prebuilt sqlite3 binary does not load on this image; compiling it instead" \
   && npm rebuild sqlite3 --build-from-source \
   && node -e "require('sqlite3')" )

# The same for better-sqlite3, which sign-in (Better Auth) opens the database
# with. It carries binaries for linux x64 and arm64 in the package itself.
RUN node -e "new (require('better-sqlite3'))(':memory:').close()" \
 || ( echo "The prebuilt better-sqlite3 binary does not load on this image; compiling it instead" \
   && npm rebuild better-sqlite3 --build-from-source \
   && node -e "new (require('better-sqlite3'))(':memory:').close()" )

# ── Build ────────────────────────────────────────────────────────────────────
FROM deps AS build

COPY . .

# An image must never be built with somebody's database in it. The ignore file
# beside this Dockerfile keeps them out of the build context, but only BuildKit
# reads that file, so this checks what actually arrived and refuses to go on.
RUN found="$(find . -path ./node_modules -prune -o -type f \
      \( -name '*.db' -o -name '*.db-wal' -o -name '*.db-shm' -o -name '*.db.*' \) -print)" \
 && if [ -n "$found" ]; then \
      echo "Refusing to build: database files in the build context:" >&2; \
      echo "$found" >&2; \
      exit 1; \
    fi

# Standalone output: a self-contained server with only the modules it uses,
# instead of the whole of node_modules. See next.config.ts.
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT=standalone
RUN npm run build

# The same check on what the runtime stage is about to copy. The build once
# traced ./data into the standalone output by itself (see the turbopackIgnore
# note in src/lib/database.ts), so the context being clean is not enough.
RUN found="$(find .next/standalone .next/static public -path '*/node_modules' -prune -o -type f \
      \( -name '*.db' -o -name '*.db-wal' -o -name '*.db-shm' -o -name '*.db.*' \) -print)" \
 && if [ -n "$found" ]; then \
      echo "Refusing to build: database files in the build output:" >&2; \
      echo "$found" >&2; \
      exit 1; \
    fi

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:26-trixie-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4 AS runtime

# The programs the probes run, and Python for Apprise. Nothing else is needed
# at run time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends iputils-ping traceroute python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*

# Apprise, which alerts are sent with (https://github.com/caronc/apprise), in an
# environment of its own: Debian does not let pip install into the system's
# Python, and its own apprise package is a release behind. The list is
# docker/apprise-requirements.txt: Apprise with `all-plugins`, which brings the
# packages that some of its services need on top of the rest (MQTT, XMPP,
# Growl, SMPP, web push and the like), and everything those pull in, each at
# one version and checked against a hash, so that what is installed is what
# was reviewed. All of them come as wheels for both architectures, so there is
# nothing to compile.
COPY docker/apprise-requirements.txt /tmp/apprise-requirements.txt
RUN python3 -m venv /opt/apprise \
 && /opt/apprise/bin/pip install --no-cache-dir --require-hashes --only-binary=:all: -r /tmp/apprise-requirements.txt \
 && rm /tmp/apprise-requirements.txt \
 && ln -s /opt/apprise/bin/apprise /usr/local/bin/apprise \
 && apprise --version

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
# measurement history. The directory is created empty here, so a fresh volume
# is writable by `node` and every new install starts with no targets.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

# Which build this is, shown on the dashboard and compared with the newest
# published image to say whether there is an update (src/lib/version.ts). CI
# passes all four; a build without them says it is a development build. Last,
# because they change with every build and anything after them would rebuild.
ARG CLEARPING_VERSION=""
ARG CLEARPING_COMMIT=""
ARG CLEARPING_BUILT_AT=""
ARG CLEARPING_IMAGE=""
ENV CLEARPING_VERSION=${CLEARPING_VERSION} \
    CLEARPING_COMMIT=${CLEARPING_COMMIT} \
    CLEARPING_BUILT_AT=${CLEARPING_BUILT_AT} \
    CLEARPING_IMAGE=${CLEARPING_IMAGE}

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
