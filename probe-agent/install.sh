#!/bin/sh
# Installs the ClearPing probe agent on Linux, as a systemd service, without
# Docker. A probe agent takes readings from this machine for a ClearPing
# dashboard somewhere else; add it there first (Settings, Probe agents), which
# gives the token this needs and the line to run:
#
#   curl -fsSL https://github.com/adamg100/clear-ping/releases/latest/download/install-probe-agent.sh \
#     | sudo CLEARPING_PROBE_AGENT_TOKEN=cpa_… CLEARPING_PROBE_AGENT_LISTEN=100.84.12.7:7380 sh
#
# Run it again to update: without a token it keeps the one already set up.
# Run it with `uninstall` to take it all off again: the service, the program,
# its user, its settings and its certificate.
#
#   curl -fsSL …/install-probe-agent.sh | sudo sh -s -- uninstall
#
#   CLEARPING_PROBE_AGENT_TOKEN    the token from the dashboard
#   CLEARPING_PROBE_AGENT_LISTEN   address:port to listen on (0.0.0.0:7380). On
#                                  a tailnet, the tailnet address keeps it off
#                                  every other interface.
#   CLEARPING_PROBE_AGENT_RELEASE  a release such as v1.9.0, or latest
#
# What it does: downloads one program for this machine's architecture to
# /usr/local/bin, makes a system user for it, keeps its settings in
# /etc/clearping-probe-agent/env (readable by root only) and its certificate in
# /var/lib/clearping-probe-agent, and runs it as a service that starts on boot.

set -eu

REPOSITORY="${CLEARPING_PROBE_AGENT_REPOSITORY:-adamg100/clear-ping}"
RELEASE="${CLEARPING_PROBE_AGENT_RELEASE:-latest}"
NAME=clearping-probe-agent
BIN="/usr/local/bin/$NAME"
ETC="/etc/$NAME"
DATA="/var/lib/$NAME"
UNIT="/etc/systemd/system/$NAME.service"

say() { printf '%s\n' "$*"; }
fail() { printf 'clearping-probe-agent install: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "run it as root, with sudo"
[ "$(uname -s)" = Linux ] || fail "this installs on Linux; elsewhere, run the Docker image"
command -v systemctl >/dev/null 2>&1 || fail "this needs systemd; without it, run the Docker image"

# Everything this script put on the machine, taken off again. The certificate
# goes too, so installed again it is a new probe agent to the dashboard, whose
# certificate has to be trusted afresh.
if [ "${1:-}" = uninstall ]; then
  systemctl disable --now "$NAME" >/dev/null 2>&1 || true
  rm -f "$UNIT"
  systemctl daemon-reload
  rm -f "$BIN"
  rm -rf "$ETC" "$DATA"
  if id -u "$NAME" >/dev/null 2>&1; then
    if command -v userdel >/dev/null 2>&1; then userdel "$NAME"; else deluser "$NAME"; fi
  fi
  say "The probe agent is uninstalled. Remove it in ClearPing too (Settings, Probe agents) if it is still listed."
  exit 0
fi
[ -z "${1:-}" ] || fail "unknown option $1: run it with nothing to install or update, or with uninstall"

case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) fail "no build for $(uname -m); the Docker image may have one" ;;
esac

# The settings already here, if this is an update.
OLD_TOKEN=""
OLD_LISTEN=""
if [ -f "$ETC/env" ]; then
  OLD_TOKEN=$(sed -n 's/^CLEARPING_PROBE_AGENT_TOKEN=//p' "$ETC/env")
  OLD_LISTEN=$(sed -n 's/^CLEARPING_PROBE_AGENT_LISTEN=//p' "$ETC/env")
fi
TOKEN="${CLEARPING_PROBE_AGENT_TOKEN:-$OLD_TOKEN}"
LISTEN="${CLEARPING_PROBE_AGENT_LISTEN:-${OLD_LISTEN:-0.0.0.0:7380}}"
[ -n "$TOKEN" ] || fail "set CLEARPING_PROBE_AGENT_TOKEN to the token the dashboard gave when the probe agent was added"
case "$TOKEN" in
  *[!A-Za-z0-9_-]*) fail "that token has characters no ClearPing token has; copy it again" ;;
esac

if [ "$RELEASE" = latest ]; then
  URL="https://github.com/$REPOSITORY/releases/latest/download/$NAME-linux-$ARCH"
else
  URL="https://github.com/$REPOSITORY/releases/download/$RELEASE/$NAME-linux-$ARCH"
fi

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
say "Downloading $URL"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$TMP" || fail "could not download it"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP" "$URL" || fail "could not download it"
else
  fail "this needs curl or wget"
fi
chmod 0755 "$TMP"
VERSION=$("$TMP" --version) || fail "the download does not run on this machine"
say "Got $VERSION"

if ! id -u "$NAME" >/dev/null 2>&1; then
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir "$DATA" --shell /usr/sbin/nologin "$NAME"
  else
    adduser -S -D -H -h "$DATA" -s /sbin/nologin "$NAME"
  fi
fi

install -d -m 0750 -o "$NAME" -g "$NAME" "$DATA"
install -d -m 0755 "$ETC"
# Stopped before the program is replaced: a running file cannot be written over.
systemctl stop "$NAME" 2>/dev/null || true
install -m 0755 "$TMP" "$BIN"

# Read by systemd as root, before it starts the agent as its own user.
umask 077
cat > "$ETC/env" <<EOF
CLEARPING_PROBE_AGENT_TOKEN=$TOKEN
CLEARPING_PROBE_AGENT_LISTEN=$LISTEN
CLEARPING_PROBE_AGENT_DATA=$DATA
EOF
umask 022

cat > "$UNIT" <<EOF
[Unit]
Description=ClearPing probe agent
Documentation=https://github.com/$REPOSITORY/blob/main/docs/probe-agents.md
# On a tailnet, the address it listens on only exists once Tailscale is up.
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=$NAME
Group=$NAME
EnvironmentFile=$ETC/env
ExecStart=$BIN
Restart=always
RestartSec=5
# Ping and traceroute send ICMP, which takes this one privilege and no other.
AmbientCapabilities=CAP_NET_RAW
CapabilityBoundingSet=CAP_NET_RAW
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$NAME" >/dev/null 2>&1
systemctl restart "$NAME"

for tool in ping traceroute; do
  command -v "$tool" >/dev/null 2>&1 || say "Warning: $tool is not installed, so probes that use it will fail. Install it (Debian and Ubuntu: apt install iputils-ping traceroute)."
done

sleep 2
if systemctl is-active --quiet "$NAME"; then
  say "The probe agent is running, listening on $LISTEN."
  journalctl -u "$NAME" -n 20 --no-pager 2>/dev/null | grep -o 'Certificate fingerprint.*' | tail -1 || true
  say "Now press Connect for it in ClearPing, and check the fingerprint it shows matches the one above."
else
  say "It did not start. What it said:"
  journalctl -u "$NAME" -n 20 --no-pager 2>/dev/null || true
  exit 1
fi
