// Publish round-trip against the offline rig, driven through the REAL UI so
// it runs identically on the dev server AND the production preview build
// (no /src/ module imports — those only exist on the dev server):
// studio text -> publish button -> Blossom PUT /upload (model only, no
// poster) -> relay publish -> live feed event -> SHA-verified re-download ->
// kind-5 delete -> tombstone.
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

  // the REAL publish flow: the studio's publish button (export -> blossom ->
  // relays; format v4 renders no poster at publish time) and the app routes
  // to the new post's viewer
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
      dim: newest ? `${newest.width}x${newest.height}` : undefined,
      size: newest?.size,
      sha: newest?.sha256,
      filename: newest?.filename,
      name: newest?.name,
    }
  }, before)
  check('publish button completes and routes to the new post', !!published.eventId && published.grew,
    published.eventId?.slice(0, 8))
  check('event advertises a localhost replica + dim (v4: no thumb)',
    (published.urls ?? []).every((u) => u.startsWith('https://localhost:8443/')) && !!published.dim,
    JSON.stringify({ urls: published.urls, dim: published.dim }))
  // AMENDMENT 66: the model name rides in event `content` (a text post names
  // itself after its first line — the seeded '/0' here)
  check('event content carries the model name', published.name === '/0', JSON.stringify({ name: published.name }))

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
    // pass-through: no user cameras added -> the ORIGINAL bytes ship.
    // renderPosterFor is a direct pipeline probe (NOT run by the publish
    // flow any more): it pixel-checks the camera policy every viewer uses.
    const poster = await f.assets.renderPosterFor(content.blob)
    return {
      passThrough: content.sourceFormat === 'glb' && content.filename === 'a.glb',
      dim: `${poster.width}x${poster.height}`,
      pixels: [...poster.pixels],
    }
  })
  check('camera model passes through byte-for-byte (no re-export)', r.passThrough)

  // the publish poster must show the AUTHORED camera view: red only
  const px = (() => {
    const d = r.pixels
    let red = 0, green = 0, opaque = 0
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 16 && d[i] < 16 && d[i + 1] < 16 && d[i + 2] < 16) continue
      opaque++
      if (d[i] > 140 && d[i + 1] < 120 && d[i + 2] < 120) red++
      if (d[i] < 120 && d[i + 1] > 140 && d[i + 2] < 150) green++
    }
    return { red: opaque ? red / opaque : 0, green: opaque ? green / opaque : 0 }
  })()
  check('local poster pipeline renders from the authored camera (red only)',
    px.red > 0.5 && px.green < 0.01,
    `red=${(px.red * 100).toFixed(1)}% green=${(px.green * 100).toFixed(2)}%`)
  await page.screenshot({ path: 'shots/verify-publish.png' })

  // AMENDMENT 66: publishing the untouched import ships the ORIGINAL bytes
  // and names the event after the file. Wait over one second so the sort by
  // createdAt cannot tie with the previous flow's post.
  await page.waitForTimeout(1100)
  const before2 = await page.evaluate(() => window.__form0.index.byId.size)
  await page.evaluate(() => document.querySelector('#btn-studio-publish').click())
  await page.waitForFunction(() => location.hash.startsWith('#/viewer/'), null, { timeout: 120000 })
  const importedPublish = await page.evaluate((bc) => {
    const f = window.__form0
    const newest = [...f.index.byId.values()].filter((m) => m.role === 'root')
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    return { grew: f.index.byId.size > bc, name: newest?.name, sha: newest?.sha256, filename: newest?.filename }
  }, before2)
  check('imported model names its nostr event after the file', importedPublish.grew && importedPublish.name === 'a',
    JSON.stringify(importedPublish))
  const origSha = await page.evaluate(async () => {
    const r = await fetch('https://localhost:8443/models/a.glb')
    const digest = await crypto.subtle.digest('SHA-256', await r.arrayBuffer())
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  })
  check('imported model publishes byte-identical (event sha == file sha)', importedPublish.sha === origSha)
}

