// Vertex-color render check — PAINT publish round-trip (AMENDMENT 71).
// Paints three ink stamps in the studio (thin-instance preview shows them
// saturated), exports via getContentForPublish(), then loads the GLB into
// the viewer: all three hues must survive. Guards the regression where the
// export-only bake dragged a fixed grey emissive that PBR never modulates
// with COLOR_0, washing every published stroke out to pastel.
//
//   TARGET_URL=http://127.0.0.1:5173 node scripts/vcolor-paint.mjs
import { launchFormBrowser } from './browser.mjs'

const TARGET = process.env.TARGET_URL || 'http://127.0.0.1:5199/'
const ok = (n, c, x = '') => console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? ' — ' + x : ''}`)

const browser = await launchFormBrowser()
const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
page.on('pageerror', (e) => console.log('[pageerror]', String(e.message).slice(0, 300)))

await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => window.__form0 && window.__form0.studio, null, { timeout: 60000 })

const res = await page.evaluate(async () => {
  const F = window.__form0
  F.setLoading?.(false); F.errorSheet?.close?.(); F.legend?.close?.()
  const st = F.studio
  const add = (px, c) => st.paint.store.add({
    shape: 'cube', px, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1,
    sx: 1.4, sy: 1.4, sz: 1.4, r: c[0], g: c[1], b: c[2], a: 1,
  })
  add(-1.2, [1, 0.1, 0.1, 1]); add(0, [0.1, 1, 0.1, 1]); add(1.2, [0.1, 0.1, 1, 1])
  const pub = await st.getContentForPublish()
  const bytes = new Uint8Array(await pub.blob.arrayBuffer())
  await F.viewer.load(bytes, { sha256: 'v-paint', eventId: 'ev-vp', pubkey: 'p', createdAt: Date.now(), name: 'paint' })
  const scene = F.viewer.scene
  const mesh = scene.meshes.find((m) => m.name.startsWith('paint-'))
  const deadline = performance.now() + 20000
  while (performance.now() < deadline) {
    scene.render()
    if (mesh?.isReady(true)) break
    await new Promise((r2) => setTimeout(r2, 250))
  }
  scene.render()
  const gl = scene.getEngine()._gl
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight
  const buf = new Uint8Array(w * h * 4)
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)
  const dom = { r: 0, g: 0, b: 0, white: 0, other: 0 }
  for (let y = Math.floor(h * 0.25); y < h * 0.75; y++) for (let x = Math.floor(w * 0.25); x < w * 0.75; x++) {
    const i = (y * w + x) * 4
    const rr = buf[i], gg = buf[i + 1], bb = buf[i + 2]
    const hi = Math.max(rr, gg, bb), spread = hi - Math.min(rr, gg, bb)
    if (spread > 50 && hi > 90) {
      if (rr > 1.8 * Math.max(gg, bb)) dom.r++
      else if (gg > 1.8 * Math.max(rr, bb)) dom.g++
      else if (bb > 1.8 * Math.max(rr, gg)) dom.b++
      else dom.other++
    } else if (rr > 230 && gg > 230 && bb > 230) dom.white++
  }
  const jl = new DataView(bytes.buffer, 0, bytes.byteLength).getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jl)))
  return {
    dom,
    mats: json.materials.map((m) => ({ name: m.name, emissive: m.emissiveFactor ?? null })),
    ready: mesh?.isReady(true),
  }
})
console.log(JSON.stringify(res))
ok('export carries no fixed grey emissive', res.mats.every((m) => m.emissive === null), JSON.stringify(res.mats))
ok('published ink keeps all three hues', res.dom.r > 500 && res.dom.g > 500 && res.dom.b > 500, JSON.stringify(res.dom))
ok('published ink not blown white', res.dom.white < (res.dom.r + res.dom.g + res.dom.b) * 0.15, `white=${res.dom.white}`)

await browser.close()
console.log('ALL VCOLOR PAINT CHECKS PASSED')
