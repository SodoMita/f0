// Guard (SPEC AMENDMENT 79): page zoom / DPI changes must not stretch or
// soften 3D content, and the resolution policy must never render a buffer
// whose aspect disagrees with the box it is displayed in.
//
// Two independent failure modes are asserted:
//
//  1. STRETCH — non-uniform scaling. Measured from the ACTIVE CAMERA's
//     projection matrix against the canvas CSS box: pixels-per-world-unit on
//     X must equal pixels-per-world-unit on Y. m00*cssW == m11*cssH.
//     (A frozen ortho frustum or a buffer/CSS aspect mismatch both show up
//     here, which is the point — this is what the eye actually sees.)
//
//  2. SOFTNESS — the drawing buffer must track devicePixelRatio. Zooming in
//     used to keep the buffer at the ratio sampled at boot, so the browser
//     upscaled a too-small frame over the new CSS box until a reload.
//
// Run: node scripts/zoom.mjs   (needs the offline rig or a dev server)
import { launchFormBrowser } from './browser.mjs'

const URL = process.env.TARGET_URL || 'http://localhost:4173/'
const browser = await launchFormBrowser(true)
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const cdp = await page.context().newCDPSession(page)
const errs = []
page.on('pageerror', (e) => errs.push(e.message.slice(0, 200)))

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForFunction(() => window.__form0?.engine, { timeout: 30000 })
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await page.waitForFunction(() => window.__form0.board.rows.length > 0, { timeout: 30000 })
await page.waitForTimeout(600)
// Pin the adaptive controller: under swiftshader every frame is slow, so it
// walks the ratio down to its 0.7 floor and the sharpness assertion below
// would measure the software renderer instead of the resize path.
await page.evaluate(() => window.__form0.settings.set({ adaptiveResolution: false }))
await page.waitForTimeout(400)

/** Everything the two assertions need, straight from the live engine. */
const sample = () => page.evaluate(() => {
  const f = window.__form0
  const e = f.engine.engine
  const c = e.getRenderingCanvas()
  const cam = f.engine.activeScene.activeCamera
  const m = cam ? cam.getProjectionMatrix(true).m : null
  const cssW = c.clientWidth
  const cssH = c.clientHeight
  return {
    cssW, cssH,
    bufW: e.getRenderWidth(),
    bufH: e.getRenderHeight(),
    dpr: window.devicePixelRatio || 1,
    // CSS px per world unit along each axis
    pxX: m ? Math.abs(m[0] * cssW) / 2 : 0,
    pxY: m ? Math.abs(m[5] * cssH) / 2 : 0,
  }
})

const aniso = (s) => (s.pxY > 0 ? s.pxX / s.pxY : 0)

/** FormEngine.budgetedRatio, mirrored so the guard is independent of it. */
const MAX_PIXELS = 2_600_000
const expectedRatio = (s) => {
  const dpr = Math.max(1, Math.min(s.dpr, 2))
  const wanted = s.cssW * s.cssH * dpr * dpr
  return wanted > MAX_PIXELS ? Math.max(0.75, dpr * Math.sqrt(MAX_PIXELS / wanted)) : dpr
}
const fmt = (s) => `css=${s.cssW}x${s.cssH} buf=${s.bufW}x${s.bufH} dpr=${s.dpr} aniso=${aniso(s).toFixed(4)}`

const setZoom = async (z) => {
  if (z === 1) await cdp.send('Emulation.clearDeviceMetricsOverride')
  else await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: Math.round(1280 / z), height: Math.round(800 / z), deviceScaleFactor: z, mobile: false,
  })
  // Wait for the engine to actually settle on the new ratio rather than
  // guessing at a delay (resize -> applyResolution -> viewport notify).
  await page.waitForFunction(() => {
    const e = window.__form0.engine.engine
    const c = e.getRenderingCanvas()
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2))
    const wanted = c.clientWidth * c.clientHeight * dpr * dpr
    const ratio = wanted > 2_600_000 ? Math.max(0.75, dpr * Math.sqrt(2_600_000 / wanted)) : dpr
    return Math.abs(e.getRenderWidth() - c.clientWidth * ratio) <= Math.max(2, c.clientWidth * ratio * 0.02)
  }, { timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(250)
}
const go = async (hash, waitMs = 900) => { await page.evaluate((h) => { location.hash = h }, hash); await page.waitForTimeout(waitMs) }

// --------------------------------------------------------------- 1. zoom
// Every view, every zoom level: square must stay square, buffer must follow
// the device pixel ratio (that is what keeps the picture sharp).
const ZOOMS = [1, 1.25, 1.5, 2, 3, 0.67]
const views = [
  ['board', '#/'],
  ['studio', '#/studio'],
]
const threadRoot = await page.evaluate(() => {
  const rows = window.__form0.board.rows
  const withReplies = rows.find((r) => r.replyCount > 0) || rows[0]
  return withReplies?.meta?.eventId ?? null
})
if (threadRoot) views.push(['thread', `#/thread/${threadRoot}`])

