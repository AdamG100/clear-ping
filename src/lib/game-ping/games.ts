import { valveRegions } from './valve'
import type { Game, GameRegion, GameSummary, RegionMethod } from './catalogue'

/**
 * The games Game Server Ping knows, each with where its regions came from.
 *
 * Only what a source vouches for is here (see catalogue.ts). Most publishers
 * publish nothing: Valorant, League of Legends, Call of Duty, Overwatch,
 * Rainbow Six Siege, PUBG and Rocket League among them, and the addresses
 * other ping sites show for those come from wikis and forums. They are left
 * out until their publishers say where their servers are. A game added here
 * needs a source for every address it lists.
 */

const ICMP: RegionMethod = { kind: 'icmp' }
/** Amazon GameLift's beacons echo a UDP datagram on 7770, and answer up to 3 a second from one port. */
const GAMELIFT: RegionMethod = { kind: 'udp-echo', port: 7770 }

const GAMELIFT_SOURCES = [
  'https://docs.aws.amazon.com/general/latest/gr/gamelift.html#gamelift_ping_beacons',
  'https://docs.aws.amazon.com/gameliftservers/latest/developerguide/reference-udp-ping-beacons.html',
]

/**
 * Amazon GameLift's UDP ping beacons, one in each AWS Region and Local Zone
 * that hosts games. A Local Zone's is named for the zone's city and its
 * parent Region (`gamelift-ping-lax.us-west-2.api.aws`), not `.<zone>.`.
 */
