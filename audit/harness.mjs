// Agent-browser audit harness for FORM/0.
// Launches Chromium (SwiftShader WebGL), collects console/pageerror/request
// failures, and saves screenshots to audit/shots/.
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
mkdirSync(join(__dir, 'shots'), { recursive: true })

const msg = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 200)

export async function launch() {
  let mod
  try { mod = await import('playwright') } catch { mod = await import('playwright-core') }
  const chromium = mod.chromium ?? mod.default?.chromium
  return chromium.launch({
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
  })
}

export function newRecorder(page, tag) {
  const rec = { console: [], pageErrors: [], failedRequests: [] }
  page.on('console', (m) => {
    const t = m.type()
    if (t === 'error' || t === 'warning') {
      const text = m.text().slice(0, 300)
      rec.console.push({ type: t, text })
      console.log(`  [console.${t}] ${text}`)
    }
  })
  page.on('pageerror', (e) => {
    rec.pageErrors.push(msg(e))
    console.log(`  [PAGEERROR] ${msg(e)}`)
  })
  page.on('requestfailed', (r) => {
    const f = r.failure()?.errorText || ''
    if (f.includes('ERR_ABORTED')) return // navigation cancels are noise
    rec.failedRequests.push({ url: r.url().slice(0, 160), error: f })
    console.log(`  [REQFAIL] ${r.url().slice(0, 120)} ${f}`)
  })
  rec.shot = async (name) => {
    await page.screenshot({ path: join(__dir, 'shots', `${tag}-${name}.png`) })
    console.log(`  [shot] ${tag}-${name}.png`)
  }
  return rec
}

export async function open(page, url, { waitBoard = true, waitMs = 12000 } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  if (waitBoard) {
    await page.waitForFunction(() => window.__form0?.board, null, { timeout: 20000 }).catch(() => {})
  }
  await page.waitForTimeout(waitMs)
}

export const URL_BASE = process.env.TARGET_URL || 'http://localhost:4173/'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function reportFindings(name, findings) {
  console.log(`\n=== ${name}: ${findings.length} findings ===`)
  findings.forEach((f, i) => console.log(`  ${i + 1}. ${f}`))
}
