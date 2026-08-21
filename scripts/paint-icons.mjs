// Browser guard for runtime editor model thumbnails + quad/triangle brushes.
// Run against a dev/preview/offline-rig URL:
//   TARGET_URL=http://localhost:5173/ node scripts/paint-icons.mjs
import { launchFormBrowser } from './browser.mjs'

const URL = process.env.TARGET_URL || 'http://localhost:4173/'
const browser = await launchFormBrowser()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(error.message.slice(0, 240)))

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.waitForFunction(() => window.__form0?.studio, { timeout: 60_000 })
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await page.evaluate(() => window.__form0.router.go({ name: 'studio' }))
await page.waitForFunction(() => window.__form0?.__mode?.() === 'studio', { timeout: 15_000 })

await page.click('button[data-tab="paint"]')
await page.waitForFunction(() => document.querySelectorAll('.paint-shapes .icon-ready').length === 6, { timeout: 30_000 })

const paintIcons = await page.evaluate(() => {
  const alphaOf = (image) => {
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let alpha = 0
    for (let i = 3; i < pixels.length; i += 4) alpha += pixels[i]
    return alpha
  }
  return [...document.querySelectorAll('.paint-shapes [data-shape]')].map((button) => {
    const image = button.querySelector('img')
    const rect = button.getBoundingClientRect()
    return {
      shape: button.dataset.shape,
      src: image?.src ?? '',
      alpha: image ? alphaOf(image) : 0,
      width: rect.width,
      height: rect.height,
      svg: button.querySelectorAll('svg').length,
    }
  })
})
const shapeNames = paintIcons.map((icon) => icon.shape)
check('paint has quad + triangle brushes', shapeNames.includes('quad') && shapeNames.includes('triangle'), shapeNames.join(','))
check('all six paint icons are runtime blob images', paintIcons.length === 6 && paintIcons.every((icon) => icon.src.startsWith('blob:') && icon.svg === 0))
check('all paint model textures contain visible pixels', paintIcons.every((icon) => icon.alpha > 0), JSON.stringify(paintIcons.map(({ shape, alpha }) => [shape, alpha])))
check('paint model buttons keep 42px touch targets', paintIcons.every((icon) => icon.width >= 42 && icon.height >= 42))

await page.click('[data-shape="quad"]')
const quadSelected = await page.evaluate(() => window.__form0.studio.paint.opts.shape)
await page.click('[data-shape="triangle"]')
const triangleSelected = await page.evaluate(() => window.__form0.studio.paint.opts.shape)
check('quad brush selects', quadSelected === 'quad', quadSelected)
check('triangle brush selects', triangleSelected === 'triangle', triangleSelected)

const painted = await page.evaluate(() => {
  const paint = window.__form0.studio.paint
  paint.clear()
  const point = (x) => ({ x, y: 0, z: 0, pressure: 1, t: x * 10 })
  paint.setOpts({ shape: 'quad' })
  paint.drawStroke([point(0)])
  paint.setOpts({ shape: 'triangle' })
  paint.drawStroke([point(1)])
  return {
    shapes: paint.store.toArray().map((stamp) => stamp.shape),
    quadVertices: paint.instances.meshes.get('quad')?.getTotalVertices() ?? 0,
    triangleVertices: paint.instances.meshes.get('triangle')?.getTotalVertices() ?? 0,
    triangleIndices: paint.instances.meshes.get('triangle')?.getTotalIndices() ?? 0,
  }
})
check('quad + triangle strokes use their own source meshes',
  painted.shapes.join(',') === 'quad,triangle' && painted.quadVertices >= 4 && painted.triangleVertices === 3 && painted.triangleIndices === 3,
  JSON.stringify(painted))

await page.click('button[data-tab="symbols"]')
await page.evaluate(() => {
  const shape = [...document.querySelectorAll('.symbol-filter')].find((button) => button.textContent === 'shape')
  shape?.click()
})
await page.waitForFunction(() => document.querySelectorAll('.symbol-cells button').length >= 10)
await page.locator('.symbol-cells button').last().scrollIntoViewIfNeeded()
await page.waitForFunction(() => {
  const cells = [...document.querySelectorAll('.symbol-cells button')]
  return cells.length > 0 && cells.every((button) => button.classList.contains('icon-ready'))
}, { timeout: 60_000 })
const libraryIcons = await page.evaluate(() => [...document.querySelectorAll('.symbol-cells button')].map((button) => ({
  id: button.dataset.symbol,
  src: button.querySelector('img')?.src ?? '',
  svg: button.querySelectorAll('svg').length,
  error: button.classList.contains('icon-error'),
})))
check('shape-tab icons are runtime model images', libraryIcons.every((icon) => icon.src.startsWith('blob:') && icon.svg === 0 && !icon.error),
  JSON.stringify(libraryIcons))
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))

await browser.close()
console.log(failures.length ? `FAILURES: ${failures.join(' | ')}` : 'ALL PAINT ICON CHECKS PASSED')
process.exit(failures.length ? 1 : 0)
