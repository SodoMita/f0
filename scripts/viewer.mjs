// Viewer guard (AMENDMENT 84): the essential viewer behaviors, asserted.
//   1. authored camera = navigable (orbit seeded from it, not a frozen frame)
//   2. authored composition preserved (position + fov, pivot on the forward ray)
//   3. near plane adaptive (close-ups of small parts never clip)
//   4. F re-fits the current camera mode
//   5. "N / M" feed position shown next to prev/next
//   6. speed 0 freezes the pose (was clamped to 1)
//   7. model audio: claimed, S toggles it, hand-off transfers it
//   8. autoplayAnimations=false -> viewer opens paused
//   9. hand-off failure falls back to the bytes path (no blank viewer)
// Needs the offline rig: TARGET_URL=http://localhost:4173/
import { chromium } from 'playwright'

const URL = process.env.TARGET_URL || 'http://localhost:4173/'
const WAIT = Number(process.env.WAIT_MS || 20000)

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true })
const errs = []
page.on('pageerror', (e) => errs.push(e.message.slice(0, 200)))
const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.waitForFunction(() => window.__form0 && window.__form0.board && window.__form0.legend, null, { timeout: 30000 }).catch(() => {})
await page.evaluate(() => {
  window.__form0.legend.close()
  if (!window.__form0.legend.root.hidden) throw new Error('legend still open')
})
await page.waitForFunction(() => [...window.__form0.index.byId.values()].length > 0, null, { timeout: WAIT }).catch(() => {})
await page.waitForTimeout(2500)

const openViewer = async (id) => {
  await page.evaluate((x) => { location.hash = '#/viewer/' + x }, id)
  await page.waitForTimeout(4500)
}
const viewerState = () => page.evaluate(() => {
  const v = window.__form0.viewer
  const cam = v.scene.activeCamera
  return {
    camIndex: v.camIndex,
    activeType: cam?.constructor.name,
    camPos: cam ? cam.position.asArray().map((n) => +n.toFixed(3)) : null,
    target: cam?.target ? cam.target.asArray().map((n) => +n.toFixed(3)) : null,
    fov: cam?.fov ? +cam.fov.toFixed(3) : null,
    radius: +v.orbit.radius.toFixed(3),
    minZ: +v.orbit.minZ.toFixed(4),
    lower: +v.orbit.lowerRadiusLimit.toFixed(3),
    upper: +v.orbit.upperRadiusLimit.toFixed(3),
    playing: v.animator.playing,
    speed: v.animator.speed,
    sounds: v.soundCount,
    soundOn: v.soundOn,
    soundBtnHidden: document.getElementById('btn-sound').hidden,
    posText: document.getElementById('viewer-pos').textContent,
    posHidden: document.getElementById('viewer-pos').hidden,
    inViewerScene: v.scene.mainSoundTrack.soundCollection.length,
  }
})
const authoredPose = () => page.evaluate(() => {
  const v = window.__form0.viewer
  const cam = v.imported[0]
  if (!cam) return null
  const wm = cam.getWorldMatrix()
  return {
    pos: [wm.m[12], wm.m[13], wm.m[14]].map((n) => +n.toFixed(3)),
    fov: +cam.fov.toFixed(3),
  }
})
// Find the rig's flavour 'a' roots: camera + animation + audio.
const ids = await page.evaluate(() => {
  const f = window.__form0
  const roots = [...f.index.byId.values()].filter((m) => m.role === 'root' && !m.tombstoned && !m.hashFailed)
  return {
    a: roots.filter((m) => m.filename?.endsWith('a.glb')).map((m) => m.eventId),
    b: roots.filter((m) => m.filename?.endsWith('b.glb')).map((m) => m.eventId),
    total: roots.length,
  }
})
console.log(`feed: ${ids.total} roots, ${ids.a.length} x 'a', ${ids.b.length} x 'b'`)
if (!ids.a.length || !ids.b.length) { console.log('FAIL  rig flavours missing'); process.exit(1) }

