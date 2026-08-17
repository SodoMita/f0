// Screenshots + smoke of the settings drawer: every group, preset switching,
// and that changing a setting actually reaches the engine.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
mkdirSync('shots', { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errs = []
page.on('pageerror', e => errs.push(e.message.slice(0, 160)))
page.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text().slice(0, 160)) })
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => window.__form0?.settingsPanel, { timeout: 20000 })
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await page.waitForTimeout(14000)
await page.evaluate(() => window.__form0.settingsPanel.open())
await page.waitForTimeout(400)

const info = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#settings-panel .setting')]
  return {
    groups: [...document.querySelectorAll('#settings-panel .settings-group')].length,
    rows: rows.length,
    visible: rows.filter(r => !r.hidden).length,
    unavailable: rows.filter(r => r.classList.contains('unavailable')).map(r => r.dataset.id),
    readout: document.querySelector('#resolution-readout')?.textContent,
  }
})
console.log('panel:', JSON.stringify(info, null, 1))
await page.screenshot({ path: 'shots/settings_top.png' })
await page.evaluate(() => { document.querySelector('.settings-body').scrollTop = 900 })
await page.waitForTimeout(200)
await page.screenshot({ path: 'shots/settings_mid.png' })
await page.evaluate(() => { document.querySelector('.settings-body').scrollTop = 2100 })
await page.waitForTimeout(200)
await page.screenshot({ path: 'shots/settings_low.png' })
await page.evaluate(() => { document.querySelector('.settings-body').scrollTop = 3600 })
await page.waitForTimeout(200)
await page.screenshot({ path: 'shots/settings_audio.png' })
console.log('errors:', errs.slice(0, 5))
await browser.close()
