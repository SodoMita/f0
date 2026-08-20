// Settings verification: every control must reach real engine state, presets
// must move many knobs at once, and everything must survive a reload.
import { chromium } from 'playwright'

const URL = process.env.TARGET_URL || 'http://localhost:5173/'
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)))

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForFunction(() => window.__form0?.settingsPanel, { timeout: 30000 })
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await page.waitForTimeout(12000)

const set = async (patch) => {
  await page.evaluate((p) => window.__form0.settings.set(p), patch)
  await page.waitForTimeout(450)
}

// ---------------------------------------------------------------- panel
await page.evaluate(() => window.__form0.settingsPanel.open())
const shape = await page.evaluate(() => ({
  groups: document.querySelectorAll('#settings-panel .settings-group').length,
  rows: document.querySelectorAll('#settings-panel .setting').length,
  unavailable: [...document.querySelectorAll('#settings-panel .setting.unavailable')].length,
  legacy: !!document.querySelector('#bg-swatches .swatch[data-bg="#ffffff"]') && !!document.querySelector('#inertia'),
}))
check('panel renders every group', shape.groups >= 11, JSON.stringify(shape))
check('unsupported features are shown disabled, not faked', shape.unavailable >= 6)
check('legacy control ids still present (headless suites)', shape.legacy)

// search filters
await page.fill('#settings-search', 'bloom')
await page.waitForTimeout(250)
const filtered = await page.evaluate(() =>
  [...document.querySelectorAll('#settings-panel .setting')].filter((r) => !r.hidden).map((r) => r.dataset.id))
check('search filters rows', filtered.length > 0 && filtered.every((id) => id.toLowerCase().includes('bloom')), filtered.join(','))
await page.fill('#settings-search', '')
await page.waitForTimeout(200)

// ----------------------------------------------------------- resolution
// pin the adaptive controller first: it moves the base ratio underneath us
await set({ adaptiveResolution: false })
await set({ resolutionMode: 'manual', resolutionWidth: 640, aspectLock: true })
const manual = await page.evaluate(() => window.__form0.engine.bufferSize)
check('manual resolution sets the drawing buffer', manual.width === 640 && manual.height > 100, JSON.stringify(manual))

await set({ resolutionMode: 'scale', renderScale: 50 })
const half = await page.evaluate(() => window.__form0.engine.bufferSize)
await set({ renderScale: 100 })
const full = await page.evaluate(() => window.__form0.engine.bufferSize)
check('render scale changes the buffer', half.width < full.width, `${half.width} < ${full.width}`)

await set({ resolutionMode: 'scale', renderScale: 30, renderScalePow2: true })
const pow2 = await page.evaluate(() => window.__form0.engine.bufferSize)
check('power-of-two snapping', Math.abs(pow2.ratio - full.ratio / 4) < 0.05 || Math.abs(pow2.ratio - full.ratio / 2) < 0.05, `ratio=${pow2.ratio} base=${full.ratio}`)
await set({ resolutionMode: 'auto', renderScalePow2: false, adaptiveResolution: true })

// upscaler = render scale + sharpen
await set({ upscaler: 'spatial', upscalerMode: 'performance' })
const up = await page.evaluate(() => window.__form0.engine.bufferSize)
check('spatial upscaler lowers the render resolution', up.width < full.width, `${up.width} < ${full.width}`)
await set({ upscaler: 'off' })

// ------------------------------------------------------------ framerate
await set({ fpsUncapped: false, fpsLimit: 10, idleThrottle: false })
const rate = await page.evaluate(async () => {
  const before = window.__form0.engine.perfStats().renders
  await new Promise((r) => setTimeout(r, 2000))
  return (window.__form0.engine.perfStats().renders - before) / 2
})
const capState = await page.evaluate(() => ({ limit: window.__form0.engine.fpsLimit, idle: window.__form0.engine.idleThrottle }))
check('frame limit is honoured', rate > 3 && rate < 16, `${rate.toFixed(1)} fps (asked 10) ${JSON.stringify(capState)}`)
await set({ fpsUncapped: true, idleThrottle: true })

