// End-to-end GLB -> AssetCache -> card badge -> viewer audio control guard.
// Requires scripts/offline-rig.mjs (flavour c carries an embedded WAV).
import { chromium } from 'playwright'

const URL = process.env.TARGET_URL || 'http://localhost:4173/'
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45_000 })
await page.waitForFunction(() => window.__form0?.index?.byId?.size >= 52, { timeout: 30_000 })
await page.evaluate(() => window.__form0.legend?.close())

const ids = await page.evaluate(async () => {
  const f = window.__form0
  const audioMeta = [...f.index.byId.values()].find((m) => m.role === 'root' && m.filename === 'c.glb')
  const plainMeta = [...f.index.byId.values()].find((m) => m.role === 'root' && m.filename === 'b.glb')
  if (!audioMeta || !plainMeta) return null
  await f.assets.getPoster(audioMeta)
  return { audio: audioMeta.eventId, plain: plainMeta.eventId }
})
check('rig exposes audio and plain model posts', !!ids)
if (!ids) {
  await browser.close()
  process.exit(1)
}

const card = await page.evaluate((id) => {
  const f = window.__form0
  const meta = f.index.byId.get(id)
  const slots = f.board.cards.filter((c) => c.meta?.eventId === id)
  return {
    verified: meta.audioVerified,
    hasAudio: meta.hasAudio,
    marked: slots.some((c) => c.audioBadge.isEnabled()),
  }
}, ids.audio)
check('actual GLB bytes verify the event audio hint', card.verified && card.hasAudio)
check('verified audio card shows its speaker marker', card.marked, JSON.stringify(card))

await page.evaluate((id) => window.__form0.router.go({ name: 'viewer', id }), ids.audio)
await page.waitForFunction(() => window.__form0.audioPlayer.available && window.__form0.viewer.stats().meshes > 0, { timeout: 30_000 })
const viewer = await page.evaluate((id) => {
  const f = window.__form0
  const meta = f.index.byId.get(id)
  const audio = f.assets.peekEmbeddedAudio(meta)
  return {
    type: audio?.type,
    size: audio?.size,
    state: f.audioPlayer.state,
    paused: f.audioPlayer.element?.paused,
    hidden: document.getElementById('vbtn-audio').hidden,
  }
}, ids.audio)
check('viewer receives the extracted typed WAV Blob', viewer.type === 'audio/wav' && viewer.size > 44 && viewer.size <= 256 * 1024, JSON.stringify(viewer))
check('opening an audio model does not autoplay', viewer.state === 'stopped' && viewer.paused && !viewer.hidden)

await page.evaluate((id) => window.__form0.router.go({ name: 'viewer', id }), ids.plain)
await page.waitForFunction((id) => location.hash.endsWith(id), ids.plain, { timeout: 30_000 })
await page.waitForTimeout(800)
const plain = await page.evaluate(() => ({
  state: window.__form0.audioPlayer.state,
  hidden: document.getElementById('vbtn-audio').hidden,
}))
check('navigation releases old audio and hides control for a plain GLB', plain.state === 'unavailable' && plain.hidden, JSON.stringify(plain))

await browser.close()
if (failures.length) {
  console.log(`FAILURES: ${failures.join(' | ')}`)
  process.exit(1)
}
console.log('ALL AUDIO INTEGRATION CHECKS PASSED')
