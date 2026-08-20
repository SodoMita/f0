// Vertex-color render check — VIEWER path (SPEC AMENDMENT 71).
//
//   TARGET_URL=http://127.0.0.1:5173 node scripts/vcolor-check.mjs
//   (dev server must be running; a browser is taken from playwright or
//    @sparticuz/chromium — see scripts/browser.mjs)
//
// Vertex-colored GLBs must keep their per-vertex colors in the detail
// viewer, the way they look in the studio. Guards two regressions:
//  1. Draco main-thread decode dropped the accessor `normalized` flag on
//     COLOR_0 (u8 values 0-255 read as literal float 0-255 -> clipped white).
//  2. Plain float/byte COLOR_0 always worked — kept as the control.
import { launchFormBrowser } from './browser.mjs'
import { execFileSync } from 'child_process'

const TARGET = process.env.TARGET_URL || 'http://127.0.0.1:5199/'
const ok = (n, c, x = '') => console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? ' — ' + x : ''}`)

// (re)generate the control GLB: per-face colored cube, u8-normalized COLOR_0.
const FIXTURE = new globalThis.URL('../.test-shots/vcolor-cube.glb', import.meta.url).pathname
execFileSync(process.execPath, [new globalThis.URL('./vcolor-asset.mjs', import.meta.url).pathname, FIXTURE])

const browser = await launchFormBrowser()
const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
page.on('pageerror', (e) => console.log('[pageerror]', String(e.message).slice(0, 300)))

await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => window.__form0 && window.__form0.viewer, null, { timeout: 60000 })
await page.evaluate(async () => {
  const F = window.__form0
  F.setLoading?.(false); F.errorSheet?.close?.(); F.legend?.close?.()
  const [a, b, c] = await Promise.all([
    fetch('/@fs/home/user/f0/.test-shots/vcolor-cube.glb').then(r => r.arrayBuffer()),
    fetch('/@fs/home/user/f0/src/studio/library/glb/heart.glb').then(r => r.arrayBuffer()),
    fetch('/@fs/home/user/f0/src/studio/library/glb/cube.glb').then(r => r.arrayBuffer()),
  ])
  window.__plain = new Uint8Array(a)
  window.__heart = new Uint8Array(b)
  window.__cube = new Uint8Array(c)
})

let failed = 0
for (const [name, gv, want] of [
  ['plain u8 COLOR_0 (control)', '__plain', 'hue'],
  ['draco heart (red, library)', '__heart', 'red'],
  ['draco cube (uniform grey)', '__cube', 'grey'],
]) {
  const res = await page.evaluate(`(async () => {
    const F = window.__form0
    const meta = { sha256: 'v-${Date.now()}', eventId: 'ev-v', pubkey: 'p', createdAt: Date.now(), name: '${name}' }
    await F.viewer.load(window.${gv}, meta)
    const scene = F.viewer.scene
    let mesh = scene.meshes.find((m) => m.name !== 'viewer-backdrop' && m.name !== 'viewer-glow' && m.name !== '__root__')
    // Parallel shader compile needs real time (SwiftShader takes seconds).
    const deadline = performance.now() + 20000
    while (performance.now() < deadline) {
      scene.render()
      if (mesh && mesh.isReady(true)) break
      await new Promise(r => setTimeout(r, 250))
      mesh = scene.meshes.find((m) => m.name !== 'viewer-backdrop' && m.name !== 'viewer-glow' && m.name !== '__root__')
    }
    scene.render()
    const gl = scene.getEngine()._gl
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight
    const buf = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    const dom = { r: 0, g: 0, b: 0, white: 0, other: 0 }
    let mean = [0, 0, 0], n = 0
    for (let y = Math.floor(h * 0.3); y < h * 0.7; y++) for (let x = Math.floor(w * 0.3); x < w * 0.7; x++) {
      const i = (y * w + x) * 4
      const r = buf[i], g = buf[i + 1], b = buf[i + 2]
      mean[0] += r; mean[1] += g; mean[2] += b; n++
      const hi = Math.max(r, g, b), spread = hi - Math.min(r, g, b)
      if (spread > 40 && hi > 80) {
        if (r > 1.8 * Math.max(g, b)) dom.r++
        else if (g > 1.8 * Math.max(r, b)) dom.g++
        else if (b > 1.8 * Math.max(r, g)) dom.b++
        else dom.other++
      } else if (r > 230 && g > 230 && b > 230) dom.white++
    }
    mean = mean.map(s => Math.round(s / n))
    const vb = mesh && mesh.geometry.getVertexBuffers().color
    return {
      dom, mean, n, vb: vb ? { type: vb.type, size: vb.getSize(), normalized: vb.normalized } : null,
      ready: mesh ? mesh.isReady(true) : null, meshName: mesh?.name,
    }
  })()`)
  console.log(name, JSON.stringify(res))
  const d = res.dom
  const colored = d.r + d.g + d.b + d.other
  const pass = want === 'hue' ? colored > 500 && d.white < colored * 0.2
    : want === 'red' ? d.r > 500 && d.white < d.r * 0.25
    : res.vb?.normalized === true && d.white < res.n * 0.02 && Math.abs(res.mean[0] - res.mean[2]) < 40 && Math.abs(res.mean[1] - res.mean[2]) < 40
  if (!pass) failed++
  ok(name, pass, `red=${d.r} green=${d.g} blue=${d.b} white=${d.white} mean=${res.mean} hue=${colored > 500 ? 'ok' : 'missing'}`)
}

await browser.close()
if (failed) { console.error(`FAIL ${failed} check(s)`); process.exit(1) }
console.log('ALL VCOLOR VIEWER CHECKS PASSED')