const GAMELIFT_REGIONS: GameRegion[] = [
  { id: 'us-east-1', label: 'N. Virginia, US', continent: 'North America', host: 'gamelift-ping.us-east-1.api.aws', method: GAMELIFT },
  { id: 'us-east-2', label: 'Ohio, US', continent: 'North America', host: 'gamelift-ping.us-east-2.api.aws', method: GAMELIFT },
  { id: 'us-west-1', label: 'N. California, US', continent: 'North America', host: 'gamelift-ping.us-west-1.api.aws', method: GAMELIFT },
  { id: 'us-west-2', label: 'Oregon, US', continent: 'North America', host: 'gamelift-ping.us-west-2.api.aws', method: GAMELIFT },
  { id: 'ca-central-1', label: 'Montreal, Canada', continent: 'North America', host: 'gamelift-ping.ca-central-1.api.aws', method: GAMELIFT },
  { id: 'mx-central-1', label: 'Querétaro, Mexico', continent: 'North America', host: 'gamelift-ping.mx-central-1.api.aws', method: GAMELIFT },
  { id: 'us-west-2-lax', label: 'Los Angeles, US', continent: 'North America', host: 'gamelift-ping-lax.us-west-2.api.aws', method: GAMELIFT },
  { id: 'us-west-2-den', label: 'Denver, US', continent: 'North America', host: 'gamelift-ping-den.us-west-2.api.aws', method: GAMELIFT },
  { id: 'us-west-2-phx', label: 'Phoenix, US', continent: 'North America', host: 'gamelift-ping-phx.us-west-2.api.aws', method: GAMELIFT },
  { id: 'us-east-1-chi', label: 'Chicago, US', continent: 'North America', host: 'gamelift-ping-chi.us-east-1.api.aws', method: GAMELIFT },
  { id: 'us-east-1-iah', label: 'Houston, US', continent: 'North America', host: 'gamelift-ping-iah.us-east-1.api.aws', method: GAMELIFT },
  { id: 'us-east-1-dfw', label: 'Dallas, US', continent: 'North America', host: 'gamelift-ping-dfw.us-east-1.api.aws', method: GAMELIFT },
  { id: 'us-east-1-atl', label: 'Atlanta, US', continent: 'North America', host: 'gamelift-ping-atl.us-east-1.api.aws', method: GAMELIFT },
  { id: 'us-east-1-mci', label: 'Kansas City, US', continent: 'North America', host: 'gamelift-ping-mci.us-east-1.api.aws', method: GAMELIFT },
  { id: 'us-east-1-mia', label: 'Miami, US', continent: 'North America', host: 'gamelift-ping-mia.us-east-1.api.aws', method: GAMELIFT },
  { id: 'us-east-1-nyc', label: 'New York City, US', continent: 'North America', host: 'gamelift-ping-nyc.us-east-1.api.aws', method: GAMELIFT },
  { id: 'sa-east-1', label: 'São Paulo, Brazil', continent: 'South America', host: 'gamelift-ping.sa-east-1.api.aws', method: GAMELIFT },
  { id: 'us-east-1-bue', label: 'Buenos Aires, Argentina', continent: 'South America', host: 'gamelift-ping-bue.us-east-1.api.aws', method: GAMELIFT },
  { id: 'us-east-1-lim', label: 'Lima, Peru', continent: 'South America', host: 'gamelift-ping-lim.us-east-1.api.aws', method: GAMELIFT },
  { id: 'eu-west-1', label: 'Dublin, Ireland', continent: 'Europe', host: 'gamelift-ping.eu-west-1.api.aws', method: GAMELIFT },
  { id: 'eu-west-2', label: 'London, UK', continent: 'Europe', host: 'gamelift-ping.eu-west-2.api.aws', method: GAMELIFT },
  { id: 'eu-west-3', label: 'Paris, France', continent: 'Europe', host: 'gamelift-ping.eu-west-3.api.aws', method: GAMELIFT },
  { id: 'eu-central-1', label: 'Frankfurt, Germany', continent: 'Europe', host: 'gamelift-ping.eu-central-1.api.aws', method: GAMELIFT },
  { id: 'eu-south-1', label: 'Milan, Italy', continent: 'Europe', host: 'gamelift-ping.eu-south-1.api.aws', method: GAMELIFT },
  { id: 'eu-south-2', label: 'Aragón, Spain', continent: 'Europe', host: 'gamelift-ping.eu-south-2.api.aws', method: GAMELIFT },
  { id: 'eu-north-1', label: 'Stockholm, Sweden', continent: 'Europe', host: 'gamelift-ping.eu-north-1.api.aws', method: GAMELIFT },
  { id: 'ap-south-1', label: 'Mumbai, India', continent: 'Asia', host: 'gamelift-ping.ap-south-1.api.aws', method: GAMELIFT },
  { id: 'ap-south-2', label: 'Hyderabad, India', continent: 'Asia', host: 'gamelift-ping.ap-south-2.api.aws', method: GAMELIFT },
  { id: 'ap-east-1', label: 'Hong Kong', continent: 'Asia', host: 'gamelift-ping.ap-east-1.api.aws', method: GAMELIFT },
  { id: 'ap-southeast-1', label: 'Singapore', continent: 'Asia', host: 'gamelift-ping.ap-southeast-1.api.aws', method: GAMELIFT },
  { id: 'ap-southeast-3', label: 'Jakarta, Indonesia', continent: 'Asia', host: 'gamelift-ping.ap-southeast-3.api.aws', method: GAMELIFT },
  { id: 'ap-southeast-5', label: 'Kuala Lumpur, Malaysia', continent: 'Asia', host: 'gamelift-ping.ap-southeast-5.api.aws', method: GAMELIFT },
  { id: 'ap-southeast-7', label: 'Bangkok, Thailand', continent: 'Asia', host: 'gamelift-ping.ap-southeast-7.api.aws', method: GAMELIFT },
  { id: 'ap-northeast-1', label: 'Tokyo, Japan', continent: 'Asia', host: 'gamelift-ping.ap-northeast-1.api.aws', method: GAMELIFT },
  { id: 'ap-northeast-2', label: 'Seoul, South Korea', continent: 'Asia', host: 'gamelift-ping.ap-northeast-2.api.aws', method: GAMELIFT },
  { id: 'ap-northeast-3', label: 'Osaka, Japan', continent: 'Asia', host: 'gamelift-ping.ap-northeast-3.api.aws', method: GAMELIFT },
  { id: 'ap-southeast-2', label: 'Sydney, Australia', continent: 'Oceania', host: 'gamelift-ping.ap-southeast-2.api.aws', method: GAMELIFT },
  { id: 'me-south-1', label: 'Bahrain', continent: 'Middle East', host: 'gamelift-ping.me-south-1.api.aws', method: GAMELIFT },
  { id: 'il-central-1', label: 'Tel Aviv, Israel', continent: 'Middle East', host: 'gamelift-ping.il-central-1.api.aws', method: GAMELIFT },
  { id: 'af-south-1', label: 'Cape Town, South Africa', continent: 'Africa', host: 'gamelift-ping.af-south-1.api.aws', method: GAMELIFT },
  { id: 'af-south-1-los', label: 'Lagos, Nigeria', continent: 'Africa', host: 'gamelift-ping-los.af-south-1.api.aws', method: GAMELIFT },
]

