// Interaction verification: thread pan / wheel-zoom / pinch-zoom, board tap.
// These are the regressions reported by hand ("pan moves constantly", "no
// pinch"), so they get an automated check that fails loudly.
import { chromium } from 'playwright'

const URL = process.env.TARGET_URL || 'http://localhost:5173/'
const WAIT = Number(process.env.WAIT_MS || 20000)

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true })
const errs = []
page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)))

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForFunction(() => window.__form0?.board, null, { timeout: 15000 }).catch(() => {})

// first-run legend is modal by design; dismiss it like a user would
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await page.waitForTimeout(WAIT)

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

// ---------------------------------------------------------------- thread
const rootId = await page.evaluate(() => {
  const f = window.__form0
  const roots = [...f.index.byId.values()].filter((m) => m.role === 'root' && !m.tombstoned)
  return roots.find((m) => f.index.childCount(m.eventId) > 0)?.eventId ?? roots[0]?.eventId ?? null
})
if (!rootId) {
  console.log('no thread root available — relays returned nothing')
} else {
  await page.evaluate((id) => { location.hash = '#/thread/' + id }, rootId)
  await page.waitForTimeout(2500)

  const state = () => page.evaluate(() => {
    const t = window.__form0.threadView
    return { x: +t.panX.toFixed(3), y: +t.panY.toFixed(3), z: +t.zoom.toFixed(4) }
  })

  // --- drag = pan, once, by roughly the dragged distance -----------------
  const a = await state()
  await page.mouse.move(640, 400)
  await page.mouse.down()
  for (let i = 1; i <= 10; i++) { await page.mouse.move(640 + i * 12, 400 + i * 6); await page.waitForTimeout(16) }
  const b = await state()
  const dx = b.x - a.x
  const dy = b.y - a.y
  // 120 px right / 60 px down at the current zoom
  const upx = await page.evaluate(() => (2 * 20 * window.__form0.threadView.zoom) / 800)
  check('thread drag pans by the dragged distance',
    Math.abs(dx + 120 * upx) < 1.2 && Math.abs(dy - 60 * upx) < 1.2,
    `dx=${dx.toFixed(2)} expected=${(-120 * upx).toFixed(2)} dy=${dy.toFixed(2)} expected=${(60 * upx).toFixed(2)}`)

  // --- holding still must NOT keep moving (the reported bug) -------------
  await page.waitForTimeout(700)
  const c = await state()
  check('thread does not drift while the pointer is held still',
    Math.abs(c.x - b.x) < 1e-6 && Math.abs(c.y - b.y) < 1e-6, `drift=${(c.x - b.x).toFixed(4)},${(c.y - b.y).toFixed(4)}`)
  await page.mouse.up()
  await page.waitForTimeout(300)
  const d = await state()
  check('thread does not drift after release',
    Math.abs(d.x - c.x) < 1e-6 && Math.abs(d.y - c.y) < 1e-6)

  // --- wheel zooms about the cursor --------------------------------------
  const worldUnder = () => page.evaluate(() => {
    const t = window.__form0.threadView
    const asp = 1280 / 800
    const fx = (400 / 1280) * 2 - 1
    const fy = 1 - (300 / 800) * 2
    return { x: t.panX + fx * 20 * t.zoom * asp, y: t.panY + fy * 20 * t.zoom }
  })
  await page.mouse.move(400, 300)
  const wBefore = await worldUnder()
  const zBefore = (await state()).z
  await page.mouse.wheel(0, -600)
  await page.waitForTimeout(200)
  const wAfter = await worldUnder()
  const zAfter = (await state()).z
  check('wheel zooms in', zAfter < zBefore * 0.95, `${zBefore} -> ${zAfter}`)
  check('wheel zoom keeps the point under the cursor',
    Math.abs(wAfter.x - wBefore.x) < 0.4 && Math.abs(wAfter.y - wBefore.y) < 0.4,
    `drift=${(wAfter.x - wBefore.x).toFixed(3)},${(wAfter.y - wBefore.y).toFixed(3)}`)

  // --- pinch (two real touch points via CDP) -----------------------------
  const cdp = await page.context().newCDPSession(page)
  const touch = async (type, pts) => {
    await cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: pts.map((p, i) => ({ x: p[0], y: p[1], id: i, radiusX: 4, radiusY: 4, force: 1 })),
    })
    await page.waitForTimeout(24)
  }
  await page.evaluate(() => window.__form0.threadView.fit())
  await page.waitForTimeout(150)
  const zPinch0 = (await state()).z
  await touch('touchStart', [[540, 400], [740, 400]])
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[540 - i * 10, 400], [740 + i * 10, 400]])
  await touch('touchEnd', [])
  await page.waitForTimeout(200)
  const zPinch1 = (await state()).z
  check('pinch out zooms in', zPinch1 < zPinch0 * 0.9, `${zPinch0} -> ${zPinch1}`)

  await page.evaluate(() => window.__form0.threadView.fit())
  await page.waitForTimeout(150)
  const zPinch2Start = (await state()).z
  await touch('touchStart', [[460, 400], [820, 400]])
  for (let i = 1; i <= 8; i++) await touch('touchMove', [[460 + i * 16, 400], [820 - i * 16, 400]])
  await touch('touchEnd', [])
  await page.waitForTimeout(200)
  const zPinch3 = (await state()).z
  check('pinch in zooms out', zPinch3 > zPinch2Start * 1.1, `${zPinch2Start} -> ${zPinch3}`)

  // --- tap a node opens the viewer ---------------------------------------
  await page.evaluate((id) => { location.hash = '#/thread/' + id }, rootId)
  await page.waitForTimeout(1200)
  await page.evaluate(() => window.__form0.threadView.fit())
  const nodePt = await page.evaluate(() => {
    const t = window.__form0.threadView
    const n = [...t.nodes.values()][0]
    const asp = 1280 / 800
    const px = ((n.x - t.panX) / (20 * t.zoom * asp) + 1) / 2 * 1280
    const py = (1 - (n.y - t.panY) / (20 * t.zoom)) / 2 * 800
    return { x: px, y: py }
  })
  await page.mouse.move(nodePt.x, nodePt.y)
  await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up()
  await page.waitForTimeout(1500)
  const hash = await page.evaluate(() => location.hash)
  check('tap on a thread node opens the viewer', hash.startsWith('#/viewer/'), hash)
}

