// Viewer animation driver units — no browser needed:
//   bun scripts/anim-unit.mjs
// Covers TrackAnimator: multi-track adoption + GLB names, track switching,
// timeline seek/clamp, stepped (whole-frame hold) posing, direction, speed,
// looping in both directions, frame stepping with wrap, and clear().
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { Animation } from '@babylonjs/core/Animations/animation'
import { AnimationGroup } from '@babylonjs/core/Animations/animationGroup'
import '@babylonjs/core/Animations/animatable'
import { TrackAnimator } from '../src/viewer/animator.ts'

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

const engine = new NullEngine()
const scene = new Scene(engine)
const node = new TransformNode('n', scene)

/** Linear position.x keyframes so the posed value equals the frame / 10. */
function makeGroup(name, from, to) {
  const anim = new Animation(name + '-a', 'position.x', 60, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE)
  anim.setKeys([{ frame: from, value: from / 10 }, { frame: to, value: to / 10 }])
  const g = new AnimationGroup(name, scene)
  g.addTargetedAnimation(anim, node)
  return g
}

const walk = makeGroup('Walk', 0, 100)
const run = makeGroup('Run', 0, 40)
const unnamed = makeGroup('', 10, 30)

const a = new TrackAnimator()
a.setGroups([walk, run, unnamed], 0, true)

check('adopts all tracks', a.count === 3)
check('names come from the GLB groups (unnamed gets a fallback)',
  a.names[0] === 'Walk' && a.names[1] === 'Run' && a.names[2] === 'track 3', a.names.join(','))
check('starts on the requested track, playing', a.index === 0 && a.playing)
check('range reports the active clip', a.range().from === 0 && a.range().to === 100)

// ---- ticking advances the pose (60 fps clip, 1x speed; dt clamp is 100 ms) ----
a.tick(50) // 0.05 s -> frame 3
check('tick advances by fps * dt', Math.abs(a.frame - 3) < 0.001, `frame ${a.frame}`)
check('tick poses the target', Math.abs(node.position.x - 0.3) < 0.001, `x ${node.position.x}`)

// ---- speed ----
a.setSpeed(2)
a.tick(50) // +6 frames -> 9
check('speed scales the advance', Math.abs(a.frame - 9) < 0.001, `frame ${a.frame}`)
check('dt is clamped (render-on-demand gap must not warp ahead)', (() => {
  a.seek(0); a.play(); a.tick(60000) // idle gap; clamp = 100 ms -> 2*60*0.1 = 12 frames
  return Math.abs(a.frame - 12) < 0.001
})(), `frame ${a.frame}`)
a.setSpeed(1)

// ---- forward looping (dt clamp caps a tick at 100 ms = 6 frames here) ----
a.seek(98); a.play()
a.tick(100) // 98 + 6 = 104 -> wraps to 4
check('forward playback loops past the end', Math.abs(a.frame - 4) < 0.001, `frame ${a.frame}`)

// ---- direction ----
a.setDirection(false)
a.seek(2); a.play()
a.tick(100) // 2 - 6 -> wraps to 96
check('reverse playback loops past the start', Math.abs(a.frame - 96) < 0.001, `frame ${a.frame}`)
check('reverse poses too', Math.abs(node.position.x - 9.6) < 0.001, `x ${node.position.x}`)
a.setDirection(true)

// ---- timeline seek ----
a.seek(50)
check('seek poses immediately', Math.abs(node.position.x - 5) < 0.001, `x ${node.position.x}`)
a.seek(9999)
check('seek clamps to the clip', a.frame === 100, `frame ${a.frame}`)

// ---- stepped ----
a.setStepped(true)
a.seek(41.7)
check('stepped holds whole frames', Math.abs(node.position.x - 4.1) < 0.001, `x ${node.position.x}`)
a.pause(); a.play()
a.setStepped(false)
a.seek(41.7)
check('smooth interpolates between frames', Math.abs(node.position.x - 4.17) < 0.001, `x ${node.position.x}`)

// ---- frame stepping (, / . shortcuts) ----
a.seek(10); a.play()
a.step(1)
check('step pauses and advances one whole frame', !a.playing && a.frame === 11, `frame ${a.frame}`)
a.seek(100)
a.step(1) // frame 100 == frame 0 on a cyclic clip, so +1 lands on 1
check('step wraps forward', a.frame === 1, `frame ${a.frame}`)
a.seek(0)
a.step(-1) // and -1 from 0 lands on 99
check('step wraps backward', a.frame === 99, `frame ${a.frame}`)

// ---- track switching ----
a.setTrack(1)
check('switch selects the new track and rewinds', a.index === 1 && a.frame === 0, `frame ${a.frame}`)
check('switch poses the new clip at its start', Math.abs(node.position.x - 0) < 0.001, `x ${node.position.x}`)
check('old track is stopped', walk.isPlaying === false)
check('range follows the active clip', a.range().to === 40)
a.setTrack(2)
check('non-zero from: opens at the clip start', a.frame === 10, `frame ${a.frame}`)

// ---- onFrame HUD hook ----
let reported = -1
a.onFrame = (f) => { reported = f }
a.seek(20)
check('onFrame reports seeks', reported === 20, `reported ${reported}`)
a.play(); a.tick(100)
check('onFrame reports ticks', reported > 20, `reported ${reported}`)

// ---- clear ----
a.clear()
check('clear resets everything', a.count === 0 && a.index === -1 && !a.playing)
check('tick after clear is a no-op', (() => { a.tick(100); return true })())

// ---- adoption stops handoff groups that arrived playing ----
const g2 = makeGroup('Live', 0, 50)
g2.start(true)
const b = new TrackAnimator()
b.setGroups([g2], 0, false)
check('handoff group adopted paused (driver owns the clock)', !b.playing && b.index === 0)
check('autoplay=false leaves it paused but posed', g2.animatables.length > 0)

engine.dispose()
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nall checks passed')
process.exit(fails.length ? 1 : 0)
