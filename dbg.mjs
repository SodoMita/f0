import { chromium } from 'playwright'
const b = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1280, height: 800 } })
p.on('pageerror', e => console.log('[pageerror]', e.message.slice(0,200)))
await p.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => window.__form0?.assets, { timeout: 20000 })
await p.evaluate(() => window.__form0?.legend?.close()).catch(()=>{})
await p.waitForTimeout(16000)
console.log('roots:', JSON.stringify(await p.evaluate(() => [...window.__form0.index.byId.values()]
  .filter(m => m.role === 'root')
  .map(m => ({ id: m.eventId.slice(0,6), mb: +(m.size/1048576).toFixed(1), poster: window.__form0.assets.posterTex.has(m.eventId) })))))
const pos = await p.evaluate(() => window.__form0.board.screenPosOf(0))
await p.mouse.click(pos.x, pos.y)
await p.waitForTimeout(12000)
console.log('viewer:', JSON.stringify(await p.evaluate(() => ({
  hash: location.hash.slice(0, 22),
  meshes: window.__form0.viewer.stats().meshes,
  busy: window.__form0.viewer.busy,
  errSheet: !document.getElementById('error-sheet')?.hidden,
  gfxErrors: [...window.__form0.graphics.errors.entries()],
}))))
await b.close()