for (const [name, hash] of views) {
  await go(hash)
  for (const z of ZOOMS) {
    await setZoom(z)
    const s = await sample()
    check(`${name} @ ${Math.round(z * 100)}% is not stretched`, Math.abs(aniso(s) - 1) < 0.01, fmt(s))
    // Sharpness: the buffer must be sized for the CURRENT device ratio, not
    // the one sampled at boot. Mirror the engine's own budget (ratio is
    // clamped to [1, 2] and then to MAX_PIXELS = 2.6 Mpx).
    const want = s.cssW * expectedRatio(s)
    check(`${name} @ ${Math.round(z * 100)}% renders at the device ratio`,
      Math.abs(s.bufW - want) <= Math.max(2, want * 0.02), `bufW=${s.bufW} want~${Math.round(want)}`)
  }
  await setZoom(1)
}

// ------------------------------------------------- 2. studio ortho + resize
// An orthographic frustum caches its bounds; Babylon does NOT re-derive them
// from the engine like it does for perspective. The studio has to do it.
await go('#/studio')
await page.evaluate(() => window.__form0.studio.setCameraState({ projection: 'ortho' }))
await page.waitForTimeout(500)
for (const [w, h] of [[1280, 800], [1000, 700], [700, 900], [1400, 600]]) {
  await page.setViewportSize({ width: w, height: h })
  await page.waitForTimeout(700)
  const s = await sample()
  check(`studio ortho follows a ${w}x${h} window`, Math.abs(aniso(s) - 1) < 0.01, fmt(s))
}
// leaving and re-entering must not resurrect a stale frustum
await go('#/')
await page.setViewportSize({ width: 900, height: 1000 })
await page.waitForTimeout(600)
await go('#/studio')
{
  const s = await sample()
  check('studio ortho re-entered at a new size', Math.abs(aniso(s) - 1) < 0.01, fmt(s))
}
await page.setViewportSize({ width: 1280, height: 800 })
await page.waitForTimeout(600)

// ------------------------------------------------------ 3. manual resolution
// aspectLock OFF renders an arbitrary buffer aspect. The canvas element is
// letterboxed to match it — it must never be stretched to fill the window.
await go('#/')
await page.evaluate(() => window.__form0.settings.set({ adaptiveResolution: false }))
await page.evaluate(() => window.__form0.settings.set({
  resolutionMode: 'manual', aspectLock: false, resolutionWidth: 1920, resolutionHeight: 1080,
}))
await page.waitForTimeout(700)
{
  const s = await sample()
  check('manual buffer is not stretched', Math.abs(aniso(s) - 1) < 0.01, fmt(s))
  check('manual buffer aspect matches its CSS box',
    Math.abs((s.bufW / s.bufH) - (s.cssW / s.cssH)) < 0.02,
    `buf=${(s.bufW / s.bufH).toFixed(3)} css=${(s.cssW / s.cssH).toFixed(3)}`)
  check('manual resolution still sets the drawing buffer', s.bufW === 1920 && s.bufH === 1080, `${s.bufW}x${s.bufH}`)
}
// ...and it survives a window resize into a very different aspect
await page.setViewportSize({ width: 800, height: 1000 })
await page.waitForTimeout(700)
{
  const s = await sample()
  check('manual buffer is not stretched after a resize', Math.abs(aniso(s) - 1) < 0.01, fmt(s))
}
// aspectLock ON fills the window again (no bars)
await page.evaluate(() => window.__form0.settings.set({ aspectLock: true }))
await page.waitForTimeout(700)
{
  const s = await sample()
  check('aspect-locked manual fills the window', s.cssW === 800 && s.cssH === 1000, `css=${s.cssW}x${s.cssH}`)
  check('aspect-locked manual is not stretched', Math.abs(aniso(s) - 1) < 0.01, fmt(s))
}
await page.evaluate(() => window.__form0.settings.set({ resolutionMode: 'auto', adaptiveResolution: true }))
await page.waitForTimeout(500)
await page.setViewportSize({ width: 1280, height: 800 })
await page.waitForTimeout(600)
{
  const s = await sample()
  check('back to auto: canvas fills the window again', s.cssW === 1280 && s.cssH === 800, `css=${s.cssW}x${s.cssH}`)
}

check('no page errors', errs.length === 0, errs.join(' | '))

await browser.close()
if (fails.length) {
  console.log(`\nFAILURES: ${fails.join(', ')}`)
  process.exit(1)
}
console.log('\nALL CHECKS PASSED')
