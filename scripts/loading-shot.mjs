// Screenshots of the loading states (board card rings + HUD ring).
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
mkdirSync('shots', { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
await page.screenshot({ path: 'shots/loading_boot.png' })      // "connecting" ring
await page.waitForFunction(() => window.__form0?.board?.rows?.length > 0, null, { timeout: 30000 }).catch(()=>{})
await page.waitForTimeout(900)
await page.screenshot({ path: 'shots/loading_cards.png' })      // per-card rings
await page.waitForTimeout(24000)
// slow the model fetch so the viewer ring is visible
await page.evaluate(() => {
  const a = window.__form0.assets
  const orig = a.getModel.bind(a)
  a.getModel = (m) => new Promise((res) => setTimeout(() => res(orig(m)), 4000))
})
const pos = await page.evaluate(() => window.__form0.board.screenPosOf(0))
await page.mouse.click(pos.x, pos.y)
await page.waitForTimeout(1200)
await page.screenshot({ path: 'shots/loading_viewer.png' })
console.log('ok')
await browser.close()
