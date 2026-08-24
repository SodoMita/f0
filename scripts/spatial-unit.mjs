// Spatial post-audio units — no browser needed:
//   bun scripts/spatial-unit.mjs
// Guards src/audio/spatial.ts: the distance curve applied by
// spatializeSound, node attach/detach pass-through, the error-swallowing
// contract (no WebAudio must never throw), and the scene-listener binding
// (stage scenes listen through the active user-facing camera).
import {
  SPATIAL_REF_DISTANCE, SPATIAL_MAX_DISTANCE, SPATIAL_ROLLOFF,
  spatializeSound, spatializeSounds, attachSound, detachSound, moveSound,
  setSpatialListener, getSpatialListener, bindSceneListener,
} from '../src/audio/spatial.ts'

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

function fakeSound() {
  const calls = []
  return {
    calls,
    updateOptions(options) { calls.push(['updateOptions', options]) },
    setDirectionalCone(a, b, c) { calls.push(['cone', a, b, c]) },
    setPosition(v) { calls.push(['setPosition', v]) },
    attachToMesh(n) { calls.push(['attach', n]) },
    detachFromMesh() { calls.push(['detach']) },
  }
}

// 1. spatializeSound applies the flat-scene curve + non-directional cone
{
  const s = fakeSound()
  spatializeSound(s)
  const opts = s.calls.find((c) => c[0] === 'updateOptions')?.[1]
  check('spatializeSound enables spatialSound', opts?.spatialSound === true)
  check('spatializeSound sets refDistance=30', opts?.refDistance === SPATIAL_REF_DISTANCE)
  check('spatializeSound sets maxDistance=240', opts?.maxDistance === SPATIAL_MAX_DISTANCE)
  check('spatializeSound sets rolloffFactor=0.35', opts?.rolloffFactor === SPATIAL_ROLLOFF)
  check('spatializeSound sets inverse distance model', opts?.distanceModel === 'inverse')
  const cone = s.calls.find((c) => c[0] === 'cone')
  check('spatializeSound sets 360° cone (never silenced by facing)', !!cone && cone[1] === 360 && cone[2] === 360 && cone[3] === 0)
}

// 2. throwing sounds are swallowed (audio unavailable must not break posts)
{
  const broken = {
    updateOptions() { throw new Error('no WebAudio') },
    setDirectionalCone() { throw new Error('no WebAudio') },
  }
  let threw = false
  try { spatializeSound(broken) } catch { threw = true }
  check('spatializeSound swallows no-WebAudio errors', !threw)
}

// 3. plural helper covers every sound
{
  const a = fakeSound(), b = fakeSound()
  spatializeSounds([a, b])
  check('spatializeSounds covers all sounds',
    a.calls.some((c) => c[0] === 'updateOptions') && b.calls.some((c) => c[0] === 'updateOptions'))
}

// 4. attach / detach / move pass through to Babylon
{
  const s = fakeSound()
  const node = { name: 'emitter' }
  attachSound(s, node)
  check('attachSound delegates to attachToMesh', s.calls.some((c) => c[0] === 'attach' && c[1] === node))
  detachSound(s)
  check('detachSound delegates to detachFromMesh', s.calls.some((c) => c[0] === 'detach'))
  const pos = { x: 1, y: 2, z: 3 }
  moveSound(s, pos)
  check('moveSound delegates to setPosition', s.calls.some((c) => c[0] === 'setPosition' && c[1] === pos))
}

// 5. listener camera roundtrip
{
  setSpatialListener(null)
  check('setSpatialListener(null) resets', getSpatialListener() === null)
  const cam = { position: { x: 0, y: 0, z: 0 } }
  setSpatialListener(cam)
  check('setSpatialListener stores the camera', getSpatialListener() === cam)
  setSpatialListener(null)
}

// 6. bindSceneListener wires position+rotation providers and the refresh rate
{
  const cam = {
    position: { x: 5, y: 6, z: 7 },
    absoluteRotation: { toEulerAngles: () => ({ x: 0.1, y: 0.2, z: 0.3 }) },
  }
  setSpatialListener(cam)
  let posProvider = null
  let rotProvider = null
  let refreshRate = 0
  const scene = {
    set audioListenerPositionProvider(fn) { posProvider = fn },
    set audioListenerRotationProvider(fn) { rotProvider = fn },
    set audioPositioningRefreshRate(v) { refreshRate = v },
  }
  bindSceneListener(scene)
  check('bindSceneListener sets 100 ms refresh', refreshRate === 100)
  check('bindSceneListener position provider returns camera position',
    posProvider?.()?.x === 5 && posProvider?.()?.z === 7)
  check('bindSceneListener rotation provider returns camera eulers',
    rotProvider?.()?.x === 0.1 && rotProvider?.()?.z === 0.3)
  setSpatialListener(null)
  const zero = posProvider()
  check('bindSceneListener falls back to origin without a camera',
    zero.x === 0 && zero.y === 0 && zero.z === 0)
}

// 7. bindSceneListener swallows scenes without audio support
{
  let threw = false
  try { bindSceneListener({}) } catch { threw = true }
  check('bindSceneListener tolerates audio-less scenes', !threw)
}

if (fails.length) {
  console.error(`\nFAIL  ${fails.length} spatial check(s): ${fails.join(', ')}`)
  process.exit(1)
}
console.log('\nALL SPATIAL UNITS PASSED')
