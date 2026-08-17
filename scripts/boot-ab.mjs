// Controlled A/B of boot cost on PRODUCTION builds: transfer bytes, parse+eval
// time, time to first paintable card. Relay content varies, so each build is
// measured N times and we report the median.
import { chromium } from 'playwright'
const URL = process.env.TARGET_URL
const RUNS = Number(process.env.RUNS || 3)
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const med = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)]
const boots = [], firsts = [], bytes = [], scripts = []
for (let i = 0; i < RUNS; i++) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  let total = 0
  page.on('response', async (r) => {
    const len = Number(r.headers()['content-length'] || 0)
    if (len) total += len
  })
  const t0 = Date.now()
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForFunction(() => window.__form0?.board, null, { timeout: 40000 }).catch(() => {})
  boots.push(Date.now() - t0)
  await page.waitForFunction(() => window.__form0?.board?.rows?.length > 0, null, { timeout: 40000 }).catch(() => {})
  firsts.push(Date.now() - t0)
  const timing = await page.evaluate(() => {
    const e = performance.getEntriesByType('resource').filter((r) => r.name.endsWith('.js'))
    return { scriptMs: +e.reduce((a, r) => a + r.duration, 0).toFixed(0), transfer: e.reduce((a, r) => a + (r.transferSize || 0), 0) }
  })
  scripts.push(timing.scriptMs)
  bytes.push(timing.transfer || total)
  await ctx.close()
}
console.log(JSON.stringify({ url: URL, runs: RUNS, engineReadyMs: med(boots), firstCardMs: med(firsts), jsTransferBytes: med(bytes), jsResourceMs: med(scripts) }))
await browser.close()
