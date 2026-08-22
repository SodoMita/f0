// Security audit harness: drives the app against the HOSTILE rig
// (scripts/hostile-rig.mjs) and measures the impact of each attack.
//
//   node scripts/hostile-audit.mjs [attack ...]   (default: all, in order)
//
// Per attack (fresh page each time):
//   * boot the app against the hostile relay
//   * fire the attack via POST /__attack?name=<id>
//   * observe for the attack's window and record:
//       crash / renderer death      (Playwright crash + page close)
//       main-thread freeze          (heartbeat max gap, ms)
//       uncaught exceptions         (pageerror)
//       console errors              (filtered)
//       XSS markers                 (window.__xss*)
//       error sheet state           (code + cause)
//       index / relay counts / heap (before vs after)
//
//   exit 0 = ran; the RESULT TABLE is the point, not the exit code.
import { chromium } from 'playwright'
import { request as httpRequest } from 'node:http'

const TARGET = 'http://localhost:9173/'
const CONTROL = 'http://localhost:9173/__attack?name='
const ATTACKS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      // RCE / XSS probes first (clean DOM state)
      'xss-name', 'xss-filename', 'xss-mixed',
      // crash / unhandled
      'malformed-burst', 'bin-frame',
      'glb-oob', 'glb-nan', 'glb-chain',
      'glb-draco', 'glb-audio-trunc', 'glb-texforge', 'glb-tex19',
      // freeze / DoS
      'huge-msg', 'deep-json', 'flood', 'reply-storm',
      'glb-animmax', 'glb-audio-big', 'reconnect-flood',
      'many-urls',
      // blossom abuse
      'blossom-eviljson', 'blossom-evilurl',
      // exhaustion, last (may kill the renderer)
      'glb-bomb',
    ]

// observation windows per attack (ms)
const WINDOW = {
  'xss-name': 6000, 'xss-filename': 6000, 'xss-mixed': 6000,
  'malformed-burst': 8000, 'bin-frame': 6000,
  'glb-oob': 12000, 'glb-nan': 12000, 'glb-chain': 15000,
  'glb-draco': 15000, 'glb-audio-trunc': 15000, 'glb-texforge': 12000, 'glb-tex19': 20000,
  'huge-msg': 15000, 'deep-json': 10000, 'flood': 20000, 'reply-storm': 25000,
  'glb-animmax': 20000, 'glb-audio-big': 20000, 'reconnect-flood': 20000,
  'many-urls': 25000,
  'blossom-eviljson': 12000, 'blossom-evilurl': 12000,
  'glb-bomb': 45000,
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function fire(name, extra = '') {
  return new Promise((resolve) => {
    const req = httpRequest(CONTROL + name + extra, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => resolve(b.slice(0, 200)))
    })
    req.on('error', (e) => resolve('control error: ' + e.message))
    req.end()
  })
}

const consoleNoise = [
  /AudioContext|audio device/i,
  /WebSocket connection to 'wss:\/\/(?!localhost)/,
  /Failed to load resource/,
  /vite|HMR/i,
]

async function bootPage(browser, pageErrors, consoleErrors) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    if (consoleNoise.some((re) => re.test(t))) return
    consoleErrors.push(t.slice(0, 300))
  })
  await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30000 })
  const t0 = Date.now()
  let booted = false
  while (Date.now() - t0 < 25000) {
    try {
      const n = await page.evaluate(() => window.__form0?.index?.byId?.size ?? 0)
      if (n >= 4) { booted = true; break }
    } catch { break }
    await sleep(500)
  }
  // let posters settle a bit
  await sleep(3000)
  await page.evaluate(() => {
    window.__hb = { last: performance.now(), max: 0 }
    setInterval(() => {
      const now = performance.now()
      if (now - window.__hb.last > 50) {
        window.__hb.max = Math.max(window.__hb.max, now - window.__hb.last - 200)
      }
      window.__hb.last = now
    }, 200)
  })
  return { page, booted }
}

