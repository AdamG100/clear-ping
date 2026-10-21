# Probe agents

A probe agent is a small program that takes readings from another machine. It
has nothing to do with AI agents or the assistant.

One ClearPing dashboard runs everything: the targets, the charts, the alerts.
Most targets are probed from the machine the dashboard runs on. A probe agent
lets a target be probed from somewhere else instead. For example, the dashboard
can run at home while a probe agent on a VPS in Germany measures some of the
targets. Those readings show the network as seen from Germany, and they sit on
the same dashboard beside everything else.

- [How it works](#how-it-works)
- [Adding one](#adding-one)
- [Over a tailnet](#over-a-tailnet)
- [Over the internet](#over-the-internet)
- [Running it](#running-it)
- [Probing a target from it](#probing-a-target-from-it)
- [When it cannot be reached](#when-it-cannot-be-reached)
- [Its certificate](#its-certificate)
- [Updating it](#updating-it)
- [Troubleshooting](#troubleshooting)

## How it works

The dashboard connects to the probe agent. The agent never connects to the
dashboard, so the dashboard can stay on a home network that nothing can reach
from outside.

```
Dashboard (home)                                   Probe agent (VPS)
scheduler: a target's turn comes round
   └─ HTTPS to the agent's port, its pinned certificate, its token ─▶  runs the probe
   ◀──────────────────────── the readings ────────────────────────────  (ping, TCP, game servers, HTTP, DNS, traceroute)
stored, charted and alerted on like any other reading
```

- **It runs the dashboard's own probe code.** Ping, TCP, game servers, HTTP, DNS and
  traceroute work exactly as they do on the dashboard's machine, only from
  somewhere else. A reading from an agent means the same as a local one.
- **The token.** Each probe agent has a token of its own, made when it is
  added. The agent refuses every request without it. An address that keeps
  trying wrong tokens is made to wait, up to a quarter of an hour.
- **Encryption.** The agent makes its own certificate the first time it
  starts. The first time the dashboard connects, it remembers ("pins") that
  exact certificate, the way SSH remembers a server it has seen before. From
  then on it only talks to the machine with that certificate, and every
  request is encrypted (TLS 1.3). The token is only ever sent after the
  certificate has been checked. You set none of this up.
- **What it can do.** It runs the probes it is asked for and nothing else. It
  keeps no history and holds no database.

## Adding one

1. In ClearPing, open **Settings → Probe agents** (admins only) and press
   **Add probe agent**.
2. Give it a name, such as *Germany VPS*, and the address the dashboard will
   reach it at. That is its tailnet address or name if you use Tailscale, and
   otherwise its public IP or hostname. The port is 7380 unless you change it.
3. **Add probe agent** again. ClearPing shows a token, once, and the commands to
   start the agent with it: Docker, Docker Compose, or Linux without Docker.
   Run one of them on the agent's machine.
4. Press **Connect**. ClearPing shows the certificate fingerprint it now
   trusts. The agent printed its own fingerprint when it started (it is in its
   log), and the two should be the same.

The page lists every probe agent with its status and when it was last seen,
below a count of how many are online and how many need attention. **Details**
on a row has everything else about it: its machine, version, certificate
and targets, and the buttons to test the connection, make a new token or
remove it.

A lost token can't be shown again. **New token** in its details makes
another, and the old one stops working straight away. Restart the agent with
the new token.

## Over a tailnet

This is the best way to connect them. If the dashboard's machine and the
agent's machine are on the same tailnet (Tailscale, Headscale), give the
agent's tailnet address (`100.x.y.z`) or its MagicDNS name (`….ts.net`). The
add form says *Over a tailnet*.

Nothing outside the tailnet can reach the agent's port, so no port has to be
opened on the internet. Listen on the tailnet address only, so the agent is
not on the machine's other interfaces either. The commands ClearPing gives you
already do this when the address is an IP:

```bash
# Docker: publish the port on the tailnet address only
docker run … -p 100.84.12.7:7380:7380 …

# Linux, no Docker
… CLEARPING_PROBE_AGENT_LISTEN=100.84.12.7:7380 …
```

## Over the internet

If the agent is reached at a public address, the add form warns you, and the
list says **Internet**. The connection is still encrypted, and the agent still
only answers to the token. But its port is open to anyone who finds it, and
ClearPing can't close it from where it is. On the agent's machine, let only
the dashboard's address through. For example, with `ufw`:

```bash
sudo ufw allow from 203.0.113.10 to any port 7380 proto tcp   # the dashboard's public IP
sudo ufw deny 7380/tcp
```

Many VPS providers also have a firewall in their control panel that does the
same thing. Docker publishes ports around `ufw`, so with Docker use the
provider's firewall, or bind the published port to one address.

If you can, put both machines on a tailnet instead (see above). Then there is
no port to close at all.

## Running it

### Docker

```bash
docker run -d --name clearping-probe-agent --restart unless-stopped \
  -p 7380:7380 \
  -e CLEARPING_PROBE_AGENT_TOKEN=cpa_… \
  -v clearping-probe-agent:/data \
  ghcr.io/adamg100/clear-ping-probe-agent:latest
```

Keep the volume. The agent's certificate is kept in it, and a new certificate
means confirming it again in the dashboard (see [Its certificate](#its-certificate)).
To keep it in a folder instead (`-v ./data:/data`), create the folder and give
it to uid 1000 first, which the container runs as, or it stops with
"permission denied": `mkdir -p data && sudo chown 1000:1000 data`.

For IPv6 targets, Docker's default network has no IPv6. Run the container with
`--network host` instead of `-p …`, and set `CLEARPING_PROBE_AGENT_LISTEN` to
the address and port to listen on.

### Docker Compose

[compose.probe-agent.example.yaml](../compose.probe-agent.example.yaml) has
the same set-up with notes. Copy it to the agent's machine as `compose.yaml`,
put the token in it, and run `docker compose up -d`.

### Linux, without Docker

```bash
curl -fsSL https://github.com/adamg100/clear-ping/releases/latest/download/install-probe-agent.sh \
  | sudo CLEARPING_PROBE_AGENT_TOKEN=cpa_… CLEARPING_PROBE_AGENT_LISTEN=0.0.0.0:7380 sh
```

This installs one program for x64 or ARM64 (Node.js is built in), at
`/usr/local/bin/clearping-probe-agent`. It runs as a systemd service called
`clearping-probe-agent`, under a user of its own:

- the only privilege it gets is the one ping needs, `CAP_NET_RAW`;
- its settings are kept in `/etc/clearping-probe-agent/env`, which only root
  can read;
- its certificate is kept in `/var/lib/clearping-probe-agent`.

It needs `ping` and `traceroute` on the machine, and says if either is
missing. On Debian or Ubuntu: `apt install iputils-ping traceroute`.

Check it with `systemctl status clearping-probe-agent`. Read its log with
`journalctl -u clearping-probe-agent`.

### Settings

| Variable | Default | Purpose |
|---|---|---|
| `CLEARPING_PROBE_AGENT_TOKEN` | required | The token ClearPing gave when the agent was added. The agent will not start without one |
| `CLEARPING_PROBE_AGENT_LISTEN` | `0.0.0.0:7380` | The address and port to listen on. Give a tailnet address to stay off every other interface. `[::]:7380` listens on IPv6 as well |
| `CLEARPING_PROBE_AGENT_DATA` | `/data` in Docker, `/var/lib/clearping-probe-agent` from the installer | Where the certificate is kept |

`clearping-probe-agent --version` prints its version.

## Probing a target from it

When you add or edit a target, its **Probe from** section offers *This
server* and each of your probe agents, as cards side by side. It only appears
once a probe agent exists. With more than five, a search box narrows the cards
down. You can also set this from an assistant: `add_targets` and
`update_target` take `probe_agent`, and `list_probe_agents` lists them.

Everywhere a target appears, it says where it is probed from:

- **The sidebar.** A purple *Remote* badge beside the target's type, which
  names the agent when you point at it. The **Probed from** filter under the
  search box lists only one agent's targets, or only this server's.
- **The target's page.** A *Probed from …* line under the address. The
  *Route* panel says *traced from …*, because a traceroute also runs from the
  agent.
- **Group comparisons.** Each line from an agent is named *Target · Agent*.
- **Alerts.** *Cloudflare DNS is not responding (from Germany VPS)*, with a
  *Probed from* line in the details.
- **Assistant answers.** Targets from an agent come back with `probedFrom`,
  and the ISP report says those were measured from another machine.

Moving a target to another probe agent keeps its history. The activity record
says where it was moved from and to, because the readings before and after
the move come from two different places.

## When it cannot be reached

The dashboard asks each probe agent how it is once a minute. If an agent
can't be reached:

- **No readings are taken for its targets.** A dead agent never shows up as
  your targets being down, so it never sets off their alerts either.
- Its targets show a grey status dot that says *No readings: probe agent … is
  offline*. Their *Remote* badge turns amber, and their page says no readings
  are being taken.
- On the chart, the time it was down is shaded *Probe agent offline: no
  readings*.
- The activity record notes when it was lost and when it came back.
- **Probe now** and **Trace now** say the agent can't be reached, and record
  nothing.

Readings start again on the first check after it is back.

## Its certificate

The fingerprint of the trusted certificate is shown under each agent's name
in Settings. If the agent ever presents a different one, the dashboard stops
talking to it and marks it **Certificate changed**, with the new fingerprint.
That is expected if the agent was reinstalled, or lost its data volume:
compare the new fingerprint with the one in the agent's log, then choose
**Trust new certificate**. If you didn't change anything, something between
the two machines may be pretending to be the agent. Don't trust it.

## Updating it

The probe agent is released together with ClearPing, with the same version
number. A dashboard and the agent of the same version always work together.
If the two can't understand each other, the agent is marked **Update needed**.

- Docker: `docker pull ghcr.io/adamg100/clear-ping-probe-agent:latest` and
  recreate the container (with Compose: `docker compose pull && docker compose up -d`).
- Linux: run the install line again. You can leave out the token, because the
  one already set up is kept.

## Troubleshooting

| What Settings says | What it means |
|---|---|
| *Nothing is listening on that port* | The agent isn't running, or is listening on another port or address. Check its log |
| *No answer in time* | A firewall is dropping the connection, or the address is wrong |
| *The address cannot be reached from here* | No route from the dashboard's machine. Over a tailnet, check both machines are connected to it |
| **Token refused** | The agent was started with a different token. Make a new one and restart the agent with it |
| **Certificate changed** | See [Its certificate](#its-certificate) |
| **Update needed** | The agent and the dashboard are different versions. Update the older one |
| *No ping installed* | Install `iputils-ping` (and `traceroute`) on the agent's machine |
