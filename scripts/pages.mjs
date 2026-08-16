// Simulate GitHub Pages hosting: load the standalone over HTTP, assert the
// board boots, posters render, and only user-content requests are made.
import { chromium } from 'playwright'
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const bad = []
page.on('request', (r) => { if (/cdn\.babylonjs\.com|unpkg|jsdelivr/.test(r.url())) bad.push(r.url()) })
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 160)))
await page.goto('http://localhost:4299/', { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForFunction(() => window.__form0 && window.__form0.board, null, { timeout: 15000 }).catch(() => {})
await page.waitForTimeout(30000)
const state = await page.evaluate(() => {
  const f = window.__form0
  const b = f.board
  const vis = b.cards.filter((c) => c.meta && c.mesh.isEnabled())
  return {
    booted: !!f,
    events: f.index.byId.size,
    roots: [...f.index.byId.values()].filter((m) => m.role === 'root' && !m.tombstoned).length,
    posters: f.assets.posterTex?.size ?? -1,
    liveSlots: b.previewPool?.activeCount ?? -1,
    canvasPresent: !!document.querySelector('canvas#engine'),
    topbarVisible: !document.getElementById('topbar').hidden,
    visibleCards: vis.length,
  }
})
await page.screenshot({ path: 'shots/pages.png' })
console.log(JSON.stringify({ ...state, badRequests: bad }, null, 1))
await browser.close()
