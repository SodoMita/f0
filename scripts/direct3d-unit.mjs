// Direct3DPool units — no browser needed:
//   bun scripts/direct3d-unit.mjs
// Guards the AMENDMENT 77 bugfixes (PR 36 + PR 38): cancel-during-load must
// not place a model, a full pool must not latch overflow as failed, eviction
// must use the caller's visible set (not stale slot.visible), leftover scene
// lights stay disabled, in-flight loads land at the LATEST cell, and the
// model is centred on the card plane.
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Direct3DPool } from '../src/board/modelCard3d.ts'

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

/** Tiny uncompressed triangle GLB (no Draco — NullEngine cannot fetch the wasm). */
function makeTriangleGlb() {
  const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0])
  const indices = new Uint16Array([0, 1, 2])
  const bin = new Uint8Array(44)
  bin.set(new Uint8Array(positions.buffer), 0)
  bin.set(new Uint8Array(indices.buffer), 36)
  const json = JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    buffers: [{ byteLength: 44 }],
  })
  const jsonBytes = new TextEncoder().encode(json)
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4
  const jsonChunk = jsonBytes.length + jsonPad
  const binPad = (4 - (bin.length % 4)) % 4
  const binChunk = bin.length + binPad
  const total = 12 + 8 + jsonChunk + 8 + binChunk
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true) // glTF
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonChunk, true)
  view.setUint32(16, 0x4e4f534a, true) // JSON
  out.set(jsonBytes, 20)
  for (let i = 0; i < jsonPad; i++) out[20 + jsonBytes.length + i] = 0x20
  const binAt = 20 + jsonChunk
  view.setUint32(binAt, binChunk, true)
  view.setUint32(binAt + 4, 0x004e4942, true) // BIN
  out.set(bin, binAt + 8)
  return out
}

const engine = new NullEngine()
const scene = new Scene(engine)
const dummy = new HemisphericLight('l', new Vector3(0, 1, 0), scene)
dummy.intensity = 1

