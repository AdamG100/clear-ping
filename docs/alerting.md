# Alerting

Without an alert rule, ClearPing is a dashboard you have to remember to look at.
A rule turns it into something that tells you when your network breaks.

## Creating a rule

Select a target and use the **Alerts** panel. Each rule watches one metric:

| Metric | Fires when |
|---|---|
| Packet loss | Loss exceeds the threshold (%) |
| Latency | Average RTT exceeds the threshold (ms) |
| Jitter | Jitter exceeds the threshold (ms) |
| Unreachable | A probe gets no reply at all |

## Why "consecutive probes" matters

A rule fires only after the condition has held for that many probes in a row,
and clears only after the same number of clean ones. This hysteresis is the
difference between an alert and a nuisance: a single probe crossing a threshold
is usually a blip, and a rule that fires and resolves on alternating probes
trains you to ignore it.

With the default of 3 and a 5-minute interval, a rule fires after roughly
15 minutes of sustained trouble.

## Webhooks

Give a rule a webhook URL and it receives a POST on both transitions:

```json
{
  "status": "firing",
  "target": { "name": "Router", "host": "192.168.1.1" },
  "metric": "packetLoss",
  "observed": 42.5,
  "threshold": 10,
  "at": "2026-08-19T22:41:43.911Z",
  "text": "Router (192.168.1.1): packetLoss is 42.5, past threshold 10"
}
```

The `text` field is a ready-made summary, so Slack and Discord incoming webhooks
work if you point them at a small relay, and most alerting services accept the
payload directly.

Delivery failures are logged and swallowed — a webhook that is down must never
stop the prober from measuring.

## Behaviour worth knowing

- **A metric with no reading holds the current state.** A host that is down
  produces no latency figure. Reading that as "0ms, all good" would silently
  resolve a firing latency alert, so an absent reading neither fires nor
  resolves a rule. Use the *Unreachable* metric to alert on the host being down.
- **Disabling a rule resets its streak**, so re-enabling it cannot resume
  part-way through a breach it was not watching.
- **Rules are evaluated after the measurement is stored**, and alerting failures
  cannot prevent a measurement being recorded.
