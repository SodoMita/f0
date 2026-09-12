// Phase 2 — viewer: keys, buttons, camera dots, download, race prev/next,
// empty-frames at open, sound button, delete button, metadata drawer.
import { launch, newRecorder, open, URL_BASE, sleep } from './harness.mjs'

const browser = await launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true })
const rec = newRecorder(page, 'p2')
const F = []
const f = (id, text) => { F.push(`${id}: ${text}`); console.log(`  FINDING ${id}: ${text}`) }

await open(page, URL_BASE)
await page.evaluate(() => document.querySelector('#btn-legend-ok')?.click())
await sleep(2500)

// pick flavor d (two cameras) and flavor e (camera, static) from the index
const ids = await page.evaluate(() => {
  const roots = [...window.__form0.index.byId.values()].filter((m) => m.role === 'root' && !m.tombstoned)
  roots.sort((a, b) => (a.event?.created_at ?? 0) - (b.event?.created_at ?? 0))
  return roots.map((m) => m.eventId)
})
console.log('roots:', ids.length)
const dId = ids[3], eId = ids[4], aId = ids[0]

// ---------- empty-frames at open: route to viewer, screenshot early frames
await page.evaluate((id) => { location.hash = '#/viewer/' + id }, aId)
await sleep(400)
await rec.shot('01-viewer-open-400ms')
await sleep(3600)
await rec.shot('02-viewer-open-4s')

// ---------- sound button & delete button states
const btnStates = await page.evaluate(() => {
  const q = (id) => document.getElementById(id)
  const vis = (el) => !!el && !el.disabled && (el.offsetWidth || el.offsetHeight) && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none'
  return {
    sound: { exists: !!q('btn-sound'), visible: vis(q('btn-sound')), disabled: q('btn-sound')?.disabled },
    del: { exists: !!q('btn-delete'), visible: vis(q('btn-delete')), disabled: q('btn-delete')?.disabled },
    reply: { exists: !!q('btn-reply'), visible: vis(q('btn-reply')) },
    camDots: (q('cam-dots')?.children.length ?? 0),
  }
})
console.log('buttons:', JSON.stringify(btnStates))

// ---------- A play/pause + timeline consistency
const rail0 = await page.evaluate(() => ({
  frame: document.getElementById('anim-frame')?.textContent,
  play: document.getElementById('btn-play')?.dataset?.state ?? document.getElementById('btn-play')?.className,
}))
await page.keyboard.press('a')
await sleep(600)
const rail1 = await page.evaluate(() => ({
  frame: document.getElementById('anim-frame')?.textContent,
  play: document.getElementById('btn-play')?.dataset?.state ?? document.getElementById('btn-play')?.className,
}))
console.log('rail after A:', JSON.stringify({ rail0, rail1 }))

// ---------- , and . frame stepping
await page.keyboard.press('.')
await sleep(300)
const step1 = await page.evaluate(() => document.getElementById('anim-frame')?.textContent)
await page.keyboard.press('.')
await sleep(300)
const step2 = await page.evaluate(() => document.getElementById('anim-frame')?.textContent)
if (step1 === step2) f('P2-1', `frame-step '.' twice produced identical frame label (${step1}) — stepping may be dead`)
console.log('step frames:', step1, step2)

// ---------- M metadata drawer
await page.keyboard.press('m')
await sleep(600)
await rec.shot('03-meta-drawer')
const metaState = await page.evaluate(() => {
  const d = document.getElementById('meta-drawer')
  return { hidden: d?.hidden, display: d ? getComputedStyle(d).display : 'absent', textLen: (document.getElementById('meta-text')?.textContent || '').length }
})
console.log('meta drawer:', JSON.stringify(metaState))
await page.keyboard.press('m')
await sleep(400)

