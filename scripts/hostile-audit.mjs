// Security audit harness: drives the app against the HOSTILE rig
// (scripts/hostile-rig.mjs) and measures the impact of each attack.
//
//   node scripts/hostile-audit.mjs [attack ...]   (default: all, in order)
//
// Per attack (fresh page each time):
//   * boot the app against the hostile relay
//   * fire the attack via POST /__attack?name=<id>
//   * observe and record:
//       crash / renderer death      (Playwright crash + page close)
//       main-thread freeze          (max gap + TOTAL blocked time)
//       uncaught exceptions         (pageerror)
//       console errors              (filtered)
//       XSS markers                 (window.__xss*)
//       error sheet state           (code + cause)
//       model outcome (glb attacks) (downloaded? poster rendered?)
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
      'huge-msg', 'flood', 'reply-storm',
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
  'glb-oob': 15000, 'glb-nan': 15000, 'glb-chain': 15000,
  'glb-draco': 15000, 'glb-audio-trunc': 15000, 'glb-texforge': 15000, 'glb-tex19': 25000,
  'huge-msg': 20000, 'flood': 30000, 'reply-storm': 30000,
  'glb-animmax': 25000, 'glb-audio-big': 25000, 'reconnect-flood': 25000,
  'many-urls': 60000,
  'blossom-eviljson': 15000, 'blossom-evilurl': 15000,
  'glb-bomb': 45000,
}
const GLB_ATTACKS = new Set(['glb-oob', 'glb-nan', 'glb-chain', 'glb-draco', 'glb-audio-trunc', 'glb-texforge', 'glb-tex19', 'glb-animmax', 'glb-audio-big', 'glb-bomb'])
const BLOSSOM_ATTACKS = new Set(['blossom-eviljson', 'blossom-evilurl'])
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

async function slowHits() {
  return await new Promise((resolve) => {
    const req = httpRequest('http://localhost:9173/__attacks', (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => { try { resolve(JSON.parse(b).slowHits ?? 0) } catch { resolve(0) } })
    })
    req.on('error', () => resolve(0))
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
    window.__hb = { last: performance.now(), max: 0, total: 0, ticks: 0 }
    setInterval(() => {
      const now = performance.now()
      const gap = now - window.__hb.last
      if (gap > 250) {
        const excess = gap - 200
        window.__hb.max = Math.max(window.__hb.max, excess)
        window.__hb.total += excess
      }
      window.__hb.ticks++
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
      const sheetOpen = !document.getElementById('error-sheet').hidden
      return {
        indexSize: f?.index?.byId?.size ?? null,
        roots: f?.index?.roots?.size ?? null,
        relays: f?.pool?.debugCounts ? f.pool.debugCounts() : null,
        heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
        sheetOpen,
        sheetCode: sheetOpen ? sheetEl?.textContent : null,
        sheetCause: sheetOpen ? (causeEl?.textContent || '').slice(0, 160) : null,
        xss: ['__xss', '__xss2', '__xss3', '__xss4', '__xss5'].map((k) => window[k] ?? 0),
        hb: { max: Math.round(window.__hb?.max ?? 0), total: Math.round(window.__hb?.total ?? 0) },
      }
    })
  } catch {
    return null // page dead
  }
}

/** For GLB attacks: what happened to the hostile model (last indexed post)? */
async function probeModel(page) {
  try {
    return await page.evaluate(async () => {
      const f = window.__form0
      const metas = [...(f.index.byId.values() ?? [])]
      if (!metas.length) return null
      const m = metas[metas.length - 1]
      let downloaded = false
      try {
        const bytes = await Promise.race([
          f.assets.getModelBytesByPostId(m.eventId),
          new Promise((r) => setTimeout(() => r(undefined), 20000)),
        ])
        downloaded = !!bytes
      } catch { downloaded = false }
      const poster = !!f.assets.peekPoster(m)
      return {
        id: m.eventId.slice(0, 8),
        filename: m.filename,
        hashFailed: !!m.hashFailed,
        downloaded,
        posterRendered: poster,
      }
    })
  } catch { return null }
}

/** For blossom attacks: drive a real upload against the hostile server. */
async function driveUpload(page) {
  try {
    return await page.evaluate(async () => {
      const f = window.__form0
      f.blossoms.setServers(['https://localhost:9443'])
      const blob = new Blob([new Uint8Array(1024)], { type: 'model/gltf-binary' })
      const secret = new Uint8Array(32).fill(7)
      const t0 = performance.now()
      try {
        const out = await f.blossoms.upload(blob, secret)
        return { ok: true, ms: Math.round(performance.now() - t0), urls: out.map((u) => ({ urlLen: u.url.length, sha: u.sha256.slice(0, 8) })) }
      } catch (e) {
        return { ok: false, ms: Math.round(performance.now() - t0), err: String(e).slice(0, 200) }
      }
    })
  } catch (e) {
    return { ok: false, err: 'evaluate failed: ' + String(e).slice(0, 120) }
  }
}

