// Load-path hash / size / thumb / tree checks against the offline rig.
// Complements verify-publish.mjs (which covers cancel/freeze + a smoke hide).
//
//   node scripts/offline-rig.mjs   + dev/preview server, then:
//   node scripts/verify-hash.mjs
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

await resetRig()
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForFunction(() => window.__form0?.board, null, { timeout: 30000 })
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await page.waitForFunction(() => window.__form0.index.byId.size >= 52, null, { timeout: 30000 })

// -------------------------------- poisoned modelCache under a real sha
{
  const r = await page.evaluate(async () => {
    const f = window.__form0
    const good = [...f.index.byId.values()].find((m) => m.role === 'root' && m.urls?.length && m.sha256)
    if (!good) return { ok: false, reason: 'no seed post' }
    const junk = new Uint8Array(96).fill(0xff)
    const junkBlob = new Blob([junk], { type: 'application/octet-stream' })
    // Poison IDB under the REAL sha, and the RAM maps.
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('form-zero', 4)
      req.onerror = () => reject(req.error)
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction('modelCache', 'readwrite')
        tx.objectStore('modelCache').put(junkBlob, good.sha256)
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => { db.close(); reject(tx.error) }
      }
    })
    f.assets.modelBlobs.clear()
    f.assets.modelBytes.clear()
    f.assets.modelBlobs.set(good.sha256, junkBlob)
    f.assets.modelBytes.set(good.sha256, junk)

    const handed = []
    const origBytes = f.assets.getModelBytes.bind(f.assets)
    f.assets.getModelBytes = async (meta) => {
      const bytes = await origBytes(meta)
      if (bytes) handed.push({ n: bytes.length, first: bytes[0], sha: meta.sha256 })
      return bytes
    }
    const blob = await f.assets.getModel(good)
    const bytes = await f.assets.getModelBytes(good)
    f.assets.getModelBytes = origBytes

    const digestOf = async (u8) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', u8))]
      .map((b) => b.toString(16).padStart(2, '0')).join('')
    const blobBytes = blob ? new Uint8Array(await blob.arrayBuffer()) : null
    return {
      ok: true,
      blobLen: blobBytes?.length ?? 0,
      blobFirst: blobBytes?.[0],
      blobSha: blobBytes ? await digestOf(blobBytes) : null,
      bytesLen: bytes?.length ?? 0,
      bytesFirst: bytes?.[0],
      bytesSha: bytes ? await digestOf(bytes) : null,
      expect: good.sha256,
      handed,
      flagged: f.assets.isHashFailed(good.eventId),
    }
  })
  const clean = (u8first, len, sha, expect) =>
    len > 96 && u8first !== 0xff && sha === expect
  check('poisoned modelCache under a real sha does not reach getModel',
    r.ok && clean(r.blobFirst, r.blobLen, r.blobSha, r.expect) && !r.flagged,
    JSON.stringify({ blobLen: r.blobLen, blobFirst: r.blobFirst, blobSha: r.blobSha?.slice(0, 12), flagged: r.flagged, reason: r.reason }))
  check('poisoned RAM/IDB bytes never reach getModelBytes / Babylon',
    r.ok && clean(r.bytesFirst, r.bytesLen, r.bytesSha, r.expect)
      && r.handed.every((h) => h.n > 96 && h.first !== 0xff),
    JSON.stringify(r.handed))
}

// --------------------- correct x + wrong size + matching bytes MUST show
{
  const r = await page.evaluate(async () => {
    const f = window.__form0
    const good = [...f.index.byId.values()].find((m) => m.role === 'root' && m.urls?.length)
    if (!good) return { ok: false, reason: 'no seed' }
    f.blossoms.setServers(['https://localhost:8443'])
    try {
      const blob = await f.blossoms.download(good.urls, good.sha256, 1)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((b) => b.toString(16).padStart(2, '0')).join('')
      return { ok: true, size: bytes.length, tag: good.size, sha, expect: good.sha256 }
    } catch (e) {
      return { ok: false, reason: e?.name + ': ' + e?.message }
    }
  })
  check('correct x + wrong size + hash-matching bytes MUST show',
    r.ok && r.sha === r.expect && r.size > 1,
    JSON.stringify(r))
}

