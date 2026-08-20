// Vertex-color render check — POSTER path (board card textures) (AMENDMENT 71).
// The same PosterRenderer the board uses renders heart.glb (red draco vertex
// colors) + cube.glb (uniform grey); the RTTs are sampled for hue.
//
//   TARGET_URL=http://127.0.0.1:5173 node scripts/vcolor-poster.mjs
import { launchFormBrowser } from './browser.mjs'

const TARGET = process.env.TARGET_URL || 'http://127.0.0.1:5199/'
const ok = (n, c, x = '') => console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${x ? ' — ' + x : ''}`)

const browser = await launchFormBrowser()
const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
page.on('pageerror', (e) => console.log('[pageerror]', String(e.message).slice(0, 300)))

await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => window.__form0 && window.__form0.viewer, null, { timeout: 60000 })
await page.evaluate(async () => {
  const F = window.__form0
  F.setLoading?.(false); F.errorSheet?.close?.(); F.legend?.close?.()
  const [a, b] = await Promise.all([
    fetch('/@fs/home/user/f0/src/studio/library/glb/heart.glb').then(r => r.arrayBuffer()),
    fetch('/@fs/home/user/f0/src/studio/library/glb/cube.glb').then(r => r.arrayBuffer()),
  ])
  window.__heart = new Uint8Array(a)
  window.__cube = new Uint8Array(b)
})

let failed = 0
for (const [gv, expect] of [['__heart', 'red'], ['__cube', 'grey']]) {
  const res = await page.evaluate(`(async () => {
    const { PosterRenderer } = await import('/src/model/poster.ts')
    // SANDBOX-ONLY stretch: doRender fires three scene.render() calls ~2ms
    // apart, which outruns SwiftShader's parallel shader compile (~1s) and
    // would leave the poster empty. Real GPUs resolve compile within the
    // existing spacing; this is only for the software-GL sandbox and must
    // never become a production timing change.
    const realST = window.setTimeout
    window.setTimeout = (fn, ms, ...a) => realST(fn, (ms ?? 0) + 700, ...a)
    const pr = new PosterRenderer(window.__form0.engine.engine)
    const r1 = await pr.render(window.${gv}, '${gv}-p1', 512, 320)
    const px = await pr.snapshot(r1.texture, 512, 320)
    const dom = { r: 0, g: 0, b: 0, white: 0, other: 0, covered: 0 }
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2], a = px[i + 3]
      if (a < 10) continue
      dom.covered++
      const hi = Math.max(r, g, b), spread = hi - Math.min(r, g, b)
      if (spread > 40 && hi > 80) {
        if (r > 1.8 * Math.max(g, b)) dom.r++
        else if (g > 1.8 * Math.max(r, b)) dom.g++
        else if (b > 1.8 * Math.max(r, g)) dom.b++
        else dom.other++
      } else if (r > 230 && g > 230 && b > 230) dom.white++
    }
    r1.texture.dispose()
    pr.dispose()
    window.setTimeout = realST
    return dom
  })()`)
  console.log(gv, 'poster', JSON.stringify(res))
  const pass = expect === 'red'
    ? res.r > 500 && res.white < res.r * 0.25
    : res.covered > 500 && res.white < res.covered * 0.25
  if (!pass) failed++
  ok(`poster ${gv === '__heart' ? 'draco heart red' : 'draco cube grey'}`, pass, JSON.stringify(res))
}

await browser.close()
if (failed) { console.error(`FAIL ${failed} check(s)`); process.exit(1) }
console.log('ALL VCOLOR POSTER CHECKS PASSED')
