// Verification for the network panel behaving as an OVERLAY rather than a
// page: opening `#/network` must not tear down the view behind it, and
// closing it must return to the route it was opened from (board / viewer /
// thread / studio) instead of dumping the player on the board.
//
//   node scripts/offline-rig.mjs      # terminal 1
//   bun run dev                       # terminal 2
//   node scripts/network-panel.mjs    # terminal 3
import { chromium } from 'playwright'

const URL = process.env.TARGET_URL || 'http://localhost:4173/'

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)))

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

const state = () => page.evaluate(() => ({
  hash: location.hash,
  panel: !document.getElementById('network-panel').hidden,
  mode: window.__form0.__mode(),
}))

const openPanel = async () => {
  await page.click('#net-dot')
  await page.waitForTimeout(350)
}
const closePanel = async (how = 'button') => {
  if (how === 'esc') await page.keyboard.press('Escape')
  else await page.click('#btn-network-close')
  await page.waitForTimeout(400)
}

await page.goto(URL, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!window.__form0, null, { timeout: 40000 })
await page.evaluate(() => document.getElementById('btn-legend-ok')?.click())
await page.waitForFunction(() => window.__form0.board?.rows?.length > 0, null, { timeout: 40000 })
await page.waitForTimeout(1200)

// ------------------------------------------------------------------- board
{
  await openPanel()
  const open = await state()
  check('board: panel opens over the board', open.panel && open.mode === 'board', JSON.stringify(open))
  await closePanel()
  const closed = await state()
  check('board: closing returns to the board',
    !closed.panel && closed.mode === 'board' && /^#\/?$/.test(closed.hash), JSON.stringify(closed))
}

// ------------------------------------------------------------------ viewer
{
  const pos = await page.evaluate(() => window.__form0.board.screenPosOf(0))
  await page.mouse.click(pos.x, pos.y)
  await page.waitForFunction(() => location.hash.startsWith('#/viewer/'), null, { timeout: 20000 })
  await page.waitForTimeout(1500)
  const before = await state()
  const meshes = () => page.evaluate(() => window.__form0.viewer.scene.meshes.length)
  const meshesBefore = await meshes()

  await openPanel()
  const open = await state()
  check('viewer: panel opens WITHOUT leaving the viewer',
    open.panel && open.mode === 'viewer', JSON.stringify(open))
  check('viewer: the model behind the panel is untouched',
    (await meshes()) === meshesBefore, `${await meshes()} vs ${meshesBefore}`)

  await closePanel()
  const closed = await state()
  check('viewer: closing returns to the same viewer post',
    !closed.panel && closed.mode === 'viewer' && closed.hash === before.hash,
    `${closed.hash} (was ${before.hash})`)
  check('viewer: the model is still loaded after closing',
    (await meshes()) === meshesBefore, `${await meshes()} vs ${meshesBefore}`)

  // Escape must behave the same way
  await openPanel()
  await closePanel('esc')
  const esc = await state()
  check('viewer: Escape closes the panel and stays in the viewer',
    !esc.panel && esc.mode === 'viewer' && esc.hash === before.hash, JSON.stringify(esc))
}

// ------------------------------------------------------------------ thread
{
  const root = await page.evaluate(() => {
    const f = window.__form0
    for (const m of f.index.byId.values()) if (f.index.childCount(m.eventId) > 0) return m.eventId
    return null
  })
  if (!root) {
    console.log('SKIP  thread checks — no root with replies in the feed')
  } else {
    await page.evaluate((id) => { location.hash = '#/thread/' + id }, root)
    await page.waitForTimeout(2500)
    const before = await state()
    await openPanel()
    const open = await state()
    check('thread: panel opens WITHOUT leaving the thread map',
      open.panel && open.mode === 'thread', JSON.stringify(open))
    await closePanel()
    const closed = await state()
    check('thread: closing returns to the same thread',
      !closed.panel && closed.mode === 'thread' && closed.hash === before.hash,
      `${closed.hash} (was ${before.hash})`)
  }
}

// ------------------------------------------------------------------ studio
{
  await page.evaluate(() => { location.hash = '#/studio' })
  await page.waitForTimeout(1200)
  // put content in the editor: closing the panel must NOT reset the studio
  await page.evaluate(() => {
    const ta = document.getElementById('studio-text')
    document.querySelector('[data-tab="type"]').click()
    ta.value = 'KEEP'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.waitForTimeout(900)
  const before = await state()
  const textBefore = await page.evaluate(() => document.getElementById('studio-text').value)

  await openPanel()
  const open = await state()
  check('studio: panel opens WITHOUT leaving the studio',
    open.panel && open.mode === 'studio', JSON.stringify(open))

  await closePanel()
  const closed = await state()
  check('studio: closing returns to the studio',
    !closed.panel && closed.mode === 'studio' && closed.hash === before.hash,
    `${closed.hash} (was ${before.hash})`)
  const textAfter = await page.evaluate(() => document.getElementById('studio-text').value)
  check('studio: in-progress work survives the panel', textAfter === textBefore && textAfter === 'KEEP',
    JSON.stringify({ textBefore, textAfter }))
}

// --------------------------------------------- deep link + explicit navigation
{
  // a REAL deep link: a cold load straight into #/network, nothing behind it
  await page.goto(URL + '#/network', { waitUntil: 'domcontentloaded' })
  // goto with only a hash difference is a same-document navigation — force a
  // real cold load so nothing is left behind the panel
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.__form0, null, { timeout: 40000 })
  await page.evaluate(() => document.getElementById('btn-legend-ok')?.click())
  await page.waitForTimeout(2000)
  const deep = await state()
  check('cold load of #/network shows the panel over the board',
    deep.panel && deep.mode === 'board', JSON.stringify(deep))
  await closePanel()
  const closed = await state()
  check('deep-linked panel closes to the board', !closed.panel && closed.mode === 'board',
    JSON.stringify(closed))

  // navigating elsewhere WHILE the panel is open must still work
  await openPanel()
  await page.click('#btn-home')
  await page.waitForTimeout(500)
  const home = await state()
  check('navigating away while open closes the panel', !home.panel && home.mode === 'board',
    JSON.stringify(home))
}

check('no page errors', errors.length === 0, errors.join(' | '))
await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall network-panel checks passed')
process.exit(fails.length ? 1 : 0)
