// Find text that overflows its box on every page/overlay (the studio-status
// bug class: content that cannot wrap and gets clipped by overflow:hidden).
//   node scripts/overflow-scan.mjs   (against the offline rig at :4173)
import { chromium } from 'playwright'

const URL = process.env.TARGET_URL || 'http://localhost:4173/'
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_PATH || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
})

const results = []
const scan = async (page, label, onlyVisible = true) => {
  const found = await page.evaluate((only) => {
    const out = []
    const els = document.querySelectorAll('body *')
    for (const el of els) {
      if (el instanceof HTMLElement === false) continue
      if (el.closest('canvas')) continue
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'NOSCRIPT') continue
      if (el.closest('[hidden]')) continue
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      if (only && el.getBoundingClientRect().width === 0) continue
      const r = el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) continue
      if (cs.display === 'inline') continue
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.tagName === 'CANVAS' || el.tagName === 'SVG') continue
      // has text content?
      const txt = (el.childNodes.length ? [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ') : el.textContent || '').trim()
      if (!txt) continue
      if (el.scrollWidth <= el.clientWidth + 2 && r.right <= innerWidth + 1 && r.left >= -1) continue
      const intentional = cs.textOverflow === 'ellipsis' && cs.overflowX !== 'visible'
      const clipped = cs.overflowX !== 'visible'
      // viewport out-of-bounds: fixed/absolute text that grows past the
      // right edge (no clipping ancestor, so scrollWidth won't flag it)
      const offScreen = r.right > innerWidth + 1
      const id = el.id ? `#${el.id}` : ''
      const cls = typeof el.className === 'string' && el.className ? '.' + el.className.split(/\s+/).slice(0, 2).join('.') : ''
      out.push({
        el: `${el.tagName.toLowerCase()}${id}${cls}`,
        overflow: Math.max(el.scrollWidth - el.clientWidth, Math.round(r.right - innerWidth)),
        scrollW: el.scrollWidth, clientW: el.clientWidth,
        whiteSpace: cs.whiteSpace,
        clipped,
        offScreen,
        intentional,
        text: txt.slice(0, 70),
        viewport: r.width,
      })
    }
    return out
  }, onlyVisible)
  if (found.length) {
    console.log(`\n===== ${label} (${found.length} overflow elements) =====`)
    for (const f of found) {
      const flag = f.intentional ? 'INTENTIONAL' : (f.offScreen ? 'OFFSCREEN' : f.clipped ? 'CLIPPED' : 'OVERFLOW')
      console.log(`  ${flag.padEnd(11)} ${f.el}  +${f.overflow}px (${f.scrollW}/${f.clientW}) ws=${f.whiteSpace} vw=${f.viewport}  "${f.text}"`)
      if (!f.intentional) results.push({ label, ...f })
    }
  } else {
    console.log(`\n===== ${label}: clean =====`)
  }
}

const browserWide = await browser.newPage({ viewport: { width: 1280, height: 800 } })
browserWide.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 160)))
await browserWide.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
await browserWide.waitForFunction(() => window.__form0?.board, { timeout: 30000 })
await browserWide.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await browserWide.waitForTimeout(15000)

// ---- board (home)
await scan(browserWide, 'board')

// ---- dev perf overlay (white-space: pre, can grow past the viewport)
await browserWide.evaluate(() => { document.body.classList.add('show-perf') })
await browserWide.waitForTimeout(800)
await browserWide.evaluate(() => {
  const el = document.getElementById('perf-overlay')
  el.textContent = '1280×800 @1×   frame 16.7 ms   renders 12345   heap 999 MB   live 12'
})
await browserWide.waitForTimeout(200)
await scan(browserWide, 'perf overlay')
await browserWide.evaluate(() => document.body.classList.remove('show-perf'))

// ---- legend
await browserWide.evaluate(() => window.__form0.legend.open())
await browserWide.waitForTimeout(300)
await scan(browserWide, 'legend')
await browserWide.evaluate(() => window.__form0.legend.close())

// ---- search panel with a LONG query (hint shows the query text)
await browserWide.evaluate(() => window.__form0.setSearchOpen(true))
await browserWide.waitForTimeout(300)
await browserWide.evaluate(() => {
  const i = document.getElementById('search-input')
  i.value = 'supercalifragilisticexpialidocious-model-name-with-a-very-long-hyphenated-suffix'
  i.dispatchEvent(new Event('input'))
})
await browserWide.waitForTimeout(300)
await scan(browserWide, 'search (long query)')
await browserWide.evaluate(() => window.__form0.setSearchOpen(false))

