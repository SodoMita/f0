// Feature verification: reply badges, thread map, settings reaching real
// engine state. FAILS (non-zero exit) on boot timeout or any missing feature.
//
//   TARGET_URL=http://localhost:4173/ node scripts/features.mjs
import { chromium } from 'playwright'

const URL = process.env.TARGET_URL || 'http://localhost:4173/'

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

// --ignore-certificate-errors: the offline rig serves wss://localhost:8443 with
// a self-signed cert; the headless test browser must accept it.
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--ignore-certificate-errors'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)))

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
await page.waitForTimeout(22000)

// 1) reply badges
const badges = await page.evaluate(() => {
  const b = window.__form0.board
  const vis = b.cards.filter((c) => c.meta && c.mesh.isEnabled())
  return vis.map((c) => ({ id: c.meta.eventId.slice(0, 8), replyCount: c.replyCount, badgeOn: c.badge.isEnabled() }))
})
console.log('badges:', JSON.stringify(badges))
check('feed rendered cards', badges.length >= 1, `cards=${badges.length}`)
check('some card has replies (badge source)', badges.some((c) => c.replyCount > 0), JSON.stringify(badges.map((c) => c.replyCount)))
check('reply badge shown wherever replies exist', badges.every((c) => c.replyCount === 0 || c.badgeOn))

// 2) childCount from index
const counts = await page.evaluate(() => {
  const f = window.__form0
  return [...f.index.byId.values()].filter((m) => m.role === 'root').map((m) => ({ id: m.eventId.slice(0, 8), children: f.index.childCount(m.eventId) }))
})
console.log('index childCount:', JSON.stringify(counts))
check('index reports child counts', counts.some((c) => c.children > 0))

// 3) open thread view (find a root with replies)
const threadRoot = await page.evaluate(() => {
  const f = window.__form0
  const roots = [...f.index.byId.values()].filter((m) => m.role === 'root')
  const r = roots.find((m) => f.index.childCount(m.eventId) > 0)
  return r?.eventId
})
console.log('threadRoot:', threadRoot?.slice(0, 8))
check('found a root with replies', !!threadRoot)
if (threadRoot) {
  await page.evaluate((id) => { location.hash = '#/thread/' + id }, threadRoot)
  await page.waitForTimeout(4000)
  const t = await page.evaluate(() => {
    const tv = window.__form0.threadView
    return {
      activeScene: window.__form0.engine.activeScene === tv.scene,
      nodes: tv.nodes.size,
      edges: tv.lineMeshes.length,
    }
  })
  console.log('thread view:', JSON.stringify(t))
  check('thread view becomes the active scene', t.activeScene)
  check('thread map renders nodes', t.nodes >= 2, `nodes=${t.nodes}`)
  check('thread map renders edges', t.edges >= 1, `edges=${t.edges}`)
  await page.screenshot({ path: 'shots/thread.png' })
  // back
  await page.evaluate(() => { location.hash = '#/' })
  await page.waitForTimeout(500)
} else {
  check('thread view becomes the active scene', false, 'no thread root')
  check('thread map renders nodes', false, 'no thread root')
  check('thread map renders edges', false, 'no thread root')
}

// 4) settings: background white + inertia 100
await page.evaluate(() => document.querySelector('#btn-settings').click())
await page.waitForTimeout(200)
await page.evaluate(() => document.querySelector('.swatch[data-bg="#ffffff"]').click())
await page.evaluate(() => { const s = document.getElementById('inertia'); s.value = '100'; s.dispatchEvent(new Event('input')) })
await page.waitForTimeout(300)
const settings = await page.evaluate(() => ({
  viewerBg: [window.__form0.viewer.scene.clearColor.r, window.__form0.viewer.scene.clearColor.g, window.__form0.viewer.scene.clearColor.b].map((n) => +n.toFixed(1)),
  threadBg: [window.__form0.threadView.scene.clearColor.r, window.__form0.threadView.scene.clearColor.g, window.__form0.threadView.scene.clearColor.b].map((n) => +n.toFixed(1)),
  inertia: window.__form0.board.inertia,
}))
console.log('settings:', JSON.stringify(settings))
const white = (rgb) => rgb.every((n) => Math.abs(n - 1) < 0.05)
check('background swatch sets the viewer to white', white(settings.viewerBg), JSON.stringify(settings.viewerBg))
check('background swatch sets the thread to white', white(settings.threadBg), JSON.stringify(settings.threadBg))
check('inertia slider reaches the engine (100 -> 1.0)', settings.inertia === 1, `inertia=${settings.inertia}`)
await page.screenshot({ path: 'shots/board_final.png' })

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '))

await browser.close()
console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL CHECKS PASSED')
process.exit(fails.length ? 1 : 0)
