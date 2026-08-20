// Verify studio error messages wrap to new lines inside the stage boundary.
import { chromium } from 'playwright'

const URL = process.env.TARGET_URL || 'http://localhost:5173/'
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BROWSER_PATH || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message.slice(0, 200)))
const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForFunction(() => window.__form0?.studio, { timeout: 30000 })
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await page.waitForTimeout(6000)

// open the studio like a user
await page.evaluate(() => window.__form0.router.go({ name: 'studio' }))
await page.waitForFunction(() => !document.getElementById('studio').hidden, { timeout: 10000 })
await page.waitForTimeout(800)

const stage = await page.evaluate(() => {
  const stageEl = document.querySelector('.studio-stage')
  const r = stageEl.getBoundingClientRect()
  return { left: r.left, right: r.right, width: r.width }
})
console.log('stage bounds:', JSON.stringify(stage))

// Long error message (like a Blossom URL upload failure / import-sidecar URI error)
const result = await page.evaluate((bounds) => {
  const el = document.getElementById('studio-status')
  el.textContent = 'Model upload failed on every Blossom server: https://blossom.example.org:3000/upload failed (500) — try again in a moment.'
  el.className = 'studio-status err'
  // force layout
  void el.offsetHeight
  const r = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  return {
    text: el.textContent,
    rect: { left: r.left, right: r.right, width: r.width, height: r.height },
    whiteSpace: cs.whiteSpace,
    overflowWrap: cs.overflowWrap,
    lineHeight: parseFloat(cs.lineHeight),
    lines: Math.round(r.height / parseFloat(cs.lineHeight)),
    fitsStage: r.left >= bounds.left - 1 && r.right <= bounds.right + 1,
  }
}, stage)

console.log('err status:', JSON.stringify(result, null, 2))
check('err message wraps (white-space pre-line)', ['normal', 'pre-line'].includes(result.whiteSpace), `white-space=${result.whiteSpace}`)
check('err message breaks long tokens (overflow-wrap anywhere)', result.overflowWrap === 'anywhere', `overflow-wrap=${result.overflowWrap}`)
check('err message renders on >1 line', result.lines > 1, `${result.lines} line(s), height=${result.rect.height}`)
check('err message stays inside stage boundaries', result.fitsStage, `right=${result.rect.right} stageRight=${stage.right}`)

// short busy/ok statuses must stay on ONE line (regression guard)
const one = await page.evaluate(() => {
  const el = document.getElementById('studio-status')
  el.textContent = 'upload…'
  el.className = 'studio-status busy'
  void el.offsetHeight
  return {
    lines: el.getClientRects().length,
    whiteSpace: getComputedStyle(el).whiteSpace,
  }
})
check('busy status stays single line', one.lines === 1 && one.whiteSpace === 'nowrap', JSON.stringify(one))

// explicit newline in an error message is honored as a hard line break
const nl = await page.evaluate(() => {
  const el = document.getElementById('studio-status')
  el.textContent = 'GLB fails validation:\nJSON chunk exceeds 2 MiB.'
  el.className = 'studio-status err'
  void el.offsetHeight
  const r = el.getBoundingClientRect()
  return Math.round(r.height / parseFloat(getComputedStyle(el).lineHeight))
})
console.log(`explicit-newline err renders ${nl} line(s)`)
check('explicit newline in error creates a line break', nl >= 2, `${nl} lines`)

await page.screenshot({ path: 'shots/studio_error_wrap.png' })
await browser.close()
if (errs.length) { console.log('pageerrors:', errs); fails.push('page error') }
if (fails.length) { console.error(`FAILED: ${fails.length}`); process.exit(1) }
console.log('ALL PASS')
