// Guard: the export review offers REAL codec encoders (local Draco wasm +
// canvas WebP) and a codec choice re-derives a smaller, re-validated GLB from
// the same frozen export — the exact bytes shown are the bytes published.
//   node scripts/offline-rig.mjs &   # then TARGET_URL=http://localhost:4173/
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

const fileSize = () => page.$eval('#export-summary b', (el) => el.textContent.split('/')[0].trim()).catch(() => '')
const state = () => page.$eval('#export-state', (el) => el.textContent).catch(() => '')

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForFunction(() => window.__form0?.studio, { timeout: 30000 })
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await page.waitForTimeout(600)

await page.evaluate(() => { location.hash = '#/studio' })
await page.waitForFunction(() => window.__form0.__mode() === 'studio', { timeout: 10000 })
await page.waitForTimeout(400)

// Type enough text that draco has real geometry to squeeze.
const typeText = async (text) => {
  await page.evaluate((t) => {
    document.querySelector('[data-tab="type"]').click()
    const ta = document.getElementById('studio-text')
    ta.value = t
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  }, text)
}
await typeText('codec roundtrip check abcdefghijklmnopqrstuvwxyz 0123456789')
await page.waitForFunction(() => window.__form0.studio.hasContent(), { timeout: 15000 })
await page.waitForTimeout(1200) // debounce -> text mesh rebuild

await page.click('#btn-studio-publish')
await page.waitForSelector('#export-review:not([hidden])', { timeout: 30000 })
await page.waitForFunction(() => document.querySelector('#export-state').textContent.includes('validated'), { timeout: 30000 })
await page.waitForTimeout(700) // codec availability probes

const raw = await fileSize()
const rawState = await state()
check('review opens with the exact export', raw.length > 0 && rawState.includes('validated'), `${raw} ${rawState}`)

const dracoVisible = await page.isVisible('#codec-geometry [data-v="draco"]')
const webpVisible = await page.isVisible('#codec-texture [data-v="webp"]')
check('draco option appears when the local encoder works', dracoVisible)
check('webp option appears when the canvas encoder works', webpVisible)

if (dracoVisible) {
  await page.click('#codec-geometry [data-v="draco"]')
  await page.waitForFunction(() => {
    const s = document.querySelector('#export-state').textContent
    return s.includes('validated') || s.includes('failed')
  }, { timeout: 60000 })
  const compressed = await fileSize()
  const note = await page.$eval('#export-codec-note', (el) => el.textContent)
  const extensions = await page.$eval('#export-extensions', (el) => el.textContent)
  check('draco choice yields a smaller reviewed GLB', compressed.length > 0 && compressed !== raw, `${raw} -> ${compressed}`)
  check('draco shows savings note', /draco .*→/.test(note), note)
  check('draco extension is declared', extensions.includes('KHR_draco_mesh_compression'), extensions)

  // Back to raw: deterministic re-derivation from the same frozen export.
  await page.click('#codec-geometry [data-v="none"]')
  await page.waitForFunction(() => {
    const s = document.querySelector('#export-state').textContent
    return s.includes('validated') || s.includes('failed')
  }, { timeout: 60000 })
  const back = await fileSize()
  check('switching back to raw restores the exact original', back === raw, `${back} vs ${raw}`)

  // The publish button only works off the reviewed snapshot; keep draco on.
  await page.click('#codec-geometry [data-v="draco"]')
  await page.waitForFunction(() => document.querySelector('#export-state').textContent.includes('validated'), { timeout: 60000 })
}

if (webpVisible) {
  // A text-only model has no textures: webp must stay honest about it.
  await page.click('#codec-texture [data-v="webp"]')
  await page.waitForFunction(() => document.querySelector('#export-state').textContent.includes('validated'), { timeout: 60000 })
  const note = await page.$eval('#export-codec-note', (el) => el.textContent)
  check('webp with nothing to encode keeps the review valid', (await state()).includes('validated'), note)
  await page.click('#codec-texture [data-v="none"]')
  await page.waitForFunction(() => document.querySelector('#export-state').textContent.includes('validated'), { timeout: 60000 })
}

// A studio edit while the review is open must invalidate the snapshot.
await typeText('codec roundtrip check abcdefghijklmnopqrstuvwxyz 0123456789 EDITED')
await page.waitForTimeout(1600)
const reviewGone = await page.$eval('#export-review', (el) => el.hidden)
check('editing while reviewed closes the review', reviewGone === true)

