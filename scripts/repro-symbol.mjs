// Browser round trip for the studio symbol library (AMENDMENT 68):
//   standalone or web build -> studio -> symbols tab -> place cube + smile ->
//   assert tinted material (text-like emissive tint), NOT black -> tint
//   change re-tints live -> delete removes the piece -> upload-as-mesh
//   imports the same GLB through the normal import path (the user's repro
//   for the CSP-blocked Draco decoder).
//
// Needs a browser — playwright's chromium (`npx playwright install chromium`),
// or the @sparticuz fallback; scripts/browser.mjs picks (see
// docs/SANDBOX-VERIFY.md, 2026-08-20 section). The standalone must exist
// first: `npm run build:standalone`, or point TARGET_URL at a running
// dev/preview server. This check was the guard that caught the WEB_CSP
// `data:` connect-src gap (library GLBs are inlined as data: URIs in both
// builds).
import { launchFormBrowser } from './browser.mjs'

const URL = process.env.TARGET_URL || 'file:///home/user/f0/form-zero-standalone.html'
const GLB = process.argv[2] || '/home/user/f0/src/studio/library/glb/cube.glb'

const browser = await launchFormBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const logs = []
const bad = []
page.on('console', (m) => { if (m.type() === 'error') logs.push(`[console.err] ${m.text().slice(0, 300)}`) })
page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e.message).slice(0, 300)}`))
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url().slice(0, 100)} :: ${(r.failure() || {}).errorText}`))
page.on('request', (r) => { if (/cdn\.babylonjs\.com|unpkg|jsdelivr/.test(r.url())) bad.push(r.url()) })

const ok = (name, cond, extra = '') => console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => window.__form0 && window.__form0.studio, null, { timeout: 60000 }).catch(() => {})
await page.waitForTimeout(3000)
ok('boot', await page.evaluate(() => !!window.__form0?.studio))
// first-run legend is modal by design; dismiss it like a user would
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await page.waitForTimeout(500)

await page.evaluate(() => { window.__form0.router?.go?.({ name: 'studio' }) })
await page.waitForTimeout(1200)
ok('studio visible', await page.evaluate(() => !document.getElementById('studio')?.hidden))

await page.click('button[data-tab="symbols"]')
await page.waitForTimeout(400)
ok('symbol grid rendered', await page.evaluate(() => !!document.querySelector('#symbol-grid button[data-symbol="cube"]')))

// The symbols tab now defaults to a NEUTRAL pick (AMENDMENT 86): library
// pieces carry their own palette texture, so white shows the art as authored
// and a coloured pick still tints it (checked below with #22AA66 / #8866FF).
const accent = '#FFFFFF'
const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const want = hex2rgb(accent).map((c) => c / 255)
const isTint = (arr, target = want) => !!arr && arr.length >= 3 && arr.every((v, i) => Math.abs(v - target[i]) < 0.02)

// place the cube
await page.click('#symbol-grid button[data-symbol="cube"]')
await page.waitForTimeout(2500)
const cube = await page.evaluate(() => {
  const s = window.__form0.studio
  const mesh = s.scene.meshes.find((m) => m.name === 'cube')
  if (!mesh || !mesh.material) return null
  const m = mesh.material
  return {
    count: s.libraryCount,
    hasVertexAlpha: mesh.hasVertexAlpha,
    useVertexColors: mesh.useVertexColors,
    albedo: m.albedoColor?.asArray?.(),
    emissive: m.emissiveColor?.asArray?.(),
    backFaceCulling: m.backFaceCulling,
    hasAlbedoTexture: !!m.albedoTexture,
  }
})
ok('cube placed', cube?.count === 1 && !!cube?.albedo, JSON.stringify(cube))
ok('cube vertex colors on (modulate, not replace)', cube?.useVertexColors === true && cube?.hasVertexAlpha === false)
ok('cube albedo = picker color (white = palette as authored)', isTint(cube?.albedo), JSON.stringify(cube?.albedo))
ok('cube emissive black (albedo/palette drives)', !!cube?.emissive && cube.emissive.slice(0, 3).every((v) => v < 0.02), JSON.stringify(cube?.emissive))
ok('cube has the palette texture bound', cube?.hasAlbedoTexture === true, JSON.stringify(cube?.hasAlbedoTexture))
ok('cube double-sided', cube?.backFaceCulling === false)

