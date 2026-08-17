// Shader-compilation probe: does the SAME model recompile its shaders every
// time it is loaded (poster -> preview -> viewer -> viewer again)?
//
// Babylon caches compiled programs per engine, keyed by "vertex+fragment@defines",
// but `Effect.dispose()` deletes the cache entry when the last material using it
// goes away — which is exactly what our poster renderer, preview pool and viewer
// do after every load.
import { chromium } from 'playwright'

const URL = process.env.TARGET_URL || 'http://localhost:5173/'
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 160)))
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForFunction(() => window.__form0?.board, null, { timeout: 30000 }).catch(() => {})
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})

await page.evaluate(() => {
  const eng = window.__form0.engine.engine
  const s = { programs: 0, effects: 0, cacheHits: 0, compileMs: 0 }
  window.__sh = s
  const origProgram = eng.createShaderProgram.bind(eng)
  eng.createShaderProgram = (...a) => {
    const t = performance.now()
    const r = origProgram(...a)
    s.programs++
    s.compileMs += performance.now() - t
    return r
  }
  const origEffect = eng.createEffect.bind(eng)
  eng.createEffect = (...a) => {
    const before = Object.keys(eng._compiledEffects).length
    const r = origEffect(...a)
    const after = Object.keys(eng._compiledEffects).length
    if (after > before) s.effects++
    else s.cacheHits++
    return r
  }
  window.__shSnap = () => ({ ...s, cached: Object.keys(eng._compiledEffects).length })
})

await page.waitForTimeout(24000)
const snap = async (label) => {
  const v = await page.evaluate(() => window.__shSnap())
  console.log(label.padEnd(34), JSON.stringify(v))
  return v
}
await snap('after feed + posters')

const ids = await page.evaluate(() => [...window.__form0.index.byId.values()]
  .filter((m) => m.role === 'root' && !m.tombstoned).slice(0, 2).map((m) => m.eventId))
if (ids.length) {
  for (let round = 1; round <= 3; round++) {
    const before = await page.evaluate(() => window.__shSnap())
    await page.evaluate((id) => { location.hash = '#/viewer/' + id }, ids[0])
    await page.waitForFunction(() => window.__form0.viewer.stats().meshes > 0, null, { timeout: 30000 }).catch(() => {})
    await page.waitForTimeout(2500)
    await page.evaluate(() => { location.hash = '#/' })
    await page.waitForTimeout(1500)
    const after = await page.evaluate(() => window.__shSnap())
    console.log(`open model A (round ${round})`.padEnd(34),
      `programs +${after.programs - before.programs}  newEffects +${after.effects - before.effects}` +
      `  cacheHits +${after.cacheHits - before.cacheHits}  compile +${(after.compileMs - before.compileMs).toFixed(0)}ms`)
  }
}
const end = await snap('end')
console.log('\nTOTAL GL program compiles:', end.programs, 'in', end.compileMs.toFixed(0), 'ms')
await browser.close()