// ----------------- publish the draco-compressed export for real
{
  await page.waitForTimeout(800) // text rebuild debounce from the edit above
  await page.evaluate(() => document.querySelector('#btn-studio-publish').click())
  await page.waitForSelector('#export-review:not([hidden])', { timeout: 30000 })
  await page.waitForFunction(() => document.querySelector('#export-state').textContent.includes('validated'), { timeout: 60000 })
  // geometry choice persists per session: this review should already be the
  // draco one (note shows the savings)
  const note = await page.$eval('#export-codec-note', (el) => el.textContent)
  check('re-opened review re-applies the draco choice', /draco .*→/.test(note), note)
  await page.evaluate(() => window.__form0.blossoms.setServers(['https://localhost:8443']))
  const before = await page.evaluate(() => window.__form0.index.byId.size)
  await page.evaluate(() => document.querySelector('#btn-export-publish').click())
  await page.waitForFunction(() => location.hash.startsWith('#/viewer/'), { timeout: 120000 })
  const published = await page.evaluate((beforeCount) => {
    const f = window.__form0
    const newest = [...f.index.byId.values()].filter((m) => m.role === 'root')
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    return { grew: f.index.byId.size > beforeCount, eventId: newest?.eventId, urls: newest?.urls, sha: newest?.sha256, size: newest?.size }
  }, before)
  check('compressed publish routes to the new post', !!published.eventId && published.grew, published.eventId?.slice(0, 8))
  const uploaded = await page.evaluate(async (m) => {
    const f = window.__form0
    f.blossoms.setServers(['https://localhost:8443'])
    const blob = await f.blossoms.download(m.urls, m.sha, m.size)
    if (!blob) return { ok: false, reason: 'download failed' }
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const got = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const jsonLen = dv.getUint32(12, true)
    const json = new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen))
    return { ok: got === m.sha, size: bytes.length, magic: dv.getUint32(0, true) === 0x46546c67, draco: json.includes('KHR_draco_mesh_compression') }
  }, published)
  check('uploaded bytes are the reviewed draco GLB (SHA-verified)', uploaded.ok && uploaded.magic && uploaded.draco,
    JSON.stringify(uploaded))
  check('uploaded model is the compressed size, not the raw export', uploaded.size === published.size && published.size < 20000,
    `${published.size} bytes`)
  // The viewer must actually decode the draco model it just opened.
  await page.waitForTimeout(2500)
  const viewerOk = await page.evaluate(() => ({
    mode: window.__form0.__mode(),
    errorSheet: document.getElementById('error-sheet').hidden,
  }))
  check('viewer renders the compressed post without errors', viewerOk.mode === 'viewer' && viewerOk.errorSheet, JSON.stringify(viewerOk))
}

