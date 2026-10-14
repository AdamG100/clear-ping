# Security: sign-in, keys and activity

Everything here is optional and starts off. Out of the box ClearPing is as it
always was: anyone who can reach it can use it, which is fine on your own
network or behind a sign-in proxy such as Authentik. For anything else, the
shield button in the sidebar sets up:

- **Sign-in** for the dashboard and its API, with accounts.
- **Keys** for scripts and AI assistants: one each, able to read or to read and
  change.
- **Activity**: a record of every change, and which account or key made it.
- **Single sign-on** with Authentik, or any OpenID Connect provider.

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

## Single sign-on with Authentik

ClearPing can sign people in through Authentik, or any other OpenID Connect
provider (Keycloak, Entra ID, Google and so on): a **Sign in with Authentik**
button on the sign-in page, with no password to keep for ClearPing.

### In Authentik

1. **Applications → Providers → Create → OAuth2/OpenID Provider.**
   - Client type: **Confidential**.
   - Redirect URI: the one shown under Security → SSO in ClearPing, which is
     `https://<your ClearPing>/api/auth/sso/callback`. Open that page at the
     address people will use, since the URI is taken from it.
   - Signing key: pick one (the self-signed certificate is fine). Without one
     Authentik signs with the client secret, which ClearPing also accepts.
   - Scopes: the defaults (`openid`, `email`, `profile`). `profile` is where
     Authentik puts the username and the person's groups.
2. **Applications → Applications → Create**, using that provider. Optionally
   bind a group or policy to it, so only some people can get to it at all.
3. Note the provider's **Client ID**, **Client Secret** and **OpenID
   Configuration Issuer**, which looks like
   `https://auth.example.com/application/o/clearping/`.

### In ClearPing

1. Security → **SSO**: paste the issuer, client ID and client secret.
   **Test the issuer** checks that Authentik can be reached there.
2. Optionally, **Only members of this group**: an Authentik group name. Every
   account in ClearPing can do everything, these settings included, so keep
   it to the people who should.
3. **Save**, then turn on **Sign in with Authentik**.
4. **Link my account**: signs in through Authentik once and ties your existing
   account to that identity, so it is you who signs in rather than a new
   account.
5. Optionally turn off **Allow signing in with a password**, leaving Authentik
   as the only way in. It can only be turned off once your own account is
   linked, and `CLEARPING_AUTH=off` turns passwords back on if Authentik is
   ever unreachable.

With **Make an account on first sign-in** on (the default), someone signing in
through Authentik for the first time gets an account under their Authentik
username. If that name is already taken here, a number is added; an existing
account is never taken over because a name matches. Off, only accounts that
have been linked can sign in this way.

### Signing out, both ways

**Signing out of Authentik signs you out of ClearPing.** In the provider (Authentik
2025.8 or later), set:

- **Logout URI**: `https://<your ClearPing>/api/auth/sso/logout`, which Security →
  SSO shows to copy.
- **Logout method**: **Back-channel**.

Authentik then tells ClearPing, server to server, whenever a sign-in there
ends: when you log out of Authentik, when an administrator ends your session,
and when your account is deactivated. ClearPing ends the session made from that
sign-in, and records it in the activity. Only sessions made through Authentik
are ended; a session signed in with a password is not Authentik's to end.
Authentik has to be able to reach that address. On a home network it usually
can.

**Signing out of ClearPing signs you out at Authentik.** With **Signing out
here signs out of Authentik too** on (the default), signing out of a session
made through Authentik goes on to Authentik's end-session page. What that ends
is the provider's **invalidation flow** (Advanced flow settings):

- `default-provider-invalidation-flow`, the default, ends only ClearPing's
  session at Authentik. You stay logged in to Authentik and its other
  applications, so **Sign in with Authentik** signs you straight back in.
- `default-invalidation-flow` logs you out of Authentik itself, and with it
  every application that has back-channel logout set up.

To come back to ClearPing's sign-in page afterwards rather than stay on
Authentik's, add `https://<your ClearPing>/login` to the provider's **Post
logout redirect URIs**. Without it, Authentik stays on its own signed-out page.

With the switch off, signing out of ClearPing ends only ClearPing's session.

### How it is checked

The authorization code flow with PKCE. ClearPing sends the browser to
Authentik with a random state, nonce and PKCE challenge, kept in a short-lived
cookie that only the callback reads. The answer is taken only if its state
matches that cookie. The code is then traded for an ID token directly with
Authentik, using the client secret and the PKCE verifier. The token's
signature (Authentik's published key, or the client secret for HS256), issuer,
audience, expiry and nonce are all checked before anyone is signed in. Linking
always ties the identity to the account signed in at that moment, never to one
named anywhere a browser could change. Everything about a sign-in goes into the
activity record: first sign-ins, links, and people turned away for not being
in the group.

The logout address is open, since it is Authentik's server calling and not a
signed-in browser, so the logout token is all the authority a sign-out there
carries. It is checked the same way: signed by Authentik, for this
application, issued in the last ten minutes, carrying the back-channel logout
event and no nonce (so an ID token cannot be passed off as one), and never
taken twice. A session made through Authentik keeps the ID token, which is
shown to Authentik's end-session page so it knows the request is ClearPing's.

The client secret is stored in ClearPing's database (it is needed for every
sign-in), never sent back to the browser, and only replaced, never shown.

## Behind Authentik as a proxy, or another sign-in proxy

If Authentik already sits in front of ClearPing as a forward-auth proxy, leave
**Require sign-in** off and let the proxy decide who gets in. Two things still
help:

- An assistant connecting from outside cannot sign in through the proxy. Let
  `/api/mcp` through without it, and turn on **Require a key for AI assistants**
  so that path is not left open.
- Signing in to ClearPing as well, even with sign-in off, is what makes the
  Security settings usable and what puts your name rather than *Anonymous* on
  your changes.
