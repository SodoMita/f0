// Phase 4 — settings panel: open/close, search, toggles, persistence,
// numeric input garbage, presets, background swatches.
import { launch, newRecorder, open, URL_BASE, sleep } from './harness.mjs'

const browser = await launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const rec = newRecorder(page, 'p4')
const F = []
const f = (id, text) => { F.push(`${id}: ${text}`); console.log(`  FINDING ${id}: ${text}`) }

await open(page, URL_BASE)
await page.evaluate(() => document.querySelector('#btn-legend-ok')?.click())
await sleep(1500)

await page.evaluate(() => document.getElementById('btn-settings')?.click())
await sleep(900)
await rec.shot('01-settings-open')
const panel = await page.evaluate(() => {
  const p = document.getElementById('settings-panel')
  const cs = getComputedStyle(p)
  return { display: cs.display, rows: p.querySelectorAll('label, .row, [class*=row]').length, inputs: p.querySelectorAll('input, select, button').length }
})
console.log('panel:', JSON.stringify(panel))

// keyboard: while panel open, press ArrowRight — should NOT move anything (typing guard only for inputs)
// but also: does the panel trap focus / close on Escape?
await page.keyboard.press('Escape')
await sleep(600)
const closedByEsc = await page.evaluate(() => getComputedStyle(document.getElementById('settings-panel')).display)
console.log('after Escape:', closedByEsc)
if (closedByEsc !== 'none') f('P4-1', `settings panel does not close on Escape (display=${closedByEsc})`)

// reopen
await page.evaluate(() => document.getElementById('btn-settings')?.click())
await sleep(600)

// search "bloom"
await page.evaluate(() => { const s = document.getElementById('settings-search'); s.focus(); })
await page.type('#settings-search', 'bloom', { delay: 20 })
await sleep(700)
const searchRes = await page.evaluate(() => {
  const p = document.getElementById('settings-panel')
  const rows = [...p.querySelectorAll('label, .row, [class*=row]')]
  const visible = rows.filter((r) => (r.offsetWidth || r.offsetHeight))
  return { visibleRows: visible.length, texts: visible.map((r) => (r.textContent || '').trim().slice(0, 40)).slice(0, 10) }
})
console.log('search bloom:', JSON.stringify(searchRes))
await rec.shot('02-search-bloom')
if (searchRes.visibleRows === 0) f('P4-2', 'settings search "bloom" shows zero rows')

// clear search, set MSAA to 4x, toggle FXAA — then RELOAD and check persistence
await page.evaluate(() => { const s = document.getElementById('settings-search'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })) })
await sleep(500)
const msaa = await page.evaluate(() => {
  const el = document.getElementById('set-msaa')
  if (!el) return null
  return { tag: el.tagName, value: el.value, opts: el.tagName === 'SELECT' ? [...el.options].map((o) => o.value) : null }
})
console.log('msaa control:', JSON.stringify(msaa))
if (msaa && msaa.tag === 'SELECT') {
  await page.evaluate(() => { const el = document.getElementById('set-msaa'); el.value = '4'; el.dispatchEvent(new Event('change', { bubbles: true })) })
  await sleep(500)
}
await page.evaluate(() => { const el = document.getElementById('set-fxaa'); if (el && !el.checked) el.click() })
await sleep(400)
const beforeReload = await page.evaluate(() => ({ msaa: document.getElementById('set-msaa')?.value, fxaa: document.getElementById('set-fxaa')?.checked }))
console.log('before reload:', JSON.stringify(beforeReload))
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__form0?.board, null, { timeout: 20000 }).catch(() => {})
await sleep(2500)
await page.evaluate(() => document.querySelector('#btn-legend-ok')?.click())
await sleep(800)
const afterReload = await page.evaluate(() => ({ msaa: document.getElementById('set-msaa')?.value, fxaa: document.getElementById('set-fxaa')?.checked, legendShown: getComputedStyle(document.getElementById('legend')).display !== 'none' }))
console.log('after reload:', JSON.stringify(afterReload))
if (beforeReload.msaa !== afterReload.msaa || beforeReload.fxaa !== afterReload.fxaa) f('P4-3', `settings did not persist across reload: before=${JSON.stringify(beforeReload)} after=${JSON.stringify(afterReload)}`)
if (!afterReload.legendShown) f('P4-4', 'legend did NOT reappear is fine — but check: this run had it dismissed once; expected persistent dismissal (info only)')

// numeric garbage into a numeric field: render scale = "abc", then 99999
await page.evaluate(() => document.getElementById('btn-settings')?.click())
await sleep(600)
const garbage = await page.evaluate(() => {
  const el = document.getElementById('set-renderScale')
  if (!el) return null
  el.focus()
  el.value = 'abc'
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  const v1 = el.value
  el.value = '99999'
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { v1, v2: el.value, engineScale: window.__form0.engine?.getRenderWidth?.() ?? null }
})
console.log('renderScale garbage:', JSON.stringify(garbage))
await sleep(800)
const rw = await page.evaluate(() => ({ w: window.__form0.engine.getRenderWidth(), h: window.__form0.engine.getRenderHeight() }))
console.log('engine render size after 99999:', JSON.stringify(rw))
if (rw.w > 20000) f('P4-5', `renderScale=99999 drives a ${rw.w}px render buffer — no clamp, potential GPU crash`)
await rec.shot('03-after-garbage')

// near clip 0 / far clip 0.00001 — degenerate camera
const clip = await page.evaluate(() => {
  const n = document.getElementById('set-nearClip'), fr = document.getElementById('set-farClip')
  if (!n || !fr) return null
  n.value = '0'; n.dispatchEvent(new Event('change', { bubbles: true }))
  fr.value = '0.00001'; fr.dispatchEvent(new Event('change', { bubbles: true }))
  return { near: n.value, far: fr.value }
})
await sleep(800)
await rec.shot('04-degenerate-clip')
console.log('clip garbage:', JSON.stringify(clip))
await page.evaluate(() => document.getElementById('btn-settings-close')?.click())
await sleep(400)
// open viewer to see if scene is broken
await page.evaluate(() => { const roots = [...window.__form0.index.byId.values()].filter(m => m.role === 'root' && !m.tombstoned); location.hash = '#/viewer/' + roots[0].eventId })
await sleep(3500)
await rec.shot('05-viewer-after-clip-garbage')

// preset switch
await page.evaluate(() => document.getElementById('btn-settings')?.click())
await sleep(500)
const preset = await page.evaluate(() => {
  const el = document.getElementById('set-preset')
  return el ? { tag: el.tagName, value: el.value, opts: el.tagName === 'SELECT' ? [...el.options].map((o) => o.value) : null } : null
})
console.log('preset control:', JSON.stringify(preset))
if (preset?.opts) {
  await page.evaluate(() => { const el = document.getElementById('set-preset'); el.value = 'low'; el.dispatchEvent(new Event('change', { bubbles: true })) })
  await sleep(900)
  await rec.shot('06-preset-low')
  const afterLow = await page.evaluate(() => ({ msaa: document.getElementById('set-msaa')?.value, preset: document.getElementById('set-preset')?.value }))
  console.log('after Low preset:', JSON.stringify(afterLow))
}

console.log(`\n=== PHASE4 FINDINGS (${F.length}) ===`)
F.forEach((x, i) => console.log(`${i + 1}. ${x}`))
await browser.close()