// ----------------- webp end-to-end with a real textured model
{
  await page.evaluate(() => { location.hash = '#/studio' })
  await page.waitForFunction(() => window.__form0.__mode() === 'studio', { timeout: 10000 })
  await page.evaluate(() => {
    const ta = document.getElementById('studio-text')
    ta.value = ''
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.waitForTimeout(300)

  // Module-level proof with the app's own modules on the dev server: build a
  // textured GLB in-page, run the REAL canvas webp encoder, then render the
  // compressed model through the app's poster pipeline (Babylon must decode
  // the EXT_texture_webp texture) and compare pixels with the raw render.
  const mod = await page.evaluate(async () => {
    const { compressGLB } = await import('/src/model/compressGlb.ts')
    const { webpCodec } = await import('/src/model/webpEncode.ts')
    const { validateGLB } = await import('/src/model/limits.ts')
    // 1024×1024 gradient png
    const canvas = document.createElement('canvas')
    canvas.width = 1024; canvas.height = 1024
    const ctx = canvas.getContext('2d')
    const grad = ctx.createLinearGradient(0, 0, 1024, 1024)
    grad.addColorStop(0, '#ff2d55'); grad.addColorStop(0.5, '#2dffb5'); grad.addColorStop(1, '#2d55ff')
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 1024, 1024)
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = `hsl(${i * 6}, 90%, 60%)`
      ctx.fillRect((i * 97) % 1000, (i * 173) % 1000, 40, 40)
    }
    const pngBlob = await new Promise((r) => canvas.toBlob(r, 'image/png'))
    const png = new Uint8Array(await pngBlob.arrayBuffer())
    // 96×96 grid mesh + uv
    const n = 97, verts = n * n
    const positions = new Float32Array(verts * 3), normals = new Float32Array(verts * 3), uvs = new Float32Array(verts * 2)
    const indices = new Uint32Array(96 * 96 * 6)
    let t = 0
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const i = y * n + x, u = x / 96, v = y / 96
      positions.set([u * 4 - 2, v * 4 - 2, Math.sin(u * 9) * Math.cos(v * 7) * 0.5], i * 3)
      normals.set([0, 0, 1], i * 3)
      uvs.set([u, 1 - v], i * 2)
    }
    for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) {
      const a = y * n + x, b = a + 1, c = a + n, d = c + 1
      indices[t++] = a; indices[t++] = c; indices[t++] = b; indices[t++] = b; indices[t++] = c; indices[t++] = d
    }
    const chunks = []
    const views = [], accessors = []
    let cursor = 0
    const push = (arr) => {
      const bytes = arr instanceof Uint8Array ? arr : new Uint8Array(arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength))
      while (cursor % 4) { chunks.push(new Uint8Array(1)); cursor++ }
      const offset = cursor
      chunks.push(bytes); cursor += bytes.length
      views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length })
      return views.length - 1
    }
    const acc = (v, ct, count, ty) => { accessors.push({ bufferView: v, componentType: ct, count, type: ty }); return accessors.length - 1 }
    const attrs = { POSITION: acc(push(positions), 5126, verts, 'VEC3'), NORMAL: acc(push(normals), 5126, verts, 'VEC3'), TEXCOORD_0: acc(push(uvs), 5126, verts, 'VEC2') }
    const json = {
      asset: { version: '2.0', generator: 'codec-browser' }, scene: 0,
      scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'textured' }],
      meshes: [{ primitives: [{ attributes: attrs, indices: acc(push(indices), 5125, indices.length, 'SCALAR'), mode: 4, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 }, doubleSided: true }],
      accessors, bufferViews: views,
      images: [{ mimeType: 'image/png', bufferView: push(png) }],
      textures: [{ source: 0 }],
    }
    let binLen = cursor
    const bin = new Uint8Array(binLen)
    let cur = 0
    for (const c of chunks) { bin.set(c, cur); cur += c.length }
    json.buffers = [{ byteLength: bin.length }]
    const enc = new TextEncoder()
    const jsonBytes = enc.encode(JSON.stringify(json))
    const jsonPad = (4 - (jsonBytes.length % 4)) % 4
    const binPad = (4 - (bin.length % 4)) % 4
    const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + bin.length + binPad
    const out = new Uint8Array(total)
    const dv = new DataView(out.buffer)
    dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true)
    dv.setUint32(12, jsonBytes.length + jsonPad, true); dv.setUint32(16, 0x4e4f534a, true)
    out.set(jsonBytes, 20)
    for (let i = 0; i < jsonPad; i++) out[20 + jsonBytes.length + i] = 0x20 // JSON padding must be spaces
    const binStart = 20 + jsonBytes.length + jsonPad
    dv.setUint32(binStart, bin.length + binPad, true); dv.setUint32(binStart + 4, 0x004e4942, true)
    out.set(bin, binStart + 8)
    const { bytes: compressed, report } = await compressGLB(out, { webp: webpCodec })
    const valid = validateGLB(compressed).ok
    const f = window.__form0
    const asBlob = (b) => new Blob([b], { type: 'model/gltf-binary' })
    const posterRaw = await f.assets.renderPosterFor(asBlob(out))
    const posterWebp = await f.assets.renderPosterFor(asBlob(compressed))
    let diff = 0, lit = 0
    for (let i = 0; i < posterRaw.pixels.length; i += 4) {
      diff += Math.abs(posterRaw.pixels[i] - posterWebp.pixels[i]) + Math.abs(posterRaw.pixels[i + 1] - posterWebp.pixels[i + 1]) + Math.abs(posterRaw.pixels[i + 2] - posterWebp.pixels[i + 2])
      if (posterWebp.pixels[i] + posterWebp.pixels[i + 1] + posterWebp.pixels[i + 2] > 90) lit++
    }
    return {
      inLen: out.length, outLen: compressed.length, images: report.webp.images, valid,
      meanDiff: diff / (posterRaw.pixels.length / 4), litRatio: lit / (posterRaw.pixels.length / 4),
    }
  })
  check('webp module pass compresses the texture', mod.images === 1 && mod.valid && mod.outLen < mod.inLen * 0.5,
    `${mod.inLen} -> ${mod.outLen} (${mod.images} image)`)
  check('webp-compressed model renders the same poster', mod.meanDiff < 20 && mod.litRatio > 0.3,
    `meanDiff=${mod.meanDiff.toFixed(1)} lit=${(mod.litRatio * 100).toFixed(0)}%`)
}

check('no page errors', errs.length === 0, errs.slice(0, 4).join(' | '))
await browser.close()
console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL CHECKS PASSED')
process.exit(fails.length ? 1 : 0)
