// End-to-end GLB -> AssetCache -> board/tree Babylon controls -> viewer guard.
// Requires scripts/offline-rig.mjs (flavour c carries an embedded WAV).
import { chromium } from 'playwright'

const URL = process.env.TARGET_URL || 'http://localhost:4173/'
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--ignore-certificate-errors'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45_000 })
await page.waitForFunction(() => window.__form0?.index?.byId?.size >= 52, { timeout: 30_000 })
await page.evaluate(() => {
  const f = window.__form0
  f.legend?.close()
  f.errorSheet?.hide()
  // The focused integration guard verifies in-scene routing rather than the
  // browser decoder (audio-playback.mjs covers the real toggle/HRTF graph).
  // Keep setAudio/setSpatialPose real, but make play deterministic on hosts
  // without an audio device.
  f.audioPlayer.toggle = async function () {
    window.__postAudioToggles = (window.__postAudioToggles || 0) + 1
    this.setState(this.state === 'playing' ? 'stopped' : 'playing')
  }
})

const ids = await page.evaluate(async () => {
  const f = window.__form0
  const audioMeta = [...f.index.byId.values()].find((m) => m.role === 'root' && m.filename === 'c.glb')
  const plainMeta = [...f.index.byId.values()].find((m) => m.role === 'root' && m.filename === 'b.glb')
  const audioReply = [...f.index.byId.values()].find((m) => m.role === 'reply' && m.filename === 'c.glb')
  if (!audioMeta || !plainMeta || !audioReply) return null
  await f.assets.getPoster(audioMeta)
  return {
    audio: audioMeta.eventId,
    plain: plainMeta.eventId,
    reply: audioReply.eventId,
    root: audioReply.refs.rootId,
  }
})
check('rig exposes audio/plain roots and an audio reply', !!ids)
if (!ids) {
  await browser.close()
  process.exit(1)
}

const card = await page.evaluate((id) => {
  const f = window.__form0
  const meta = f.index.byId.get(id)
  const slot = f.board.cards.find((c) => c.meta?.eventId === id)
  return {
    verified: meta.audioVerified,
    hasAudio: meta.hasAudio,
    marked: !!slot?.audioBadge.isEnabled(),
    meshName: slot?.audioBadge.name,
    metadata: !!slot?.audioBadge.metadata?.audioButton,
  }
}, ids.audio)
check('actual GLB bytes verify the event audio hint', card.verified && card.hasAudio)
check('verified card owns an enabled Babylon audio button', card.marked && card.metadata && card.meshName?.startsWith('audio-button-'), JSON.stringify(card))

const boardTap = await page.evaluate((id) => {
  const f = window.__form0
  const b = f.board
  const slot = b.cards.find((c) => c.meta?.eventId === id)
  if (!slot) return null
  const eng = b.scene.getEngine()
  const cssW = eng.getRenderWidth() * eng.getHardwareScalingLevel()
  const cssH = eng.getRenderHeight() * eng.getHardwareScalingLevel()
  const x = cssW / 2 + slot.audioBadge.position.x * b.pxPerUnit
  const y = ((b.halfH - slot.audioBadge.position.y) / (2 * b.halfH)) * cssH
  b.tapAt(x, y)
  return {
    sourceId: f.audioPlayer.sourceId,
    state: f.audioPlayer.state,
    toggles: window.__postAudioToggles,
    face: slot.audioBadgeMat.getTexture?.('textureSampler')?.name || slot.audioBadgeMat._textures?.textureSampler?.name,
    pose: f.audioPlayer.pose,
  }
}, ids.audio)
check('tapping the board mesh plays without opening viewer', boardTap?.sourceId === ids.audio && boardTap.state === 'playing' && boardTap.toggles === 1, JSON.stringify(boardTap))
check('board control supplies a card-relative HRTF pose', boardTap?.pose?.source && boardTap.pose.listener?.z === -30, JSON.stringify(boardTap?.pose))

await page.evaluate((root) => window.__form0.router.go({ name: 'thread', rootId: root }), ids.root)
await page.waitForFunction((id) => window.__form0.threadView.nodes.get(id)?.audio?.isEnabled(), ids.reply, { timeout: 30_000 })
const tree = await page.evaluate((id) => {
  const f = window.__form0
  const t = f.threadView
  const node = t.nodes.get(id)
  return {
    enabled: !!node?.audio.isEnabled(),
    meshName: node?.audio.name,
    metadata: node?.audio.metadata?.taudio?.eventId === id,
    oldReleased: f.audioPlayer.state === 'unavailable' && f.audioPlayer.sourceId === null,
  }
}, ids.reply)
check('route switch releases the board source graph/URL', tree.oldReleased)
check('verified thread node owns an enabled Babylon audio button', tree.enabled && tree.metadata && tree.meshName?.startsWith('taudio-'), JSON.stringify(tree))

const treeTap = await page.evaluate((id) => {
  const f = window.__form0
  const t = f.threadView
  const node = t.nodes.get(id)
  if (!node) return null
  const rect = t.scene.getEngine().getRenderingCanvas().getBoundingClientRect()
  const halfH = 20 * t.zoom
  const halfW = halfH * t.aspect
  const x = ((node.audio.position.x - t.panX) / halfW + 1) * rect.width / 2
  const y = (1 - (node.audio.position.y - t.panY) / halfH) * rect.height / 2
  t.tapAt(x, y)
  return {
    sourceId: f.audioPlayer.sourceId,
    state: f.audioPlayer.state,
    toggles: window.__postAudioToggles,
    pose: f.audioPlayer.pose,
  }
}, ids.reply)
check('tapping the tree mesh plays without opening viewer', treeTap?.sourceId === ids.reply && treeTap.state === 'playing' && treeTap.toggles === 2, JSON.stringify(treeTap))
check('tree control tracks node and active Babylon camera positions', treeTap?.pose?.source && treeTap.pose.listener?.x !== undefined && treeTap.pose.listener?.z === -30, JSON.stringify(treeTap?.pose))

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
  element: window.__form0.audioPlayer.element,
  route: window.__form0.audioPlayer.route,
}))
check('plain GLB navigation releases media and HRTF route', plain.state === 'unavailable' && plain.hidden && !plain.element && !plain.route, JSON.stringify(plain))

await browser.close()
if (failures.length) {
  console.log(`FAILURES: ${failures.join(' | ')}`)
  process.exit(1)
}
console.log('ALL AUDIO INTEGRATION CHECKS PASSED')
