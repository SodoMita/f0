import { chromium } from 'playwright'
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__form0?.board, null, { timeout: 15000 }).catch(()=>{})
await page.waitForTimeout(20000)
const rows = await page.evaluate(() => [...window.__form0.index.byId.values()].map(m => ({ id: m.eventId.slice(0,8), size: m.size, url: m.urls[0] })))
console.log(JSON.stringify(rows, null, 1))
await browser.close()