function fmt(r, r0) {
  const parts = []
  if (r.crash) parts.push('CRASH')
  if (r.xss.some(Boolean)) parts.push('XSS!')
  if (r.pageErrors.length) parts.push(`pageerror x${r.pageErrors.length}`)
  if (r.consoleErrors.length) parts.push(`console x${r.consoleErrors.length}`)
  if (r.maxLag > 1000) parts.push(`freeze-max ${r.maxLag}ms`)
  if (r.blockedTotal > 3000) parts.push(`freeze-total ${r.blockedTotal}ms`)
  if (r0 && r.indexSize > r0.indexSize + 50) parts.push(`index ${r0.indexSize}->${r.indexSize}`)
  if (r0 && r.heap && r.heap > r0.heap + 64) parts.push(`heap +${r.heap - r0.heap}MiB`)
  if (r.sheetOpen) parts.push(`sheet ${r.sheetCode}`)
  return parts.join(' | ') || 'benign'
}

async function runAttack(browser, name) {
  const pageErrors = []
  const consoleErrors = []
  const { page, booted } = await bootPage(browser, pageErrors, consoleErrors)
  const r = { name, crash: false, pageErrors, consoleErrors, maxLag: 0, blockedTotal: 0, xss: [], sheetOpen: false, sheetCode: null }
  if (!booted) {
    console.log(`\n=== ${name} ===  (app did NOT boot: ${pageErrors[0] || consoleErrors[0] || 'timeout'})`)
    await page.close().catch(() => {})
    r.maxLag = -1
    return r
  }
  const before = await snap(page)
  const slowBefore = name === 'many-urls' ? await slowHits() : 0
  const fired = await fire(name)
  if (fired.includes('error') || fired.includes('unknown attack')) {
    console.log(`\n=== ${name} ===  CONTROL FAILED: ${fired}`)
    await page.close().catch(() => {})
    return r
  }
  if (BLOSSOM_ATTACKS.has(name)) {
    r.upload = await driveUpload(page)
  }
  let dead = false
  const crashP = new Promise((resolve) => {
    page.on('crash', () => resolve(true))
    page.on('close', () => resolve(page.isClosed()))
  })
  const window = WINDOW[name] ?? 12000
  const t0 = Date.now()
  let lastLag = 0, lastTotal = 0
  while (Date.now() - t0 < window) {
    const done = await Promise.race([crashP, sleep(1000)])
    if (done) { r.crash = true; break }
    const s = await snap(page)
    if (!s) { r.crash = true; dead = true; break }
    lastLag = Math.max(lastLag, s.hb.max)
    lastTotal = Math.max(lastTotal, s.hb.total)
    r.xss = s.xss
    r.sheetOpen = s.sheetOpen
    r.sheetCode = s.sheetCode
    r.after = s
    await sleep(0)
  }
  const after = r.after || (await snap(page)) || {}
  r.maxLag = lastLag
  r.blockedTotal = lastTotal
  r.before = before
  r.after = after
  if (GLB_ATTACKS.has(name)) r.model = await probeModel(page)
  if (name === 'many-urls') r.slowHits = (await slowHits()) - slowBefore
  console.log(`\n=== ${name} ===`)
  console.log(`    impact:  ${fmt(r, before)}`)
  console.log(`    before:  index=${before.indexSize} roots=${before.roots} heap=${before.heap}MiB`)
  if (after.indexSize !== undefined) {
    const rc = after.relays ? JSON.stringify(after.relays) : '-'
    console.log(`    after:   index=${after.indexSize} roots=${after.roots} heap=${after.heap}MiB relays=${rc} sheet=${after.sheetCode ?? '-'}`)
  }
  if (r.model) {
    const m = r.model
    console.log(`    model:   ${m.filename} hashFailed=${m.hashFailed} downloaded=${m.downloaded} poster=${m.posterRendered}`)
  }
  if (r.upload) console.log(`    upload:  ${JSON.stringify(r.upload)}`)
  if (r.slowHits !== undefined) console.log(`    slowHits: ${r.slowHits} replica attempts (400 slow urls queued)`)
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
