# Security: sign-in, roles, keys and activity

Everything here is optional and starts off. Out of the box ClearPing is as it
always was: anyone who can reach it can use it, which is fine on your own
network or behind a sign-in proxy such as Authentik. For anything else, the
**Settings** page (the cog at the foot of the sidebar, or `/settings`) sets up:

- **Sign-in** for the dashboard and its API, with accounts.
- **Roles**: admins, editors who change what is monitored, viewers who look.
- **Keys** for scripts and AI assistants: one each, able to read or to read and
  change.
- **Activity**: a record of every change, and which account or key made it.
- **Single sign-on** with Authentik, or any OpenID Connect provider.

## Setting it up

1. Open **Settings** (the cog, bottom of the sidebar) and choose **Create an
   account**. The first account is made on the sign-in page; after that the
   page offers only to sign in, and more accounts are added in Settings →
   Accounts. Each section has an address of its own: `/settings/keys`,
   `/settings/sso`, `/settings/accounts`, `/settings/activity`,
   `/settings/assistant`.
2. Under **Access**, turn on **Require sign-in for the dashboard and API**.
3. Under **Keys**, create a key for each assistant or script that needs one.

Changing anything under Settings always takes being signed in, even while
sign-in is off for the dashboard. Otherwise anyone who could open the page could
make themselves a key. A key can never change these settings.

## Roles

Every account has one of three roles, set by an admin in **Settings →
Accounts** (or by Authentik groups; see below):

| | Admin | Editor | Viewer |
|---|---|---|---|
| See targets, charts, routes, incidents | yes | yes | yes |
| See alerts | yes | yes | yes, without the tokens in where they are sent |
| Add, change, pause and delete targets and groups; probe; trace | yes | yes | no |
| Make, change and delete alerts | yes | yes | no |
| Create keys | any | of its own | of its own, read only |
| Revoke keys | any | its own | its own |
| Change its own password, link its own account to single sign-on | yes | yes | yes |
| Sign-in, single sign-on settings, accounts and roles, the activity record | yes | no | no |

- The first account is an admin, and so is one made with
  `CLEARPING_AUTH=off` to get back in. Accounts that were here before roles
  are admins: nothing changes for them.
- An account an admin adds is a **viewer** unless they choose otherwise.
- There is always an admin: the last one cannot be made anything else, or
  removed.
- A change of role takes effect at once, on the next request, without
  signing in again.
- A viewer's dashboard leaves out what it may not do (Add target, editing,
  Probe now, Trace route, the alerts' buttons), and the server refuses it
  anyway.
- Roles are about a ClearPing that asks for sign-in. With sign-in off,
  anyone who can reach it can change anything without signing in, as before.

**A key never does more than the account that made it.** A viewer's keys only
read. An editor made a viewer has keys that only read from the next request;
made an editor again, they change things again. Removing an account revokes
its keys. Keys made before roles have no maker on record and do what they were
made to.

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

Sessions last 30 days from the last visit, and end on the server when you
sign out. The cookie, `clearping.session_token`, is signed, `HttpOnly`,
`SameSite=Lax`, and `Secure` over HTTPS. A change made with the cookie has to
come from a page of this site; one sent from another site is refused. Sign-in
failures are slowed down after five tries, per address and per username, up to
a quarter of an hour.

### Better Auth

