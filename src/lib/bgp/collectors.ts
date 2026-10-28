import type { BgpRegion } from '@/types/bgp'
import { countryRegion } from './countries'

/**
 * RIPE RIS's route collectors: where each one is, and where its peers see a
 * prefix from. Pure: the routing pages use it too.
 *
 * A collector at an exchange peers with routers at that exchange, so they see
 * from its country. RRC00, RRC24 and RRC25 take sessions from anywhere
 * ("multihop"): their peers are placed by the country their network is
 * registered in, where that has been looked up, and by the collector's until
 * then.
 */

interface Collector {
  location: string
  /** ISO 3166 code of the country it is in. */
  country: string
  multihop: boolean
}

export interface Place {
  country: string
  region: BgpRegion
}

const at = (location: string, country: string, multihop = false): Collector => ({ location, country, multihop })

const COLLECTORS: Record<string, Collector> = {
  RRC00: at('Amsterdam (multihop)', 'NL', true),
  RRC01: at('London, LINX', 'GB'),
  RRC03: at('Amsterdam, AMS-IX', 'NL'),
  RRC04: at('Geneva, CIXP', 'CH'),
  RRC05: at('Vienna, VIX', 'AT'),
  RRC06: at('Tokyo, DIX-IE', 'JP'),
  RRC07: at('Stockholm, Netnod', 'SE'),
  RRC10: at('Milan, MIX', 'IT'),
  RRC11: at('New York, NYIIX', 'US'),
  RRC12: at('Frankfurt, DE-CIX', 'DE'),
  RRC13: at('Moscow, MSK-IX', 'RU'),
  RRC14: at('Palo Alto, PAIX', 'US'),
  RRC15: at('São Paulo, IX.br', 'BR'),
  RRC16: at('Miami, Equinix', 'US'),
  RRC18: at('Barcelona, CATNIX', 'ES'),
  RRC19: at('Johannesburg, NAPAfrica', 'ZA'),
  RRC20: at('Zurich, SwissIX', 'CH'),
  RRC21: at('Paris, France-IX', 'FR'),
  RRC22: at('Bucharest, InterLAN', 'RO'),
  RRC23: at('Singapore, Equinix', 'SG'),
  RRC24: at('Montevideo (multihop)', 'UY', true),
  RRC25: at('Amsterdam (multihop)', 'NL', true),
  RRC26: at('Dubai, UAE-IX', 'AE'),
}

/** RRC19, from "RRC19", "rrc19" or RIS Live's "rrc19.ripe.net". */
export function collectorName(host: string): string {
  return host.split('.')[0].toUpperCase()
}

export function collectorInfo(name: string): Collector {
  // One RIS has added since this list was written: named, and counted in
  // the Netherlands, where RIS is run from.
  return COLLECTORS[collectorName(name)] ?? at(collectorName(name), 'NL')
}

/** Where a collector's peer sees from: see the note at the top. */
export function peerPlace(collector: string, peerAsn: number, asCountry: (asn: number) => string | undefined): Place {
  const info = collectorInfo(collector)
  const country = (info.multihop && peerAsn > 0 && asCountry(peerAsn)) || info.country
  return { country, region: countryRegion(country) }
}
