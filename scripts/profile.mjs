// CPU profile of the heavy phase (feed -> posters -> viewer). Aggregates the
// V8 sampling profile by self time so the top JS costs are named, not guessed.
import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'node:fs'

const URL = process.env.TARGET_URL || 'http://localhost:5173/'
const PHASE = process.env.PHASE || 'load' // load | scroll | viewer
mkdirSync('shots', { recursive: true })

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const cdp = await page.context().newCDPSession(page)
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForFunction(() => window.__form0?.board, null, { timeout: 30000 }).catch(() => {})
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})

await cdp.send('Profiler.enable')
await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
await cdp.send('Profiler.start')

if (PHASE === 'load') {
  await page.waitForTimeout(26000)
} else if (PHASE === 'viewer') {
  const ids = await page.evaluate(() => [...window.__form0.index.byId.values()]
    .filter((m) => m.role === 'root').slice(0, 3).map((m) => m.eventId))
  for (const id of ids) {
    await page.evaluate((i) => { location.hash = '#/viewer/' + i }, id)
    await page.waitForTimeout(4000)
    await page.evaluate(() => { location.hash = '#/' })
    await page.waitForTimeout(1200)
  }
} else {
  await page.waitForTimeout(20000)
  await page.evaluate(async () => {
    const b = window.__form0.board
    const t = performance.now()
    while (performance.now() - t < 6000) {
      b.setScroll((b.scrollY + 0.6) % Math.max(0.1, b.maxScroll || 1))
      await new Promise((r) => requestAnimationFrame(r))
    }
  })
}

const { profile } = await cdp.send('Profiler.stop')
writeFileSync(`shots/profile-${PHASE}.cpuprofile`, JSON.stringify(profile))

// aggregate self time per function
const byId = new Map(profile.nodes.map((n) => [n.id, n]))
const self = new Map()
const total = profile.samples.length
const dt = profile.timeDeltas
profile.samples.forEach((id, i) => {
  const n = byId.get(id)
  if (!n) return
  const f = n.callFrame
  const key = `${f.functionName || '(anonymous)'}  ${(f.url || '').split('/').slice(-1)[0]}:${f.lineNumber + 1}`
  self.set(key, (self.get(key) || 0) + (dt[i] || 0) / 1000)
})
const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 28)
const wall = dt.reduce((a, b) => a + b, 0) / 1000
console.log(`PHASE=${PHASE}  wall=${wall.toFixed(0)}ms  samples=${total}\n`)
console.log('self(ms)   %     function')
for (const [k, v] of rows) {
  if (v < 8) continue
  console.log(`${v.toFixed(0).padStart(7)}  ${((v / wall) * 100).toFixed(1).padStart(5)}%  ${k}`)
}
await browser.close()
