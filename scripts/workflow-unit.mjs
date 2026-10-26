#!/usr/bin/env node
/**
 * Deployment + config-loader guards (pure text checks, no browser).
 *
 * Two failures here have already cost real debugging time:
 *  - the Pages workflow used `bun-version: latest` while CI was pinned to
 *    `.bun-version`, so the same commit could produce two different
 *    standalone bundles;
 *  - both Vite configs imported `./csp` without an extension, which Vite 8
 *    warns will stop working when `configLoader: 'native'` becomes default.
 *
 * Keep the checks tied to behaviour (the exact pin + extension), not to a
 * copy of the whole workflow, so harmless comment edits do not fail CI.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(here)
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
let failed = 0

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}

const bunVersion = read('.bun-version').trim()
check('bun pin is a concrete semver version', /^\d+\.\d+\.\d+$/.test(bunVersion), bunVersion)

for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/deploy-pages.yml']) {
  const yml = read(workflow)
  check(`${workflow} uses the repo bun pin`, /bun-version-file:\s*\.bun-version\b/.test(yml))
  check(`${workflow} never uses bun-version: latest`, !/bun-version:\s*latest\b/.test(yml))
  check(`${workflow} installs with a frozen lockfile`, /bun install --frozen-lockfile/.test(yml))
}

const deploy = read('.github/workflows/deploy-pages.yml')
check('Pages deploys only from main', /on:[\s\S]*?push:[\s\S]*?branches:\s*\[main\]/.test(deploy))
check('Pages builds the standalone HTML', /bun run build:standalone/.test(deploy))
check('Pages artifact is the standalone HTML', /cp form-zero-standalone\.html site\/index\.html/.test(deploy))
check('Pages uploads the site/ artifact', /path:\s*site\b/.test(deploy))
check('Pages has bounded build + deploy jobs', /timeout-minutes:\s*\d+/.test(deploy) && (deploy.match(/timeout-minutes:/g) || []).length >= 2)

const vite = read('vite.config.ts')
const standalone = read('vite.standalone.config.ts')
check('vite.config.ts imports csp.ts with its extension', /from ['"]\.\/csp\.ts['"]/.test(vite))
check('vite.standalone.config.ts imports vite.config.ts with its extension', /from ['"]\.\/vite\.config\.ts['"]/.test(standalone))
check('vite.standalone.config.ts imports csp.ts with its extension', /from ['"]\.\/csp\.ts['"]/.test(standalone))
// Strip line comments first: the config documents the old option by name.
const standaloneCode = standalone.replace(/\/\/.*$/gm, '')
check('standalone uses the non-deprecated single-chunk option', /codeSplitting:\s*false/.test(standaloneCode))
check('standalone no longer uses deprecated inlineDynamicImports', !/inlineDynamicImports/.test(standaloneCode))

if (failed) {
  console.error(`\n${failed} DEPLOYMENT/CONFIG GUARD(S) FAILED`)
  process.exit(1)
}
console.log('\nALL DEPLOYMENT/CONFIG GUARDS PASSED')