/** Epic's ping endpoints, one for each region Fortnite matches in. Epic tells players to ping these to check their connection. */
const FORTNITE_REGIONS: GameRegion[] = [
  { id: 'va', label: 'Virginia, US (NA-East)', continent: 'North America', host: 'ping-va.ds.on.epicgames.com', method: ICMP },
  { id: 'oh', label: 'Ohio, US (NA-East)', continent: 'North America', host: 'ping-oh.ds.on.epicgames.com', method: ICMP },
  { id: 'ia', label: 'Iowa, US (NA-Central)', continent: 'North America', host: 'ping-ia.ds.on.epicgames.com', method: ICMP },
  { id: 'tx', label: 'Texas, US (NA-Central)', continent: 'North America', host: 'ping-tx.ds.on.epicgames.com', method: ICMP },
  { id: 'mx', label: 'Mexico (NA-Central)', continent: 'North America', host: 'ping-mx.ds.on.epicgames.com', method: ICMP },
  { id: 'ncal', label: 'N. California, US (NA-West)', continent: 'North America', host: 'ping-ncal.ds.on.epicgames.com', method: ICMP },
  { id: 'or', label: 'Oregon, US (NA-West)', continent: 'North America', host: 'ping-or.ds.on.epicgames.com', method: ICMP },
  { id: 'gb', label: 'United Kingdom (Europe)', continent: 'Europe', host: 'ping-gb.ds.on.epicgames.com', method: ICMP },
  { id: 'de', label: 'Germany (Europe)', continent: 'Europe', host: 'ping-de.ds.on.epicgames.com', method: ICMP },
  { id: 'fr', label: 'France (Europe)', continent: 'Europe', host: 'ping-fr.ds.on.epicgames.com', method: ICMP },
  { id: 'sao', label: 'São Paulo, Brazil', continent: 'South America', host: 'ping-sao.ds.on.epicgames.com', method: ICMP },
  { id: 'bah', label: 'Bahrain (Middle East)', continent: 'Middle East', host: 'ping-bah.ds.on.epicgames.com', method: ICMP },
  { id: 'il', label: 'Israel (Middle East)', continent: 'Middle East', host: 'ping-il.ds.on.epicgames.com', method: ICMP },
  { id: 'mum', label: 'Mumbai, India (Middle East region)', continent: 'Asia', host: 'ping-mum.ds.on.epicgames.com', method: ICMP },
  { id: 'tok', label: 'Tokyo, Japan (Asia)', continent: 'Asia', host: 'ping-tok.ds.on.epicgames.com', method: ICMP },
  { id: 'syd', label: 'Sydney, Australia (Oceania)', continent: 'Oceania', host: 'ping-syd.ds.on.epicgames.com', method: ICMP },
]

