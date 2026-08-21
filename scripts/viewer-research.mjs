// Research probe: what can the viewer actually do? (read-only, no asserts)
// Run against the offline rig proxy: TARGET_URL=http://localhost:4173/
import { chromium } from 'playwright'

const URL = process.env.TARGET_URL || 'http://localhost:4173/'
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true })
const errs = []
page.on('pageerror', (e) => errs.push(e.message.slice(0, 200)))

page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)) })
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForFunction(() => window.__form0 && window.__form0.board, null, { timeout: 30000 }).catch(() => {})
await page.evaluate(() => window.__form0?.legend?.close()).catch(() => {})
await page.waitForFunction(() => {
  const f = window.__form0
  return f && f.index && [...f.index.byId.values()].length > 0
}, null, { timeout: 30000 }).catch(() => {})
const bootState = await page.evaluate(() => ({
  form0: !!window.__form0,
  roots: window.__form0?.index ? [...window.__form0.index.byId.values()].length : -1,
  mode: window.__form0?._mode?.() ?? window.__form0?.__mode?.(),
}))
console.log('BOOT STATE:', JSON.stringify(bootState))

const snap = (label) => page.screenshot({ path: `/tmp/vr-${label}.png` })

// pick a model WITH cameras (flavour a or d) and open it
const target = await page.evaluate(() => {
  const f = window.__form0
  const roots = [...f.index.byId.values()].filter((m) => m.role === 'root' && !m.tombstoned && !m.hashFailed)
  const withCam = roots.find((m) => m.eventId.endsWith('a') || m.eventId.endsWith('d')) || roots[0]
  return { id: withCam?.eventId, count: roots.length, filename: withCam?.filename }
})
console.log('feed roots:', target.count, 'opening:', target.filename, target.id?.slice(0, 8))
if (target.id) await page.evaluate((id) => { location.hash = '#/viewer/' + id }, target.id)
await page.waitForTimeout(6000)
await snap('1-viewer-orbit')

// 1) what cameras exist, which is active
const c1 = await page.evaluate(() => {
  const v = window.__form0.viewer
  return {
    imported: v.cameraCount, camIndex: v.camIndex,
    activeType: v.scene.activeCamera?.constructor.name,
    activeName: v.scene.activeCamera?.name,
    orbitAttached: (() => { try { return !!v.scene.activeCamera._attachedPointers || v.scene.activeCamera._pointerInputInfo ? true : false } catch { return false } })(),
    minZ: v.scene.activeCamera?.minZ, maxZ: v.scene.activeCamera?.maxZ,
    radius: v.orbit?.radius,
    sounds: v.scene.mainSoundTrack?.soundCollection?.length,
    playing: v.scene.mainSoundTrack?.soundCollection?.filter((s) => s.isStarted()).length,
    anims: v.stats(),
  }
})
console.log('VIEWER STATE:', JSON.stringify(c1, null, 1))

// 2) switch to authored camera 1 and see if the pointer can do anything
const clickDot = async (i) => { const d = await page.$$('#cam-dots .cam-dot'); if (d[i]) { await d[i].click(); return true } return false }
const dotCount = (await page.$$('#cam-dots .cam-dot')).length
console.log('camera dots:', dotCount)
if (dotCount > 1) {
  await clickDot(1)
  await page.waitForTimeout(800)
}
const c2 = await page.evaluate(() => {
  const v = window.__form0.viewer
  const cam = v.scene.activeCamera
  const r0 = v.orbit.radius
  return {
    activeType: cam?.constructor.name, camIndex: v.camIndex,
    orbitRadiusBefore: r0,
  }
})
console.log('AFTER DOT CLICK:', JSON.stringify(c2))

// try wheel zoom + drag on the authored camera
await page.mouse.move(640, 400)
await page.mouse.wheel(0, -400)
await page.waitForTimeout(300)
await page.mouse.move(640, 400)
await page.mouse.down()
await page.mouse.move(840, 480, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(500)
const c3 = await page.evaluate(() => {
  const v = window.__form0.viewer
  return {
    activeType: v.scene.activeCamera?.constructor.name,
    camPos: v.scene.activeCamera ? v.scene.activeCamera.position.asArray().map((n) => +n.toFixed(3)) : null,
  }
})
console.log('AFTER WHEEL+DRAG on authored cam:', JSON.stringify(c3))
await snap('2-viewer-authoredcam')

// 3) back to orbit; zoom in hard to probe the near plane
await clickDot(0)
await page.waitForTimeout(600)
const nearProbe = await page.evaluate(async () => {
  const v = window.__form0.viewer
  const before = v.scene.activeCamera.position.asArray().map((n) => +n.toFixed(3))
  v.orbit.radius = Math.max(0.02, v.orbit.radius * 0.02)
  v.orbit.checkCollision = false
  v.form.kick()
  return { before, minZ: v.orbit.minZ, maxZ: v.orbit.maxZ, newRadius: +v.orbit.radius.toFixed(4) }
})
console.log('NEAR PROBE:', JSON.stringify(nearProbe))
await page.waitForTimeout(800)
await snap('3-viewer-zoomed-in')

// 4) animation rail: speed 0 attempt
const railState = await page.evaluate(() => {
  const f = window.__form0
  const a = f.viewer.animator
  const speedInput = document.getElementById('anim-speed')
  return {
    railVisible: !document.getElementById('anim-rail').hidden,
    tracks: a.count, frame: +a.frame.toFixed(1), playing: a.playing,
    speedInputValue: speedInput?.value,
  }
})
console.log('RAIL:', JSON.stringify(railState))
// type 0 into the speed field
await page.evaluate(() => {
  const el = document.getElementById('anim-speed')
  el.focus(); el.value = '0'
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.blur()
})
await page.waitForTimeout(400)
const after0 = await page.evaluate(() => ({
  speedField: document.getElementById('anim-speed').value,
  animatorSpeed: window.__form0.viewer.animator.speed,
}))
console.log('SPEED=0 ATTEMPT ->', JSON.stringify(after0))

// 5) metadata drawer
await page.keyboard.press('m')
await page.waitForTimeout(400)
await snap('4-viewer-drawer')
await page.evaluate(() => {
  const d = document.getElementById('meta-drawer')
  d.hidden = true; document.body.classList.remove('drawer-open')
})

// 6) is there a way to reset/refit? try key '0' (thread only?) and double-click
await page.keyboard.press('0')
await page.waitForTimeout(300)
await page.mouse.dblclick(640, 400)
await page.waitForTimeout(400)
const afterReset = await page.evaluate(() => {
  const v = window.__form0.viewer
  return { radius: +v.orbit.radius.toFixed(3) }
})
console.log('after 0 + dblclick, orbit radius =', afterReset.radius, '(was ~' + nearProbe.newRadius + ')')

// 7) fullscreen / share / screenshot surfaces
const hud = await page.evaluate(() => {
  const ids = ['btn-fullscreen', 'btn-share', 'btn-screenshot', 'btn-ar', 'btn-rotate', 'btn-fit', 'btn-sound']
  return Object.fromEntries(ids.map((i) => [i, !!document.getElementById(i)]))
})
console.log('HUD BUTTONS present?', JSON.stringify(hud))

console.log('pageerrors:', errs.length ? errs : 'none')
await browser.close()
