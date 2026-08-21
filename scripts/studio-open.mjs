// Guard: opening the studio must close the board. Board-only chrome
// (search / shuffle / 3D / create) must not stay clickable, cards must
// not stay pickable, and a tap where a card was must not leave studio.
import { chromium } from 'playwright'

const URL = process.env.TARGET_URL || 'http://localhost:4173/'
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
await page.waitForFunction(() => window.__form0.board.rows.length > 0, { timeout: 30000 })
await page.waitForTimeout(800)

const card0 = await page.evaluate(() => window.__form0.board.screenPosOf(0))
await page.evaluate(() => { location.hash = '#/studio' })
await page.waitForFunction(() => window.__form0.__mode() === 'studio', { timeout: 10000 })
await page.waitForTimeout(400)

const snap = await page.evaluate(() => {
  const f = window.__form0
  const vis = (id) => {
    const el = document.getElementById(id)
    if (!el) return false
    const r = el.getBoundingClientRect()
    const st = getComputedStyle(el)
    return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
  }
  return {
    mode: f.__mode(),
    active: f.engine.activeScene === f.studio.scene ? 'studio'
      : f.engine.activeScene === f.board.scene ? 'board' : 'other',
    studioHidden: document.getElementById('studio').hidden,
    pickable: f.board.cards.filter((c) => c.mesh.isEnabled()).map((c) => c.mesh.isPickable),
    shuffle: vis('btn-shuffle'),
    threeD: vis('btn-3d'),
    search: vis('btn-search'),
    add: vis('btn-add'),
    home: vis('btn-home'),
    bodyMode: document.body.dataset.mode,
  }
})

check('mode is studio', snap.mode === 'studio', snap.mode)
check('active scene is studio', snap.active === 'studio', snap.active)
check('studio HUD is showing', snap.studioHidden === false)
check('body data-mode is studio', snap.bodyMode === 'studio', snap.bodyMode)
check('shuffle is hidden in studio', snap.shuffle === false)
check('3D toggle is hidden in studio', snap.threeD === false)
check('search is hidden in studio', snap.search === false)
check('create (+) is hidden in studio', snap.add === false)
check('home stays so you can leave', snap.home === true)
check('board cards are not pickable', snap.pickable.every((p) => p === false),
  JSON.stringify(snap.pickable.slice(0, 8)))

if (card0) {
  await page.mouse.click(card0.x, card0.y)
  await page.waitForTimeout(400)
  const after = await page.evaluate(() => ({ hash: location.hash, mode: window.__form0.__mode() }))
  check('tap where a card was does not leave studio', after.hash === '#/studio' && after.mode === 'studio',
    JSON.stringify(after))
}

check('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '))
await browser.close()
console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL CHECKS PASSED')
process.exit(fails.length ? 1 : 0)