const VALVE_SOURCE = 'https://partner.steamgames.com/doc/features/multiplayer/steamdatagramrelay'
const VALVE_NOTE =
  'Valve\'s relays, read from Valve\'s own list as you open the game, so they stay current. Matches are played through the relay ' +
  'nearest you and the one nearest the server, so these are the first leg of every connection to the game.'

export const GAMES: Game[] = [
  {
    id: 'cs2',
    name: 'Counter-Strike 2',
    publisher: 'Valve',
    what: 'own-servers',
    sources: ['https://api.steampowered.com/ISteamApps/GetSDRConfig/v1/?appid=730', VALVE_SOURCE],
    note: VALVE_NOTE,
    regions: [],
    valveAppId: 730,
  },
  {
    id: 'dota2',
    name: 'Dota 2',
    publisher: 'Valve',
    what: 'own-servers',
    sources: ['https://api.steampowered.com/ISteamApps/GetSDRConfig/v1/?appid=570', VALVE_SOURCE],
    note: VALVE_NOTE,
    regions: [],
    valveAppId: 570,
  },
  {
    id: 'deadlock',
    name: 'Deadlock',
    publisher: 'Valve',
    what: 'own-servers',
    sources: ['https://api.steampowered.com/ISteamApps/GetSDRConfig/v1/?appid=1422450', VALVE_SOURCE],
    note: VALVE_NOTE,
    regions: [],
    valveAppId: 1422450,
  },
  {
    id: 'fortnite',
    name: 'Fortnite',
    publisher: 'Epic Games',
    what: 'ping-endpoint',
    sources: [
      'https://www.epicgames.com/help/fortnite-battle-royale-c-202300000001636/technical-support-c-202300000001719/fortnite-latency-and-ping-troubleshooting-a202300000010042',
    ],
    note: 'Epic\'s own ping endpoints, one in each region Fortnite matches players in. The region names in brackets are the ones in the game\'s matchmaking settings.',
    regions: FORTNITE_REGIONS,
  },
  {
    id: 'apex-legends',
    name: 'Apex Legends',
    publisher: 'Electronic Arts / Respawn',
    what: 'cloud-region',
    sources: ['https://aws.amazon.com/blogs/gametech/apex-legends-migrates-to-amazon-gamelift-servers-in-just-10-days/', ...GAMELIFT_SOURCES],
    note: 'Apex Legends is hosted on Amazon GameLift, but which of its locations the game uses is not published. These are all of them: the ones nearest you are the ones that matter.',
    regions: GAMELIFT_REGIONS,
  },
  {
    id: 'dead-by-daylight',
    name: 'Dead by Daylight',
    publisher: 'Behaviour Interactive',
    what: 'cloud-region',
    sources: ['https://aws.amazon.com/blogs/gametech/how-dead-by-daylight-survives-the-test-of-time-using-aws/', ...GAMELIFT_SOURCES],
    note: 'Dead by Daylight is hosted on Amazon GameLift, but which of its locations the game uses now is not published. These are all of them: the ones nearest you are the ones that matter.',
    regions: GAMELIFT_REGIONS,
  },
  {
    id: 'amazon-gamelift',
    name: 'Any game on Amazon GameLift',
    publisher: 'Amazon Web Services',
    what: 'cloud-region',
    sources: GAMELIFT_SOURCES,
    note: 'The ping beacons Amazon runs in every region that hosts games, for games to choose a region by. Useful for any game hosted on GameLift, named here or not.',
    regions: GAMELIFT_REGIONS,
  },
]

export function findGame(id: string): Game | undefined {
  return GAMES.find(game => game.id === id)
}

export function gameSummaries(): GameSummary[] {
  return GAMES.map(({ regions, valveAppId, ...game }) => {
    void regions
    return { ...game, live: valveAppId !== undefined }
  })
}

/** A game's regions: from Valve's own list for a Valve game, otherwise as listed here. */
export function regionsOf(game: Game): Promise<GameRegion[]> {
  return game.valveAppId !== undefined ? valveRegions(game.valveAppId) : Promise.resolve(game.regions)
}
