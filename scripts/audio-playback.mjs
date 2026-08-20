// Browser guard for no-autoplay media decoding + the per-source HRTF graph.
//   TARGET_URL=http://localhost:5173/ node scripts/audio-playback.mjs
import { chromium } from 'playwright'

const URL = process.env.TARGET_URL || 'http://localhost:5173/'
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 960, height: 640 } })
const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

// Deterministic WebAudio: headless hosts often have no output device. This
// records the exact graph while the real HTMLAudioElement/object URL path is
// retained below.
await page.addInitScript(() => {
  const param = (value = 0) => ({
    value,
    setValueAtTime(v) { this.value = v },
    setTargetAtTime(v) { this.value = v },
  })
  const graph = { contexts: 0, resumes: 0, mediaSources: 0, panners: 0, disconnects: 0, edges: [] }
  const node = (kind) => ({
    kind,
    connect(to) { graph.edges.push(`${kind}->${to.kind || 'destination'}`); return to },
    disconnect() { graph.disconnects++ },
  })
  class FakeAudioContext {
    constructor() {
      graph.contexts++
      this.state = 'suspended'
      this.currentTime = 0
      this.destination = { kind: 'destination', maxChannelCount: 2, channelCount: 2, channelInterpretation: 'speakers' }
      this.listener = {
        positionX: param(), positionY: param(), positionZ: param(),
        forwardX: param(), forwardY: param(), forwardZ: param(),
        upX: param(), upY: param(), upZ: param(),
      }
    }
    createGain() { return Object.assign(node('gain'), { gain: param(1) }) }
    createMediaElementSource(element) {
      graph.mediaSources++
      return Object.assign(node('media'), { mediaElement: element })
    }
    createPanner() {
      graph.panners++
      return Object.assign(node('panner'), {
        panningModel: 'equalpower', distanceModel: 'inverse',
        refDistance: 1, maxDistance: 10_000, rolloffFactor: 1,
        coneInnerAngle: 360, coneOuterAngle: 360,
        positionX: param(), positionY: param(), positionZ: param(),
      })
    }
    resume() { graph.resumes++; this.state = 'running'; return Promise.resolve() }
    setSinkId() { return Promise.resolve() }
  }
  window.AudioContext = FakeAudioContext
  window.__audioGraph = graph
})

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45_000 })
await page.waitForFunction(() => window.__form0?.audioPlayer, { timeout: 30_000 })
await page.evaluate(() => {
  window.__form0.legend?.close()
  window.__form0.errorSheet?.hide()
})

const initial = await page.evaluate(() => {
  const p = window.__form0.audioPlayer
  // A minimally valid PCM WAV header + one silent sample. Decode is not part
  // of this test; playback is mocked below so headless needs no audio device.
  const bytes = new Uint8Array(46)
  const v = new DataView(bytes.buffer)
  bytes.set([82, 73, 70, 70], 0); v.setUint32(4, 38, true)
  bytes.set([87, 65, 86, 69, 102, 109, 116, 32], 8)
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, 8000, true); v.setUint32(28, 16000, true)
  v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  bytes.set([100, 97, 116, 97], 36); v.setUint32(40, 2, true)
  p.setAudio(new Blob([bytes], { type: 'audio/wav' }), 'browser-test')
  p.setSpatialPose({
    source: { x: 7, y: -2, z: 0 },
    listener: { x: 1, y: 3, z: -30 },
    forward: { x: 0, y: 0, z: 1 },
    up: { x: 0, y: 1, z: 0 },
  })
  document.getElementById('viewer-bar').hidden = false
  const el = p.element
  let paused = true
  let playCalls = 0
  Object.defineProperty(el, 'paused', { configurable: true, get: () => paused })
  el.play = () => { playCalls++; paused = false; return Promise.resolve() }
  el.pause = () => { paused = true }
  window.__audioTest = { get playCalls() { return playCalls } }
  return {
    state: p.state,
    paused: el.paused,
    autoplay: el.autoplay,
    loop: el.loop,
    volume: el.volume,
    src: el.src,
    hidden: document.getElementById('vbtn-audio').hidden,
    pressed: document.getElementById('btn-audio').getAttribute('aria-pressed'),
    playCalls,
    graph: { ...window.__audioGraph },
  }
})
check('assigning a clip never autoplays', initial.state === 'stopped' && initial.paused && initial.playCalls === 0)
check('loop=true with glTF gain 0.72 × UI volume 0.78', initial.loop && Math.abs(initial.volume - 0.5616) < 0.001)
check('clip is an object URL and autoplay is false', initial.src.startsWith('blob:') && !initial.autoplay, initial.src.slice(0, 16))
check('setting a source creates no context or graph', initial.graph.contexts === 0 && initial.graph.mediaSources === 0)
check('verified-source control is visible and unpressed', !initial.hidden && initial.pressed === 'false')

