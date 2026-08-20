// Browser guard for the embedded-audio viewer control.
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
  p.setAudio(new Blob([bytes], { type: 'audio/wav' }))
  // This focused player test does not wait for a relay model to open the
  // viewer, so reveal its already-wired rail for real pointer clicks.
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
  }
})
check('assigning a clip never autoplays', initial.state === 'stopped' && initial.paused && initial.playCalls === 0)
check('HTMLAudioElement uses loop=true and volume=0.78', initial.loop && Math.abs(initial.volume - 0.78) < 0.001)
check('clip is an object URL and autoplay is false', initial.src.startsWith('blob:') && !initial.autoplay, initial.src.slice(0, 16))
check('verified-source control is visible and unpressed', !initial.hidden && initial.pressed === 'false')

await page.evaluate(() => document.getElementById('btn-audio').click())
await page.waitForFunction(() => window.__form0.audioPlayer.state === 'playing')
const playing = await page.evaluate(() => ({
  calls: window.__audioTest.playCalls,
  cls: document.getElementById('btn-audio').className,
  pressed: document.getElementById('btn-audio').getAttribute('aria-pressed'),
  label: document.getElementById('btn-audio').getAttribute('aria-label'),
}))
check('button gesture starts playback exactly once', playing.calls === 1)
check('playing icon/ARIA state is exposed', playing.cls.includes('audio-playing') && playing.pressed === 'true' && playing.label === 'stop sound')

await page.evaluate(() => document.getElementById('btn-audio').click())
await page.waitForFunction(() => window.__form0.audioPlayer.state === 'stopped')
check('second gesture pauses playback', await page.evaluate(() =>
  document.getElementById('btn-audio').getAttribute('aria-pressed') === 'false'))

await page.evaluate(() => window.__form0.audioPlayer.clear())
check('clearing a model hides and releases its control', await page.evaluate(() =>
  window.__form0.audioPlayer.state === 'unavailable' && document.getElementById('vbtn-audio').hidden))

await browser.close()
if (failures.length) {
  console.log(`FAILURES: ${failures.join(' | ')}`)
  process.exit(1)
}
console.log('ALL AUDIO PLAYBACK CHECKS PASSED')
