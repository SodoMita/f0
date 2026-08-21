// Manifest-based unit runner. Every scripts/*-unit.mjs file MUST be listed
// here: a new unit file that is not registered fails the run (so nobody adds
// a check without wiring it into CI).
//
//   bun scripts/check-units.mjs          # run every "unit" tier file
//   TIER=unit bun scripts/check-units.mjs   # same (default)
//
// Two tiers:
//   "unit"    — pure logic / NullEngine, no browser, no live app. Runs in the
//               `static-and-unit` CI job (`bun run check:unit`).
//   "browser" — needs a live app + headless browser; runs under `check:e2e`
//               (`scripts/run-e2e.mjs`), not here.
//
// Runner choice per file (must match each script's own header comment):
//   bun  — scripts that import src/*.ts (bun strips types natively)
//   node — scripts with no TS imports
//   tsx  — relay-pool installs a FakeWS on globalThis BEFORE nostr-tools is
//          imported; bun's built-in WebSocket can't be swapped, so it runs
//          under tsx as its header documents.
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(here)

// filename -> { run: [...argv before the file], tier }
const MANIFEST = {
  'anim-unit.mjs':        { run: ['bun'],            tier: 'unit' },
  'codec-unit.mjs':       { run: ['bun'],            tier: 'unit' },
  'direct3d-unit.mjs':    { run: ['bun'],            tier: 'unit' },
  'error-copy-unit.mjs':  { run: ['node'],           tier: 'browser' },
  'export-card-unit.mjs': { run: ['bun'],            tier: 'unit' },
  'hash-unit.mjs':        { run: ['bun'],            tier: 'unit' },
  'library-unit.mjs':     { run: ['node'],           tier: 'unit' },
  'load-unit.mjs':        { run: ['bun'],            tier: 'unit' },
  'model-info-unit.mjs':  { run: ['bun'],            tier: 'unit' },
  'paint-unit.mjs':       { run: ['bun'],            tier: 'unit' },
  'publish-unit.mjs':     { run: ['bun'],            tier: 'unit' },
  'relay-pool-unit.mjs':  { run: ['npx', '--yes', 'tsx'], tier: 'unit' },
  'search-unit.mjs':      { run: ['bun'],            tier: 'unit' },
  'studio-unit.mjs':      { run: ['bun'],            tier: 'unit' },
  'thread-open-unit.mjs': { run: ['bun'],            tier: 'unit' },
}

const TIER = process.env.TIER || 'unit'

// 1. every *-unit.mjs on disk must be registered
const onDisk = readdirSync(here).filter((f) => f.endsWith('-unit.mjs')).sort()
const unregistered = onDisk.filter((f) => !MANIFEST[f])
if (unregistered.length) {
  console.error(`FAIL  unregistered unit file(s): ${unregistered.join(', ')}`)
  console.error('      add each to the MANIFEST in scripts/check-units.mjs (tier "unit" or "browser")')
  process.exit(1)
}

// 2. run the requested tier, serially, fail fast on the first non-zero exit
const toRun = Object.entries(MANIFEST)
  .filter(([, spec]) => spec.tier === TIER)
  .sort(([a], [b]) => a.localeCompare(b))

console.log(`check-units: ${toRun.length} "${TIER}" file(s)`)
for (const [file, spec] of toRun) {
  const argv = [...spec.run, join(here, file)]
  console.log(`\n$ ${argv.map((a) => (a === join(here, file) ? file : a)).join(' ')}`)
  const res = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', cwd: ROOT })
  const code = res.status ?? 1
  if (code !== 0) {
    console.error(`\nFAIL  ${file} exited ${res.status ?? `(signal ${res.signal})`}`)
    process.exit(1)
  }
}
console.log(`\nALL ${toRun.length} "${TIER}" UNIT FILES PASSED`)