// ---- settings
await browserWide.evaluate(() => window.__form0.settingsPanel.open())
await browserWide.waitForTimeout(300)
await scan(browserWide, 'settings')
await browserWide.evaluate(() => window.__form0.settingsPanel.close())

// ---- network panel
await browserWide.evaluate(() => window.__form0.networkPanel.open())
await browserWide.waitForTimeout(1500)
await scan(browserWide, 'network panel')
await browserWide.evaluate(() => window.__form0.networkPanel.close())

// ---- studio (empty) + long error status
await browserWide.evaluate(() => window.__form0.router.go({ name: 'studio' }))
await browserWide.waitForTimeout(800)
await scan(browserWide, 'studio (empty)')
await browserWide.evaluate(() => {
  const el = document.getElementById('studio-status')
  el.textContent = 'Model upload failed on every Blossom server: https://blossom.example.org:3000/upload failed (500) — try again in a moment.'
  el.className = 'studio-status err'
})
await browserWide.waitForTimeout(200)
await scan(browserWide, 'studio (long error status)')

// ---- toast with a long message
await browserWide.evaluate(() => {
  const t = document.getElementById('toast')
  t.hidden = false
  t.textContent = 'delete failed on all relays: wss://relay.example.org:7777/hook?session=supercalifragilistic-expialidocious'
})
await browserWide.waitForTimeout(200)
await scan(browserWide, 'toast (long message)')
await browserWide.evaluate(() => { document.getElementById('toast').hidden = true })

// ---- error sheet with a long cause
await browserWide.evaluate(() => window.__form0.errorSheet.show({
  code: 'E999',
  cause: 'The selected file is not a valid GLB within limits (20 MiB, magic bytes, sane JSON chunk): https://blossom.example.org:3000/upload returned a body that could not be parsed as a verified model and the retry policy gave up after three attempts across all replicas.',
  action: 'dismiss',
  onAction: () => {},
}))
await browserWide.waitForTimeout(300)
await scan(browserWide, 'error sheet (long cause)')
await browserWide.evaluate(() => window.__form0.errorSheet.hide())

// ---- viewer with a real model from the rig
const ids = await browserWide.evaluate(() => [...window.__form0.index.byId.values()].filter((m) => m.role === 'root' && !m.tombstoned).slice(0, 6).map((m) => m.eventId))
console.log('\nroot ids available:', ids.length)
if (ids.length) {
  await browserWide.evaluate((id) => window.__form0.router.go({ name: 'viewer', id }), ids[0])
  await browserWide.waitForTimeout(6000)
  await scan(browserWide, 'viewer')
}

// ---- thread map
if (ids.length) {
  await browserWide.evaluate((id) => window.__form0.router.go({ name: 'thread', rootId: id }), ids[0])
  await browserWide.waitForTimeout(5000)
  await scan(browserWide, 'thread')
}

// ---- meta drawer (open on viewer again)
await browserWide.evaluate((id) => window.__form0.router.go({ name: 'viewer', id }), ids[0])
await browserWide.waitForTimeout(4000)
await browserWide.evaluate(() => { (document.getElementById('btn-meta')).click() })
await browserWide.waitForTimeout(400)
await scan(browserWide, 'meta drawer')

// ---- 320px (small phone) pass: board + dev perf overlay + studio status
const tiny = await browser.newPage({ viewport: { width: 320, height: 700 } })
tiny.on('pageerror', (e) => console.log('[pageerror tiny]', e.message.slice(0, 160)))
await tiny.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
await tiny.waitForFunction(() => window.__form0?.board, { timeout: 30000 })
await tiny.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await tiny.waitForTimeout(12000)
await scan(tiny, 'board @320px')
await tiny.evaluate(() => { document.body.classList.add('show-perf') })
await tiny.waitForTimeout(800)
await tiny.evaluate(() => {
  const el = document.getElementById('perf-overlay')
  el.textContent = '320×700 @1×   frame 16.7 ms   renders 12345   heap 999 MB   live 12'
})
await tiny.waitForTimeout(200)
await scan(tiny, 'perf overlay @320px')
await tiny.evaluate(() => document.body.classList.remove('show-perf'))
await tiny.evaluate(() => window.__form0.router.go({ name: 'studio' }))
await tiny.waitForTimeout(800)
await tiny.evaluate(() => {
  const el = document.getElementById('studio-status')
  el.textContent = 'Model upload failed on every Blossom server: https://blossom.example.org:3000/upload failed (500) — try again in a moment.'
  el.className = 'studio-status err'
})
await tiny.waitForTimeout(200)
await scan(tiny, 'studio (long error status) @320px')

