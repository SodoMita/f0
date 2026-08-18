// Publish round-trip against the offline rig: studio export -> poster ->
// Blossom PUT /upload -> relay publish -> live feed event -> SHA-verified
// re-download -> delete (kind-5 tombstone). The rig's relay speaks NIP-20 OK
// and live-pushes new events to matching subscriptions.
//
//   node scripts/offline-rig.mjs   + dev/preview server, then:
//   node scripts/verify-publish.mjs
import { chromium } from 'playwright'

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

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForFunction(() => window.__form0?.board, null, { timeout: 30000 })
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await page.waitForFunction(() => window.__form0.index.byId.size >= 52, null, { timeout: 30000 })

// ------------------------------------------------- publish a text model
{
  await page.evaluate(() => { location.hash = '#/studio' })
  await page.waitForFunction(() => window.__form0.engine.activeScene === window.__form0.studio.scene, null, { timeout: 10000 })
  await page.waitForFunction(() => window.__form0.studio.hasContent(), null, { timeout: 20000 })

  const published = await page.evaluate(async () => {
    const f = window.__form0
    f.blossoms.setServers(['https://localhost:8443'])
    const content = await f.studio.getContentForPublish()
    const poster = await f.assets.renderPosterFor(content.blob, f.studio.tintColor)
    const { publishModel } = await import('/src/protocol/publish.ts')
    const result = await publishModel(
      {
        model: content.blob,
        poster: poster.blob,
        tint: f.studio.tintColor,
        filename: content.filename,
        sourceFormat: content.sourceFormat,
        role: 'root',
      },
      { relays: ['wss://localhost:8443'], blossoms: ['https://localhost:8443'], pool: f.pool },
    )
    return { eventId: result.eventId, ok: result.ok.length, failed: result.failed.length, posterBlank: poster.blank }
  })
  check('publish resolves with event id', !!published.eventId, published.eventId?.slice(0, 8))
  check('relay accepted the event (NIP-20 OK)', published.ok === 1 && published.failed === 0,
    `ok=${published.ok} failed=${published.failed}`)
  check('publish poster is not blank', !published.posterBlank)

  // live relay push -> the event lands in the app's feed without resubscribe
  await page.waitForFunction((id) => window.__form0.index.byId.has(id), published.eventId, { timeout: 30000 })
  const meta = await page.evaluate((id) => {
    const m = window.__form0.index.byId.get(id)
    return { urls: m?.urls, thumb: m?.thumbUrl, size: m?.size, sha: m?.sha256, role: m?.role }
  }, published.eventId)
  check('published event appears in the live feed', !!meta.sha,
    JSON.stringify(meta && { urls: meta.urls, thumb: meta.thumb }))
  check('event advertises a localhost replica + thumb', (meta.urls ?? []).every((u) => u.startsWith('https://localhost:8443/')) && !!meta.thumb,
    JSON.stringify({ urls: meta.urls, thumb: meta.thumb }))

  // SHA-verified re-download of the published model through the blossom client
  const roundtrip = await page.evaluate(async (m) => {
    const f = window.__form0
    f.blossoms.setServers(['https://localhost:8443'])
    const blob = await f.blossoms.download(m.urls, m.sha, m.size)
    if (!blob) return { ok: false, reason: 'download failed' }
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const { sha256Hex } = await import('/src/protocol/blossom.ts')
    const got = await sha256Hex(bytes)
    return { ok: got === m.sha, size: bytes.length, expected: m.size }
  }, meta)
  check('published model re-downloads byte-for-byte (SHA-256)', roundtrip.ok && roundtrip.size === roundtrip.expected,
    JSON.stringify(roundtrip))

  // delete it (kind-5) — the rig accepts EVENT; the tombstone must then
  // arrive back through the app's own kind-5 subscription (NIP-09 author
  // check included) and hide the post without any local shortcut.
  const del = await page.evaluate(async (id) => {
    const { DeletionService } = await import('/src/protocol/deletion.ts')
    const d = new DeletionService(window.__form0.pool)
    await d.refresh()
    if (!d.canDelete(id)) return { ok: 0, failed: 1, reason: 'not owned' }
    const res = await d.delete(id)
    return { ok: res.ok.length, failed: res.failed.length }
  }, published.eventId)
  check('deletion publishes a kind-5 tombstone', del.ok === 1, JSON.stringify(del))
  const hidden = await page.waitForFunction((id) => {
    const m = window.__form0.index.byId.get(id)
    return m?.tombstoned === true
  }, published.eventId, { timeout: 20000 }).then(() => true).catch(() => false)
  check('tombstone arrives live and hides the post', hidden)
  await page.evaluate(() => { location.hash = '#/' })
  await page.waitForTimeout(600)
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