async function snap(page) {
  try {
    return await page.evaluate(() => {
      const f = window.__form0
      const sheetEl = document.getElementById('error-code')
      const causeEl = document.getElementById('error-cause')
      return {
        indexSize: f?.index?.byId?.size ?? null,
        roots: f?.index?.roots?.size ?? null,
        relays: f?.pool?.debugCounts ? f.pool.debugCounts() : null,
        heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
        sheetOpen: sheetEl ? !document.getElementById('error-sheet').hidden : null,
        sheetCode: sheetEl?.textContent ?? null,
        sheetCause: causeEl ? causeEl.textContent.slice(0, 160) : null,
        xss: ['__xss', '__xss2', '__xss3', '__xss4', '__xss5'].map((k) => window[k] ?? 0),
        maxLag: Math.round(window.__hb?.max ?? 0),
        mode: f?._mode ? undefined : (f.__mode ? f.__mode() : null),
      }
    })
  } catch {
    return null // page dead
  }
}

function fmt(r, r0) {
  const parts = []
  if (r.crash) parts.push('CRASH')
  if (r.xss.some(Boolean)) parts.push('XSS!')
  if (r.pageErrors.length) parts.push(`pageerror x${r.pageErrors.length}`)
  if (r.consoleErrors.length) parts.push(`console x${r.consoleErrors.length}`)
  if (r.maxLag > 1000) parts.push(`freeze ${r.maxLag}ms`)
  if (r0 && r.indexSize > r0.indexSize + 50) parts.push(`index ${r0.indexSize}->${r.indexSize}`)
  if (r0 && r.heap && r.heap > r0.heap + 64) parts.push(`heap +${r.heap - r0.heap}MiB`)
  if (r.sheetOpen) parts.push(`sheet ${r.sheetCode}`)
  return parts.join(' | ') || 'benign'
}

async function runAttack(browser, name) {
  const pageErrors = []
  const consoleErrors = []
  const { page, booted } = await bootPage(browser, pageErrors, consoleErrors)
  const r = { name, crash: false, pageErrors, consoleErrors, maxLag: 0, xss: [], sheetOpen: false, sheetCode: null }
  if (!booted) {
    console.log(`\n=== ${name} ===  (app did NOT boot: ${pageErrors[0] || consoleErrors[0] || 'timeout'})`)
    await page.close().catch(() => {})
    r.maxLag = -1
    return r
  }
  const before = await snap(page)
  const fired = await fire(name)
  if (fired.includes('error') || fired.includes('unknown attack')) {
    console.log(`\n=== ${name} ===  CONTROL FAILED: ${fired}`)
    await page.close().catch(() => {})
    return r
  }
  let dead = false
  const crashP = new Promise((resolve) => {
    page.on('crash', () => resolve(true))
    page.on('close', () => resolve(page.isClosed()))
  })
  const window = WINDOW[name] ?? 12000
  const t0 = Date.now()
  let lastLag = 0
  while (Date.now() - t0 < window) {
    const done = await Promise.race([crashP, sleep(1000)])
    if (done) { r.crash = true; break }
    const s = await snap(page)
    if (!s) { r.crash = true; dead = true; break }
    lastLag = Math.max(lastLag, s.maxLag)
    r.xss = s.xss
    r.sheetOpen = s.sheetOpen
    r.sheetCode = s.sheetCode
    r.after = s
    if (s.sheetOpen && s.sheetCode === 'E102') { /* keep watching; other models may follow */ }
    await sleep(0)
  }
  const after = r.after || (await snap(page)) || {}
  r.maxLag = lastLag
  r.before = before
  r.after = after
  console.log(`\n=== ${name} ===`)
  console.log(`    impact:  ${fmt(r, before)}`)
  console.log(`    before:  index=${before.indexSize} roots=${before.roots} heap=${before.heap}MiB`)
  if (after.indexSize !== undefined) {
    const rc = after.relays ? JSON.stringify(after.relays) : '-'
    console.log(`    after:   index=${after.indexSize} roots=${after.roots} heap=${after.heap}MiB relays=${rc} sheet=${after.sheetCode ?? '-'}`)
  }
  for (const e of [...pageErrors.slice(0, 3)]) console.log(`    pageerror: ${e}`)
  for (const e of [...consoleErrors.slice(0, 3)]) console.log(`    console:   ${e}`)
  if (r.xss.some(Boolean)) console.log(`    XSS MARKERS: ${JSON.stringify(r.xss)}`)
  if (after.sheetOpen) console.log(`    sheet:     ${after.sheetCode} — ${after.sheetCause ?? ''}`)
  await page.close().catch(() => {})
  void dead
  return r
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--ignore-certificate-errors'],
})
console.log(`hostile audit: ${ATTACKS.length} attacks, target ${TARGET}\n`)
for (const name of ATTACKS) {
  await runAttack(browser, name)
}
await browser.close()
console.log('\n=== done ===')
