# Behind a reverse proxy

On your own network ClearPing can be opened straight at
`http://<machine>:3000`. To reach it from anywhere else, to install it as an app
on Android or a desktop, or to give an AI assistant a key from outside your
network, put it behind something that serves it over HTTPS. Any reverse proxy
does; this page has the ones people use most:

- [Caddy](#caddy): the least to write, and it gets its own certificate.
- [nginx](#nginx), including Nginx Proxy Manager.
- [Traefik](#traefik), if it already runs your other containers.
- [Cloudflare Tunnel](#cloudflare-tunnel): no port opened on your router.
- [Tailscale](#tailscale): only your own devices can reach it.

Whichever you use, turn sign-in on first (Settings → Access → **Require
sign-in**), unless the proxy itself only lets you in.

## What ClearPing needs from any proxy

Three settings and three headers, the same for every proxy:

| | |
|---|---|
| `CLEARPING_ALLOWED_HOSTS` | The name it is reached at, such as `ping.example.com` (several, comma-separated). A request addressed to any other name is refused, which stops another website pointing its own domain at your machine to read the API. |
| `CLEARPING_TRUST_PROXY` | How many proxies in front of ClearPing add to `X-Forwarded-For`: `1` for one proxy, `2` for a CDN in front of your proxy, and so on. Without it the header is ignored, and every sign-in looks as if it came from the proxy. |
| `TZ` | Not about the proxy, but set it while you are here: the time zone every time is shown in. |
| `Host` | Passed through unchanged (or as `X-Forwarded-Host`). |
| `X-Forwarded-For` | The visitor's address, for sign-in limits and the Activity record. |
| `X-Forwarded-Proto` | `https`, so ClearPing knows the connection was encrypted. Assistants' keys are only taken over HTTPS or from your own network ([mcp.md](mcp.md#keys-are-only-taken-encrypted)). |

ClearPing listens on port `3000` inside the container. The proxy only has to
reach that port; it need not be published to the host at all if the two share
a Docker network.

## Caddy

Caddy fetches and renews a certificate by itself, and passes all three headers
without being asked. A `Caddyfile`:

```caddyfile
ping.example.com {
	reverse_proxy clearping:3000
}
```

With both in one Compose file:

```yaml
services:
  clearping:
    image: ghcr.io/adamg100/clear-ping:latest
    container_name: clearping
    restart: unless-stopped
    environment:
      CLEARPING_ALLOWED_HOSTS: ping.example.com
      CLEARPING_TRUST_PROXY: 1
      TZ: Etc/UTC
    volumes:
      - ./data:/data

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data

volumes:
  caddy-data:
```

Point `ping.example.com` at the machine in DNS and open ports 80 and 443 to it.

## nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name ping.example.com;

    ssl_certificate     /etc/letsencrypt/live/ping.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ping.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # The MCP server streams its answers to an assistant.
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

`proxy_set_header X-Forwarded-Proto $scheme` is the line most often missing:
without it ClearPing thinks every request came over plain HTTP. Set
`CLEARPING_ALLOWED_HOSTS=ping.example.com` and `CLEARPING_TRUST_PROXY=1` on the
container.

**Nginx Proxy Manager:** add a proxy host for `ping.example.com` forwarding to
`http`, the container's name or the machine's address, port `3000`; request a
certificate on the SSL tab and turn on *Force SSL*. It sends the headers above
by itself.

## Traefik

For a Traefik that already watches Docker. Put ClearPing on the network Traefik
is on (here `traefik`; use the name of yours) and give it labels instead of a
published port:

```yaml
services:
  clearping:
    image: ghcr.io/adamg100/clear-ping:latest
    container_name: clearping
    restart: unless-stopped
    labels:
      traefik.enable: true
      traefik.http.routers.clearping.rule: Host(`ping.example.com`)
      traefik.http.routers.clearping.entrypoints: websecure
      traefik.http.routers.clearping.tls.certresolver: letsencrypt
      traefik.http.services.clearping.loadbalancer.server.port: 3000
    environment:
      CLEARPING_ALLOWED_HOSTS: ping.example.com
      CLEARPING_TRUST_PROXY: 1
      TZ: Etc/UTC
    volumes:
      - ./data:/data
    networks:
      - traefik

networks:
  traefik:
    external: true
```

`websecure` and `letsencrypt` are the usual names of the HTTPS entry point and
certificate resolver; use whatever yours are called.

## Cloudflare Tunnel

A tunnel connects out from your machine to Cloudflare, so nothing has to be
opened on your router. In the Cloudflare dashboard, under **Zero Trust →
Networks → Tunnels**, create a tunnel, copy its token, and add a public
hostname `ping.example.com` with the service `http://clearping:3000`. Then:

```yaml
services:
  clearping:
    image: ghcr.io/adamg100/clear-ping:latest
    container_name: clearping
    restart: unless-stopped
    environment:
      CLEARPING_ALLOWED_HOSTS: ping.example.com
      CLEARPING_TRUST_PROXY: 1
      TZ: Etc/UTC
    volumes:
      - ./data:/data

  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: paste-the-tunnel-token-here
```

To keep the dashboard to yourself, add a Cloudflare Access application for the
hostname as well; ClearPing's own sign-in still applies behind it.

## Tailscale

[Tailscale Serve](https://tailscale.com/kb/1312/serve) gives ClearPing an
HTTPS address that only devices on your tailnet can open, with a certificate
Tailscale provides. On the machine ClearPing runs on:

```bash
tailscale serve --bg 3000
```

It is then at `https://<machine>.<your-tailnet>.ts.net`. Set
`CLEARPING_ALLOWED_HOSTS` to that name and `CLEARPING_TRUST_PROXY=1`. Nothing is
reachable from the internet, so this is also the simplest way to use an AI
assistant with a key from a laptop away from home.

## Checking it

Open the new address and sign in. Then:

- **Settings → AI assistant** shows the `https://` address to give an
  assistant. If it warns that the page was opened over plain HTTP, the proxy
  is not sending `X-Forwarded-Proto`.
- **Settings → Activity** lists your sign-in with your own address. If it shows
  the proxy's address instead, set `CLEARPING_TRUST_PROXY`.
- *This address is not one ClearPing was set up to answer to* means the name you
  opened is not in `CLEARPING_ALLOWED_HOSTS`.
