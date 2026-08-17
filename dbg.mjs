import { chromium } from 'playwright'
const b = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const p = await b.newPage({ viewport: { width: 1280, height: 800 } })
await p.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => window.__form0?.threadView, { timeout: 20000 })
await p.evaluate(() => window.__form0?.legend?.close()).catch(()=>{})
await p.waitForTimeout(8000)
console.log(JSON.stringify(await p.evaluate(() => {
  const el = document.elementFromPoint(640, 400)
  const chain = []
  let n = el
  while (n && chain.length < 6) {
    const cs = getComputedStyle(n)
    chain.push({ tag: n.tagName, id: n.id, cls: n.className?.toString().slice(0,40), pe: cs.pointerEvents, pos: cs.position, z: cs.zIndex, rect: n.getBoundingClientRect().toJSON?.() ? undefined : undefined, w: Math.round(n.getBoundingClientRect().width), h: Math.round(n.getBoundingClientRect().height) })
    n = n.parentElement
  }
  return chain
}), null, 1))
await b.close()
