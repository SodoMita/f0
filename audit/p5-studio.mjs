// Phase 5 — studio: open, import a GLB via the file input, paint strokes,
// undo/redo, text tool, publish flow (export review), cancel, keyboard.
import { launch, newRecorder, open, URL_BASE, sleep } from './harness.mjs'
import { readFileSync } from 'node:fs'

const browser = await launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true })
const rec = newRecorder(page, 'p5')
const F = []
const f = (id, text) => { F.push(`${id}: ${text}`); console.log(`  FINDING ${id}: ${text}`) }

await open(page, URL_BASE)
await page.evaluate(() => document.querySelector('#btn-legend-ok')?.click())
await sleep(1200)

// open studio via + button
await page.evaluate(() => document.getElementById('btn-add')?.click())
await sleep(2000)
const st0 = await page.evaluate(() => ({ hash: location.hash, mode: window.__form0.__mode(), status: (document.getElementById('studio-status')?.textContent || '').slice(0, 60) }))
console.log('studio open:', JSON.stringify(st0))
await rec.shot('01-studio-empty')

// import a GLB from the rig server via fetch -> File -> DataTransfer
const imported = await page.evaluate(async () => {
  const resp = await fetch('https://localhost:8443/models/a.glb')
  const buf = await resp.arrayBuffer()
  const file = new File([buf], 'a.glb', { type: 'model/gltf-binary' })
  const dt = new DataTransfer()
  dt.items.add(file)
  const input = document.getElementById('file-input')
  input.files = dt.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return { size: buf.byteLength }
})
console.log('imported bytes:', JSON.stringify(imported))
await sleep(5000)
const st1 = await page.evaluate(() => ({
  filename: (document.getElementById('studio-filename')?.textContent || '').slice(0, 40),
  status: (document.getElementById('studio-status')?.textContent || '').slice(0, 80),
  infoRows: document.querySelectorAll('#mi-rows *').length,
  publishVisible: !document.getElementById('btn-studio-publish')?.closest('[hidden]') && (document.getElementById('btn-studio-publish')?.offsetHeight || 0) > 0,
}))
console.log('after import:', JSON.stringify(st1))
await rec.shot('02-after-import')

// paint: drag on the canvas (brush tool is default)
const cv = await page.evaluate(() => { const c = document.getElementById('engine'); const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
await page.mouse.move(cv.x + cv.w / 2 - 100, cv.y + cv.h / 2)
await page.mouse.down()
await page.mouse.move(cv.x + cv.w / 2 + 120, cv.y + cv.h / 2 + 40, { steps: 25 })
await page.mouse.up()
await sleep(1500)
const paintState = await page.evaluate(() => ({
  budget: (document.getElementById('paint-budget')?.textContent || '').slice(0, 40),
  undoEnabled: !document.getElementById('paint-undo')?.disabled,
}))
console.log('after stroke:', JSON.stringify(paintState))
await rec.shot('03-after-stroke')
if (/^0 stamps/.test(paintState.budget)) f('P5-1', `brush drag produced no stamps ("${paintState.budget}") — stroke may have missed the model`)

// undo / redo
await page.evaluate(() => document.getElementById('paint-undo')?.click())
await sleep(900)
const afterUndo = await page.evaluate(() => (document.getElementById('paint-budget')?.textContent || '').slice(0, 40))
console.log('after undo:', afterUndo)
await page.evaluate(() => document.getElementById('paint-redo')?.click())
await sleep(900)
const afterRedo = await page.evaluate(() => (document.getElementById('paint-budget')?.textContent || '').slice(0, 40))
console.log('after redo:', afterRedo)
if (afterUndo === afterRedo) f('P5-2', `undo/redo produce identical state (${afterUndo})`)

// text tool
await page.evaluate(() => { const t = document.getElementById('studio-text'); t.value = 'HELLO FORM'; t.dispatchEvent(new Event('input', { bubbles: true })) })
await sleep(2500)
const textState = await page.evaluate(() => ({
  budget: (document.getElementById('text-budget')?.textContent || '').slice(0, 40),
  status: (document.getElementById('studio-status')?.textContent || '').slice(0, 80),
}))
console.log('after text:', JSON.stringify(textState))
await rec.shot('04-after-text')

// camera tool roundtrip: FOV numeric
await page.evaluate(() => { const el = document.getElementById('cam-fov'); if (el) { el.value = '120'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })) } })
await sleep(800)

// publish flow
await page.evaluate(() => document.getElementById('btn-studio-publish')?.click())
await sleep(1500)
const pub0 = await page.evaluate(() => ({
  publishing: window.__form0.isPublishing(),
  reviewVisible: (() => { const e = document.getElementById('export-review'); return e ? getComputedStyle(e).display : 'absent' })(),
  state: (document.getElementById('export-state')?.textContent || '').slice(0, 60),
}))
console.log('publish clicked:', JSON.stringify(pub0))
await rec.shot('05-publish-review')
await sleep(5000)
const pub1 = await page.evaluate(() => ({
  publishing: window.__form0.isPublishing(),
  state: (document.getElementById('export-state')?.textContent || '').slice(0, 80),
  summary: (document.getElementById('export-summary')?.textContent || '').slice(0, 100),
  dim: JSON.stringify(window.__form0.previewDim?.()),
}))
console.log('publish settled:', JSON.stringify(pub1))
await rec.shot('06-publish-settled')

// cancel the publish
await page.evaluate(() => window.__form0.cancelPublish?.())
await sleep(1200)
const pub2 = await page.evaluate(() => ({ publishing: window.__form0.isPublishing() }))
console.log('after cancel:', JSON.stringify(pub2))

// W/E/R transform keys + Escape behavior in studio
await page.keyboard.press('w')
await sleep(300)
const xform = await page.evaluate(() => [...document.querySelectorAll('[data-xform]')].filter((b) => b.classList.contains('active')).map((b) => b.dataset.xform))
console.log('xform after w:', JSON.stringify(xform))
// typing in the textarea must NOT trigger hotkeys
await page.evaluate(() => { const t = document.getElementById('studio-text'); t.focus(); t.select() })
await page.keyboard.press('w')
await sleep(300)
const xform2 = await page.evaluate(() => [...document.querySelectorAll('[data-xform]')].filter((b) => b.classList.contains('active')).map((b) => b.dataset.xform))
console.log('xform after w in textarea:', JSON.stringify(xform2))
if (JSON.stringify(xform) !== JSON.stringify(xform2) && xform2.length && xform2[0] !== (xform[0] ?? null)) f('P5-3', `typing 'w' in the studio textarea changed transform mode (${JSON.stringify(xform)} -> ${JSON.stringify(xform2)})`)

console.log(`\n=== PHASE5 FINDINGS (${F.length}) ===`)
F.forEach((x, i) => console.log(`${i + 1}. ${x}`))
await browser.close()
