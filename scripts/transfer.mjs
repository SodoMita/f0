// Verification for the network button hit target + the live transfer
// (download/upload speed) readouts. Runs against the OFFLINE rig, which
// serves real GLBs over https://localhost:8443 so the numbers come from an
// actual streamed download, not a simulation.
//
//   node scripts/offline-rig.mjs     # terminal 1
//   bun run dev                      # terminal 2
//   node scripts/transfer.mjs        # terminal 3
import { chromium } from 'playwright'

const URL = process.env.TARGET_URL || 'http://localhost:4173/'

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

async function boot(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!window.__form0, null, { timeout: 40000 })
  await page.evaluate(() => document.getElementById('btn-legend-ok')?.click())
  // record every meter snapshot so we can assert on the whole transfer
  await page.evaluate(() => {
    window.__xfer = []
    window.__form0.transfers.subscribe((s) => window.__xfer.push(JSON.parse(JSON.stringify(s))))
  })
}

// ---------------------------------------------------------------- hit target
{
  const page = await browser.newPage({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true })
  await boot(page)
  const box = await page.locator('#net-dot').boundingBox()
  check('network button is a real tap target (>= 40x40)',
    box.width >= 40 && box.height >= 40, `${box.width}x${box.height}`)

  // spacing: the target must not overlap its neighbour (WCAG 2.5.5 spacing)
  const gap = await page.evaluate(() => {
    const a = document.getElementById('net-dot').getBoundingClientRect()
    const b = document.getElementById('btn-shuffle').getBoundingClientRect()
    return Math.round(b.left - a.right)
  })
  check('network button does not overlap the next control', gap >= 0, `gap=${gap}px`)

  // a sloppy touch 14px off centre used to miss the 8px dot entirely
  await page.evaluate(() => { window.location.hash = '#/' })
  await page.waitForTimeout(200)
  await page.touchscreen.tap(box.x + box.width / 2 + 14, box.y + box.height / 2 + 14)
  await page.waitForTimeout(400)
  check('off-centre tap (14px) still opens the network panel',
    !(await page.locator('#network-panel').isHidden()))
  await page.close()
}

// ------------------------------------------------------- real download speed
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await boot(page)
  await page.waitForFunction(() => window.__form0.board?.rows?.length > 0, null, { timeout: 40000 })
  // force a network fetch: drop the caches so the model cannot come from IDB
  await page.evaluate(() => window.__form0.assets.clearCaches())
  const pos = await page.evaluate(() => window.__form0.board.screenPosOf(0))
  await page.mouse.click(pos.x, pos.y)

  // the meter must observe the model fetch as an in-flight download
  const sawActive = await page.waitForFunction(
    () => (window.__xfer || []).some((s) => s.down.active > 0),
    null, { timeout: 20000 },
  ).then(() => true).catch(() => false)
  check('a model open registers an in-flight download', sawActive)

  // Session counter, not a mid-flight snapshot: the rig's GLBs are small
  // enough to finish inside one 200 ms sample tick.
  const moved = await page.evaluate(() => window.__form0.transfers.stats().session.down)
  check('download byte counter advances', moved > 0, `${moved} B`)

  const sized = await page.evaluate(() =>
    (window.__xfer || []).some((s) => s.down.active > 0 && s.down.total > 0))
  check('download knows its expected total (progress is determinate)', sized)

  const idle = await page.evaluate(() => {
    const s = window.__form0.transfers.stats()
    return { active: s.active, down: s.down.active, bps: s.down.bps }
  })
  check('meter returns to idle after the transfer', !idle.active && idle.down === 0, JSON.stringify(idle))

  const panelIdle = await page.evaluate(() => document.getElementById('net-down').textContent)
  check('idle panel row reports the session total', /this session/.test(panelIdle), panelIdle)

  const hudClean = await page.evaluate(() => ({
    rateHidden: document.getElementById('loading-rate').hidden,
    barHidden: document.getElementById('loading-bar').hidden,
    topbar: document.getElementById('net-rate').hidden,
    busy: document.getElementById('net-dot').classList.contains('busy'),
  }))
  check('idle hides every transfer readout',
    hudClean.rateHidden && hudClean.barHidden && hudClean.topbar && !hudClean.busy,
    JSON.stringify(hudClean))
  await page.close()
}

// -------------------------------------------------- formatting + upload path
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await boot(page)
  const out = await page.evaluate(async () => {
    const f = window.__form0
    const u = f.transfers.track('up', 4 * 1048576)
    for (let i = 0; i < 8; i++) {
      u.advance(256 * 1024)
      await new Promise((r) => setTimeout(r, 120))
    }
    const s = f.transfers.stats()
    const hud = {
      loading: document.getElementById('loading-rate').textContent,
      topbar: document.getElementById('net-rate').textContent,
      panelUp: document.getElementById('net-up').textContent,
      busy: document.getElementById('net-dot').classList.contains('busy'),
    }
    u.end()
    return { s, hud }
  })
  check('upload direction is metered', out.s.up.active > 0 && out.s.up.bps > 0,
    `${Math.round(out.s.up.bps)} B/s`)
  check('topbar shows an upload rate', /^↑ .*\/s$/.test(out.hud.topbar.trim()), out.hud.topbar)
  check('network panel shows upload speed + progress',
    /↑?\s*[\d.]+ \w+\/s · .*% *$/.test(out.hud.panelUp) || /\/s ·/.test(out.hud.panelUp), out.hud.panelUp)
  check('network button pulses while transferring', out.hud.busy)
  await page.close()
}

