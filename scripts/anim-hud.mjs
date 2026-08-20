// Animation rail verification (browser, offline — no relays needed):
//   node scripts/anim-hud.mjs [TARGET_URL]
// Loads a synthetic TWO-track GLB straight into the viewer via the
// __form0 test hooks, then drives the rail DOM: track dropdown shows the
// GLB names, switching tracks re-poses the model, the timeline scrubs,
// stepped/direction/speed all round-trip into the TrackAnimator.
import { chromium } from 'playwright'

const TARGET = process.env.TARGET_URL || process.argv[2] || 'http://localhost:5173/'
const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

// ---------------- minimal 2-track GLB (cube + "Spin" + "Bob") ----------------
function buildGlb() {
  const pos = new Float32Array([
    -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
  ])
  const idx = new Uint16Array([0, 1, 2, 0, 2, 3, 5, 4, 7, 5, 7, 6, 4, 0, 3, 4, 3, 7, 1, 5, 6, 1, 6, 2, 3, 2, 6, 3, 6, 7, 4, 5, 1, 4, 1, 0])
  const tIn = new Float32Array([0, 1, 2])
  const rotOut = new Float32Array([0, 0, 0, 1, 0, 0.7071, 0, 0.7071, 0, 1, 0, 0]) // yaw 0 -> 90 -> 180
  const bobOut = new Float32Array([0, 0, 0, 0, 1.2, 0, 0, 0, 0])
  const parts = [pos, idx, tIn, rotOut, bobOut]
  const views = []
  let off = 0
  const bufs = []
  for (const p of parts) {
    off = (off + 3) & ~3
    views.push({ buffer: 0, byteOffset: off, byteLength: p.byteLength })
    bufs.push({ off, bytes: new Uint8Array(p.buffer) })
    off += p.byteLength
  }
  const bin = new Uint8Array((off + 3) & ~3)
  for (const b of bufs) bin.set(b.bytes, b.off)
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'cube' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5123, count: idx.length, type: 'SCALAR' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'SCALAR', min: [0], max: [2] },
      { bufferView: 3, componentType: 5126, count: 3, type: 'VEC4' },
      { bufferView: 4, componentType: 5126, count: 3, type: 'VEC3' },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.byteLength }],
    animations: [
      { name: 'Spin', channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }], samplers: [{ input: 2, interpolation: 'LINEAR', output: 3 }] },
      { name: 'Bob', channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }], samplers: [{ input: 2, interpolation: 'LINEAR', output: 4 }] },
    ],
  }
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4
  const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + bin.byteLength
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true)
  dv.setUint32(12, jsonBytes.length + jsonPad, true); dv.setUint32(16, 0x4e4f534a, true)
  out.set(jsonBytes, 20)
  for (let i = 0; i < jsonPad; i++) out[20 + jsonBytes.length + i] = 0x20
  const binOff = 20 + jsonBytes.length + jsonPad
  dv.setUint32(binOff, bin.byteLength, true); dv.setUint32(binOff + 4, 0x004e4942, true)
  out.set(bin, binOff + 8)
  return out
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
await page.goto(TARGET, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => !!window.__form0, null, { timeout: 30000 })
// first-run legend is modal by design; dismiss it like a user would
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
// offline sandboxes surface a relay error sheet — hide it, it is not under test
await page.evaluate(() => window.__form0?.errorSheet?.hide()).catch(() => {})

const glb = Array.from(buildGlb())
await page.evaluate(async (bytes) => {
  const f = window.__form0
  const meta = {
    eventId: 'anim-hud-test', pubkey: '0'.repeat(64), createdAt: 0,
    sha256: 'anim-hud-test', size: bytes.length, mime: 'model/gltf-binary',
    role: 'root', refs: {}, urls: [],
  }
  await f.viewer.load(new Uint8Array(bytes), meta)
  f.engine.setActiveScene(f.viewer.scene)
  f.viewer.attach()
  document.getElementById('viewer-bar').hidden = false
  f.syncAnimRail()
}, glb)