// ---------- camera dots on flavor d (two cameras)
await page.evaluate((id) => { location.hash = '#/viewer/' + id }, dId)
await sleep(4000)
const camInfo = await page.evaluate(() => ({
  dots: document.getElementById('cam-dots')?.children.length ?? 0,
  dotsVisible: (() => { const el = document.getElementById('cam-dots'); return el ? getComputedStyle(el).display : 'absent' })(),
}))
console.log('cam dots (model d, 2 cameras):', JSON.stringify(camInfo))
if (camInfo.dots < 2) f('P2-2', `two-camera model shows ${camInfo.dots} camera dots — authored cameras not exposed in UI`)
await rec.shot('04-model-d')
await page.keyboard.press('c')
await sleep(800)
await page.keyboard.press('c')
await sleep(800)
await rec.shot('05-model-d-after-CC')

// ---------- download button fires a download
const dlPromise = page.waitForEvent('download', { timeout: 8000 }).catch(() => null)
await page.evaluate(() => document.getElementById('btn-download')?.click())
const dl = await dlPromise
if (!dl) f('P2-3', 'SAVE/download button produced no download event')
else console.log('download:', dl.suggestedFilename())

// ---------- delete button for a stranger's post
await page.evaluate(() => document.getElementById('btn-delete')?.click())
await sleep(800)
await rec.shot('06-after-delete-click')
const delState = await page.evaluate(() => ({
  fatal: document.getElementById('fatal')?.hidden,
  fatalText: (document.getElementById('fatal-text')?.textContent || '').slice(0, 120),
  errSheet: !document.getElementById('error-sheet')?.hidden,
  errText: (document.getElementById('error-code')?.textContent || '') + ' ' + (document.getElementById('error-cause')?.textContent || '').slice(0, 100),
  toast: (document.getElementById('toast-text')?.textContent || '').slice(0, 120),
}))
console.log('after delete click:', JSON.stringify(delState))
// recover
await page.evaluate(() => { const b = document.getElementById('btn-error-close'); if (b) b.click() })
await sleep(400)

// ---------- race prev/next: 16 rapid ArrowRight then settle
const before = await page.evaluate(() => ({ hash: location.hash }))
for (let i = 0; i < 16; i++) { await page.keyboard.press('ArrowRight'); await sleep(60) }
await sleep(6000)
const race = await page.evaluate(() => {
  const f0 = window.__form0
  const scene = f0.engine.scenes?.[0] ?? f0.board?.scene
  const meshes = scene ? scene.meshes.filter((m) => m.isEnabled()) : []
  const hash = location.hash
  return { hash, meshCount: meshes.length, nonHelper: meshes.filter((m) => m.name && !/helper|grid/i.test(m.name)).map((m) => m.name).slice(0, 20) }
})
console.log('after race:', JSON.stringify(race))
await rec.shot('07-after-race')
if (race.nonHelper.length > 12) f('P2-4', `after 16 rapid nexts the scene holds ${race.nonHelper.length} non-helper meshes — possible stacked containers`)

// ---------- orbit drag + wheel zoom
const camBefore = await page.evaluate(() => {
  const v = window.__form0.viewer
  const c = v?.camera
  return { radius: c?.radius, alpha: c?.alpha, beta: c?.beta }
})
await page.mouse.move(640, 400)
await page.mouse.down()
await page.mouse.move(760, 340, { steps: 8 })
await page.mouse.up()
await sleep(900)
await page.mouse.wheel(0, -240)
await sleep(900)
const camAfter = await page.evaluate(() => {
  const v = window.__form0.viewer
  const c = v?.camera
  return { radius: c?.radius, alpha: c?.alpha, beta: c?.beta }
})
console.log('orbit/zoom:', JSON.stringify({ camBefore, camAfter }))
if (camBefore.radius != null && camAfter.radius != null && Math.abs(camBefore.radius - camAfter.radius) < 0.01) f('P2-5', 'wheel in viewer did not change camera radius — zoom dead?')
await rec.shot('08-after-orbit')

// ---------- T key → thread
await page.keyboard.press('t')
await sleep(2500)
const tHash = await page.evaluate(() => location.hash)
console.log('after T:', tHash)
if (!String(tHash).startsWith('#/thread')) f('P2-6', `T in viewer did not open the thread (hash=${tHash})`)
await rec.shot('09-thread-from-T')

console.log(`\n=== PHASE2 FINDINGS (${F.length}) ===`)
F.forEach((x, i) => console.log(`${i + 1}. ${x}`))
await browser.close()
