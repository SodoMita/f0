// Phase 3 — thread map: fit/pan/zoom, connectors, node taps, reply badge,
// camera dot #2 (green view), deep links, 3D board toggle, shuffle.
import { launch, newRecorder, open, URL_BASE, sleep } from './harness.mjs'

const browser = await launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true })
const rec = newRecorder(page, 'p3')
const F = []
const f = (id, text) => { F.push(`${id}: ${text}`); console.log(`  FINDING ${id}: ${text}`) }

await open(page, URL_BASE)
await page.evaluate(() => document.querySelector('#btn-legend-ok')?.click())
await sleep(2000)

// ---------------- camera dot #2 on flavor d should be the GREEN view
const ids = await page.evaluate(() => {
  const roots = [...window.__form0.index.byId.values()].filter((m) => m.role === 'root' && !m.tombstoned)
  roots.sort((a, b) => (a.event?.created_at ?? 0) - (b.event?.created_at ?? 0))
  return roots.map((m) => m.eventId)
})
await page.evaluate((id) => { location.hash = '#/viewer/' + id }, ids[3])
await sleep(3500)
await page.keyboard.press('c') // cam 1 -> 2
await sleep(1200)
await rec.shot('01-cam2-view')
const px = await page.evaluate(() => {
  const c = document.getElementById('engine')
  const gl = c.getContext('experimental-webgl2') || c.getContext('webgl2')
  // read center pixel via a 1x1 draw is not trivial; instead sample via toDataURL
  const cv = document.createElement('canvas')
  cv.width = 8; cv.height = 8
  return null
})
// sample average color of the center region via screenshot clip is easier — do it outside

// ---------------- thread of root #1 (has the reply tree)
await page.evaluate((id) => { location.hash = '#/thread/' + id }, ids[0])
await sleep(3500)
await rec.shot('02-thread-initial')
const t0 = await page.evaluate(() => {
  const t = window.__form0.threadView
  return { x: +t.panX.toFixed(1), y: +t.panY.toFixed(1), z: +t.zoom.toFixed(3), zoomShown: document.getElementById('thread-zoom')?.textContent }
})
console.log('thread initial:', JSON.stringify(t0))

// wheel zoom about center
await page.mouse.move(640, 400)
await page.mouse.wheel(0, -400)
await sleep(800)
const t1 = await page.evaluate(() => {
  const t = window.__form0.threadView
  return { z: +t.zoom.toFixed(3), zoomShown: document.getElementById('thread-zoom')?.textContent }
})
console.log('after wheel-up zoom:', JSON.stringify(t1))
if (t1.z <= t0.z) f('P3-1', `wheel-up did not zoom in (zoom ${t0.z} -> ${t1.z})`)
const shownConsistent = t1.zoomShown !== '' && t1.zoomShown != null
if (!shownConsistent) f('P3-2', `thread zoom readout empty: "${t1.zoomShown}"`)

// drag pan
await page.mouse.move(640, 400)
await page.mouse.down()
await page.mouse.move(760, 460, { steps: 10 })
await page.mouse.up()
await sleep(800)
const t2 = await page.evaluate(() => {
  const t = window.__form0.threadView
  return { x: +t.panX.toFixed(1), y: +t.panY.toFixed(1) }
})
console.log('after drag:', JSON.stringify(t2))
if (Math.abs(t2.x - t0.x) < 5 && Math.abs(t2.y - t0.y) < 5) f('P3-3', `thread drag pan did not move (${JSON.stringify(t0)} -> ${JSON.stringify(t2)})`)

// keyboard 0 = fit
await page.keyboard.press('0')
await sleep(900)
const t3 = await page.evaluate(() => {
  const t = window.__form0.threadView
  return { x: +t.panX.toFixed(1), y: +t.panY.toFixed(1), z: +t.zoom.toFixed(3) }
})
console.log('after 0-fit:', JSON.stringify(t3))

