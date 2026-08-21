// Headless verification: vertical feed, scroll direction + reachability,
// poster aspect (no stretch), click->viewer framing, cameras, HTML HUD.
// FAILS (non-zero exit) on: boot timeout, CDN request, unexpected console
// error, empty feed, empty poster set, broken scroll, or a failed viewer open.
//
//   TARGET_URL=http://localhost:4173/ node scripts/smoke.mjs
import { chromium } from 'playwright'

const URL = process.env.TARGET_URL || 'http://localhost:4173/'
const WAIT = Number(process.env.WAIT_MS || 18000)

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = [], bad = []
page.on('console', (m) => {
  if (m.type() !== 'error') return
  // headless has no audio device; the mixer's device error is expected
  if (/AudioContext|audio device/i.test(m.text())) return
  // the app boots on the DEFAULT public relays for a few frames before the
  // rig hook switches to the local one; those failed connections are expected
  if (/WebSocket connection to 'wss:\/\/(?!localhost)/.test(m.text())) return
  errors.push(m.text().slice(0, 160))
})
page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)))
page.on('request', (r) => { if (/cdn\.babylonjs\.com|unpkg|jsdelivr/.test(r.url())) bad.push(r.url()) })

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 })

let booted = true
try {
  await page.waitForFunction(() => window.__form0 && window.__form0.board, null, { timeout: 15000 })
} catch {
  booted = false
}
check('app boots (window.__form0.board)', booted)
if (!booted) {
  await browser.close()
  console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL CHECKS PASSED')
  process.exit(1)
}

// first-run legend is modal by design; dismiss it like a user would
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await page.waitForTimeout(WAIT)

const pre = await page.evaluate(() => {
  const f = window.__form0, b = f.board
  const visible = b.cards.filter((c) => c.meta && c.mesh.isEnabled())
  const scales = visible.map((c) => c.mesh.scaling.asArray().map((n) => +n.toFixed(2)).join('x'))
  return {
    events: f.index.byId.size,
    roots: [...f.index.byId.values()].filter((m) => m.role === 'root' && !m.tombstoned).length,
    posters: f.assets.posterTex?.size ?? -1,
    liveSlots: b.previewPool?.activeCount ?? -1,
    visibleCards: visible.length,
    uniformScale: [...new Set(scales)],
    scrollY: +b.scrollY.toFixed(2),
    maxScroll: +b.maxScroll.toFixed(2),
    hud: {
      topbarVisible: !document.getElementById('topbar').hidden,
      viewerBarHidden: document.getElementById('viewer-bar').hidden,
    },
  }
})

check('feed has events', pre.events >= 1, `events=${pre.events}`)
check('feed has root posts', pre.roots >= 1, `roots=${pre.roots}`)
check('poster pipeline produced posters', pre.posters >= 1, `posters=${pre.posters}`)
check('live preview pool is present', pre.liveSlots !== -1)
check('card scaling is uniform (no stretch)', pre.uniformScale.length === 1, pre.uniformScale.join(','))
check('topbar visible', pre.hud.topbarVisible)
check('viewer bar hidden on the board', pre.hud.viewerBarHidden)

// --- scroll DOWN (wheel) must increase scrollY toward maxScroll (reach later cards) ---
const pos0 = await page.evaluate(() => window.__form0.board.screenPosOf(0))
let scrollDownWorks = false
let backAtTop = false
if (pos0) {
  await page.mouse.move(pos0.x, pos0.y)
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, 400)
  await page.waitForTimeout(400)
  const s1 = await page.evaluate(() => window.__form0.board.scrollY)
  scrollDownWorks = s1 > 0
  await page.evaluate(() => window.__form0.board.screenPosOf(6))
  await page.screenshot({ path: 'shots/board_bottom.png' })
  // scroll back up
  for (let i = 0; i < 30; i++) await page.mouse.wheel(0, -400)
  await page.waitForTimeout(300)
  backAtTop = await page.evaluate(() => window.__form0.board.scrollY < 0.01)
}
check('card 0 has a clickable screen position', !!pos0)
if (pre.maxScroll > 0.01) {
  check('scroll down moves the feed', scrollDownWorks)
  check('scroll back returns to the top', backAtTop)
} else {
  console.log('SKIP  scroll assertions (maxScroll=0: too few cards to scroll)')
}

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
check('card click opens the viewer (hash route)', viewerHash.startsWith('#/viewer/'), viewerHash.slice(0, 40))

await page.screenshot({ path: 'shots/board_top.png' })

check('no CDN requests', bad.length === 0, bad.join(','))
check('no unexpected console/page errors', errors.length === 0, errors.slice(0, 3).join(' | '))

await browser.close()
console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL CHECKS PASSED')
process.exit(fails.length ? 1 : 0)
