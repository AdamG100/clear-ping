# Game Server Ping

Game Server Ping pings each region of a game from the local probe and every
probe agent that is online, side by side, on demand. It shows which region each
of your networks reaches best, and how much farther the next one is. Open it
from the tile beside Routing.

Nothing is kept. To watch a region over time, press **+** beside it: the
add-monitor form opens with the address, the method and a group
(`Game Server Ping/<game>`) filled in. From then on it is a monitor like any
other, with history, charts and alerts.

## What it measures

Each region is asked the way its server is built to answer, since many game
servers drop ping:

| Source | Method | What the number is |
|---|---|---|
| Valve's relays (CS2, Dota 2, Deadlock) | ICMP ping | The first leg of every connection to the game: matches are played through the relay nearest you |
| Epic's ping endpoints (Fortnite) | ICMP ping | Epic's own endpoint in each matchmaking region, the one Epic tells players to ping |
| Amazon GameLift's beacons | UDP echo, port 7770 | The AWS region a match would be hosted in, not a game server |

Each test is 10 requests, and the grid shows their median. Hover a reading for
its jitter, its loss and the address it went to. **Fastest first** sorts the
regions by the first probe's readings.

A probe agent measures with the same code as the local probe, so its column is
the network as that machine sees it. One from before Game Server Ping has no
UDP echo, and says it needs updating on Amazon GameLift's rows.

## Where the list comes from

Every address has a source that can be checked, and the page links to it.

- **Valve** lists its relays for each game at
  `api.steampowered.com/ISteamApps/GetSDRConfig/v1/?appid=<game>`. ClearPing
  reads that list when the game is picked and keeps it for six hours. If Valve
  cannot be reached, the last list it gave is used. The dashboard needs to
  reach `api.steampowered.com` for these games.
- **Epic** publishes `ping-<region>.ds.on.epicgames.com` for Fortnite, in its
  latency troubleshooting article.
- **Amazon** documents a UDP ping beacon in every AWS Region and Local Zone
  that hosts games. Apex Legends and Dead by Daylight are hosted on Amazon
  GameLift, by AWS's own account, but neither says which of those locations it
  uses, so both show them all, marked **Cloud region**.

Most publishers publish nothing: Valorant, League of Legends, Call of Duty,
Overwatch, Rainbow Six Siege, PUBG and Rocket League among them. The addresses
other ping sites show for those come from wikis and forums, and are not used
here. A game is added once its publisher, or the platform it runs on, says where
its servers are (`src/lib/game-ping/games.ts`).

## Limits

Tests run a few at a time: four from each open page, and no more than six at
once across the dashboard. That keeps the page from becoming a flood of
packets at someone else's servers. A test names a region by its id, never by an
address, so the page can only ever reach the servers in the list.

Amazon's beacons answer up to three requests a second from one port, which a
test stays within.