// --------- wrong x + valid GLB + valid thumb must not stay on board or tree
{
  const r = await page.evaluate(async () => {
    const f = window.__form0
    const good = [...f.index.byId.values()].find((m) => m.role === 'root' && m.urls?.length)
    if (!good) return { ok: false, reason: 'no seed' }
    const c = document.createElement('canvas')
    c.width = 8; c.height = 8
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#3af'
    ctx.fillRect(0, 0, 8, 8)
    const png = await new Promise((res) => c.toBlob(res, 'image/png'))
    f.blossoms.setServers(['https://localhost:8443'])
    const up = await f.blossoms.upload(png, crypto.getRandomValues(new Uint8Array(32)))
    const thumbBytes = new Uint8Array(await png.arrayBuffer())
    const thumbSha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', thumbBytes))]
      .map((b) => b.toString(16).padStart(2, '0')).join('')
    const badId = 'cd'.repeat(32)
    const bad = {
      ...good,
      eventId: badId,
      sha256: '11'.repeat(32),
      thumbUrl: up[0]?.url,
      thumbSha256: thumbSha,
      thumbSize: png.size,
      hashFailed: false,
      tombstoned: false,
      role: 'root',
      refs: {},
    }
    f.index.add(bad)
    const roots = [...f.index.byId.values()]
      .filter((m) => m.role === 'root' && !m.tombstoned && !m.hashFailed)
      .sort((a, b) => b.createdAt - a.createdAt)
    f.board.setMetas(roots)
    const poster = await f.assets.getPoster(bad)
    // produce() kicks getModel in the background; also call it so the
    // wait is bounded if the kick races.
    void f.assets.getModel(bad)
    const t0 = performance.now()
    while (!f.assets.isHashFailed(badId) && performance.now() - t0 < 8000) {
      await new Promise((r) => setTimeout(r, 20))
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    await f.threadView.open(badId)
    return {
      ok: true,
      hadPoster: !!poster,
      flagged: !!f.index.byId.get(badId)?.hashFailed,
      cache: f.assets.isHashFailed(badId),
      onBoard: f.board.rows.some((row) => row.meta.eventId === badId),
      peek: !!f.assets.peekPoster(bad),
      threadNode: f.threadView.hasNode(badId),
      threadSize: f.threadView.nodes.size,
    }
  })
  check('wrong x + valid GLB + valid thumb does not stay on the board',
    r.ok && r.flagged && r.cache && !r.onBoard && !r.peek,
    JSON.stringify(r))
  check('wrong x + valid GLB + valid thumb does not stay on the tree',
    r.ok && !r.threadNode && r.threadSize === 0,
    JSON.stringify(r))
}

// --------------------- thread must not build a node for hashFailed meta
{
  const r = await page.evaluate(async () => {
    const f = window.__form0
    const good = [...f.index.byId.values()].find((m) => m.role === 'root' && !m.tombstoned && f.index.childCount(m.eventId) > 0)
    if (!good) return { ok: false, reason: 'no threaded root' }
    const deadId = 'ee'.repeat(32)
    const dead = {
      ...good,
      eventId: deadId,
      role: 'reply',
      refs: { rootId: good.eventId, parentId: good.eventId },
      hashFailed: true,
      tombstoned: false,
    }
    f.index.add(dead)
    f.index.rejectHash(deadId)
    await f.threadView.open(good.eventId)
    return {
      ok: true,
      hasDead: f.threadView.hasNode(deadId),
      hasRoot: f.threadView.hasNode(good.eventId),
      listed: f.index.flatten(good.eventId).some((m) => m.eventId === deadId),
    }
  })
  check('thread does not build a node for hashFailed meta',
    r.ok && r.hasRoot && !r.hasDead && !r.listed,
    JSON.stringify(r))
}

console.log('--- page errors ---')
for (const e of errors.slice(0, 10)) console.log('  ' + e)
check('no page errors', errors.length === 0)
await browser.close()
console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL HASH CHECKS PASSED')
process.exit(fails.length ? 1 : 0)
