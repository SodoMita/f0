// Phase 1 — boot, first-run legend, board basics, scroll, card taps.
import { launch, newRecorder, open, URL_BASE, sleep } from './harness.mjs'

const browser = await launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true })
const rec = newRecorder(page, 'p1')
const F = []
const f = (id, text) => { F.push(`${id}: ${text}`); console.log(`  FINDING ${id}: ${text}`) }

await open(page, URL_BASE)
await rec.shot('01-first-boot')

// ---- what does first boot look like?
const boot = await page.evaluate(() => ({
  hasForm0: !!window.__form0,
  legendVisible: !!document.querySelector('#legend') && getComputedStyle(document.querySelector('#legend')).display !== 'none' && getComputedStyle(document.querySelector('#legend')).visibility !== 'hidden' && getComputedStyle(document.querySelector('#legend')).opacity !== '0',
  focused: document.activeElement?.id || document.activeElement?.tagName,
  title: document.title,
  hasLang: document.documentElement.lang,
}))
console.log('boot state:', JSON.stringify(boot))
if (!boot.hasLang || boot.hasLang === 'en') f('P1-a', `document.lang = "${boot.hasLang}" — check a11y`)

// ---- legend: is it keyboard dismissible? does Escape work? is focus trapped?
const legendBefore = await page.evaluate(() => {
  const l = document.querySelector('#legend')
  return l ? getComputedStyle(l).display : 'absent'
})
console.log('legend display before:', legendBefore)
await page.keyboard.press('Escape').catch(() => {})
await sleep(700)
const legendAfterEsc = await page.evaluate(() => {
  const l = document.querySelector('#legend')
  return l ? getComputedStyle(l).display : 'absent'
})
console.log('legend after Escape:', legendAfterEsc)
if (legendBefore !== 'none' && legendAfterEsc !== 'none') f('P1-1', 'First-run legend ignores Escape — no keyboard dismissal for a full-screen modal')

// try clicking outside
await page.mouse.click(640, 400)
await sleep(500)
const legendAfterOutside = await page.evaluate(() => {
  const l = document.querySelector('#legend')
  return l ? getComputedStyle(l).display : 'absent'
})
console.log('legend after canvas click:', legendAfterOutside)

// close it like a user: find the visible buttons
const legendButtons = await page.evaluate(() =>
  [...document.querySelectorAll('#legend button')].map((b) => ({ id: b.id, text: (b.textContent || '').trim().slice(0, 30), visible: !!(b.offsetWidth || b.offsetHeight) }))
)
console.log('legend buttons:', JSON.stringify(legendButtons))
await page.evaluate(() => document.querySelector('#btn-legend-ok')?.click())
await sleep(500)

// ---- board content
const board = await page.evaluate(() => {
  const f0 = window.__form0
  const roots = [...f0.index.byId.values()].filter((m) => m.role === 'root' && !m.tombstoned)
  return { roots: roots.length, total: f0.index.byId.size }
})
console.log('board content:', JSON.stringify(board))

// ---- hit test: can we tap a card in the middle of the screen?
await rec.shot('02-board')

// does the board respond to keyboard arrows (spec: arrows move selection)?
const selBefore = await page.evaluate(() => window.__form0.board?.['sel'] ?? window.__form0.board?.selected ?? null)
await page.keyboard.press('ArrowRight')
await sleep(1200)
const selAfter = await page.evaluate(() => window.__form0.board?.['sel'] ?? window.__form0.board?.selected ?? null)
console.log('arrow-right selection:', JSON.stringify({ selBefore, selAfter }))

// Enter should open the selected card in the viewer
await page.keyboard.press('Enter')
await sleep(2500)
const afterEnter = await page.evaluate(() => ({ hash: location.hash, mode: window.__form0?.__mode?.() }))
console.log('after Enter:', JSON.stringify(afterEnter))
await rec.shot('03-after-enter')
if (!String(afterEnter.hash).includes('viewer')) f('P1-2', `Enter with no explicit selection does not open the viewer (hash=${afterEnter.hash}) — keyboard path may be dead`)

// go back to board
await page.keyboard.press('Escape')
await sleep(1500)
console.log('after Escape hash:', await page.evaluate(() => location.hash))

// ---- wheel scroll: does it actually move?
const scrollState = () => page.evaluate(() => {
  const b = window.__form0.board
  return { y: b?.scrollY ?? b?.['scroll'] ?? b?.['target'] ?? null, keys: Object.keys(b || {}).slice(0, 30) }
})
const s0 = await scrollState()
console.log('board keys:', JSON.stringify(s0.keys))
await page.mouse.move(640, 400)
for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 400); await sleep(120) }
await sleep(2500)
const s1 = await scrollState()
console.log('scroll before/after wheel-down:', JSON.stringify({ s0: s0.y, s1: s1.y }))
await rec.shot('04-after-wheel')

// ---- hit-test cards via Babylon scene pick — find where cards actually are
const cardPick = await page.evaluate(() => {
  const f0 = window.__form0
  const scene = f0.board?.scene || f0.engine?.scenes?.[0]
  if (!scene) return null
  const meshes = scene.meshes.filter((m) => m.name && m.isEnabled())
  return { meshCount: meshes.length, names: [...new Set(meshes.map((m) => m.name.replace(/\\d+/g, '#')))].slice(0, 25) }
})
console.log('board meshes:', JSON.stringify(cardPick))
await rec.shot('05-board-end')

console.log(`\n=== PHASE1 FINDINGS (${F.length}) ===`)
F.forEach((x, i) => console.log(`${i + 1}. ${x}`))
console.log(`console errors: ${rec.console.filter((c) => c.type === 'error').length}, pageerrors: ${rec.pageErrors.length}, reqfail: ${rec.failedRequests.length}`)

await browser.close()
