// Phase 5b — studio with proper waits: paint on a LOADED model, mirrored text
// probe, card preview state, filename display, real publish.
import { launch, newRecorder, open, URL_BASE, sleep } from './harness.mjs'

const browser = await launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true })
const rec = newRecorder(page, 'p5b')
const F = []
const f = (id, text) => { F.push(`${id}: ${text}`); console.log(`  FINDING ${id}: ${text}`) }

await open(page, URL_BASE)
await page.evaluate(() => document.querySelector('#btn-legend-ok')?.click())
await sleep(1000)
await page.evaluate(() => document.getElementById('btn-add')?.click())
await sleep(1500)

await page.evaluate(async () => {
  const resp = await fetch('https://localhost:8443/models/a.glb')
  const buf = await resp.arrayBuffer()
  const file = new File([buf], 'a.glb', { type: 'model/gltf-binary' })
  const dt = new DataTransfer()
  dt.items.add(file)
  const input = document.getElementById('file-input')
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
})
// poll until the model actually shows in the studio scene
let loaded = false
for (let i = 0; i < 20; i++) {
  await sleep(500)
  loaded = await page.evaluate(() => {
    const s = window.__form0.studio?.scene
    return !!s && s.meshes.filter((m) => m.isEnabled() && m.name && !/gizmo|helper|plane|camera/i.test(m.name)).length > 0
  })
  if (loaded) break
}
console.log('model loaded:', loaded)
const fn = await page.evaluate(() => ({
  filename: (document.getElementById('studio-filename')?.textContent || '').trim(),
  status: (document.getElementById('studio-status')?.textContent || '').trim().slice(0, 60),
}))
console.log('filename after load:', JSON.stringify(fn))
if (!fn.filename) f('P5b-1', 'studio filename stays empty after a successful import')
await rec.shot('01-model-loaded')

// paint across the model center
const cv = await page.evaluate(() => { const c = document.getElementById('engine'); const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
const cx = cv.x + cv.w * 0.45, cy = cv.y + cv.h * 0.5
await page.mouse.move(cx - 120, cy)
await page.mouse.down()
for (let i = 0; i <= 20; i++) await page.mouse.move(cx - 120 + i * 12, cy + Math.sin(i / 3) * 30, { steps: 2 })
await page.mouse.up()
await sleep(1500)
const paint = await page.evaluate(() => (document.getElementById('paint-budget')?.textContent || '').slice(0, 50))
console.log('paint after stroke on loaded model:', paint)
if (/^0 stamps/.test(paint)) f('P5b-2', `brush drag over the visible model produced 0 stamps ("${paint}")`)
await rec.shot('02-painted')

const stamps1 = paint
await page.evaluate(() => document.getElementById('paint-undo')?.click())
await sleep(800)
const stamps2 = await page.evaluate(() => (document.getElementById('paint-budget')?.textContent || '').slice(0, 30))
await page.evaluate(() => document.getElementById('paint-redo')?.click())
await sleep(800)
const stamps3 = await page.evaluate(() => (document.getElementById('paint-budget')?.textContent || '').slice(0, 30))
console.log('undo/redo:', JSON.stringify({ stamps1, stamps2, stamps3 }))
if (stamps2 === stamps1) f('P5b-3', `undo did not change stamp count (${stamps1} -> ${stamps2})`)

// switch to text tool and probe mirroring
await page.evaluate(() => { const t = document.getElementById('studio-text'); t.focus() })
await page.type('#studio-text', 'ABC', { delay: 30 })
await sleep(3000)
await rec.shot('03-text-abc')
// sample: does the text read mirrored? compare a screenshot of the center.
const tris = await page.evaluate(() => (document.getElementById('text-budget')?.textContent || '').slice(0, 40))
console.log('text budget:', tris)
if (/0 tris/.test(tris)) f('P5b-4', `text tool reports 0 triangles for real text ("${tris}") — budget readout dead`)

// card preview state
const prev = await page.evaluate(() => {
  const c = document.getElementById('studio-preview-canvas')
  const gl = c?.getContext('webgl2') || c?.getContext('webgl')
  return { hasCanvas: !!c, w: c?.width, h: c?.height }
})
console.log('preview canvas:', JSON.stringify(prev))
await rec.shot('04-preview-state')

// REALLY publish (rig blossom on 8443 should accept)
await page.evaluate(() => document.getElementById('btn-studio-publish')?.click())
await sleep(2500)
const pubRun = await page.evaluate(() => ({
  publishing: window.__form0.isPublishing(),
  state: (document.getElementById('export-state')?.textContent || '').slice(0, 80),
}))
console.log('publish running:', JSON.stringify(pubRun))
await rec.shot('05-publishing')
// wait for terminal state up to 30s
for (let i = 0; i < 15; i++) {
  await sleep(2000)
  const s = await page.evaluate(() => ({ publishing: window.__form0.isPublishing(), state: (document.getElementById('export-state')?.textContent || '').slice(0, 100) }))
  if (!s.publishing) { console.log('publish terminal:', JSON.stringify(s)); break }
  if (i === 14) { console.log('publish STILL RUNNING after 30s:', JSON.stringify(s)); f('P5b-5', 'publish never reached a terminal state in 30s') }
}
await rec.shot('06-publish-done')
const finalHash = await page.evaluate(() => ({ hash: location.hash, mode: window.__form0.__mode() }))
console.log('after publish:', JSON.stringify(finalHash))

console.log(`\n=== PHASE5b FINDINGS (${F.length}) ===`)
F.forEach((x, i) => console.log(`${i + 1}. ${x}`))
await browser.close()