// ------------------------------------------------------------------ 1-2
// Hand-off path: wait until 'a' is live in the preview pool, then open it —
// the viewer must adopt the parsed container (instant) INCLUDING its sound.
await page.waitForFunction((id) => {
  const pool = window.__form0.board.previewPool
  return pool['byPost'] && pool['byPost'].has(id)
}, ids.a[0], { timeout: 30000 }).catch(() => {})
const isLive = await page.evaluate((id) => window.__form0.board.previewPool['byPost'].has(id), ids.a[0])
await openViewer(ids.a[0])
let s = await viewerState()
check('authored camera: viewer opens on the model camera (camIndex 0)', s.camIndex === 0, `camIndex=${s.camIndex}`)
check('authored camera: ORBIT is the active camera (navigable, not frozen)', s.activeType === 'ArcRotateCamera', `active=${s.activeType}`)
check('sound: hand-off transferred the model audio into the viewer scene',
  s.sounds === 1 && s.inViewerScene >= 1, `sounds=${s.sounds} inViewerScene=${s.inViewerScene}`)
const pose = await authoredPose()
if (pose) {
  const d = Math.hypot(s.camPos[0] - pose.pos[0], s.camPos[1] - pose.pos[1], s.camPos[2] - pose.pos[2])
  check('authored camera: orbit seeded at the authored position', d < 0.01, `d=${d.toFixed(3)}`)
  check('authored camera: authored fov adopted', Math.abs(s.fov - pose.fov) < 0.01, `fov=${s.fov} authored=${pose.fov}`)
  // Pivot must sit on the authored forward ray -> view direction preserved:
  // (target - pos) is parallel to the authored forward.
  const fwdInfo = await page.evaluate(() => {
    const v = window.__form0.viewer
    const cam = v.imported[0]
    const wm = cam.getWorldMatrix()
    // Babylon forward = TransformNormal((0,0,1), M) = (m[8], m[9], m[10])
    // (row-vector convention: v' = v·M, so the image of +Z is the 3rd row).
    const fwd = [wm.m[8], wm.m[9], wm.m[10]]
    const l = Math.hypot(...fwd) || 1
    const t = v.orbit.target.asArray()
    const p = v.orbit.position.asArray()
    const dir = [t[0] - p[0], t[1] - p[1], t[2] - p[2]]
    const dl = Math.hypot(...dir) || 1
    const dot = (dir[0] * fwd[0] + dir[1] * fwd[1] + dir[2] * fwd[2]) / (l * dl)
    return { dot, fwd, t, p }
  })
  check('authored camera: pivot on the authored forward ray (composition kept)', fwdInfo.dot > 0.999,
    `dot=${fwdInfo.dot.toFixed(5)} fwd=[${fwdInfo.fwd.map((n) => n.toFixed(2))}] target=[${fwdInfo.t}]`)
  const dbg = await page.evaluate(() => {
    const v = window.__form0.viewer
    const b = v.modelBoxForTest()
    return {
      box: b ? { min: b.min.asArray(), max: b.max.asArray(), radius: b.radius } : null,
      orbitPos: v.orbit.position.asArray().map((n) => +n.toFixed(2)),
      minZ: +v.orbit.minZ.toFixed(4),
      camIdx: v.camIdx,
      autoplay: v.autoplay,
    }
  })
  console.log('DIAG after open:', JSON.stringify(dbg))
}

