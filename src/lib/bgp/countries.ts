import type { BgpRegion } from '@/types/bgp'

/**
 * Countries, by the region of the registry that serves them, and their names.
 * Pure: the routing pages use it too.
 *
 * The regions are the five registries' service regions, so a country is where
 * its addresses are handed out from: RIPE NCC's, the default here, covers
 * Europe, the Middle East and Central Asia.
 */

const BY_REGION: Record<Exclude<BgpRegion, 'europe'>, string> = {
  africa:
    'AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG EH ER ET GA GH GM GN GQ GW IO KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RE RW SC SD SH SL SN SO SS ST SZ TD TF TG TN TZ UG YT ZA ZM ZW',
  'north-america': 'AG AI AQ BB BM BS BV CA DM GD HM JM KN KY LC MS PM PR TC UM US VC VG VI',
  'latin-america': 'AR AW BO BQ BR BZ CL CO CR CU CW DO EC FK GF GS GT GY HN HT MX NI PA PE PY SR SV SX TT UY VE',
  'asia-pacific':
    'AF AP AS AU BD BN BT CC CK CN CX FJ FM GU HK ID IN JP KH KI KP KR LA LK MH MM MN MO MP MV MY NC NF NP NR NU NZ PF PG PH PK PN PW SB SG TH TK TL TO TV TW VN VU WF WS',
}

const REGION_OF = new Map<string, BgpRegion>(
  Object.entries(BY_REGION).flatMap(([region, codes]) => codes.split(' ').map(code => [code, region as BgpRegion]))
)

/** The region a country's addresses come from: ZA is Africa, NL Europe. */
export function countryRegion(code: string): BgpRegion {
  return REGION_OF.get(code.toUpperCase()) ?? 'europe'
}

let displayNames: Intl.DisplayNames | null | undefined

/** "South Africa" for ZA, or the code itself where the name is not known. */
export function countryName(code: string): string {
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(['en'], { type: 'region' })
    } catch {
      displayNames = null
    }
  }
  try {
    return displayNames?.of(code.toUpperCase()) ?? code
  } catch {
    return code
  }
}