const bytes = makeTriangleGlb()
const sha256 = '0'.repeat(64)
const place = { x: 0, y: 0, z: 0, w: 16, h: 10, depth: 4 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitUntil(pred, tries = 40, ms = 25) {
  for (let i = 0; i < tries; i++) {
    if (pred()) return true
    await sleep(ms)
  }
  return pred()
}

// ---- dummy hemi disabled, d3 rig present --------------------------------
{
  const pool = new Direct3DPool(scene, async () => ({ bytes, sha256 }), { maxSlots: 2 })
  check('disables leftover scene lights', dummy.isEnabled() === false)
  check('owns a d3 hemi', scene.lights.some((l) => l.name === 'd3-hemi' && l.isEnabled()))
  pool.dispose()
}

// ---- cancel during load does not place -----------------------------------
{
  let releaseResolve
  const gate = new Promise((r) => { releaseResolve = r })
  const pool = new Direct3DPool(scene, async () => {
    await gate
    return { bytes, sha256 }
  }, { maxSlots: 2 })
  let placed = 0
  pool.onPlaced = () => { placed++ }
  const ok = pool.request('slow', place)
  check('request accepts a pending load', ok === true)
  check('isLoading while gated', pool.isLoading('slow'))
  pool.release('slow')
  check('release of a pending load keeps loading set (scroll-back can un-cancel)', pool.isLoading('slow'))
  releaseResolve()
  await waitUntil(() => !pool.isLoading('slow'))
  check('cancelled load never places', placed === 0 && !pool.isLive('slow'), `placed=${placed} live=${pool.isLive('slow')}`)
  pool.dispose()
}

// ---- scroll-back un-cancels the in-flight parse --------------------------
{
  let releaseResolve
  const gate = new Promise((r) => { releaseResolve = r })
  const pool = new Direct3DPool(scene, async () => {
    await gate
    return { bytes, sha256 }
  }, { maxSlots: 2 })
  let placed = 0
  pool.onPlaced = () => { placed++ }
  pool.request('back', place)
  pool.release('back')
  const again = pool.request('back', place)
  check('re-request of a cancelled in-flight load returns true', again === true)
  releaseResolve()
  await waitUntil(() => pool.isLive('back'))
  check('un-cancelled load still places', pool.isLive('back') && placed === 1, `placed=${placed} live=${pool.isLive('back')}`)
  pool.dispose()
}

// ---- capacity miss is not a rejection; visible set drives eviction -------
{
  const pool = new Direct3DPool(scene, async () => ({ bytes, sha256 }), { maxSlots: 1 })
  pool.request('a', place, new Set(['a']))
  await waitUntil(() => pool.isLive('a'))
  check('first model is live', pool.isLive('a'))
  const second = pool.request('b', { ...place, x: 20 }, new Set(['a', 'b']))
  check('visible-full pool refuses without rejecting', second === false && !pool.isRejected('b'))
  const evicted = pool.request('b', { ...place, x: 20 }, new Set(['b']))
  check('offscreen slot is evictable', evicted === true)
  await waitUntil(() => pool.isLive('b'))
  check('eviction placed the new model', pool.isLive('b'))
  check('evicted model is gone', !pool.isLive('a'))
  pool.dispose()
}

// ---- in-flight load lands at the LATEST cell, not the request cell -------
{
  let releaseResolve
  const gate = new Promise((r) => { releaseResolve = r })
  const pool = new Direct3DPool(scene, async () => {
    await gate
    return { bytes, sha256 }
  }, { maxSlots: 1 })
  pool.request('move', { ...place, x: 0, y: 0 })
  pool.place('move', { ...place, x: 50, y: -12 })
  releaseResolve()
  await waitUntil(() => pool.isLive('move'))
  const node = scene.transformNodes.find((n) => n.name.startsWith('d3-') && !n.name.includes('orient') && !n.name.includes('fit'))
  check('pending place is applied on completion', !!node && Math.abs(node.position.x - 50) < 1e-4 && Math.abs(node.position.y + 12) < 1e-4,
    `x=${node?.position.x} y=${node?.position.y}`)
  pool.dispose()
}

// ---- placed model sits on the card plane ---------------------------------
{
  const pool = new Direct3DPool(scene, async () => ({ bytes, sha256 }), { maxSlots: 1 })
  pool.request('front', place)
  await waitUntil(() => pool.isLive('front'))
  const node = scene.transformNodes.find((n) => n.name.startsWith('d3-') && !n.name.includes('orient') && !n.name.includes('fit'))
  check('found a root transform', !!node, node?.name ?? 'none')
  if (node) {
    // Measure the GEOMETRY, not the root: the root sits at the framing
    // camera (behind the card plane). The model itself must land on the cell.
    const mn = [Infinity, Infinity, Infinity]
    const mx = [-Infinity, -Infinity, -Infinity]
    for (const mesh of scene.meshes) {
      if (mesh.getTotalVertices() <= 0) continue
      mesh.computeWorldMatrix(true)
      const bb = mesh.getBoundingInfo().boundingBox
      const lo = bb.minimumWorld, hi = bb.maximumWorld
      mn[0] = Math.min(mn[0], lo.x); mn[1] = Math.min(mn[1], lo.y); mn[2] = Math.min(mn[2], lo.z)
      mx[0] = Math.max(mx[0], hi.x); mx[1] = Math.max(mx[1], hi.y); mx[2] = Math.max(mx[2], hi.z)
    }
    const mid = [0, 1, 2].map((i) => (mn[i] + mx[i]) / 2)
    check('model is centred on the card plane', Math.abs(mid[2] - place.z) < 0.5, `z=${mid[2]}`)
    check('model x/y match the requested cell', Math.abs(mid[0] - place.x) < 0.5 && Math.abs(mid[1] - place.y) < 0.5,
      `x=${mid[0]} y=${mid[1]}`)
  }
  const importedOn = scene.lights.filter((l) => !l.name.startsWith('d3-') && l.isEnabled())
  check('no non-d3 lights left enabled', importedOn.length === 0, importedOn.map((l) => l.name).join(','))
  const before = scene.transformNodes.filter((n) => n.name.startsWith('d3-')).length
  pool.release('front')
  const leftover = scene.transformNodes.filter((n) => n.name.startsWith('d3-') && !n.isDisposed())
  check('release disposes the transform chain', leftover.length === 0, `before=${before} leftover=${leftover.map((n) => n.name).join(',')}`)
  pool.dispose()
}

engine.dispose()
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nall checks passed')
process.exit(fails.length ? 1 : 0)
