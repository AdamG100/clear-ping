# API

Everything the dashboard does goes through this HTTP API, so a script can do
anything the dashboard can. What the dashboard calls a monitor is a *target*
here, in the JSON and in the assistant tools, so that nothing written against
them breaks. A monitor measured from several probes has
`probes` (a list of probe ids, with `local` for the dashboard's own), and
`probeAgentId` is its first.

Who may call it is set under Settings → Access. With sign-in on, every call
needs a signed-in account or a key, sent as `Authorization: Bearer <key>` (or
`X-API-Key`); a read-only key can only `GET`. To leave looking open and ask for
an account or a write key only to change things (`POST`, `PUT`, `PATCH`,
`DELETE`), turn on **Require sign-in or a key to change anything**. A web page
on another site can call the API from a browser only if you list its address
there (CORS), and then it must send a key. A key can expire after a chosen
number of days, or not at all. Re-roll, under Settings → Keys, makes a new one
in its place and stops the old one at once. See
[docs/security.md](security.md#the-api-and-who-may-call-it).

| | |
|---|---|
| `GET /api/targets` | Every monitor; `?packetLoss=true` adds latest readings, recent traces, the groups and their order |
| `POST /api/targets` | Add a monitor |
| `POST /api/targets/import` | Add several at once (`{ targets: [...] }`, each optionally with `probes`: probe names); all are checked first, and none is added if one is wrong. Answers `missingProbes`, the names no probe here has |
| `DELETE /api/targets` | Delete several at once (`{ ids: [...] }`), each with its history |
| `GET`, `PATCH`, `DELETE /api/targets/:id` | Read, change (including pause and group) or delete one |
| `POST /api/targets/:id/probe` | Measure it now (`?probe=` from one probe, `?probes=all` from every one) |
| `GET /api/targets/merge`, `POST /api/targets/merge` | Monitors set up once for each probe, and putting them together (`{ keep, merge: [...] }`) |
| `GET /api/targets/:id/measurements` | Its readings, bucketed for a chart (`?hours=` or `?start=&end=`) |
| `GET /api/targets/:id/loss` | Its packet loss analysis over the same period: pattern, hour of day, other monitors that lost packets at the same time, likely source (`&tz=` for the hours) |
| `GET`, `POST /api/targets/:id/traceroute` | Its saved routes; trace it now, over `{"family": "ipv4" \| "ipv6" \| "both"}` if given |
| `DELETE /api/targets/:id/traceroute` | Delete one saved route (`?trace=id`) or all but the newest (`?older=1`) |
| `PUT /api/targets/reorder` | Save the order of monitors or of groups |
| `POST /api/groups` | Make a group (`{ group }`, a path such as `Home/Network`) |
| `PUT /api/groups` | Rename a group or move it inside another (`{ from, to }`) |
| `DELETE /api/groups` | Delete a group (`{ group }`); what was in it moves up a level |
| `PATCH /api/groups/probe` | Add and take off probes across a group (`{ group, add, remove }`), leaving each monitor's others |
| `PATCH /api/groups/resolvers` | Which probes ask which DNS resolvers across a group (`{ group, changes: [{ protocol, server, probe, asked }] }`) |
| `GET /api/compare` | The same period of several monitors (`?targets=id,id`; `&probes=all` draws a line for each probe of each monitor, `&probe=id` moves them to one probe, and `?series=id:probe,…` names the lines exactly); `&split=resolver` gives a DNS monitor's resolvers a line each (`&family=4` or `6` for one side of a monitor on both) |
| `GET`, `POST /api/alerts` | Every alert; make one |
| `PATCH`, `DELETE /api/alerts/:id` | Change or delete one |
| `GET /api/alerts/:id/events` | Its history: each fire and clear, and why |
| `POST /api/alerts/:id/test` | Send its notification URLs a test message |
| `GET /api/probe-agents` | The probe agents monitors can be probed from, and whether each can be reached. A monitor's `probeAgentId` says which it uses (`null` for the local probe), and is set the same way in `POST` and `PATCH /api/targets` |
| `/api/security/probe-agents/…` | Add, change and remove probe agents, connect to one (`…/:id/connect`) and make it a new token (`…/:id/token`); admins only ([docs/probe-agents.md](probe-agents.md)) |
| `GET /api/bgp` | BGP monitoring: whether it is on, the connection to RIS Live, and every watched prefix with how it stands ([docs/bgp-monitoring.md](bgp-monitoring.md)) |
| `POST`, `PUT /api/bgp` | Watch a prefix (`{ resource, label? }`, a prefix or an IP address); turn monitoring on or off (`{ enabled }`, admins only); set your own network (`{ homeAsns: [64500] }`) |
| `GET /api/bgp/lookup?resource=` | What watching an address or prefix would watch: the announced prefix that holds it, who announces it, and the announced prefixes around it |
| `GET`, `POST`, `PATCH`, `DELETE /api/bgp/:id` | One watched prefix in full, with every update and how your network reaches it; trace into it now from the local probe and each probe agent (`POST`); rename it (`{ label }`) or take how it is carried now as normal (`{ acceptNormal: true }`); stop watching it |
| `GET /api/overview` | The last 24 hours for the Overview: each monitor's uptime, the events with where each fault lay, and how many monitors had trouble in each quarter of an hour |
| `GET /api/scheduler/status` | Whether the scheduler is running and when each monitor is next due |
| `GET /api/health` | Whether the server is up; open even with sign-in on |
| `POST /api/auth/login`, `/register`, `/logout`; `GET /api/auth/status` | Signing in and out ([docs/security.md](security.md)) |
| `POST /api/auth/password-reset` | A forgotten password: the primary account's code from the server log, or the code in a password link ([docs/security.md](security.md#forgotten-password)) |
| `POST /api/auth/two-factor`, `/passkey` | The code after a password, and signing in with a passkey ([docs/security.md](security.md#second-factors)) |
| `/api/security/…` | Sign-in switches, keys, accounts and their roles (`PATCH /api/security/users/:id`), another account's password or a password link for it (`…/users/:id/password`, `…/users/:id/link`), single sign-on, the activity record, and your own second factors (`/api/security/me`); signed in only, and most of it for admins ([docs/security.md](security.md#roles)) |
| `GET /api/auth/sso/start`, `/callback` | Signing in with Authentik or another OpenID Connect provider |
| `POST /api/auth/sso/logout` | Where the provider says someone signed out there (back-channel logout) |
| `GET`, `PUT /api/privacy` | The privacy settings, and whether addresses are hidden from whoever asks; changed by admins only ([docs/security.md](security.md#privacy)) |
| `GET`, `PUT`, `POST /api/maintenance` | The maintenance schedule, its last runs and any run under way; change the schedule (`PUT`) or run it now (`POST`); admins only ([docs/running.md](running.md#maintenance)) |
| `GET /api/release-notes` | What changed in each version up to the one running, newest first |
| `GET /api/version` | The version, commit and build time running, the same for the newest published image, and whether that is an update |
| `POST /api/mcp` | The MCP server an AI assistant connects to; `GET /api/mcp/info` says whether it asks for a token |
