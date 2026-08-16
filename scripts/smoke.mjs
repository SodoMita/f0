// Headless verification: vertical feed, scroll direction + reachability,
// poster aspect (no stretch), click->viewer framing, cameras, HTML HUD.
import { chromium } from 'playwright'

const URL = process.env.TARGET_URL || 'http://localhost:4173/'
const WAIT = Number(process.env.WAIT_MS || 18000)

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const logs = [], bad = []
page.on('console', (m) => { if (m.type() === 'error') logs.push(`[err] ${m.text().slice(0, 140)}`) })
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message.slice(0, 200)}`))
page.on('request', (r) => { if (/cdn\.babylonjs\.com|unpkg|jsdelivr/.test(r.url())) bad.push(r.url()) })

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForFunction(() => window.__form0 && window.__form0.board, null, { timeout: 15000 }).catch(() => {})
await page.waitForTimeout(WAIT)

const pre = await page.evaluate(() => {
  const f = window.__form0, b = f.board
  const visible = b.cards.filter((c) => c.meta && c.mesh.isEnabled())
  const scales = visible.map((c) => c.mesh.scaling.asArray().map((n) => +n.toFixed(2)).join('x'))
  return {
    booted: !!f,
    events: f.index.byId.size,
    roots: [...f.index.byId.values()].filter((m) => m.role === 'root' && !m.tombstoned).length,
    posters: f.assets.posterTex?.size ?? -1,
    liveSlots: b.previewPool?.activeCount ?? -1,
    visibleCards: visible.length,
    allCentered: visible.every((c) => Math.abs(c.mesh.position.x) < 0.01),
    uniformScale: [...new Set(scales)],
    scrollY: +b.scrollY.toFixed(2),
    maxScroll: +b.maxScroll.toFixed(2),
    hud: {
      topbarVisible: !document.getElementById('topbar').hidden,
      viewerBarHidden: document.getElementById('viewer-bar').hidden,
    },
  }
})

// --- scroll DOWN (wheel) must increase scrollY toward maxScroll (reach later cards) ---
const pos0 = await page.evaluate(() => window.__form0.board.screenPosOf(0))
let reachedMax = false
let scrollDownWorks = false
if (pos0) {
  await page.mouse.move(pos0.x, pos0.y)
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, 400)
  await page.waitForTimeout(400)
  const s1 = await page.evaluate(() => window.__form0.board.scrollY)
  scrollDownWorks = s1 > 0
  reachedMax = await page.evaluate(() => Math.abs(window.__form0.board.scrollY - window.__form0.board.maxScroll) < 0.01)
  const last = await page.evaluate(() => window.__form0.board.screenPosOf(6))
  await page.screenshot({ path: 'shots/board_bottom.png' })
  // scroll back up
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -400)
  await page.waitForTimeout(300)
}
const backAtTop = await page.evaluate(() => window.__form0.board.scrollY < 0.01)

// --- click card 0 -> viewer ---
const pos0b = await page.evaluate(() => window.__form0.board.screenPosOf(0))
let viewerHash = ''
if (pos0b) {
  await page.mouse.move(pos0b.x, pos0b.y)
  await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up()
  await page.waitForTimeout(3500)
  viewerHash = await page.evaluate(() => location.hash)
  const v = await page.evaluate(() => ({
    cameras: window.__form0.viewer.cameraCount,
    camIndex: window.__form0.viewer.camIndex,
    stats: window.__form0.viewer.stats(),
    hudVisible: !document.getElementById('viewer-bar').hidden,
    camDotCount: document.querySelectorAll('.cam-dot').length,
  }))
  await page.screenshot({ path: 'shots/viewer.png' })
  console.log('viewer:', JSON.stringify(v))
}

await page.screenshot({ path: 'shots/board_top.png' })
console.log(JSON.stringify({ ...pre, scrollDownWorks, reachedMax, backAtTop, viewerHash: viewerHash.slice(0, 50), badRequests: bad }, null, 2))
console.log('--- console (tail) ---')
console.log(logs.slice(-8).join('\n'))
await browser.close()