// live tint change
const newAccent = '#22AA66'
await page.evaluate((v) => {
  const input = document.getElementById('studio-color')
  input.value = v
  input.dispatchEvent(new Event('input'))
}, newAccent)
await page.waitForTimeout(800)
// The cube is still selected after placement, so the picker change repaints
// ONLY the cube (per-item colors, AMENDMENT 68 corrected 2026-08-21) via
// albedo — emissive stays black.
const retint = await page.evaluate(() => {
  const s = window.__form0.studio
  const mesh = s.scene.meshes.find((m) => m.name === 'cube')
  return mesh?.material?.albedoColor?.asArray?.() ?? null
})
ok('color change re-tints selected symbol live', isTint(retint, hex2rgb(newAccent).map((c) => c / 255)), JSON.stringify(retint))

// place smile too, then delete the cube
await page.click('#symbol-grid button[data-symbol="smile"]')
await page.waitForTimeout(2500)
const two = await page.evaluate(() => window.__form0.studio.libraryCount)
ok('smile placed (2 pieces)', two === 2, `count=${two}`)

// Per-item colors: the smile is selected after placement, so the next picker
// change repaints ONLY the smile; the cube keeps its own color (AMENDMENT 68
// corrected 2026-08-21).
const third = '#8866FF'
await page.evaluate((v) => {
  const input = document.getElementById('studio-color')
  input.value = v
  input.dispatchEvent(new Event('input'))
}, third)
await page.waitForTimeout(800)
const perItem = await page.evaluate(() => {
  const s = window.__form0.studio
  const cube = s.scene.meshes.find((m) => m.name === 'cube')
  const smile = s.scene.meshes.find((m) => m.name === 'smile')
  return {
    cube: cube?.material?.albedoColor?.asArray?.(),
    smile: smile?.material?.albedoColor?.asArray?.(),
  }
})
ok('per-item colors: smile repainted, cube keeps its own',
  isTint(perItem.smile, hex2rgb(third).map((c) => c / 255)) &&
  isTint(perItem.cube, hex2rgb(newAccent).map((c) => c / 255)),
  JSON.stringify(perItem))

await page.evaluate(() => {
  const s = window.__form0.studio
  const mesh = s.scene.meshes.find((m) => m.name === 'cube')
  if (mesh) s.select(mesh)
  s.deleteSelection()
})
await page.waitForTimeout(800)
const one = await page.evaluate(() => window.__form0.studio.libraryCount)
ok('delete removes the piece', one === 1, `count=${one}`)

await page.screenshot({ path: '/tmp/symbols-after-fix.png' })

// the user's exact repro: upload the library GLB as a mesh through the
// import tab (same Draco decode path, but surfaced as import errors)
await page.click('button[data-tab="upload"]')
await page.waitForTimeout(300)
const chooser = page.waitForEvent('filechooser', { timeout: 10000 })
await page.click('#btn-studio-import')
const fc = await chooser
await fc.setFiles(GLB)
await page.waitForTimeout(4000)
const imported = await page.evaluate(() => {
  const s = window.__form0.studio
  const status = document.getElementById('studio-status')?.textContent ?? ''
  return { hasModel: s?.hasModel() ?? false, status }
})
ok('upload-as-mesh imports the Draco GLB', imported.hasModel, `status=${imported.status}`)
const cspBlocked = logs.filter((l) => /Content Security Policy|unsafe-inline|wasm-unsafe-eval|Refused to/.test(l))
ok('no CSP violation on decode', cspBlocked.length === 0, cspBlocked[0] ?? '')
ok('no CDN requests', bad.length === 0, bad[0] ?? '')

console.log('--- console errors (tail) ---')
for (const l of logs.slice(-15)) console.log(l)
await browser.close()