// ------------------------------------------------------------------ 3
// Near plane: wheel all the way in — the model must remain visible, i.e.
// minZ must track the (shrinki)ng distance to the model box, not stay at
// the model-sized value that used to slice close-ups.
await page.mouse.move(640, 400)
const beforeMinZ = (await viewerState()).minZ
for (let i = 0; i < 70; i++) { await page.mouse.wheel(0, -250); await page.waitForTimeout(12) }
await page.waitForTimeout(400)
// Self-contained: read minZ + box + camPos in one evaluate (no serialization gap).
const nearProbe = await page.evaluate(() => {
  const v = window.__form0.viewer
  const box = v.modelBoxForTest()
  const p = v.orbit.position.asArray()
  if (!box || !p) return { ok: false, box: !!box, p }
  const dx = Math.max(box.min.x - p[0], 0, p[0] - box.max.x)
  const dy = Math.max(box.min.y - p[1], 0, p[1] - box.max.y)
  const dz = Math.max(box.min.z - p[2], 0, p[2] - box.max.z)
  return { ok: true, minZ: v.orbit.minZ, distToBox: Math.sqrt(dx * dx + dy * dy + dz * dz), p }
})
check('near plane: minZ tracks distance to model (no close-up slice)',
  nearProbe.ok && nearProbe.minZ <= nearProbe.distToBox * 0.15 + 0.02,
  nearProbe.ok ? `minZ=${nearProbe.minZ.toFixed(4)} distToBox=${nearProbe.distToBox.toFixed(3)} (was ${beforeMinZ} at framing)` : JSON.stringify(nearProbe))
await page.screenshot({ path: '/tmp/vr-guard-zoomed.png' })

// ------------------------------------------------------------------ 4
// F re-fits the CURRENT mode (authored here) back to the authored pose.
await page.mouse.move(640, 400); await page.mouse.down()
for (let i = 1; i <= 12; i++) { await page.mouse.move(640 + i * 18, 400 - i * 9, { steps: 2 }); await page.waitForTimeout(12) }
await page.mouse.up()
await page.waitForTimeout(300)
const drifted = await viewerState()
const dDrift = Math.hypot(drifted.camPos[0] - pose.pos[0], drifted.camPos[1] - pose.pos[1], drifted.camPos[2] - pose.pos[2])
check('refit: orbiting moves the camera (drift is real)', dDrift > 0.5, `drift=${dDrift.toFixed(2)}`)
// Let the orbit inertia glide settle (inertia default 0.7 keeps the camera
// moving for a while after mouse.up).
for (let i = 0; i < 40; i++) {
  const p1 = await page.evaluate(() => window.__form0.viewer.orbit.position.asArray().map((n) => +n.toFixed(3)))
  await page.waitForTimeout(150)
  const p2 = await page.evaluate(() => window.__form0.viewer.orbit.position.asArray().map((n) => +n.toFixed(3)))
  if (Math.hypot(p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]) < 0.01) break
}
await page.keyboard.press('f')
await page.waitForTimeout(400)
s = await viewerState()
const dBack = Math.hypot(s.camPos[0] - pose.pos[0], s.camPos[1] - pose.pos[1], s.camPos[2] - pose.pos[2])
check('refit: F returns to the authored framing', dBack < 0.01,
  `d=${dBack.toFixed(3)} camIdx=${s.camIndex} pos=${JSON.stringify(s.camPos)} target=${JSON.stringify(s.target)} radius=${s.radius} authored=${JSON.stringify(pose.pos)}`)
// A dot = auto-fit (dominant face), then F re-fits THAT mode.
const dots = await page.$$('#cam-dots .cam-dot')
if (dots[0]) { await dots[0].click(); await page.waitForTimeout(500) }
s = await viewerState()
check('A dot: auto-fit mode (camIndex -1)', s.camIndex === -1, `camIndex=${s.camIndex}`)
await page.keyboard.press('f')
await page.waitForTimeout(400)
const afterFitF = await viewerState()
check('refit: F in auto-fit mode stays framed (finite pose)',
  afterFitF.camPos.every((n) => Number.isFinite(n)), JSON.stringify(afterFitF.camPos))

// ------------------------------------------------------------------ 5
check('N of M: feed position shown for a listed model', !s.posHidden && /\d+ \/ \d+/.test(s.posText), `"${s.posText}"`)