const rail = () => page.evaluate(() => {
  const a = window.__form0.viewer.animator
  const track = document.getElementById('anim-track')
  const tl = document.getElementById('anim-timeline')
  return {
    hidden: document.getElementById('anim-rail').hidden,
    options: [...track.options].map((o) => o.textContent),
    selected: track.selectedIndex,
    tlMin: tl.min, tlMax: tl.max, tlVal: parseFloat(tl.value),
    frameText: document.getElementById('anim-frame').textContent,
    idx: a.index, playing: a.playing, frame: a.frame,
    speed: a.speed, forward: a.forward, stepped: a.stepped,
    cubeY: window.__form0.viewer.scene.getTransformNodeByName('cube')?.position.y
      ?? window.__form0.viewer.scene.getMeshByName('cube')?.position.y,
  }
})

let r = await rail()
check('rail visible for an animated model', r.hidden === false)
check('dropdown lists GLB track names', r.options.join(',') === 'Spin,Bob', r.options.join(','))
check('opens on track 0, playing', r.idx === 0 && r.selected === 0 && r.playing)
check('timeline spans the clip', r.tlMin === '0' && parseFloat(r.tlMax) > 0, `${r.tlMin}..${r.tlMax}`)

// playback advances the thumb
const f0 = r.tlVal
await page.waitForTimeout(600)
r = await rail()
check('timeline thumb follows playback', r.tlVal !== f0, `${f0} -> ${r.tlVal}`)

// switch track via the dropdown -> animator follows, model re-poses
await page.selectOption('#anim-track', '1')
await page.waitForTimeout(400)
r = await rail()
check('dropdown switches the animator track', r.idx === 1)
check('Bob track moves the cube on Y', typeof r.cubeY === 'number' && r.cubeY !== 0, `y ${r.cubeY}`)

// scrub the timeline -> pauses + seeks
await page.evaluate(() => {
  const tl = document.getElementById('anim-timeline')
  tl.value = tl.max
  tl.dispatchEvent(new Event('input', { bubbles: true }))
})
r = await rail()
check('scrubbing pauses playback', r.playing === false)
check('scrubbing seeks to the thumb', Math.abs(r.frame - parseFloat(r.tlMax)) < 0.001, `frame ${r.frame}`)
check('frame readout tracks the cursor', /\d+ \/ \d+/.test(r.frameText), r.frameText)

// direction + stepped + speed round-trip
// (relay failures may have re-raised the error sheet asynchronously by now)
await page.evaluate(() => window.__form0?.errorSheet?.hide()).catch(() => {})
await page.click('#anim-dir')
await page.click('#anim-stepped')
await page.selectOption('#anim-speed', '2')
r = await rail()
check('direction toggles to reverse', r.forward === false)
check('stepped toggles on', r.stepped === true)
check('speed select applies', r.speed === 2)
const dirClass = await page.evaluate(() => document.getElementById('anim-dir').classList.contains('reverse'))
const stepClass = await page.evaluate(() => document.getElementById('anim-stepped').classList.contains('active'))
check('dir/stepped buttons show their state', dirClass && stepClass)

// reverse playback from frame 0 wraps backwards
await page.evaluate(() => { window.__form0.viewer.animator.seek(0); window.__form0.viewer.animator.play(); window.__form0.engine.kick() })
await page.waitForTimeout(500)
r = await rail()
check('reverse playback runs (frame decreases from the end)', r.playing && r.frame > 0 && r.frame < parseFloat(r.tlMax), `frame ${r.frame}`)

// play/pause button still works and rail hides on clear
await page.click('#btn-play')
r = await rail()
check('play button pauses the driver', r.playing === false)

// screenshots BEFORE teardown: dark, light theme, phone viewport
await page.evaluate(() => { window.__form0.viewer.animator.seek(45); window.__form0.engine.kick() })
await page.waitForTimeout(300)
await page.screenshot({ path: 'shots/anim-rail.png' })
await page.evaluate(() => window.__form0.settings.set({ background: '#F2F2F5' }))
await page.waitForTimeout(300)
await page.screenshot({ path: 'shots/anim-rail-light.png' })
await page.evaluate(() => window.__form0.settings.set({ background: '#0B0B0C' }))
await page.setViewportSize({ width: 390, height: 844 })
await page.waitForTimeout(300)
await page.screenshot({ path: 'shots/anim-rail-phone.png' })
await page.setViewportSize({ width: 1280, height: 800 })

await page.evaluate(() => { window.__form0.viewer.clear(); window.__form0.syncAnimRail() })
r = await rail()
check('rail hides when the model is cleared', r.hidden === true)
await browser.close()
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nall checks passed')
process.exit(fails.length ? 1 : 0)
