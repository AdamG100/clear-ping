# Alerting

Without an alert, ClearPing is a dashboard you have to remember to look at. An
alert turns it into something that tells you when your network breaks.

## Making an alert

Open **Alerts** at the bottom of the sidebar and choose **New alert**. An alert
is three things:

1. **A condition**: what to watch for, and for how many probes in a row.
2. **Where to send it**: Discord, a webhook, or nowhere but the Alerts screen.
3. **The targets it watches**: tick them. Ticking a group ticks every target
   in it and in the groups inside it.

One alert covers every target ticked for it, but each target is judged on its
own: it fires and clears separately, and one target in trouble says nothing
about the rest. A target added later is not ticked for anything until you tick
it, including one added to a group whose other targets are all ticked.

The Alerts button shows how many alerts are firing, and each target's page lists
the alerts watching it.

### Conditions

| Watching | Fires when |
|---|---|
| Packet loss | Loss exceeds the threshold (%) |
| Latency | Average RTT exceeds the threshold (ms) |
| Jitter | Jitter exceeds the threshold (ms) |
| Unreachable | A probe gets no reply at all |
| Certificate expires in | Fewer days than the threshold remain on an HTTPS target's certificate |

The certificate condition is the one that fires when a value falls *below* its
threshold. It defaults to a single probe rather than several in a row: a
certificate's expiry date does not flap. Only HTTPS targets have a certificate,
so on any other target it never fires.

When a **packet loss** or **unreachable** alert fires on a target, a traceroute
to that target is taken automatically and saved to its Route panel.

A target probed over **both IP versions** takes two readings each round, and its
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

The destination is chosen on the alert, not worked out from the URL. Each kind
is sent in its own format.

Use **Send test** on an alert to post a sample message, marked as a test, and
find a mistyped URL or ID now rather than during an outage. It changes nothing
about the alert's state.

### Discord

Create a webhook in Discord (channel settings, Integrations, Webhooks), copy its
URL and paste it in. Each time the alert fires or clears on a target, one embed
is posted to the channel:

- red when it fires, green when it clears
- the target's name and what is wrong in the title
- its address, the current reading, the alert's name and the target's group as
  fields
- the time of the probe as the embed's timestamp

**Mentions.** Give the alert role IDs, user IDs or both, separated by commas,
and they are mentioned when the alert fires. To copy an ID, turn on Developer
Mode in Discord (User Settings, Advanced), then right-click the role or user and
choose Copy ID. A mention pasted as Discord writes it (`<@&123...>`) works too.

- Mentions are sent when an alert **fires**, not when it clears.
- Only the IDs you listed can be mentioned. Nothing else in the message can
  ping anyone, so a target named `@everyone` is only text.

### Webhook

Any other URL receives a JSON POST on both transitions:

```json
{
  "status": "firing",
  "alert": { "id": "5f0c...", "name": "Packet loss above 10%" },
  "target": { "name": "Router", "host": "192.168.1.1", "group": "Home/Network" },
  "metric": "packetLoss",
  "observed": 42.5,
  "threshold": 10,
  "at": "2026-08-19T22:41:43.911Z",
  "text": "Router (192.168.1.1): packetLoss is 42.5, past threshold 10"
}
```

`status` is `firing` or `resolved`. The `text` field is a ready-made summary,
which is what a Slack-compatible endpoint reads, and most alerting services
accept the payload directly. A test message also carries `"test": true`.

### Only show it here

Nothing is sent. The alert still fires and clears, and shows on the Alerts
screen and in the count on the Alerts button.

Delivery failures are logged and swallowed: a webhook that is down must never
stop the prober from measuring.

## Behaviour worth knowing

- **A metric with no reading holds the current state.** A host that is down
  produces no latency figure. Reading that as "0ms, all good" would silently
  resolve a firing latency alert, so an absent reading neither fires nor
  resolves an alert. Use the *Unreachable* condition to alert on the host being
  down.
- **Muting an alert stops it being judged**, and resets its count, so unmuting
  it cannot resume part-way through a breach it was not watching. Changing its
  condition resets the count too.
- **Unticking a target forgets its state for that alert.** The targets that
  stay ticked keep theirs.
- **A paused target is not probed**, so its alerts neither fire nor clear until
  it is resumed.
- **Alerts are judged after the measurement is stored**, and alerting failures
  cannot prevent a measurement being recorded.

## Alerts made before there was an Alerts screen

Earlier versions set alerts on each target's own page. Those are carried over
automatically the first time a newer version starts: rules that said the same
thing on different targets become one alert ticked for all of them, each target
keeps its state (so one that was firing does not announce itself again), and
each is sent the way its URL was already being sent.

## API

| | |
|---|---|
| `GET /api/alerts` | Every alert, with the state of each ticked target |
| `POST /api/alerts` | Create one |
| `PATCH /api/alerts/:id` | Change one; `targetIds` replaces the ticked set, `enabled` mutes |
| `DELETE /api/alerts/:id` | Delete one |
| `POST /api/alerts/:id/test` | Send its destination a test message |

An alert is created with `metric`, `threshold`, `consecutiveProbes`,
`targetIds`, and optionally `name`, `destination` (`none`, `discord` or
`webhook`), `webhookUrl`, `mentionRoleIds` and `mentionUserIds`.