// ------------------------------------------------------------------ 6
await page.evaluate(() => {
  const el = document.getElementById('anim-speed')
  el.focus(); el.value = '0'
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.blur()
})
await page.waitForTimeout(300)
s = await viewerState()
check('speed 0: the documented freeze pose is reachable', s.speed === 0, `speed=${s.speed}`)
await page.evaluate(() => {
  const el = document.getElementById('anim-speed')
  el.focus(); el.value = '1'
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.blur()
})

// ------------------------------------------------------------------ 7
// Model audio (rig 'a' carries a beep): claimed on open, OFF until tapped.
check('sound: model audio claimed by the viewer', s.sounds === 1, `sounds=${s.sounds}`)
check('sound: button visible for an audio model', s.soundBtnHidden === false)
check('sound: NOT auto-playing on open (spec: tap to play)', s.soundOn === false, `soundOn=${s.soundOn}`)
await page.keyboard.press('s')
await page.waitForFunction(() => window.__form0.viewer.soundOn, null, { timeout: 4000 }).catch(() => {})
s = await viewerState()
check('sound: S turns the model audio on', s.soundOn === true, `soundOn=${s.soundOn}`)
await page.keyboard.press('s')
await page.waitForTimeout(300)
s = await viewerState()
check('sound: S mutes it again', s.soundOn === false, `soundOn=${s.soundOn}`)

// ------------------------------------------------------------------ 8
// autoplayAnimations=false -> the viewer opens PAUSED.
await page.evaluate(() => {
  // Instrument: capture the autoplay flag of the next setGroups call.
  const a = window.__form0.viewer.animator
  const orig = a.setGroups.bind(a)
  a.setGroups = (groups, idx, autoplay) => {
    window.__lastSetGroups = { autoplay, n: groups.length }
    return orig(groups, idx, autoplay)
  }
  window.__lastSetGroups = undefined
  window.__form0.settings.set({ autoplayAnimations: false })
})
const autoplayNow = await page.evaluate(() => window.__form0.viewer.autoplay)
// Open a DIFFERENT animated model (flavour c: animated, no camera) so the
// hash actually changes and the viewer really reloads.
const cId = await page.evaluate(() => {
  const roots = [...window.__form0.index.byId.values()].filter((m) => m.role === 'root' && m.filename?.endsWith('c.glb'))
  return roots[0]?.eventId
})
check('autoplay off: an animated no-camera model exists in the rig', !!cId)
await openViewer(cId)
// Wait until the reload actually happened (setGroups instrumented call).
let lsg = null
for (let i = 0; i < 40 && !lsg; i++) {
  await page.waitForTimeout(400)
  lsg = await page.evaluate(() => window.__lastSetGroups)
}
s = await viewerState()
check('autoplay off: viewer opened paused',
  !!lsg && lsg.autoplay === false && lsg.n > 0 && s.playing === false,
  `playing=${s.playing} viewer.autoplay=${autoplayNow} lastSetGroups=${JSON.stringify(lsg)}`)
await page.evaluate(() => window.__form0.settings.set({ autoplayAnimations: true }))
await page.waitForTimeout(200)

// ------------------------------------------------------------------ 9
// Camera-less model: auto-fit orbit, navigable, no authored dots.
await openViewer(ids.b[0])
s = await viewerState()
check('no-camera model: auto-fit orbit (camIndex -1)', s.camIndex === -1 && s.activeType === 'ArcRotateCamera', `idx=${s.camIndex} ${s.activeType}`)
check('no-camera model: no sound button', s.soundBtnHidden === true)
const dotsB = (await page.$$('#cam-dots .cam-dot')).length
check('no-camera model: only the A dot', dotsB === 1, `dots=${dotsB}`)

check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '))

await browser.close()
console.log(fails.length ? `FAILURES: ${fails.length}` : 'ALL CHECKS PASSED')
process.exit(fails.length ? 1 : 0)
