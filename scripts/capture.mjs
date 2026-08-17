// Visual capture: board / viewer / thread / settings screenshots for design review.
import { chromium } from 'playwright'

const URL = process.env.TARGET_URL || 'http://localhost:5173/'
const WAIT = Number(process.env.WAIT_MS || 20000)
const OUT = process.env.OUT_DIR || 'shots'

import { mkdirSync } from 'node:fs'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const logs = []
page.on('console', (m) => { if (m.type() === 'error') logs.push(`[err] ${m.text().slice(0, 140)}`) })
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message.slice(0, 200)}`))

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForFunction(() => window.__form0 && window.__form0.board, null, { timeout: 15000 }).catch(() => {})

// first-run legend is modal by design; dismiss it like a user would
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await page.waitForTimeout(WAIT)

// --- board top ---
await page.screenshot({ path: `${OUT}/board_top.png` })

const board = await page.evaluate(() => {
  const b = window.__form0.board
  const visible = b.cards.filter((c) => c.meta && c.mesh.isEnabled())
  return {
    events: window.__form0.index.byId.size,
    visibleCards: visible.length,
    ids: visible.map((c) => c.meta.eventId.slice(0, 8)),
    replyCounts: visible.map((c) => c.replyCount),
    scrollY: +b.scrollY.toFixed(2),
    maxScroll: +b.maxScroll.toFixed(2),
    cardHeights: visible.map((c) => +c.mesh.getBoundingInfo().boundingBox.extendSize.y.toFixed(2)),
    cardScales: visible.map((c) => c.mesh.scaling.asArray().map((n) => +n.toFixed(2)).join('x')),
    hasReplies: visible.map((c) => c.badge.isEnabled()),
  }
})
console.log('BOARD', JSON.stringify(board, null, 1))

// --- scroll down a bit for a mid-board shot ---
await page.mouse.move(640, 400)
for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 500)
await page.waitForTimeout(600)
await page.screenshot({ path: `${OUT}/board_mid.png` })
for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -500)
await page.waitForTimeout(600)

// --- viewer: click first card ---
const pos = await page.evaluate(() => window.__form0.board.screenPosOf(0))
if (pos) {
  await page.mouse.move(pos.x, pos.y)
  await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up()
  await page.waitForTimeout(4000)
  const v = await page.evaluate(() => ({
    hash: location.hash,
    cameras: window.__form0.viewer?.cameraCount,
    camIndex: window.__form0.viewer?.camIndex,
    stats: window.__form0.viewer?.stats(),
  }))
  console.log('VIEWER', JSON.stringify(v))
  await page.screenshot({ path: `${OUT}/viewer.png` })
  // metadata drawer
  await page.keyboard.press('KeyM')
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT}/viewer_meta.png` })
  await page.keyboard.press('KeyM')
  await page.waitForTimeout(300)
  await page.evaluate(() => { location.hash = '#/' })
  await page.waitForTimeout(800)
}

// --- thread view: find a root with replies ---
const threadRoot = await page.evaluate(() => {
  const f = window.__form0
  const roots = [...f.index.byId.values()].filter((m) => m.role === 'root' && !m.tombstoned)
  return roots.find((m) => f.index.childCount(m.eventId) > 0)?.eventId ?? null
})
console.log('THREAD root:', threadRoot?.slice(0, 8))
if (threadRoot) {
  await page.evaluate((id) => { location.hash = '#/thread/' + id }, threadRoot)
  await page.waitForTimeout(4500)
  await page.screenshot({ path: `${OUT}/thread.png` })
  await page.evaluate(() => { location.hash = '#/' })
  await page.waitForTimeout(600)
}

// --- settings ---
await page.evaluate(() => document.querySelector('#btn-settings')?.click())
await page.waitForTimeout(400)
await page.screenshot({ path: `${OUT}/settings.png` })
await page.evaluate(() => document.querySelector('#btn-settings')?.click())
await page.waitForTimeout(200)

// --- light theme board ---
await page.evaluate(() => document.querySelector('.swatch[data-bg="#ffffff"]')?.click())
await page.waitForTimeout(600)
await page.screenshot({ path: `${OUT}/board_light.png` })
await page.evaluate(() => document.querySelector('.swatch[data-bg="#0B0B0C"]')?.click())
await page.evaluate(() => document.querySelector('#btn-settings')?.click())
await page.waitForTimeout(500)

// --- phone viewport ---
const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
await phone.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
await phone.waitForFunction(() => window.__form0 && window.__form0.board, null, { timeout: 15000 }).catch(() => {})
await phone.waitForTimeout(WAIT)
await phone.screenshot({ path: `${OUT}/board_phone.png` })

console.log('LOGS', JSON.stringify(logs, null, 1))
await browser.close()
