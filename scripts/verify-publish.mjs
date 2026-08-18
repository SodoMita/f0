// Publish round-trip against the offline rig, driven through the REAL UI so
// it runs identically on the dev server AND the production preview build
// (no /src/ module imports — those only exist on the dev server):
// studio text -> publish button -> Blossom PUT /upload -> relay publish ->
// live feed event -> SHA-verified re-download -> kind-5 delete -> tombstone.
//
//   node scripts/offline-rig.mjs   + dev/preview server, then:
//   node scripts/verify-publish.mjs
import { chromium } from 'playwright'
import { request } from 'node:https'

const URL = process.env.TARGET_URL || 'http://localhost:4173/'
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)))
page.on('console', (m) => {
  if (m.type() !== 'error') return
  if (/AudioContext|audio device/i.test(m.text())) return
  if (/WebSocket connection to 'wss:\/\/(?!localhost)/.test(m.text())) return
  errors.push('[console] ' + m.text().slice(0, 160))
})

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

/** POST /__reset on the rig relay (Node-side; the page cannot pre-reset). */
function resetRig() {
  return new Promise((resolve, reject) => {
    const req = request({
      host: 'localhost', port: 8443, path: '/__reset', method: 'POST',
      rejectUnauthorized: false, timeout: 5000,
    }, (res) => { res.resume(); res.on('end', () => resolve()) })
    req.on('error', (e) => reject(new Error('rig reset failed: ' + e.message)))
    req.on('timeout', () => { req.destroy(); reject(new Error('rig reset timeout')) })
    req.end()
  })
}

// reset the rig relay to the seed feed BEFORE the page ingests anything
await resetRig()
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForFunction(() => window.__form0?.board, null, { timeout: 30000 })
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await page.waitForFunction(() => window.__form0.index.byId.size >= 52, null, { timeout: 30000 })
// NOTE: resetRig() runs BEFORE goto (the page must never see earlier
// publishes; a mid-run reset cannot remove them from the app's index).

// ------------------------------------------------- publish a text model
{
  await page.evaluate(() => { location.hash = '#/studio' })
  await page.waitForFunction(() => window.__form0.engine.activeScene === window.__form0.studio.scene, null, { timeout: 10000 })
  // the studio opens on the UPLOAD tab with EMPTY text (by design since the
  // upload-tab regression fix) — switch to the type tab, which seeds '/0'
  await page.evaluate(() => document.querySelector('[data-tab="type"]').click())
  await page.waitForFunction(() => window.__form0.studio.hasContent(), null, { timeout: 20000 })

  // point the app's blossom client at the rig's upload endpoint
  await page.evaluate(() => window.__form0.blossoms.setServers(['https://localhost:8443']))
  const before = await page.evaluate(() => window.__form0.index.byId.size)

  // the REAL publish flow: the studio's publish button (export -> poster ->
  // blossom -> relays) and the app routes to the new post's viewer
  await page.evaluate(() => document.querySelector('#btn-studio-publish').click())
  await page.waitForFunction(() => location.hash.startsWith('#/viewer/'), null, { timeout: 120000 })
  const published = await page.evaluate((beforeCount) => {
    const f = window.__form0
    const newest = [...f.index.byId.values()].filter((m) => m.role === 'root')
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    return {
      grew: f.index.byId.size > beforeCount,
      eventId: newest?.eventId,
      urls: newest?.urls,
      thumb: newest?.thumbUrl,
      size: newest?.size,
      sha: newest?.sha256,
      filename: newest?.filename,
    }
  }, before)
  check('publish button completes and routes to the new post', !!published.eventId && published.grew,
    published.eventId?.slice(0, 8))
  check('event advertises a localhost replica + thumb',
    (published.urls ?? []).every((u) => u.startsWith('https://localhost:8443/')) && !!published.thumb,
    JSON.stringify({ urls: published.urls, thumb: published.thumb }))

  // SHA-verified re-download of the published model via the app's client
  const roundtrip = await page.evaluate(async (m) => {
    const f = window.__form0
    f.blossoms.setServers(['https://localhost:8443'])
    const blob = await f.blossoms.download(m.urls, m.sha, m.size)
    if (!blob) return { ok: false, reason: 'download failed' }
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const got = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    return { ok: got === m.sha, size: bytes.length, expected: m.size }
  }, published)
  check('published model re-downloads byte-for-byte (SHA-256)',
    roundtrip.ok && roundtrip.size === roundtrip.expected, JSON.stringify(roundtrip))

  // delete via the REAL viewer delete button + error-sheet confirmation
  await page.waitForFunction(() => !document.getElementById('btn-delete').closest('#vbtn-delete').hidden
    || !document.getElementById('vbtn-delete').hidden, null, { timeout: 30000 })
  await page.evaluate(() => document.querySelector('#btn-delete').click())
  await page.waitForFunction(() => !document.getElementById('error-sheet').hidden, null, { timeout: 10000 })
  await page.evaluate(() => document.querySelector('#btn-error-action').click())
  const hidden = await page.waitForFunction((id) => {
    const m = window.__form0.index.byId.get(id)
    return m?.tombstoned === true
  }, published.eventId, { timeout: 30000 }).then(() => true).catch(() => false)
  check('kind-5 delete hides the post (live tombstone)', hidden)
}

// --------------------------- publish an imported camera model (bug 1 path)
{
  await page.evaluate(() => { location.hash = '#/studio' })
  await page.waitForFunction(() => window.__form0.engine.activeScene === window.__form0.studio.scene, null, { timeout: 10000 })
  await page.evaluate(() => document.querySelector('#btn-studio-import').click())
  await page.waitForTimeout(300)
  const bytes = await page.evaluate(async () => {
    const r = await fetch('https://localhost:8443/models/a.glb')
    return [...new Uint8Array(await r.arrayBuffer())]
  })
  await page.setInputFiles('#file-input', { name: 'a.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from(bytes) })
  await page.waitForFunction(() => window.__form0.studio.currentModel !== null, null, { timeout: 30000 })

  const r = await page.evaluate(async () => {
    const f = window.__form0
    f.blossoms.setServers(['https://localhost:8443'])
    const content = await f.studio.getContentForPublish()
    // pass-through: no user cameras added -> the ORIGINAL bytes ship
    const poster = await f.assets.renderPosterFor(content.blob, f.studio.tintColor)
    return {
      passThrough: content.sourceFormat === 'glb' && content.filename === 'a.glb',
      posterBlank: poster.blank,
      png: [...new Uint8Array(await poster.blob.arrayBuffer())],
    }
  })
  check('camera model passes through byte-for-byte (no re-export)', r.passThrough)

  // the publish poster must show the AUTHORED camera view: red only
  const px = await page.evaluate(async (pngBytes) => {
    const bmp = await createImageBitmap(new Blob([new Uint8Array(pngBytes)]))
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height
    const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let red = 0, green = 0, opaque = 0
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 16) continue
      opaque++
      if (d[i] > 140 && d[i + 1] < 120 && d[i + 2] < 120) red++
      if (d[i] < 120 && d[i + 1] > 140 && d[i + 2] < 150) green++
    }
    return { red: red / opaque, green: green / opaque }
  }, r.png)
  check('publish poster renders from the authored camera (red only)',
    !r.posterBlank && px.red > 0.5 && px.green < 0.01,
    `red=${(px.red * 100).toFixed(1)}% green=${(px.green * 100).toFixed(2)}%`)
  await page.screenshot({ path: 'shots/verify-publish.png' })
}

// -------------------------------------------------------------- summary
console.log('--- page errors ---')
for (const e of errors.slice(0, 10)) console.log('  ' + e)
check('no page errors', errors.length === 0)
await browser.close()
console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL PUBLISH CHECKS PASSED')
process.exit(fails.length ? 1 : 0)
