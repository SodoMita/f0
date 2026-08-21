// Deterministic end-to-end orchestrator. One command replaces the three
// hand-managed terminals (vite + offline-rig + browser suites):
//
//   1. ensures the self-signed rig certs exist (regenerates if missing/expired)
//   2. starts Vite (dev server, :5173)
//   3. starts the offline rig (scripts/offline-rig.mjs: wss relay + model
//      server on :8443, proxy on :4173)
//   4. waits for both health endpoints
//   5. runs each browser suite serially against the rig proxy
//   6. terminates every child process in `finally`, so a failed suite cannot
//      leak orphan servers
//
//   bun scripts/run-e2e.mjs
//   SUITES="smoke features offline-verify" bun scripts/run-e2e.mjs
//   TARGET_URL=http://localhost:4173/ bun scripts/run-e2e.mjs
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(here)

const CERTS = '/tmp/rig-certs'
const CERT = join(CERTS, 'cert.pem')
const KEY = join(CERTS, 'key.pem')
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:4173/'
const SUITES = (process.env.SUITES || 'smoke codec-browser features offline-verify').split(/\s+/).filter(Boolean)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --------------------------------------------------------------- certs
function ensureCerts() {
  if (existsSync(KEY) && existsSync(CERT)) {
    try {
      execFileSync('openssl', ['x509', '-checkend', '86400', '-noout', '-in', CERT], { stdio: 'ignore' })
      return
    } catch { /* expired -> regenerate below */ }
  }
  mkdirSync(CERTS, { recursive: true })
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-keyout', KEY, '-out', CERT, '-days', '30', '-nodes', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore' })
  console.log('[e2e] generated rig certs in ' + CERTS)
}

// -------------------------------------------------------- process group
const children = new Set()
function spawnProc(cmd, args) {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', detached: true })
  children.add(child)
  child.on('exit', () => children.delete(child))
  return child
}
function killAll() {
  for (const child of children) {
    try { process.kill(-child.pid, 'SIGTERM') } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------- health probes
// The rig serves https://localhost:8443 with a self-signed cert we generate in
// ensureCerts(). Validate against that exact cert (as the trusted CA) instead
// of disabling TLS verification, so the probe checks the rig really is the
// server we booted — not just that something answers on the port.
function probe(url) {
  return new Promise((resolve) => {
    const opts = { timeout: 3000 }
    if (url.startsWith('https:')) opts.ca = readFileSync(CERT)
    const req = (url.startsWith('https:') ? httpsRequest : httpRequest)(
      url, opts,
      (res) => { res.resume(); resolve(res.statusCode === 200) },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.end()
  })
}
async function waitFor(desc, url, timeoutMs = 120000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await probe(url)) { console.log(`[e2e] ${desc} ready`); return }
    await sleep(500)
  }
  throw new Error(`[e2e] ${desc} did not become ready at ${url} within ${timeoutMs}ms`)
}

function runSuite(name) {
  return new Promise((resolve) => {
    const child = spawn('node', [join(here, name + '.mjs')], {
      cwd: ROOT, stdio: 'inherit', env: { ...process.env, TARGET_URL },
    })
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

// ------------------------------------------------------------------ main
console.log(`[e2e] suites: ${SUITES.join(', ')}  (target ${TARGET_URL})`)
try {
  ensureCerts()
  spawnProc('bun', ['run', 'dev'])                       // vite :5173
  spawnProc('node', [join(here, 'offline-rig.mjs')])     // rig :4173 + :8443

  await waitFor('vite (via rig proxy)', 'http://localhost:4173/')
  await waitFor('rig models', 'https://localhost:8443/models/a.glb')

  let failed = false
  for (const name of SUITES) {
    console.log(`\n[e2e] === suite: ${name} ===`)
    const code = await runSuite(name)
    if (code !== 0) { failed = true; console.error(`[e2e] suite ${name} FAILED (exit ${code})`) }
  }
  if (failed) throw new Error('[e2e] one or more suites failed')
  console.log(`\n[e2e] ALL ${SUITES.length} SUITES PASSED`)
} finally {
  killAll()
  await sleep(600)
}
