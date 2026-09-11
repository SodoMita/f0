// Phase 7 — narrow viewport (mobile), zoom/DPR, fullscreen, perf overlay,
// background settings, reduce motion, search filter, resolution settings.
import { launch, newRecorder, open, URL_BASE, sleep } from './harness.mjs'

const browser = await launch()
const F = []
const f = (id, t) => { F.push(`${id}: ${t}`); console.log(`  FINDING ${id}: ${t}`) }

// ---------- narrow mobile viewport
const page = await browser.newPage({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
const rec = newRecorder(page, 'p7')
await open(page, URL_BASE)
await page.evaluate(() => document.querySelector('#btn-legend-ok')?.click())
await sleep(3500)
await rec.shot('01-mobile-board')
const mob = await page.evaluate(() => {
  const bar = document.getElementById('viewer-bar')
  const topbar = document.getElementById('topbar')
  const overflowX = document.documentElement.scrollWidth > document.documentElement.clientWidth
  return { cols: window.__form0.board.cols, viewerBarVisible: bar ? getComputedStyle(bar).display : 'absent', topbarW: topbar?.getBoundingClientRect().width, overflowX }
})
console.log('mobile:', JSON.stringify(mob))
// open viewer on mobile
await page.evaluate(() => { const r = [...window.__form0.index.byId.values()].find((m) => m.role === 'root' && !m.tombstoned); location.hash = '#/viewer/' + r.eventId })
await sleep(3500)
await rec.shot('02-mobile-viewer')
const mbar = await page.evaluate(() => {
  const bar = document.getElementById('viewer-bar')
  const r = bar?.getBoundingClientRect()
  const over = r ? (r.left < -2 || r.right > window.innerWidth + 2) : null
  const kids = bar ? [...bar.querySelectorAll('button')].filter((b) => b.offsetWidth || b.offsetHeight).length : 0
  return { rect: r ? { l: r.left | 0, r: r.right | 0, w: window.innerWidth } : null, over, visibleButtons: kids }
})
console.log('mobile viewer bar:', JSON.stringify(mbar))
if (mbar.over) f('P7-1', `viewer bar overflows the ${mbar.rect.w}px viewport (left ${mbar.rect.l}, right ${mbar.rect.r})`)
// settings on mobile
await page.evaluate(() => document.getElementById('btn-settings')?.click())
await sleep(900)
await rec.shot('03-mobile-settings')
const mset = await page.evaluate(() => {
  const p = document.getElementById('settings-panel')
  const r = p?.getBoundingClientRect()
  return { rect: r ? { l: r.left | 0, r: r.right | 0, w: window.innerWidth } : null }
})
console.log('mobile settings:', JSON.stringify(mset))
if (mset.rect && (mset.rect.l < -2 || mset.rect.r > mset.rect.w + 2)) f('P7-2', 'settings panel overflows the mobile viewport')
await page.close()

// ---------- desktop: perf overlay, backgrounds, resolution garbage
const page2 = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const rec2 = newRecorder(page2, 'p7b')
await open(page2, URL_BASE)
await page2.evaluate(() => document.querySelector('#btn-legend-ok')?.click())
await sleep(1200)
await page2.evaluate(() => document.getElementById('btn-settings')?.click())
await sleep(800)
// perf overlay toggle
await page2.evaluate(() => { const el = document.getElementById('set-showFps'); if (el && !el.checked) el.click() })
await sleep(1200)
const perf = await page2.evaluate(() => {
  const o = document.getElementById('perf-overlay')
  return { exists: !!o, visible: o ? (o.offsetWidth || o.offsetHeight) > 0 : false, text: (o?.textContent || '').slice(0, 60) }
})
console.log('perf overlay:', JSON.stringify(perf))
await rec2.shot('04-perf-overlay')
if (!perf.visible) f('P7-3', 'show-FPS setting did not make the perf overlay visible')

// background color change (viewer background)
await page2.evaluate(() => { const el = document.getElementById('set-background'); if (el) { el.value = '#ff00ff'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })) } })
await sleep(1000)
await rec2.shot('05-bg-magenta')

// resolution numeric: width 50
await page2.evaluate(() => {
  const mode = document.getElementById('set-resolutionMode')
  if (mode) { mode.value = 'pixels'; mode.dispatchEvent(new Event('change', { bubbles: true })) }
})
await sleep(500)
await page2.evaluate(() => {
  const w = document.getElementById('set-resolutionWidth')
  if (w) { w.value = '50'; w.dispatchEvent(new Event('input', { bubbles: true })); w.dispatchEvent(new Event('change', { bubbles: true })) }
})
await sleep(1500)
const resInfo = await page2.evaluate(() => {
  const e = window.__form0.engine
  return { rw: e.getRenderWidth?.() ?? window.innerWidth, readout: (document.getElementById('resolution-readout')?.textContent || '').slice(0, 40) }
})
console.log('resolution after 50px width:', JSON.stringify(resInfo))
await rec2.shot('06-res-50px')
await page2.evaluate(() => document.getElementById('btn-settings-close')?.click())
await sleep(500)

// search filter
await page2.evaluate(() => document.getElementById('btn-search')?.click())
await sleep(700)
await page2.type('#search-input', 'bob', { delay: 30 })
await sleep(1500)
const searchInfo = await page2.evaluate(() => {
  const f0 = window.__form0
  const total = [...f0.index.byId.values()].filter((m) => m.role === 'root' && !m.tombstoned).length
  return { q: f0.search(), boardCards: f0.board.cards.filter((c) => c.isEnabled?.()).length ?? null, total, hint: (document.getElementById('search-hint')?.textContent || '').slice(0, 40) }
})
console.log('search bob:', JSON.stringify(searchInfo))
await rec2.shot('07-search-bob')
// empty search behavior
await page2.evaluate(() => { const i = document.getElementById('search-input'); i.value = 'zzzznothing'; i.dispatchEvent(new Event('input', { bubbles: true })) })
await sleep(1500)
await rec2.shot('08-search-empty')
const emptyQ = await page2.evaluate(() => window.__form0.search())
console.log('empty search q:', emptyQ)
// Escape closes search?
await page2.keyboard.press('Escape')
await sleep(600)
const searchClosed = await page2.evaluate(() => getComputedStyle(document.getElementById('search-panel')).display)
console.log('search panel after Escape:', searchClosed)
if (searchClosed !== 'none') f('P7-4', 'search panel does not close on Escape')

console.log(`\n=== PHASE7 FINDINGS (${F.length}) ===`)
F.forEach((x, i) => console.log(`${i + 1}. ${x}`))
await browser.close()
