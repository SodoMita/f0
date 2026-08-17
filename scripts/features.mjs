import { chromium } from 'playwright'
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
page.on('pageerror', e => console.log('[pageerror]', e.message.slice(0,160)))
const URL = process.env.TARGET_URL || 'http://localhost:4173/'
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForFunction(() => window.__form0 && window.__form0.board, null, { timeout: 15000 }).catch(()=>{})
await page.waitForTimeout(22000)

// 1) reply badges
const badges = await page.evaluate(() => {
  const b = window.__form0.board
  const vis = b.cards.filter(c => c.meta && c.mesh.isEnabled())
  return vis.map(c => ({ id: c.meta.eventId.slice(0,8), replyCount: c.replyCount, badgeOn: c.badge.isEnabled() }))
})
console.log('badges:', JSON.stringify(badges))

// 2) childCount from index
const counts = await page.evaluate(() => {
  const f = window.__form0
  return [...f.index.byId.values()].filter(m => m.role === 'root').map(m => ({ id: m.eventId.slice(0,8), children: f.index.childCount(m.eventId) }))
})
console.log('index childCount:', JSON.stringify(counts))

// 3) open thread view (find a root with replies)
const threadRoot = await page.evaluate(() => {
  const f = window.__form0
  const roots = [...f.index.byId.values()].filter(m => m.role === 'root')
  const r = roots.find(m => f.index.childCount(m.eventId) > 0)
  return r?.eventId
})
console.log('threadRoot:', threadRoot?.slice(0,8))
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
  await page.screenshot({ path: 'shots/thread.png' })
  // back
  await page.evaluate(() => { location.hash = '#/' })
  await page.waitForTimeout(500)
}

// 4) settings: background white + inertia 100
await page.evaluate(() => document.querySelector('#btn-settings').click())
await page.waitForTimeout(200)
await page.evaluate(() => document.querySelector('.swatch[data-bg="#ffffff"]').click())
await page.evaluate(() => { const s = document.getElementById('inertia'); s.value = '100'; s.dispatchEvent(new Event('input')) })
await page.waitForTimeout(300)
const settings = await page.evaluate(() => ({
  viewerBg: [window.__form0.viewer.scene.clearColor.r, window.__form0.viewer.scene.clearColor.g, window.__form0.viewer.scene.clearColor.b].map(n=>+n.toFixed(1)),
  threadBg: [window.__form0.threadView.scene.clearColor.r, window.__form0.threadView.scene.clearColor.g, window.__form0.threadView.scene.clearColor.b].map(n=>+n.toFixed(1)),
  inertia: window.__form0.board.inertia,
}))
console.log('settings:', JSON.stringify(settings))
await page.screenshot({ path: 'shots/board_final.png' })
await browser.close()
