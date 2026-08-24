// Guard: the studio "image" tab uploads a picture and places it as a flat
// textured plane that exports into the published GLB.
//
//   TARGET_URL=http://localhost:4173/ node scripts/image-plane.mjs
//
// Registers as the `image-plane` e2e suite (scripts/run-e2e.mjs).
import { chromium } from 'playwright'

const URL = process.env.TARGET_URL || 'http://localhost:4173/'
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_PATH || undefined,
  // --ignore-certificate-errors: the rig relay serves wss://localhost:8443
  // with a self-signed cert; the headless test browser must accept it.
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message.slice(0, 200)))

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

/** Tiny 4x4 RGBA checker PNG (83 bytes). */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAGklEQVR4nGP4b2PzH4Sh1H8GDAEYAyaCIQAALx8nYS5AgcoAAAAASUVORK5CYII='

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForFunction(() => window.__form0?.studio, { timeout: 30000 })
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await page.waitForFunction(() => window.__form0.board.rows.length > 0, { timeout: 30000 })
await page.evaluate(() => { location.hash = '#/studio' })
await page.waitForFunction(() => window.__form0.__mode() === 'studio', { timeout: 10000 })
await page.waitForTimeout(400)

// 1. the image rail tab exists and opens its panel
await page.click('.rail-btn[data-tab="image"]')
await page.waitForTimeout(200)
const panelOpen = await page.evaluate(() => {
  const panel = document.querySelector('.studio-panel[data-panel="image"]')
  return panel && !panel.hidden && !!document.getElementById('btn-studio-image')
})
check('image tab opens the image panel', panelOpen)

// 2. uploading a PNG places one textured plane
await page.setInputFiles('#studio-image-file', {
  name: 'checker.png', mimeType: 'image/png', buffer: Buffer.from(PNG_B64, 'base64'),
})
await page.waitForFunction(() => window.__form0.studio.imageCount === 1, { timeout: 15000 })
const placed = await page.evaluate(() => {
  const s = window.__form0.studio
  const p = s.imagePlanes[0]
  return {
    count: s.imageCount,
    hasContent: s.hasContent(),
    mesh: !!p?.mesh && p.mesh.isEnabled() && p.mesh.isPickable,
    tex: !!p?.texture?.isReady && p.texture.isReady(),
    dims: p ? [p.pixelW, p.pixelH] : null,
    world: p ? [p.width.toFixed(2), p.height.toFixed(2)] : null,
  }
})
check('imageCount is 1', placed.count === 1, `count=${placed.count}`)
check('hasContent includes the image', placed.hasContent === true)
check('plane mesh is enabled and pickable', placed.mesh === true)
check('plane texture is ready', placed.tex === true)
check('plane pixels are the source size', !!placed.dims && placed.dims[0] === 4 && placed.dims[1] === 4, String(placed.dims))
check('plane world size keeps the aspect', !!placed.world && placed.world[0] === '4.00' && placed.world[1] === '4.00', String(placed.world))

// 3. the export embeds the image as a GLB texture on one plane mesh
const glb = await page.evaluate(async () => {
  const r = await window.__form0.studio.getContentForPublish()
  const bytes = new Uint8Array(await r.blob.arrayBuffer())
  if (bytes.byteLength < 20 || bytes[0] !== 0x67 || bytes[1] !== 0x6c || bytes[2] !== 0x54 || bytes[3] !== 0x46) return { magic: false, head: Array.from(bytes.slice(0, 16)), len: bytes.byteLength }
  const view = new DataView(bytes.buffer)
  let offset = 12
  let json = null
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset, true)
    const type = view.getUint32(offset + 4, true)
    offset += 8
    if (type === 0x4e4f534a) {
      try { json = JSON.parse(new TextDecoder().decode(bytes.subarray(offset, offset + size))) } catch { return { json: false } }
      break
    }
    offset += size
  }
  if (!json) return { json: false }
  return {
    magic: true, json: true,
    filename: r.filename,
    textures: (json.textures ?? []).length,
    images: (json.images ?? []).length,
    meshes: (json.meshes ?? []).length,
    hasExt: Array.isArray(json.extensionsUsed) ? json.extensionsUsed.includes('KHR_materials_unlit') : false,
    size: bytes.byteLength,
  }
})
check("export is a GLB", glb.magic === true && glb.json === true)
check('export filename is the image name', glb.filename === 'checker.glb', glb.filename)
check('GLB has one texture', glb.textures === 1, `textures=${glb.textures}`)
check('GLB has one embedded image', glb.images === 1, `images=${glb.images}`)
check('GLB has one plane mesh', glb.meshes === 1, `meshes=${glb.meshes}`)
check('material is unlit (picture stays a picture)', glb.hasExt === true)
check('export is small (4x4 PNG)', glb.size < 20000, `${glb.size} bytes`)

// 4. a large source keeps its NATIVE resolution (no cap — the post size
//    limit is the bound), and the tab's width control sets the plane's
//    world size (height follows the aspect)
await page.fill('#image-width', '8')
const big = await page.evaluate(async () => {
  const canvas = document.createElement('canvas')
  canvas.width = 3000
  canvas.height = 1000
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#0b6b6b'
  ctx.fillRect(0, 0, 3000, 1000)
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'))
  const file = new File([blob], 'wide.png', { type: 'image/png' })
  const dt = new DataTransfer()
  dt.items.add(file)
  const input = document.getElementById('studio-image-file')
  input.files = dt.files
  input.dispatchEvent(new Event('change'))
  return true
})
check('large upload dispatched', big === true)
await page.waitForFunction(() => window.__form0.studio.imageCount === 2, { timeout: 15000 })
const bigPlane = await page.evaluate(() => {
  const p = window.__form0.studio.imagePlanes[1]
  return p ? { px: p.pixelW, py: p.pixelH, w: p.width.toFixed(2), h: p.height.toFixed(2) } : null
})
check('wide image keeps native resolution (no cap)', bigPlane?.px === 3000 && bigPlane?.py === 1000,
  JSON.stringify(bigPlane))
check('world size follows the width control + aspect', bigPlane?.w === '8.00' && bigPlane?.h === '2.67',
  JSON.stringify(bigPlane))

// 5. deleting the planes removes the image from content (an object must be
//    selected first — delete acts on the selection, like every studio object)
await page.evaluate(() => { window.__form0.studio.deleteSelection() })
await page.waitForFunction(() => window.__form0.studio.imageCount === 1, undefined, { timeout: 5000 })
await page.evaluate(() => { window.__form0.studio.select(window.__form0.studio.imagePlanes[0].mesh) })
await page.evaluate(() => { window.__form0.studio.deleteSelection() })
await page.waitForFunction(() => window.__form0.studio.imageCount === 0, undefined, { timeout: 5000 })
check('deleteSelection removes the planes', await page.evaluate(() => !window.__form0.studio.hasContent()))

check('no page errors', errs.length === 0, errs.join(' | ').slice(0, 300))

await browser.close()
if (fails.length) {
  console.error(`\nFAIL  ${fails.length} image-plane check(s): ${fails.join(', ')}`)
  process.exit(1)
}
console.log('\nALL IMAGE-PLANE CHECKS PASSED')