// +/- zoom keys
await page.keyboard.press('=')
await sleep(400)
const t4 = await page.evaluate(() => +window.__form0.threadView.zoom.toFixed(3))
await page.keyboard.press('-')
await sleep(400)
const t5 = await page.evaluate(() => +window.__form0.threadView.zoom.toFixed(3))
console.log('zoom keys +/-:', t4, t5)
if (!(t4 > t3.z && t5 < t4)) f('P3-4', `+/- zoom keys misbehave (${t3.z} -> +${t4} -> -${t5})`)

// Escape back to board
await page.keyboard.press('Escape')
await sleep(1200)
const backHash = await page.evaluate(() => location.hash)
if (backHash !== '#/') f('P3-5', `Escape in thread went to "${backHash}", expected "#/"`)
await rec.shot('03-back-to-board')

// ---------------- reply badge tap -> thread (badge is bottom-right of card 1)
const badgeTarget = await page.evaluate(() => {
  // find screen position of card-1 badge via scene pick: card slots are laid out in a grid
  // instead: use the board's own tapAt through a synthetic pointer at the badge position.
  const b = window.__form0.board
  return { cols: b.cols, scrollY: b.scrollY }
})
console.log('board layout:', JSON.stringify(badgeTarget))

// ---------------- deep link with focus: #/thread/<root>/<child>
const focusInfo = await page.evaluate(() => {
  const f0 = window.__form0
  const root = [...f0.index.byId.values()].find((m) => m.eventId === location.hash.split('/').pop())
  return null
})
const childId = await page.evaluate(() => {
  const f0 = window.__form0
  const roots = [...f0.index.byId.values()].filter((m) => m.role === 'root' && !m.tombstoned)
  roots.sort((a, b) => (a.event?.created_at ?? 0) - (b.event?.created_at ?? 0))
  const rid = roots[0].eventId
  const kids = f0.index.childIds ? f0.index.childIds(rid) : null
  return kids && kids[0] ? kids[0] : null
})
console.log('childId:', childId)
if (childId) {
  await page.evaluate((id) => { location.hash = '#/thread/' + id }, ids[0])
  await sleep(1500)
  await page.evaluate(([r, c2]) => { location.hash = `#/thread/${r}/${c2}` }, [ids[0], childId])
  await sleep(2500)
  await rec.shot('04-thread-focus-deeplink')
  const fd = await page.evaluate(() => ({ hash: location.hash, mode: window.__form0.__mode() }))
  console.log('focus deeplink:', JSON.stringify(fd))
}

// ---------------- 3D board toggle
await page.evaluate(() => { location.hash = '#/' })
await sleep(1500)
await page.evaluate(() => document.getElementById('btn-3d')?.click())
await sleep(5000)
await rec.shot('05-board-3d-mode')
const mode3d = await page.evaluate(() => ({ threeD: window.__form0.board.threeD, btnActive: document.getElementById('btn-3d')?.classList.contains('active') }))
console.log('3D toggle state:', JSON.stringify(mode3d))
// toggle back
await page.evaluate(() => document.getElementById('btn-3d')?.click())
await sleep(2000)

// ---------------- shuffle
await page.evaluate(() => document.getElementById('btn-shuffle')?.click())
await sleep(2500)
await rec.shot('06-after-shuffle')
console.log('shuffle clicked, hash:', await page.evaluate(() => location.hash))

// unknown-route handling: garbage hash
await page.evaluate(() => { location.hash = '#/nonsense/route' })
await sleep(1200)
const junk = await page.evaluate(() => ({ hash: location.hash, mode: window.__form0.__mode() }))
console.log('garbage route:', JSON.stringify(junk))
await rec.shot('07-garbage-route')
if (junk.mode !== 'board') f('P3-6', `garbage route "#/nonsense/route" lands in mode "${junk.mode}", expected board`)

console.log(`\n=== PHASE3 FINDINGS (${F.length}) ===`)
F.forEach((x, i) => console.log(`${i + 1}. ${x}`))
await browser.close()