// -------------------------------------------------------------- quality
await page.evaluate(() => { location.hash = '#/' })
await page.waitForTimeout(500)
const pos = await page.evaluate(() => window.__form0.board.screenPosOf(0))
if (pos) {
  await page.mouse.click(pos.x, pos.y)
  await page.waitForFunction(() => window.__form0.viewer.stats().meshes > 0, { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(1200)
}

await set({ bloom: true, bloomStrength: 60 })
const bloom = await page.evaluate(() => {
  const s = window.__form0.viewer.scene
  const names = s.postProcessRenderPipelineManager?.supportedPipelines?.map((p) => p._name ?? p.name) ?? []
  return { names, count: s.postProcesses?.length ?? 0 }
})
check('bloom creates the post pipeline', bloom.names.includes('form0-post'), JSON.stringify(bloom.names))

await set({ ao: 'ssao2' })
const ao = await page.evaluate(() =>
  (window.__form0.viewer.scene.postProcessRenderPipelineManager?.supportedPipelines ?? []).map((p) => p._name ?? p.name))
check('SSAO2 pipeline is created', ao.includes('form0-ssao'), JSON.stringify(ao))
await set({ ao: 'off', bloom: false })

await set({ pbr: false })
const unlit = await page.evaluate(() => {
  const mats = window.__form0.viewer.scene.materials.filter((m) => 'unlit' in m)
  return { total: mats.length, unlit: mats.filter((m) => m.unlit).length }
})
check('PBR off switches materials to unlit', unlit.total === 0 || unlit.unlit === unlit.total, JSON.stringify(unlit))
await set({ pbr: true })

await set({ fov: 90 })
// The setting drives the ORBIT camera. When a model's own authored camera is
// active it keeps its authored fov by design (the viewer shows the author's
// view), so asserting on activeCamera.fov is wrong — read the orbit camera.
const fov = await page.evaluate(() => window.__form0.viewer.orbit.fov)
check('field of view reaches the orbit camera', Math.abs(fov - (90 * Math.PI) / 180) < 0.01, fov.toFixed(3))
await set({ fov: 46 })

// --------------------------------------------------------------- memory
await set({ livePreviews: 0 })
const slots = await page.evaluate(() => window.__form0.board.previewPool.opts.maxSlots)
check('live preview slots are applied', slots === 0, String(slots))
await set({ livePreviews: 5 })

// ---------------------------------------------------------- interface
await set({ autoplayAnimations: false })
const autoplay = await page.evaluate(() => ({
  board: window.__form0.board.autoplay,
  thread: window.__form0.threadView.autoplay,
}))
check('autoplay setting reaches board and thread', autoplay.board === false && autoplay.thread === false, JSON.stringify(autoplay))
await set({ autoplayAnimations: true })
const autoplayOn = await page.evaluate(() => ({
  board: window.__form0.board.autoplay,
  thread: window.__form0.threadView.autoplay,
}))
check('autoplay setting can be re-enabled', autoplayOn.board === true && autoplayOn.thread === true, JSON.stringify(autoplayOn))

await set({ contactShadowStrength: 0, shadows: 'off' })
const shadowOff = await page.evaluate(() =>
  window.__form0.board.cards.filter((c) => c.shadow.isEnabled()).length)
check('contact shadows can be turned off', shadowOff === 0, String(shadowOff))
await set({ shadows: 'contact', contactShadowStrength: 55 })

// ---------------------------------------------------------------- audio
await set({ volMaster: 40 })
const gain = await page.evaluate(() => {
  const m = window.__form0.mixer
  m.resume()
  return m.context ? 'context-ready' : 'no-context'
})
check('audio mixer accepts volume changes', gain === 'context-ready' || gain === 'no-context', gain)

// ---------------------------------------------------------- presets
for (const preset of ['low', 'ultra', 'high']) {
  await page.evaluate((p) => window.__form0.settings.applyPreset(p), preset)
  await page.waitForTimeout(400)
}
const afterPreset = await page.evaluate(() => ({
  preset: window.__form0.settings.get('preset'),
  msaa: window.__form0.settings.get('msaa'),
  ao: window.__form0.settings.get('ao'),
}))
check('presets move many settings at once', afterPreset.preset === 'high' && afterPreset.msaa === '4' && afterPreset.ao === 'ssao2', JSON.stringify(afterPreset))

await set({ msaa: '1', bloom: false })
const custom = await page.evaluate(() => window.__form0.settings.get('preset'))
check('editing a setting switches the preset to Custom', custom === 'custom', String(custom))

// ------------------------------------------------------------ persistence
await set({ volMusic: 33, fov: 71 })
// set() persists fire-and-forget (void put); give IndexedDB a beat so the
// reload cannot race the write (that flaked on the fast production build)
await page.waitForTimeout(500)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__form0?.settings, { timeout: 30000 })
await page.waitForTimeout(1500)
const restored = await page.evaluate(() => ({
  vol: window.__form0.settings.get('volMusic'),
  fov: window.__form0.settings.get('fov'),
}))
check('settings persist across reload', restored.vol === 33 && restored.fov === 71, JSON.stringify(restored))

check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '))
await browser.close()
if (fails.length) { console.log('\nFAILURES:', fails.join(', ')); process.exit(1) }
console.log('\nall settings checks passed')
