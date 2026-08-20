// Browser guard: opening a reply tree with the 3D cube toggle OFF must not
// freeze the tab. Direct-3D used to parse every in-view GLB into the map
// (and fit() puts the whole tree in view). This asserts:
//   * the page stays responsive during open (evaluate round-trips)
//   * Direct3DPool stays empty
//   * getPoster is not fired for every node on open
import { chromium } from 'playwright'

const URL = process.env.TARGET_URL || 'http://localhost:4173/'
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_PATH || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message.slice(0, 200)))

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForFunction(() => window.__form0?.board, { timeout: 30000 })
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await page.waitForFunction(() => window.__form0.index.byId.size >= 20, { timeout: 30000 })

// Cube toggle OFF (the freeze was 2D open after Direct-3D shipped).
await page.evaluate(() => window.__form0.settings.set({ direct3D: false }))

await page.waitForFunction(() => {
  const f = window.__form0
  return [...f.index.byId.values()].some((m) => m.role === 'root' && !m.tombstoned && f.index.childCount(m.eventId) > 0)
}, { timeout: 30000 }).catch(() => {})

const rootId = await page.evaluate(() => {
  const f = window.__form0
  const roots = [...f.index.byId.values()].filter((m) => m.role === 'root' && !m.tombstoned)
  const withKids = roots.filter((m) => f.index.childCount(m.eventId) > 0)
    .sort((a, b) => f.index.childCount(b.eventId) - f.index.childCount(a.eventId))
  const pick = withKids[0] ?? roots[0]
  return pick ? { id: pick.eventId, kids: f.index.childCount(pick.eventId), events: f.index.byId.size } : null
})
check('found a thread root', !!rootId?.id, JSON.stringify(rootId))
const openId = rootId?.id
if (!openId) {
  await browser.close()
  process.exit(fails.length ? 1 : 0)
}

await page.evaluate(() => {
  const a = window.__form0.assets
  window.__posterCalls = 0
  const orig = a.getPoster.bind(a)
  a.getPoster = (m) => { window.__posterCalls++; return orig(m) }
  window.__modelCalls = 0
  const origB = a.getModelBytesByPostId.bind(a)
  a.getModelBytesByPostId = (id) => { window.__modelCalls++; return origB(id) }
})

const t0 = Date.now()
await page.evaluate((id) => { location.hash = '#/thread/' + id }, openId)

// Heartbeat: if open() freezes the main thread, these evaluates stall.
const beats = []
for (let i = 0; i < 8; i++) {
  const s = Date.now()
  const ok = await page.evaluate(() => Date.now()).then(() => true).catch(() => false)
  beats.push({ ms: Date.now() - s, ok })
  await page.waitForTimeout(80)
}

await page.waitForFunction(
  () => window.__form0.engine.activeScene === window.__form0.threadView.scene
    && window.__form0.threadView.nodes.size >= 1,
  { timeout: 15000 },
).catch(() => {})

const openMs = Date.now() - t0
const snap = await page.evaluate(() => {
  const tv = window.__form0.threadView
  const nodes = [...tv.nodes.values()]
  return {
    nodes: nodes.length,
    posters: nodes.filter((n) => n.poster).length,
    spinners: nodes.filter((n) => n.spinner.isEnabled()).length,
    live3d: [...(tv.pool3d?.byPost?.keys?.() ?? [])].length,
    loading3d: tv.pool3d?.loading?.size ?? 0,
    threeD: tv.threeD,
    posterCalls: window.__posterCalls ?? -1,
    modelCalls: window.__modelCalls ?? -1,
    zoom: +tv.zoom.toFixed(3),
    animating: tv.isAnimating(),
  }
})

const slowBeats = beats.filter((b) => !b.ok || b.ms > 1500)
check('2D cube toggle is off', snap.threeD === false, JSON.stringify(snap.threeD))
check('thread map built', snap.nodes >= 1, `nodes=${snap.nodes} kids=${rootId?.kids}`)
check('Direct3DPool empty on 2D open', snap.live3d === 0 && snap.loading3d === 0,
  `live=${snap.live3d} loading=${snap.loading3d}`)
check('getPoster trickle (not a storm)', snap.posterCalls >= 0 && snap.posterCalls <= Math.max(2, snap.nodes),
  `calls=${snap.posterCalls} nodes=${snap.nodes}`)
check('open stayed responsive (no >1.5s main-thread stall)', slowBeats.length === 0,
  JSON.stringify(beats))
check('open finished in under 8s', openMs < 8000, `openMs=${openMs} zoom=${snap.zoom}`)
check('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '))

await browser.close()
console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL CHECKS PASSED')
process.exit(fails.length ? 1 : 0)
