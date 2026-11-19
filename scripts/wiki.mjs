#!/usr/bin/env node
// The GitHub wiki, made from the guides in docs/. docs/ stays the one place
// they are written; this turns each guide into a wiki page, points links
// between guides at the wiki pages, screenshots at the repository, and links
// to anything else in the repository at its file on main.
//
//   node scripts/wiki.mjs <wiki checkout>
//       writes the pages into a checkout of the wiki repository, removing the
//       pages it made before that no longer have a guide
//
// Run from the repository root.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'https://github.com/AdamG100/clear-ping'
const RAW = 'https://raw.githubusercontent.com/AdamG100/clear-ping/main'

/** Each guide, in the order the sidebar lists them, with its wiki page name and what it is about. */
export const PAGES = [
  { file: 'overview.md', page: 'The-Overview', about: 'the Overview, and how it tells where a fault lay' },
  { file: 'running.md', page: 'Running-ClearPing', about: 'running it, Docker, installing it as an app, maintenance, versions and upgrading' },
  { file: 'reverse-proxy.md', page: 'Behind-a-Reverse-Proxy', about: 'HTTPS with Caddy, nginx, Traefik, Cloudflare Tunnel or Tailscale' },
  { file: 'automatic-probing.md', page: 'Automatic-Probing', about: 'what each kind of check measures, groups, comparisons, traceroute' },
  { file: 'alerting.md', page: 'Alerting', about: 'alerts, and sending them with Apprise' },
  { file: 'probe-agents.md', page: 'Probe-Agents', about: 'measuring from other machines, over a tailnet or the internet' },
  { file: 'game-server-ping.md', page: 'Game-Server-Ping', about: "a game's regions pinged from every probe" },
  { file: 'bgp-monitoring.md', page: 'BGP-Monitoring', about: 'watching your prefixes in BGP' },
  { file: 'mcp.md', page: 'Connecting-an-AI-Assistant', about: 'connecting an AI assistant, and the report for an ISP' },
  { file: 'security.md', page: 'Security', about: 'sign-in, roles, single sign-on, keys and the activity record' },
  { file: 'api.md', page: 'API', about: 'the HTTP API' },
  { file: 'structure.md', page: 'Where-Things-Go', about: 'for changing ClearPing: where files go and how they are named' },
]

const PAGE_FOR = new Map(PAGES.map(each => [each.file, each.page]))

/** A page name as the wiki shows it. */
const titleOf = page => page.replaceAll('-', ' ')

/** Where a link in a guide goes on the wiki. Links off the repository are left as they are. */
export function wikiTarget(target) {
  if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return target

  const hash = target.indexOf('#')
  const path = hash === -1 ? target : target.slice(0, hash)
  const fragment = hash === -1 ? '' : target.slice(hash)
  const inRepo = posix.normalize(posix.join('docs', path))

  if (inRepo.startsWith('docs/') && PAGE_FOR.has(inRepo.slice(5))) return PAGE_FOR.get(inRepo.slice(5)) + fragment
  if (inRepo.startsWith('docs/screenshots/')) return `${RAW}/${inRepo}`
  if (inRepo.startsWith('..')) return target
  return `${REPO}/blob/main/${inRepo}${fragment}`
}

/** A guide as a wiki page: its title dropped (the wiki shows the page name) and its links pointed at the wiki. */
export function pageFrom(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  if (lines[0]?.startsWith('# ')) {
    lines.shift()
    while (lines[0] === '') lines.shift()
  }

  let fence = null
  return lines
    .map(line => {
      const opens = line.match(/^\s*(`{3,}|~{3,})/)
      if (opens) {
        if (!fence) fence = opens[1]
        else if (opens[1].startsWith(fence[0]) && opens[1].length >= fence.length) fence = null
        return line
      }
      if (fence) return line
      return line.replace(/(!?\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g, (_, open, target, close) => open + wikiTarget(target) + close)
    })
    .join('\n')
}

/** The wiki's front page. */
export function home() {
  const list = PAGES.map(each => `- [${titleOf(each.page)}](${each.page}): ${each.about}`).join('\n')
  return `ClearPing watches your network: ping, DNS, HTTP and game servers, from the
dashboard's own machine and from probe agents elsewhere, with alerts when
something stops answering.

New here? Start with [Running ClearPing](Running-ClearPing), then
[The Overview](The-Overview).

## Guides

${list}

The [README](${REPO}#readme) has the quick start and every setting.
`
}

/** The sidebar on every page. */
export function sidebar() {
  return `**[Home](Home)**\n\n${PAGES.map(each => `- [${titleOf(each.page)}](${each.page})`).join('\n')}\n`
}

/** The footer on every page. */
export function footer() {
  return `These pages are made from [docs/](${REPO}/tree/main/docs) in the repository, and edits made here are replaced the next time they change there. To change a page, change its guide in \`docs/\`.\n`
}

/** Writes the wiki into a checkout of the wiki repository. */
export function writeWiki(out, docs = 'docs') {
  const made = new Set(['Home.md', '_Sidebar.md', '_Footer.md', ...PAGES.map(each => `${each.page}.md`)])
  const guides = readdirSync(docs).filter(name => name.endsWith('.md'))
  const missing = guides.filter(name => !PAGE_FOR.has(name))
  if (missing.length) throw new Error(`No wiki page for ${missing.join(', ')}: add it to PAGES in scripts/wiki.mjs`)

  mkdirSync(out, { recursive: true })
  for (const name of readdirSync(out)) {
    if (name.endsWith('.md') && !made.has(name)) rmSync(join(out, name))
  }

  for (const each of PAGES) {
    writeFileSync(join(out, `${each.page}.md`), pageFrom(readFileSync(join(docs, each.file), 'utf8')))
  }
  writeFileSync(join(out, 'Home.md'), home())
  writeFileSync(join(out, '_Sidebar.md'), sidebar())
  writeFileSync(join(out, '_Footer.md'), footer())
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = process.argv[2]
  if (!out) throw new Error('Usage: node scripts/wiki.mjs <wiki checkout>')
  writeWiki(out)
}
