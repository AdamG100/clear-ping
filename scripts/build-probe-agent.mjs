// Bundles the probe agent into one file, dist/probe-agent/clearping-probe-agent.cjs,
// which the Docker image runs and the standalone binary is built from.
//
//   node scripts/build-probe-agent.mjs          the bundle
//   node scripts/build-probe-agent.mjs --sea    the bundle, then a single
//                                               executable of it for this
//                                               machine (Node 25.5 or later)
//
// The version is CLEARPING_VERSION, as CI sets it for the image; a build
// without one calls itself "development".
//
// The agent shares the probe code with the dashboard, and must never pull in
// what only the dashboard has: the database, Next.js, sign-in. The bundle is
// checked for those, and the build fails if any of them got in.

import { execFileSync } from 'node:child_process'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'dist', 'probe-agent')
const bundle = join(outDir, 'clearping-probe-agent.cjs')
const version = process.env.CLEARPING_VERSION?.trim() || 'development'

const FORBIDDEN = [
  /(^|\/)src\/lib\/db\//,
  /(^|\/)src\/lib\/security\/(auth|store|settings-store|access)\.ts$/,
  /(^|\/)node_modules\/(next|better-auth|@better-auth|sqlite3|better-sqlite3|kysely|react)\//,
]

mkdirSync(outDir, { recursive: true })

const result = await build({
  entryPoints: [join(root, 'probe-agent', 'main.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // tsconfig.json's paths resolve @/ and @/types/.
  tsconfig: join(root, 'tsconfig.json'),
  define: { 'process.env.CLEARPING_PROBE_AGENT_VERSION': JSON.stringify(version) },
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
})

const leaked = Object.keys(result.metafile.inputs).filter(input => FORBIDDEN.some(pattern => pattern.test(input.replace(/\\/g, '/'))))
if (leaked.length > 0) {
  console.error('The probe agent bundle pulls in code only the dashboard may have:')
  for (const input of leaked) console.error(`  ${input}`)
  console.error('Something the agent imports reaches these. Keep the probe modules free of them.')
  process.exit(1)
}

console.log(`Built ${bundle} (${version}, ${Math.round(statSync(bundle).size / 1024)} KB)`)

if (process.argv.includes('--sea')) {
  const executable = join(outDir, process.platform === 'win32' ? 'clearping-probe-agent.exe' : 'clearping-probe-agent')
  const config = join(outDir, 'sea-config.json')
  writeFileSync(
    config,
    JSON.stringify({ main: bundle, output: executable, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }, null, 2)
  )
  execFileSync(process.execPath, ['--build-sea', config], { stdio: 'inherit' })
  console.log(`Built ${executable}`)
}
