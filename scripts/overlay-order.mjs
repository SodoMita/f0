// Verify that board/thread overlay meshes (reply badge, play/pause button)
// always render ABOVE the card/node they belong to.
//
// Why this exists: Babylon sorts transparent meshes back-to-front by the
// distance from the camera to each mesh's bounding-sphere CENTER. A
// corner-mounted button's center is several world units off its card's
// center, so a card near screen-center sorts CLOSER than its own buttons
// and paints over them whenever the card's opaque poster/live pixels reach
// the corner. The fix pins overlays in renderingGroupId 1 (rendered after
// group 0 = cards/nodes/backdrop), independent of the distance sort.
import { chromium } from 'playwright'

const URL = process.env.TARGET_URL || 'http://localhost:5173/'
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_PATH || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message.slice(0, 200)))
const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForFunction(() => window.__form0?.board, { timeout: 30000 })
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await page.waitForTimeout(12000)

// ---- board ----
const board = await page.evaluate(() => {
  const b = window.__form0.board
  const vis = b.cards.filter((c) => c.meta && c.mesh.isEnabled())
  return {
    visibleCards: vis.length,
    cardGroup: [...new Set(vis.map((c) => c.mesh.renderingGroupId))],
    badgeGroups: [...new Set(vis.map((c) => c.badge.renderingGroupId))],
    playGroups: [...new Set(vis.map((c) => c.play.renderingGroupId))],
    // overlay z must be closer (smaller) than the card z=0
    badgeZ: [...new Set(vis.map((c) => +c.badge.position.z.toFixed(3)))],
    playZ: [...new Set(vis.map((c) => +c.play.position.z.toFixed(3)))],
    // a center card would have sorted behind its own buttons before the fix:
    centeredDistances: (() => {
      const near = vis.filter((c) => Math.hypot(c.mesh.position.x, c.mesh.position.y) < 6)
      if (!near.length) return null
      const c = near[0]
      return {
        cardDist: +Math.hypot(c.mesh.position.x, c.mesh.position.y, 30).toFixed(3),
        playDist: +Math.hypot(c.play.position.x, c.play.position.y, 30 - c.play.position.z).toFixed(3),
      }
    })(),
  }
})
check('board has visible cards to inspect', board.visibleCards > 0, String(board.visibleCards))
check('board cards render in group 0', board.cardGroup.length === 1 && board.cardGroup[0] === 0, JSON.stringify(board.cardGroup))
check('board badges render in group 1 (above cards)', board.badgeGroups.length === 1 && board.badgeGroups[0] === 1, JSON.stringify(board.badgeGroups))
check('board play buttons render in group 1 (above cards)', board.playGroups.length === 1 && board.playGroups[0] === 1, JSON.stringify(board.playGroups))
check('board overlays are geometrically in front (z < 0)', board.badgeZ.every((z) => z < 0) && board.playZ.every((z) => z < 0), `badge z=${board.badgeZ} play z=${board.playZ}`)
if (board.centeredDistances) {
  // document that a centered card's center is nearer than its corner button,
  // i.e. the old distance-sort would have drawn the card over the button
  check('a centered card sorts nearer than its own play button (bug precondition)',
    board.centeredDistances.cardDist < board.centeredDistances.playDist,
    JSON.stringify(board.centeredDistances))
}

// ---- thread view ----
const threadRoot = await page.evaluate(() => {
  const f = window.__form0
  const roots = [...f.index.byId.values()].filter((m) => m.role === 'root')
  return (roots.find((m) => f.index.childCount(m.eventId) > 0) ?? roots[0])?.eventId
})
if (threadRoot) {
  await page.evaluate((id) => { location.hash = '#/thread/' + id }, threadRoot)
  await page.waitForFunction(() => window.__form0.engine.activeScene === window.__form0.threadView.scene, { timeout: 10000 }).catch(() => {})
  await page.waitForTimeout(2500)
  const thread = await page.evaluate(() => {
    const tv = window.__form0.threadView
    const nodes = [...tv.nodes.values()]
    return {
      nodes: nodes.length,
      nodeGroup: [...new Set(nodes.map((n) => n.mesh.renderingGroupId))],
      replyGroups: [...new Set(nodes.map((n) => n.reply.renderingGroupId))],
      playGroups: [...new Set(nodes.map((n) => n.play.renderingGroupId))],
      replyZ: [...new Set(nodes.map((n) => +n.reply.position.z.toFixed(3)))],
      playZ: [...new Set(nodes.map((n) => +n.play.position.z.toFixed(3)))],
    }
  })
  check('thread view has nodes', thread.nodes > 0, String(thread.nodes))
  check('thread nodes render in group 0', thread.nodeGroup.length === 1 && thread.nodeGroup[0] === 0, JSON.stringify(thread.nodeGroup))
  check('thread reply pills render in group 1 (above nodes)', thread.replyGroups.length === 1 && thread.replyGroups[0] === 1, JSON.stringify(thread.replyGroups))
  check('thread play buttons render in group 1 (above nodes)', thread.playGroups.length === 1 && thread.playGroups[0] === 1, JSON.stringify(thread.playGroups))
  check('thread overlays are geometrically in front (z < 0)', thread.replyZ.every((z) => z < 0) && thread.playZ.every((z) => z < 0), `reply z=${thread.replyZ} play z=${thread.playZ}`)
  await page.screenshot({ path: 'shots/overlay-order-thread.png' })
} else {
  console.log('no thread root available — skipping thread overlay checks')
}

await page.screenshot({ path: 'shots/overlay-order-board.png' })
await browser.close()
if (errs.length) { console.log('pageerrors:', errs); fails.push('page error') }
if (fails.length) { console.error(`FAILED: ${fails.length}`); process.exit(1) }
console.log('ALL OVERLAY ORDER CHECKS PASSED!')
