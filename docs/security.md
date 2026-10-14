# Security: sign-in, keys and activity

Everything here is optional and starts off. Out of the box ClearPing is as it
always was: anyone who can reach it can use it, which is fine on your own
network or behind a sign-in proxy such as Authentik. For anything else, the
shield button in the sidebar sets up:

- **Sign-in** for the dashboard and its API, with accounts.
- **Keys** for scripts and AI assistants: one each, able to read or to read and
  change.
- **Activity**: a record of every change, and which account or key made it.

## Setting it up

1. Open **Security** (the shield, bottom of the sidebar) and choose **Create an
   account**. The first account is made on the sign-in page; after that the
   page offers only to sign in, and more accounts are added from Security.
2. Under **Access**, turn on **Require sign-in for the dashboard and API**.
3. Under **Keys**, make a key for each assistant or script that needs one.

Changing anything under Security always takes being signed in, even while
sign-in is off for the dashboard. Otherwise anyone who could open the page could
make themselves a key. A key can never change these settings.

## What sign-in covers

With **Require sign-in** on:

- Every page needs a signed-in account; anyone else is sent to `/login`.
- Every API route needs a signed-in account **or a key**, sent as
  `Authorization: Bearer <key>` (or `X-API-Key: <key>`):

  ```bash
  curl -H "Authorization: Bearer cp_…" https://ping.example.com/api/targets
  ```

- The MCP address needs a key too: an open MCP address would hand out what
  sign-in protects.
- Left open: `/login` and `/api/auth/*`, `/api/health` (for the container's
  health check; it says nothing about what is monitored), `/api/mcp/info`, and
  the icons, manifest and offline page the sign-in page needs.

Sessions last 30 days from the last visit, are kept as a hash on the server,
and end on the server when you sign out. The cookie is `HttpOnly`,
`SameSite=Lax`, and `Secure` over HTTPS. A change made with the cookie has to
come from a page of this site; one sent from another site is refused. Sign-in
failures are slowed down after five tries, per address and per username, up to
a quarter of an hour.

## Keys

| | Read only | Read and change |
|---|---|---|
| API: `GET` | yes | yes |
| API: `POST`, `PATCH`, `PUT`, `DELETE` | no (`403`) | yes |
| MCP: the tools that read | yes | yes |
| MCP: `add_targets`, `update_target`, `set_target_paused`, `probe_now`, `run_traceroute` | no | yes |
| Security settings | no | no |

- Give each script or assistant **its own key**. Then one can be revoked
  without touching the others, and the activity record names which one did
  what: *GPT added targets* rather than *someone did*.
- A key is shown **once**, when it is made, and only a hash of it is kept.
  Lost, it is revoked and replaced.
- Revoking stops it at once. The key stays in the list, marked revoked, so the
  activity it was used for still says whose it was.
- Over MCP, a key is only taken over HTTPS or from ClearPing's own network; see
  [mcp.md](mcp.md#keys-are-only-taken-encrypted).
- **Keys are honoured whether or not sign-in is on.** With sign-in off, a key is
  what lets an assistant change things over MCP, and what puts a name to API
  changes in the activity record. A wrong or revoked key is always refused,
  never treated as nobody.

`CLEARPING_MCP_TOKEN`, from before keys were made in the dashboard, still
works, as a key that can change things, and while it is set the MCP address
always asks for a key. Keys made in Security are better: one per assistant,
revocable without a restart, named in the record. Move to them and unset it.

## Activity

**Security → Activity** lists, newest first:

- targets added, imported, changed, paused, resumed and deleted;
- groups made, renamed and deleted; alerts made, changed and deleted;
- every change an assistant made over MCP, with what it was asked to do;
- keys made and revoked, accounts added and removed, passwords changed, sign-in
  turned on and off;
- sign-ins, and failed sign-ins with the address they came from.

Each entry says who (the account, the key, or *Anonymous* while sign-in is off)
and how it arrived: the dashboard, the API or MCP. Entries are kept for a year.

## Locked out

Start ClearPing with `CLEARPING_AUTH=off`:

```bash
docker run … -e CLEARPING_AUTH=off ghcr.io/adamg100/clear-ping:latest
```

While it is set, sign-in is not asked for, whatever the switch says, and the
sign-in page offers to make a new account. Make one, sign in, change what needs
changing (remove the old account, or change its password from that account),
then remove the variable and restart. Nothing is deleted along the way.

## Behind Authentik, or another sign-in proxy

Leave **Require sign-in** off and let the proxy decide who gets in. Two things
still help:

- An assistant connecting from outside cannot sign in through the proxy. Let
  `/api/mcp` through without it, and turn on **Require a key for AI assistants**
  so that path is not left open.
- Signing in to ClearPing as well, even with sign-in off, is what makes the
  Security settings usable and what puts your name rather than *Anonymous* on
  your changes.