// ---- narrow viewport pass on every surface (the classic overflow trigger)
const narrow = await browser.newPage({ viewport: { width: 390, height: 780 } })
narrow.on('pageerror', (e) => console.log('[pageerror narrow]', e.message.slice(0, 160)))
await narrow.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
await narrow.waitForFunction(() => window.__form0?.board, { timeout: 30000 })
await narrow.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await narrow.waitForTimeout(12000)
const nids = await narrow.evaluate(() => [...window.__form0.index.byId.values()].filter((m) => m.role === 'root' && !m.tombstoned).slice(0, 6).map((m) => m.eventId))

await scan(narrow, 'board @390px')
await narrow.evaluate(() => window.__form0.legend.open())
await narrow.waitForTimeout(300)
await scan(narrow, 'legend @390px')
await narrow.evaluate(() => window.__form0.legend.close())

await narrow.evaluate(() => window.__form0.setSearchOpen(true))
await narrow.waitForTimeout(200)
await narrow.evaluate(() => {
  const i = document.getElementById('search-input')
  i.value = 'supercalifragilisticexpialidocious-model-name-with-a-very-long-hyphenated-suffix'
  i.dispatchEvent(new Event('input'))
})
await narrow.waitForTimeout(200)
await scan(narrow, 'search (long query) @390px')
await narrow.evaluate(() => window.__form0.setSearchOpen(false))

await narrow.evaluate(() => window.__form0.networkPanel.open())
await narrow.waitForTimeout(1500)
await scan(narrow, 'network panel @390px')
await narrow.evaluate(() => window.__form0.networkPanel.close())

await narrow.evaluate(() => window.__form0.settingsPanel.open())
await narrow.waitForTimeout(300)
await scan(narrow, 'settings @390px')
await narrow.evaluate(() => window.__form0.settingsPanel.close())

await narrow.evaluate(() => window.__form0.router.go({ name: 'studio' }))
await narrow.waitForTimeout(800)
await narrow.evaluate(() => {
  const el = document.getElementById('studio-status')
  el.textContent = 'Model upload failed on every Blossom server: https://blossom.example.org:3000/upload failed (500) — try again in a moment.'
  el.className = 'studio-status err'
})
await narrow.waitForTimeout(200)
await scan(narrow, 'studio (long error status) @390px')

await narrow.evaluate(() => {
  const t = document.getElementById('toast')
  t.hidden = false
  t.textContent = 'delete failed on all relays: wss://relay.example.org:7777/hook?session=supercalifragilistic-expialidocious'
})
await narrow.waitForTimeout(200)
await scan(narrow, 'toast (long message) @390px')
await narrow.evaluate(() => { document.getElementById('toast').hidden = true })

await narrow.evaluate(() => window.__form0.errorSheet.show({
  code: 'E999',
  cause: 'The selected file is not a valid GLB within limits (20 MiB, magic bytes, sane JSON chunk): https://blossom.example.org:3000/upload returned a body that could not be parsed as a verified model and the retry policy gave up after three attempts across all replicas.',
  action: 'dismiss',
  onAction: () => {},
}))
await narrow.waitForTimeout(300)
await scan(narrow, 'error sheet (long cause) @390px')
await narrow.evaluate(() => window.__form0.errorSheet.hide())

if (nids.length) {
  await narrow.evaluate((id) => window.__form0.router.go({ name: 'viewer', id }), nids[0])
  await narrow.waitForTimeout(6000)
  await scan(narrow, 'viewer @390px')
  await narrow.evaluate(() => { (document.getElementById('btn-meta')).click() })
  await narrow.waitForTimeout(400)
  await scan(narrow, 'meta drawer @390px')
  await narrow.evaluate((id) => window.__form0.router.go({ name: 'thread', rootId: id }), nids[0])
  await narrow.waitForTimeout(5000)
  await scan(narrow, 'thread @390px')
}

await browser.close()
console.log(`\n===== ${results.length} NON-INTENTIONAL OVERFLOWS =====`)
for (const r of results) console.log(`  [${r.label}] ${r.el}  +${r.overflow}px ws=${r.whiteSpace} "${r.text}"`)
if (results.length) { console.error(`FAILED: ${results.length}`); process.exit(1) }
console.log('ALL PASS')