const scaledVolume = await page.evaluate(() => {
  const f = window.__form0
  f.settings.set({ volMaster: 50, volSfx: 50 })
  const level = f.audioPlayer.element.volume
  f.settings.set({ volMaster: 100, volSfx: 100 })
  return level
})
check('direct-media fallback honours master/effects before routing', Math.abs(scaledVolume - 0.1404) < 0.001, String(scaledVolume))

await page.evaluate(() => document.getElementById('btn-audio').click())
await page.waitForFunction(() => window.__form0.audioPlayer.state === 'playing')
const playing = await page.evaluate(() => {
  const p = window.__form0.audioPlayer
  const route = p.route
  const listener = window.__form0.mixer.context.listener
  return {
    calls: window.__audioTest.playCalls,
    cls: document.getElementById('btn-audio').className,
    pressed: document.getElementById('btn-audio').getAttribute('aria-pressed'),
    label: document.getElementById('btn-audio').getAttribute('aria-label'),
    graph: { ...window.__audioGraph, edges: [...window.__audioGraph.edges] },
    panningModel: route?.panner?.panningModel,
    distanceModel: route?.panner?.distanceModel,
    refDistance: route?.panner?.refDistance,
    gain: route?.gain?.gain?.value,
    sourcePosition: [route?.panner?.positionX?.value, route?.panner?.positionY?.value, route?.panner?.positionZ?.value],
    listenerPosition: [listener.positionX.value, listener.positionY.value, listener.positionZ.value],
    elementVolume: p.element.volume,
  }
})
check('button gesture starts playback exactly once', playing.calls === 1)
check('gesture creates one media source and one panner', playing.graph.contexts === 1 && playing.graph.mediaSources === 1 && playing.graph.panners === 1 && playing.graph.resumes === 1, JSON.stringify(playing.graph))
check('graph is media → panner → clip gain → SFX bus', playing.graph.edges.includes('media->panner') && playing.graph.edges.includes('panner->gain') && playing.graph.edges.filter((x) => x === 'gain->gain').length >= 1)
check('panner uses HRTF inverse-distance spatialisation', playing.panningModel === 'HRTF' && playing.distanceModel === 'inverse' && playing.refDistance === 30)
check('route applies 0.72 × 0.78 once', Math.abs(playing.gain - 0.5616) < 0.001 && playing.elementVolume === 1)
check('Babylon source and listener pose reaches WebAudio', JSON.stringify(playing.sourcePosition) === '[7,-2,0]' && JSON.stringify(playing.listenerPosition) === '[1,3,-30]')
check('playing icon/ARIA state is exposed', playing.cls.includes('audio-playing') && playing.pressed === 'true' && playing.label === 'stop sound')

await page.evaluate(() => document.getElementById('btn-audio').click())
await page.waitForFunction(() => window.__form0.audioPlayer.state === 'stopped')
check('second gesture pauses playback', await page.evaluate(() =>
  document.getElementById('btn-audio').getAttribute('aria-pressed') === 'false'))

const disconnectedBefore = await page.evaluate(() => window.__audioGraph.disconnects)
await page.evaluate(() => window.__form0.audioPlayer.clear())
const cleared = await page.evaluate(() => ({
  state: window.__form0.audioPlayer.state,
  hidden: document.getElementById('vbtn-audio').hidden,
  route: window.__form0.audioPlayer.route,
  source: window.__form0.audioPlayer.element,
  disconnected: window.__audioGraph.disconnects,
}))
check('clearing releases media, route and control', cleared.state === 'unavailable' && cleared.hidden && !cleared.route && !cleared.source)
check('cleanup disconnects every per-source graph node', cleared.disconnected >= disconnectedBefore + 3, `${disconnectedBefore} -> ${cleared.disconnected}`)

await browser.close()
if (failures.length) {
  console.log(`FAILURES: ${failures.join(' | ')}`)
  process.exit(1)
}
console.log('ALL AUDIO PLAYBACK CHECKS PASSED')