// -------------------------------------------------- viewer: one model only
// Regression: load() awaited the GLB parse AFTER clear(), so racing
// navigations (fast next/next/next) added several containers to the single
// model scene and left the earlier ones undisposed.
await page.evaluate(() => { location.hash = '#/' })
await page.waitForTimeout(1000)
const firstPos = await page.evaluate(() => window.__form0.board.screenPosOf(0))
if (firstPos) {
  await page.mouse.click(firstPos.x, firstPos.y)
  await page.waitForTimeout(800)
  // hammer prev/next while models are still downloading/parsing
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => document.getElementById('btn-next').click())
    await page.waitForTimeout(180)
  }
  await page.evaluate(() => document.getElementById('btn-prev').click())
  await page.waitForTimeout(9000)
  const v = await page.evaluate(() => ({
    inScene: window.__form0.viewer.sceneModelMeshCount(),
    ofContainer: window.__form0.viewer.stats().meshes,
    cameras: window.__form0.viewer.scene.cameras.length,
  }))
  check('exactly one model is present after rapid switching',
    v.inScene === v.ofContainer, `scene=${v.inScene} container=${v.ofContainer}`)
  check('no stale cameras accumulate', v.cameras <= 1 + (await page.evaluate(() => window.__form0.viewer.cameraCount)),
    `cameras=${v.cameras}`)
}

// ------------------------------------------------------- loading indicator
await page.evaluate(() => { location.hash = '#/' })
await page.waitForTimeout(800)
const pos2 = await page.evaluate(() => window.__form0.board.screenPosOf(1))
if (pos2) {
  // deterministic: make the viewer's byte fetch slow so the ring must be
  // observable even when the blob is already cached. (The viewer calls
  // getModelBytes, not getModel — delaying the wrong one left the check
  // dependent on cache state.)
  await page.evaluate(() => {
    const a = window.__form0.assets
    const orig = a.getModelBytes.bind(a)
    window.__restoreGetModelBytes = () => { a.getModelBytes = orig }
    a.getModelBytes = (m) => new Promise((res) => setTimeout(() => res(orig(m)), 1500))
  })
  await page.mouse.click(pos2.x, pos2.y)
  const shown = await page.waitForFunction(
    () => !document.getElementById('loading').hidden &&
          document.querySelector('#loading .ring') !== null, null, { timeout: 4000 })
    .then(() => true).catch(() => false)
  check('loading ring appears while a model loads', shown)
  const spins = await page.evaluate(() => {
    const el = document.querySelector('#loading .ring')
    const st = getComputedStyle(el)
    return { dots: el.querySelectorAll('circle').length, anim: st.animationName, dur: st.animationDuration }
  })
  check('ring is 12 animated dots', spins.dots === 12 && spins.anim === 'ring-spin' && parseFloat(spins.dur) > 0,
    JSON.stringify(spins))
  const hidden = await page.waitForFunction(() => document.getElementById('loading').hidden, null, { timeout: 30000 })
    .then(() => true).catch(() => false)
  check('loading ring disappears when the model is ready', hidden)
  await page.evaluate(() => window.__restoreGetModelBytes?.())
}

// ---------------------------------------------------------------- board
await page.evaluate(() => { location.hash = '#/' })
await page.waitForTimeout(1200)
const pos = await page.evaluate(() => window.__form0.board.screenPosOf(0))
if (pos) {
  await page.mouse.move(pos.x, pos.y)
  await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up()
  await page.waitForTimeout(1500)
  const h = await page.evaluate(() => location.hash)
  check('tap on card 0 opens the viewer', h.startsWith('#/viewer/'), h)
}

check('no page errors', errs.length === 0, errs.join(' | '))
await browser.close()
if (fails.length) { console.log('\nFAILURES:', fails.join(', ')); process.exit(1) }
console.log('\nall interaction checks passed')