// -------------------------------------------- cancel mid-upload + hash hide
{
  await page.evaluate(() => { location.hash = '#/studio' })
  await page.waitForFunction(() => window.__form0.engine.activeScene === window.__form0.studio.scene, null, { timeout: 10000 })
  await page.evaluate(() => document.querySelector('[data-tab="type"]').click())
  await page.waitForFunction(() => window.__form0.studio.hasContent(), null, { timeout: 20000 })

  const cancelled = await page.evaluate(async () => {
    const f = window.__form0
    const origUpload = f.blossoms.upload.bind(f.blossoms)
    f.blossoms.upload = (_blob, _secret, signal) => new Promise((_resolve, reject) => {
      const boom = () => {
        const err = new Error('upload aborted')
        err.name = 'AbortError'
        reject(err)
      }
      if (signal?.aborted) { boom(); return }
      signal?.addEventListener('abort', boom, { once: true })
    })
    document.querySelector('#btn-studio-publish').click()
    await new Promise((r) => {
      const t0 = performance.now()
      const tick = () => {
        if (document.getElementById('btn-studio-publish').textContent === 'cancel' || performance.now() - t0 > 4000) r()
        else requestAnimationFrame(tick)
      }
      tick()
    })
    const labeled = document.getElementById('btn-studio-publish').textContent
    const frozen = f.studio.isFrozen
    document.querySelector('#btn-studio-publish').click()
    await new Promise((r) => {
      const t0 = performance.now()
      const tick = () => {
        if (document.getElementById('studio-status').textContent === 'cancelled' || performance.now() - t0 > 4000) r()
        else requestAnimationFrame(tick)
      }
      tick()
    })
    f.blossoms.upload = origUpload
    return {
      labeled,
      frozen,
      status: document.getElementById('studio-status').textContent,
      publishing: f.isPublishing(),
      stillFrozen: f.studio.isFrozen,
      button: document.getElementById('btn-studio-publish').textContent,
    }
  })
  check('publish button becomes cancel while uploading', cancelled.labeled === 'cancel' && cancelled.frozen,
    JSON.stringify(cancelled))
  check('cancel aborts the upload and unfreezes the studio',
    cancelled.status === 'cancelled' && cancelled.publishing === false && cancelled.stillFrozen === false
      && cancelled.button === 'publish',
    JSON.stringify(cancelled))

  // Don't re-upload a thumb here: the cancel test stubs blossoms.upload and
  // a full produce()+decode can hang while the studio is the active scene.
  // verify-hash.mjs covers the thumb+tree path; this asserts failHash + hide.
  const hidden = await page.evaluate(async () => {
    const f = window.__form0
    const good = [...f.index.byId.values()].find((m) => m.role === 'root' && m.urls?.length)
    if (!good) return { ok: false, reason: 'no seed post' }
    const bad = {
      ...good,
      eventId: 'ab'.repeat(32),
      sha256: '00'.repeat(32),
      hashFailed: false,
      tombstoned: false,
      role: 'root',
      refs: {},
    }
    f.index.add(bad)
    const before = [...f.index.byId.values()].filter((m) => m.role === 'root' && !m.tombstoned && !m.hashFailed)
      .some((m) => m.eventId === bad.eventId)
    await f.assets.getModel(bad)
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const after = [...f.index.byId.values()].filter((m) => m.role === 'root' && !m.tombstoned && !m.hashFailed)
      .some((m) => m.eventId === bad.eventId)
    const onBoard = f.board.rows.some((row) => row.meta.eventId === bad.eventId)
    const listed = f.index.flatten(bad.eventId).some((m) => m.eventId === bad.eventId)
    return {
      ok: true,
      before,
      after,
      onBoard,
      listed,
      flagged: !!f.index.byId.get(bad.eventId)?.hashFailed,
      cache: f.assets.isHashFailed(bad.eventId),
    }
  }, { timeout: 20000 })
  check('a wrong-hash model is hidden from the board',
    hidden.ok && hidden.before && !hidden.after && hidden.flagged && hidden.cache && !hidden.onBoard,
    JSON.stringify(hidden))
  check('a wrong-hash model is not a thread node (flatten skips hashFailed)',
    hidden.ok && !hidden.listed,
    JSON.stringify(hidden))
}

// -------------------------------------------------------------- summary
console.log('--- page errors ---')
for (const e of errors.slice(0, 10)) console.log('  ' + e)
check('no page errors', errors.length === 0)
await browser.close()
console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL PUBLISH CHECKS PASSED')
process.exit(fails.length ? 1 : 0)
