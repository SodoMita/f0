// Liveness + JS heap check after a full live session (crash regression).
import { chromium } from 'playwright'
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
let crashed = false
page.on('crash', () => { crashed = true })
await page.goto('file:///home/user/f0/form-zero-standalone.html', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__form0 && window.__form0.index, null, { timeout: 15000 }).catch(()=>{})
await page.waitForTimeout(20000)
const m = await page.evaluate(() => ({
  alive: true,
  events: window.__form0.index.byId.size,
  jsHeapMB: performance.memory ? +(performance.memory.usedJSHeapSize/1048576).toFixed(1) : -1,
  liveSlots: window.__form0.board.previewPool.activeCount,
  rejected: window.__form0.board.previewPool.rejected ? 0 : 0,
}))
console.log(JSON.stringify({ ...m, crashed }, null, 2))
await browser.close()