// ------------------------------------------- per-server rows in the panel
{
  const page = await browser.newPage({ viewport: { width: 900, height: 980 } })
  await boot(page)
  await page.waitForFunction(() => window.__form0.board?.rows?.length > 0, null, { timeout: 40000 })
  await page.waitForTimeout(1500)
  // the rig serves its models from https://localhost:8443 — registering it as
  // a Blossom server gives the per-server rows a host that really moves bytes
  await page.evaluate(() => window.__form0.blossoms.setServers(
    ['https://localhost:8443', ...window.__form0.blossoms.servers]))
  await page.click('#net-dot')
  await page.waitForTimeout(2500)

  const rowOf = (host) => page.evaluate((h) => {
    const li = [...document.querySelectorAll('#relay-list .net-item, #blossom-list .net-item')]
      .find((n) => n.querySelector('.url')?.textContent.includes(h))
    if (!li) return null
    const dot = li.querySelector('.net-state')
    return {
      list: li.closest('ul').id,
      status: li.querySelector('.net-status').textContent,
      statusCls: li.querySelector('.net-status').className,
      ping: li.querySelector('.net-ping').textContent,
      pingCls: li.querySelector('.net-ping').className,
      flow: li.querySelector('.net-flow').textContent,
      dotCls: dot.className,
      dotBg: getComputedStyle(dot).backgroundColor,
    }
  }, host)

  const relay = await rowOf('localhost:8443')
  check('relay row says what the connection is doing, not just a colour',
    relay && /connected|connecting|offline/.test(relay.status), JSON.stringify(relay))
  check('relay row shows a round-trip ping', /^\d+ ms$/.test(relay.ping), relay.ping)
  check('ping is bucketed (good/fair/slow), not a bare number',
    /good|fair|slow/.test(relay.pingCls), relay.pingCls)
  check('relay row reports how much of the feed it carried',
    /events?$/.test(relay.flow.trim()), relay.flow)

  // an unreachable server must be visibly, describably down
  const dead = await rowOf('nostr.download')
  check('unreachable server says "unreachable"', dead && dead.status === 'unreachable',
    JSON.stringify(dead))
  check('offline dot is actually painted (--danger exists in the dark theme)',
    dead && dead.dotBg !== 'rgba(0, 0, 0, 0)' && dead.dotBg !== 'transparent', dead && dead.dotBg)
  check('unreachable server shows no ping', dead && dead.ping === '—', dead && dead.ping)

  // real per-server download attribution
  await page.evaluate(async () => {
    const f = window.__form0
    await f.assets.clearCaches()
    const metas = [...f.index.byId.values()].slice(0, 6)
    window.__dl = Promise.all(metas.map((m) => f.assets.getModel(m)))
  })
  await page.waitForTimeout(1200)
  const host = await page.evaluate(() =>
    window.__form0.transfers.hostStats('https://localhost:8443').session.down)
  check('downloads are attributed to the server that served them', host > 0, `${host} B`)
  const other = await page.evaluate(() =>
    window.__form0.transfers.hostStats('https://nostr.download').session.down)
  check('a server that served nothing stays at zero', other === 0, `${other} B`)

  // a live per-server rate must appear on that row
  await page.evaluate(() => {
    const u = window.__form0.transfers.track('up', 6 * 1048576, 'https://localhost:8443')
    window.__u = u
    window.__uiv = setInterval(() => u.advance(200 * 1024), 100)
  })
  await page.waitForTimeout(1300)
  const busy = await rowOf('localhost:8443/')
  const blossomRow = busy && busy.list === 'blossom-list' ? busy : await page.evaluate(() => {
    const li = [...document.querySelectorAll('#blossom-list .net-item')]
      .find((n) => n.querySelector('.url')?.textContent.includes('localhost:8443'))
    return { flow: li.querySelector('.net-flow').textContent, status: li.querySelector('.net-status').textContent }
  })
  check('the serving row shows its own live upload rate',
    /↑ .*\/s/.test(blossomRow.flow), blossomRow.flow)
  const quiet = await rowOf('blossom.primal.net')
  check('an idle server row does not borrow another server\'s rate',
    !/\/s/.test(quiet.flow), quiet.flow)

  await page.evaluate(() => { clearInterval(window.__uiv); window.__u.end() })
  await page.waitForTimeout(700)
  const after = await page.evaluate(() => {
    const li = [...document.querySelectorAll('#blossom-list .net-item')]
      .find((n) => n.querySelector('.url')?.textContent.includes('localhost:8443'))
    return li.querySelector('.net-flow').textContent
  })
  check('once idle the row falls back to per-server session totals',
    /↓|↑/.test(after) && !/\/s/.test(after), after)
  await page.close()
}

await browser.close()
console.log(fails.length ? `\n${fails.length} FAILED: ${fails.join(', ')}` : '\nall transfer checks passed')
process.exit(fails.length ? 1 : 0)
