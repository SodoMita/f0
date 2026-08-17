// Orientation regression guard: /test/orient2.html must report every texture
// kind (raw / dyn / rtt) as correctly oriented — no mirrored posts, no
// mirrored reply badges, nothing upside down.
import { chromium } from 'playwright'

const URL = (process.env.TARGET_URL || 'http://localhost:5173/') + 'test/orient2.html'
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1000, height: 500 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)))
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForFunction(() => window.__orient, null, { timeout: 30000 })
const r = await page.evaluate(() => window.__orient)
console.log(await page.evaluate(() => document.getElementById('out').textContent))
await page.screenshot({ path: 'shots/orient.png' })
await browser.close()
process.exit(r.ok ? 0 : 1)