Accounts, passwords, sessions, keys and the sign-in through Authentik are run
by [Better Auth](https://better-auth.com), kept in its own tables in
ClearPing's database. ClearPing adds its rules on top: the roles, the last
admin, keys that never outdo their maker, who may sign in through Authentik and
as what, signing out together with Authentik, and the activity record. Better
Auth's own HTTP endpoints are not open to the browser; ClearPing's routes call
it on the server, so nothing gets round those rules.

The cookies are signed with `BETTER_AUTH_SECRET` where that is set. Otherwise
a secret is made at the first start and kept in the database, so nothing has
to be set. Set it yourself only to keep sessions working across a database
that is replaced.

**Upgrading from a version before it** (0.1.x): the first start moves
everything across, once.

- Accounts keep their passwords, roles and links to Authentik.
- Keys keep working, unchanged.
- Everyone signs in once more: sessions are not moved.
- Nothing changes in Authentik: the redirect URI stays
  `/api/auth/sso/callback`. Its provider does need a signing key now (see
  below).
- The old tables (`users`, `sessions`, `api_keys`) are left in the database,
  unread, in case the upgrade has to be undone.

## Second factors

Accounts that sign in with a password can add a second factor under
**Settings → Sign-in**. Accounts that sign in through Authentik use
Authentik's own second factor instead, and are not shown these.

- **An authenticator app.** Scan the QR code with 1Password, Google
  Authenticator, Authy or the like, and type a code from it to turn it on.
  From then on, signing in asks for a code after the password. Ten backup
  codes are shown once, at setup, each good for one sign-in if the phone is
  lost; new ones can be made, which ends the old. *Trust this browser* skips the
  code there for 30 days. Ten wrong codes in a row stop the account finishing a
  sign-in for a quarter of an hour.
- **Passkeys.** Sign in with a fingerprint, face or device PIN, with no
  password or code to type. Browsers make passkeys only for a site name over
  HTTPS, or for `localhost`: not at an address such as `192.168.1.10`. A
  passkey works at the name it was made at, so make it at the address you
  normally use. The sign-in page offers passkeys once one exists. Adding one
  is done within a day of signing in; after that, sign in again first.

### Requiring them

An admin chooses, under **Settings → Sign-in**, what every account that signs
in with a password must have:

| Required | Satisfied by |
|---|---|
| Nothing more than a password | anything |
| An authenticator app or a passkey | either one |
| An authenticator app | the app |
| A passkey | at least one passkey |
| An authenticator app and a passkey | both |

and whose accounts: **editors and viewers**, or **everyone, admins too**.
An account without what is required is sent to a page that asks for it the
next time it opens ClearPing, and until it has added it, the dashboard and API
answer it with nothing else. Nobody can remove a factor they are required to
have, and an admin cannot require of everyone something their own account does
not have yet: that is how an admin would lock themselves out. If it happens
anyway, `CLEARPING_AUTH=off` (below) lifts the requirement while it is set.

Both factors are Better Auth's, its two-factor and passkey plugins, called
from ClearPing's routes like the rest of sign-in.

## Keys

| | Read only | Read and change |
|---|---|---|
| API: `GET` | yes | yes |
| API: `POST`, `PATCH`, `PUT`, `DELETE` | no (`403`) | yes |
| MCP: the tools that read | yes | yes |
| MCP: `add_targets`, `update_target`, `set_target_paused`, `probe_now`, `run_traceroute` | no | yes |
| Settings | no | no |
| Ever more than the account that made it | no | no |

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
always asks for a key. Keys made in Settings are better: one per assistant,
revocable without a restart, named in the record. Move to them and unset it.

## Activity

**Settings → Activity** lists, newest first:

- targets added, imported, changed, paused, resumed and deleted;
- groups made, renamed and deleted; alerts made, changed and deleted;
- every change an assistant made over MCP, with what it was asked to do;
- keys made and revoked, accounts added and removed, roles changed (and by
  whom: an admin, or the person's groups at Authentik), passwords changed,
  sign-in turned on and off;
- authenticator apps turned on and off, backup codes remade, passkeys added
  and removed, and changes to what is required;
- sign-ins, with how (a password, an authenticator code, a backup code, a
  passkey), and failed sign-ins with the address they came from.

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
   - Redirect URI: the one shown under Settings → Single sign-on in ClearPing, which is
     `https://<your ClearPing>/api/auth/sso/callback`. Open that page at the
     address people will use, since the URI is taken from it.
   - Signing key: pick one (the self-signed certificate is fine). ClearPing
     checks every sign-in against Authentik's published keys, so one is
     needed: without it Authentik signs with the client secret, which is not
     accepted.
   - Scopes: the defaults (`openid`, `email`, `profile`). `profile` is where
     Authentik puts the username and the person's groups.
2. **Applications → Applications → Create**, using that provider. Optionally
   bind a group or policy to it, so only some people can get to it at all.
3. Note the provider's **Client ID**, **Client Secret** and **OpenID
   Configuration Issuer**, which looks like
   `https://auth.example.com/application/o/clearping/`.

### In ClearPing

1. Settings → **Single sign-on**: paste the issuer, client ID and client secret.
   **Test the issuer** checks that Authentik can be reached there.
2. Optionally, **Only members of this group**: an Authentik group name. Only
   its members can sign in through Authentik at all.
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

### Roles from Authentik groups

Under **Roles from groups**, name a group for admins and one for editors:

- At every sign-in through Authentik, the account's role is set from the
  person's groups: in the admin group, an admin; in the editor group, an
  editor; in neither, a viewer. A change of groups in Authentik is a change of
  role here at their next sign-in.
- The last admin is never made anything else this way; the activity record
  says the role was kept, and why.
- Left empty, Authentik has no say: roles are set in Settings → Accounts, and
  an account made at its first sign-in starts as the role chosen there (a
  viewer, unless changed).

Authentik sends the groups with `profile`, which ClearPing asks for, so there
is nothing to set up on that side beyond the groups themselves.

### Signing out, both ways

**Signing out of Authentik signs you out of ClearPing.** In the provider (Authentik
2025.8 or later), set:

- **Logout URI**: `https://<your ClearPing>/api/auth/sso/logout`, which Settings →
  Single sign-on shows to copy.
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

The authorization code flow with PKCE, run by Better Auth. The browser goes
to Authentik with a random state, nonce and PKCE challenge, and the answer is
taken only if its state is the one this browser was given. The code is traded
for an ID token directly with Authentik, using the client secret and the PKCE
verifier, and the token's signature (against Authentik's published keys),
issuer, audience and nonce are checked before anyone is signed in. ClearPing
then turns away anyone outside the allowed group and sets the role from the
groups.

Linking always ties the identity to the account signed in at that moment.
Every account's email address, as far as Better Auth is concerned, is a
placeholder of its own on the reserved `.invalid` domain, never the address
Authentik gives: no two ever match, so an account is never linked, or taken
over, because of a matching email. Everything about a sign-in goes into the
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
