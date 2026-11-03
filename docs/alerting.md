# Alerting

Without an alert, ClearPing is a dashboard you have to remember to look at. An
alert turns it into something that tells you when your network breaks.

## Making an alert

Open **Alerts** at the bottom of the sidebar and choose **New alert**. An alert
is three things:

1. **A condition**: what to watch for, and for how many probes in a row.
2. **Where to send it**: any service [Apprise](https://github.com/caronc/apprise)
   can notify, as many of them as you like, or nowhere but the Alerts screen.
3. **The monitors it watches**: tick them. Ticking a group ticks every monitor
   in it and in the groups inside it.

One alert covers every monitor ticked for it, but each monitor is judged on its
own: it fires and clears separately, and one monitor in trouble says nothing
about the rest. A monitor added later is not ticked for anything until you tick
it, including one added to a group whose other monitors are all ticked.

The Alerts button shows how many alerts are firing, and each monitor's page lists
the alerts watching it. On the Alerts screen each alert is a card that says
whether it is firing (and on which monitors), on, or muted, with buttons to send
a test, mute it, edit it and delete it.

![The alerts screen, with one alert firing](screenshots/alerts.jpg)

![The alert editor](screenshots/alert-editor.jpg)

### Conditions

| Watching | Fires when |
|---|---|
| Packet loss | Loss exceeds the threshold (%) |
| Latency | Average RTT exceeds the threshold (ms) |
| Jitter | Jitter exceeds the threshold (ms) |
| Unreachable | A probe gets no reply at all |
| Certificate expires in | Fewer days than the threshold remain on an HTTPS monitor's certificate |

The certificate condition is the one that fires when a value falls *below* its
threshold. It defaults to a single probe rather than several in a row: a
certificate's expiry date does not flap. Only HTTPS monitors have a certificate,
so on any other monitor it never fires.

### Tracing the route when an alert fires

An alert on packet loss, unreachable, latency or jitter can **trace the route**
to the monitor the moment it fires (the *Trace the route* box under *When it
fires*). The trace is saved to the monitor's Route panel, marked *Taken on
alert*. It is on by default for packet loss and unreachable alerts, and off for
latency and jitter.

So that a link which keeps dropping out is not traced over and over, each alert
sets a wait (15 minutes unless changed, up to a day) before the same monitor is
traced on an alert again. The wait runs from the last trace taken on any alert
for that monitor, and survives a restart. Alerts that fire together share one
trace. Tracing by hand with *Trace route* is never held back.

Any trace, however it was taken, can be passed on from the Route panel: *Copy
as text* gives the hops in columns for a chat or a ticket, and *Save as a web
page* gives a single HTML file, with nothing to load from anywhere, to send to
whoever runs the network. Times in both are given in the zone ClearPing is set
to (`TZ`) with their offset from UTC, such as `2026-10-20 11:05:07 GMT+2`, so
they mean the same thing to whoever reads them.

A monitor probed over **both IP versions** takes two readings each round, and its
alerts are judged once per round on the worse of the two: the higher loss, the
higher latency, the certificate that expires sooner, and unreachable if either
family is. An alert therefore fires when either family is in trouble. (Judging
the two readings one after the other would not work: a healthy IPv4 reading
would reset the count of consecutive probes a failing IPv6 one had just
started.)

## Why "probes in a row" matters

An alert fires only after the condition has held for that many probes in a row,
and clears only after the same number of clean ones. This hysteresis is the
difference between an alert and a nuisance: a single probe crossing a threshold
is usually a blip, and an alert that fires and resolves on alternating probes
trains you to ignore it.

With the default of 3 and a 5-minute interval, an alert fires after roughly
15 minutes of sustained trouble.

## Where an alert is sent

Alerts are sent by [Apprise](https://github.com/caronc/apprise), which knows how
to post to well over a hundred services: Discord, Slack, Telegram, Teams,
Matrix, email, ntfy, Gotify, Pushover, PagerDuty, SMS gateways, MQTT, a plain
JSON webhook, and the rest. There is no list of kinds to choose from here, and
nothing to wait for when Apprise gains a service: whatever it can notify, an
alert can be sent to.

Each service is named by a URL. Put one on each line of **Notification URLs**,
as many as the alert should go to:

```
discord://webhook_id/webhook_token
tgram://bot_token/chat_id
mailtos://user:password@smtp.example.com?to=oncall@example.com
ntfy://ntfy.sh/my-topic
```

[Apprise's list of services](https://appriseit.com/services/) says how the URL
for each one is written and what options it takes, and its
[URL builder](https://appriseit.com/tools/url-builder/) will put one together
for you. A few things worth knowing:

- **Some web addresses work as they are.** Apprise recognises the webhook
  address that Discord, Slack and a few others hand out, so a
  `https://discord.com/api/webhooks/…` URL can be pasted in unchanged.
- **Any other webhook is `json://`.** A plain `https://` address is not a
  service. To POST JSON to an endpoint of your own, write it as
  `jsons://host/path` (`json://` for plain HTTP). `xml://` and `form://` do the
  same in those formats.
- **The URLs are checked when the alert is saved.** One that Apprise cannot
  make sense of is refused there and then, with Apprise's reason.
- **They are secrets.** Anyone holding one can post to that channel. Only
  someone who may change alerts is shown them whole; a viewer, a read-only key
  and anyone not signed in see just the name of each service.

Leave the box empty and nothing is sent. The alert still fires and clears, and
shows on the Alerts screen and in the count on the Alerts button.

Use **Send test** on an alert to send a sample message, marked as a test, and
find a mistyped URL now rather than during an outage. It changes nothing about
the alert's state, and if a service refuses the message it says why.

Delivery failures are logged and swallowed: a service that is down must never
stop the prober from measuring.

The same URLs can carry another message: under **Settings → Maintenance**, pick
one of your alerts and its notification URLs are sent the report of each
maintenance run, or only of the runs that found a problem
([running.md](running.md#maintenance)). Nothing else about the alert changes.

### What is sent

Each time the alert fires or clears on a monitor, one message goes to every URL:

- a title saying what happened: `Router: packet loss is too high`, or
  `Router has recovered`
- the condition and how long it has held, then the monitor's address, the
  current reading, when it happened (in the zone set by `TZ`, with its offset
  from UTC), the alert's name and the monitor's group
- Apprise's `failure` type when it fires and `success` when it clears, which
  services that have colours or icons show as red and green

The message is written once and Apprise turns it into what each service takes:
rich text for an email or Telegram, Markdown for Discord or Slack, plain text
for an SMS or ntfy. Where a service takes more than one format, the URL can say
which with `?format=text`, `?format=markdown` or `?format=html`.

Two examples of what that is for:

- **Discord as an embed.** Apprise sends Discord (and Guilded) an embed only
  when the URL asks for Markdown, so ClearPing asks for it: an alert is posted
  as an embed, red when it fires and green when it clears, with the details on
  lines of their own. Add `?format=text` to a URL to get a plain message
  instead. Slack and Teams get a coloured attachment or card from Apprise
  whatever the format.
- **A JSON endpoint that wants plain text.** `jsons://host/path?format=text`.
  The body it receives is Apprise's:

  ```json
  {
    "version": "1.0",
    "title": "Router: packet loss is too high",
    "message": "Packet loss above 5% for 3 probes in a row.\n- Address: 192.168.1.1\n- Now: 42.5%\n- Alert: Packet loss above 5%\n- Group: Home / Network",
    "attachments": [],
    "type": "failure"
  }
  ```

  A query parameter of the endpoint's own is written with a `-` in front
  (`?-token=abc`), and a header with a `+`.

**Mentions** belong to the URL too, in whatever way the service does them. For
Discord that is `?ping=`, with role and user IDs:
`discord://id/token/?format=markdown&ping=<@%26123…>,<@456…>` (`%26` is the `&`
of a role mention). They are mentioned on every message sent to that URL, when
the alert clears as well as when it fires. A monitor or an alert that happens to
be called `@everyone` or `@here` is only ever text.

### Where Apprise comes from

The Docker image has Apprise installed, with the extra packages some of its
services need, so every service that can work from inside a container does.
The exceptions are the ones that pop a notification up on the desktop of the
machine they run on (`dbus://`, `glib://`, `gnome://`, `macosx://`,
`windows://`), which have no desktop to reach there.

Running from source, install it yourself: `pip install "apprise[all-plugins]"`.
If the `apprise` program is not on the `PATH`, name it with
`CLEARPING_APPRISE_BIN`. Without it alerts still fire and clear and show in the
app; sending one, or a test, says that Apprise is missing.

## More than one condition, and more than one probe

Under **More options** on the alert's form, and in the API, an alert can say
more than one threshold on the monitors you tick.

**Conditions.** Up to six, each a metric past a threshold: *loss above 5%*
*and* *latency above 200 ms*. They add up as **any holds**, **all hold** or
**at least N hold** (nothing nested: no "A and (B or C)"). Each condition can
clear under its own lower threshold (a rule that fires above 5% and clears
under 2%), and can judge the mean of the newest readings, a window, in place
of the newest alone.

**How long.** The default is some readings in a row. Choose **minutes**
instead and it fires once the conditions have held that long. A probe that goes
quiet for longer than two intervals starts a duration in minutes again, so it
never fires the moment it comes back. **Clear after** can be a different time
from the time to fire, in the same unit.

**Where it applies.** The monitors ticked, plus everything in chosen
**groups** (including any added later) and **everything one probe
measures**.

**How many probes must agree.** With more than one probe, a monitor measured
from several is judged probe by probe, each on its own readings, and the
monitor fires when enough of them are in breach: **any one**, **every**,
**at least a number** (4 of 7), or **at least a share** (60%, rounded up). You
can also choose which probes count. The alert's message names how many and which
probes saw it. Weighting some probes more than others is not offered.

**A share of the probes that are up.** *At least a share of the probes that are
reporting* takes the share from the probes that answered, not from all of them:
two thirds (66%) of the 3 probes that are up is 2, even with 3 more offline.
Resolving still counts a probe that is offline as in breach, so it never fires
and clears in turn.

**Seen from several places.** Label each probe with a region and a network under
Settings, Probes, *Where each probe is* (Europe, Example Networks). An alert can
then also ask that the probes in breach come from at least some number of
regions and networks, such as 3 and 3: a problem seen from one data centre does
not page anyone. A probe with no label counts for neither. A message for a
problem seen from one region only says so.

**What broke.** A notification that fires says the likely cause, read from the
failing reading: the connection was refused, the name did not resolve, it did
not answer in time, a certificate expired, an HTTP error, or a different answer
from the one expected. It is a guess from the message the probe gave, and the
history keeps it with the event.

A probe that is **not reporting**, because its probe agent is down or it has
taken no reading for two intervals, is not counted as seeing the problem, so a
probe agent going quiet cannot make an alert fire. Nor can it make one clear:
a firing alert resolves only when it could not hold even if every probe that is
not reporting were in breach. So a quorum never fires and clears in turn, and
the dashboard losing its own connection, which silences every probe agent at
once, does not fire an alert that needs every probe to agree.

**Probe agents going offline.** With a probe agent, an alert's More options
has *Also tell these URLs when a probe agent goes offline*. That alert's
notification URLs then get a message when a probe agent has been silent for
longer than the time set under Settings, Probes, and another when it is back.
In the API it is `probeAgentOffline` on `POST` and `PATCH /api/alerts`.

**History.** The clock button on an alert's card lists each time a monitor fired
or cleared: the conditions as they stood, with their values, and each probe's
part in it.

## Behaviour worth knowing

- **A metric with no reading holds the current state.** A host that is down
  produces no latency figure. Reading that as "0ms, all good" would silently
  resolve a firing latency alert, so an absent reading neither fires nor
  resolves an alert. Use the *Unreachable* condition to alert on the host being
  down.
- **Muting an alert stops it being judged**, and resets its count, so unmuting
  it cannot resume part-way through a breach it was not watching. Changing its
  condition resets the count too.
- **Unticking a monitor forgets its state for that alert.** The monitors that
  stay ticked keep theirs.
- **A paused monitor is not probed**, so its alerts neither fire nor clear until
  it is resumed.
- **Alerts are judged after the measurement is stored**, and alerting failures
  cannot prevent a measurement being recorded.

## Alerts made by an earlier version

Alerts used to be sent by ClearPing itself, to Discord or to a webhook. The
first time a version with Apprise starts, each of those is given the Apprise
URL that reaches the same place:

- **A Discord alert** becomes a `discord://` URL with `format=markdown`, so it
  is still an embed, and with its roles and users in `ping`. One difference:
  they are now mentioned when the alert clears as well as when it fires.
- **A Slack webhook** is kept as it is, since Apprise knows Slack by that
  address.
- **Any other webhook** becomes `jsons://…?format=text` (or `json://`). The
  endpoint is the same, but **what it receives has changed**: Apprise's JSON,
  shown above, in place of the payload with `status`, `metric`, `observed` and
  `text`. Anything that read those fields needs to read `title`, `message` and
  `type` instead. If the endpoint belonged to a chat service that was reading
  `text` (Mattermost, Rocket.Chat and the like), swap the URL for that
  service's own Apprise URL.

Use **Send test** on each alert after upgrading to see that it still arrives.

Before that, alerts were set on each monitor's own page. Those are carried over
too: rules that said the same thing on different monitors become one alert
ticked for all of them, and each monitor keeps its state, so one that was
firing does not announce itself again.

Alerts made before conditions, durations and probes could be set carry over as
one condition, held for the readings in a row they had, on every probe of the
monitors ticked for them, and fire when any probe is in breach: exactly what
they did. A firing one is still firing and does not announce itself again.

## API

| | |
|---|---|
| `GET /api/alerts` | Every alert, with the state of each ticked monitor |
| `POST /api/alerts` | Create one |
| `PATCH /api/alerts/:id` | Change one; `targetIds` replaces the ticked set (and only those entries of its scope), `scope` replaces all of it, `enabled` mutes |
| `GET /api/alerts/:id/events` | Its history: each fire and clear, with the conditions and probes behind it (`?limit=`) |
| `DELETE /api/alerts/:id` | Delete one |
| `POST /api/alerts/:id/test` | Send its notification URLs a test message |

An alert is created with `metric`, `threshold`, `consecutiveProbes`,
`targetIds`, and optionally `conditions` (a list of `{ metric, threshold,
clearThreshold?, window? }`, the first of which is also `metric` and
`threshold`), `combine` (`"any"`, `"all"` or `{ atLeast: n }`), `forMinutes`,
`clearAfter`, `policy` (`"any"`, `"all"`, `{ kind: "atLeast", count }` or
`{ kind: "share", percent, of?: "healthy" }`), `spread` (`{ regions?, networks? }`, or
`null`), `probes` (the probes that count, `"local"` being
the dashboard's own) and `scope` (a list of `{ kind: "monitor" | "group" |
"probe", ref }`), and also `name`, `traceOnFire` and `traceCooldownMinutes`
(tracing the route when it fires, and the wait before the same monitor is
traced again), and `notifyUrls`: the Apprise URLs to send it
to, as a list or as text with one to a line. An empty list is an alert that is
only shown in the app. A URL Apprise cannot use is refused with a `400` and
Apprise's reason.
