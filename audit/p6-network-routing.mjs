// Phase 6 — network panel: open, relay list, add/remove relay, probe button,
// error copy; plus routing: deep links, refresh, back button, unknown ids.
import { launch, newRecorder, open, URL_BASE, sleep } from './harness.mjs'

const browser = await launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const rec = newRecorder(page, 'p6')
const F = []
const f = (id, t) => { F.push(`${id}: ${t}`); console.log(`  FINDING ${id}: ${t}`) }

await open(page, URL_BASE)
await page.evaluate(() => document.querySelector('#btn-legend-ok')?.click())
await sleep(1500)

// network dot click opens panel
await page.evaluate(() => document.getElementById('net-dot')?.click())
await sleep(1200)
await rec.shot('01-network-panel')
const np = await page.evaluate(() => {
  const p = document.getElementById('network-panel')
  const relays = [...p.querySelectorAll('#relay-list *')].filter((x) => x.children.length === 0 && (x.textContent || '').trim()).map((x) => (x.textContent || '').trim().slice(0, 40))
  return { open: getComputedStyle(p).display, relays: relays.slice(0, 8), blossoms: [...p.querySelectorAll('#blossom-list *')].filter((x) => x.children.length === 0 && (x.textContent || '').trim()).map((x) => (x.textContent || '').trim().slice(0, 30)).slice(0, 5) }
})
console.log('network panel:', JSON.stringify(np))
if (np.open === 'none') f('P6-1', 'net-dot click did not open the network panel')

// add a bogus relay
await page.evaluate(() => {
  const i = document.getElementById('relay-add')
  i.value = 'wss://nonexistent.example.invalid'
  i.dispatchEvent(new Event('change', { bubbles: true }))
  i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
})
await sleep(2500)
await rec.shot('02-after-bogus-relay')
const np2 = await page.evaluate(() => {
  const p = document.getElementById('network-panel')
  const txt = (p.textContent || '').replace(/\s+/g, ' ')
  return { hasBogus: txt.includes('nonexistent.example.invalid'), snippet: txt.slice(0, 300) }
})
console.log('after bogus relay add:', JSON.stringify(np2))

// Escape should close the network panel (main.ts has that branch)
await page.keyboard.press('Escape')
await sleep(700)
const npClosed = await page.evaluate(() => getComputedStyle(document.getElementById('network-panel')).display)
console.log('network panel after Escape:', npClosed)
if (npClosed !== 'none') f('P6-2', 'network panel does not close on Escape')

// ---- routing: deep link to viewer then BACK should return to board
await page.evaluate(() => { location.hash = '#/' })
await sleep(1000)
const rid = await page.evaluate(() => { const r = [...window.__form0.index.byId.values()].find((m) => m.role === 'root' && !m.tombstoned); return r.eventId })
await page.evaluate((r) => { location.hash = '#/viewer/' + r }, rid)
await sleep(2500)
await page.goBack()
await sleep(1500)
const backState = await page.evaluate(() => ({ hash: location.hash, mode: window.__form0.__mode() }))
console.log('after browser Back:', JSON.stringify(backState))
if (backState.mode !== 'board') f('P6-3', `browser Back from viewer lands in "${backState.mode}" (hash ${backState.hash})`)

// forward again
await page.goForward()
await sleep(2500)
const fwd = await page.evaluate(() => ({ hash: location.hash, mode: window.__form0.__mode() }))
console.log('after Forward:', JSON.stringify(fwd))
if (fwd.mode !== 'viewer') f('P6-4', `browser Forward lands in "${fwd.mode}"`)

// deep link while board not yet ready: reload directly into a viewer URL
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__form0?.board, null, { timeout: 20000 }).catch(() => {})
await sleep(4000)
const deep = await page.evaluate(() => ({ hash: location.hash, mode: window.__form0.__mode() }))
console.log('after reload on viewer deep link:', JSON.stringify(deep))
if (deep.mode !== 'viewer') f('P6-5', `deep link #/viewer/<id> after reload lands in "${deep.mode}"`)
await rec.shot('03-deep-link-reload')

// unknown event id
await page.evaluate(() => { location.hash = '#/viewer/' + 'f'.repeat(64) })
await sleep(4000)
const unk = await page.evaluate(() => ({ mode: window.__form0.__mode(), hash: location.hash, err: !document.getElementById('error-sheet')?.hidden, errCode: (document.getElementById('error-code')?.textContent || '') + ':' + (document.getElementById('error-cause')?.textContent || '').slice(0, 90) }))
console.log('unknown id viewer:', JSON.stringify(unk))
await rec.shot('04-unknown-id')
if (unk.err) f('P6-6', `unknown event id shows error sheet: ${unk.errCode}`)

// thread deep link for unknown root
await page.evaluate(() => { location.hash = '#/thread/' + 'e'.repeat(64) })
await sleep(3500)
const unkT = await page.evaluate(() => ({ mode: window.__form0.__mode(), hash: location.hash }))
console.log('unknown thread:', JSON.stringify(unkT))
await rec.shot('05-unknown-thread')

console.log(`\n=== PHASE6 FINDINGS (${F.length}) ===`)
F.forEach((x, i) => console.log(`${i + 1}. ${x}`))
await browser.close()
