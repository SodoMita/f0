// Visual guard for the studio symbol library (AMENDMENT 85): place a strip of
// palette-textured pieces in the real studio and screenshot the canvas, so a
// human (or an agent with `visual_critique.py`) can see that the palette
// texture actually renders — not black, not washed out, not inside-out.
//
//   node scripts/library-shot.mjs [id,id,id]
//
// Needs a browser (scripts/browser.mjs) and a built standalone
// (`bun run build:standalone`) or TARGET_URL pointing at a dev/preview server.
import { launchFormBrowser } from './browser.mjs'

const URL = process.env.TARGET_URL || 'file:///home/user/f0/form-zero-standalone.html'
const IDS = (process.argv[2] || 'smile,cool,invader,creep,grassblock,snake,pixheart,sword').split(',')
const OUT = process.env.OUT || 'shots/library-studio.png'

const browser = await launchFormBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)) })

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => window.__form0?.studio, null, { timeout: 60000 }).catch(() => {})
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await page.evaluate(() => window.__form0.router?.go?.({ name: 'studio' }))
await page.waitForTimeout(1200)
await page.click('button[data-tab="symbols"]')
await page.waitForTimeout(400)

for (const id of IDS) {
  const sel = `#symbol-grid button[data-symbol="${id}"]`
  const found = await page.$(sel)
  if (!found) { console.log(`MISS  ${id}`); continue }
  await page.click(sel)
  await page.waitForTimeout(1400)
  console.log(`placed ${id}`)
}

// frame everything the studio holds
const info = await page.evaluate((ids) => {
  const s = window.__form0.studio
  const cam = s.scene.activeCamera
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const m of s.scene.meshes) {
    if (!m.getTotalVertices || m.getTotalVertices() === 0) continue
    if (!ids.includes(m.name)) continue  // skip the studio grid / helpers
    m.computeWorldMatrix(true)
    const b = m.getBoundingInfo().boundingBox
    for (const k of ['x', 'y', 'z']) {
      const i = { x: 0, y: 1, z: 2 }[k]
      lo[i] = Math.min(lo[i], b.minimumWorld[k])
      hi[i] = Math.max(hi[i], b.maximumWorld[k])
    }
  }
  if (cam && Number.isFinite(lo[0])) {
    cam.target.set((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2)
    cam.alpha = -Math.PI / 2
    cam.beta = Math.PI / 2.35
    cam.radius = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 1.2 + 1.5
  }
  const mats = s.scene.materials.filter((m) => !!m.albedoTexture)
  return { pieces: s.libraryCount, textured: mats.length, meshes: s.scene.meshes.length, box: [lo, hi] }
}, IDS)
await page.evaluate(() => window.__form0.studio.select?.(null)).catch(() => {})
await page.waitForTimeout(900)
await page.screenshot({ path: OUT })
console.log(JSON.stringify(info), '->', OUT)
if (errors.length) console.log('errors:', errors.slice(0, 5))
await browser.close()
