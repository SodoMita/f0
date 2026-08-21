// Framing robustness — the odd models real relays actually carry:
//   bun scripts/framing-edge-unit.mjs
//
// model/framing.ts decides how every 3D card / thread node is posed. It runs
// on whatever a stranger published: flat plates, dust-sized props, kilometre
// -sized scenes, geometry parked 100k units from the origin, cameras inside
// the mesh, degenerate single-point meshes. None of those may produce NaN, a
// zero scale, or a MIRRORED model (spec AMENDMENT 77's "inverted models"
// regression — flat, wordmark-like content is where a mirror is obvious and
// unforgivable on a wordless imageboard).
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { Vector3, Matrix, Quaternion } from '@babylonjs/core/Maths/math.vector'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
import '../src/model/gltf.ts'
import { frameModel, placeFrame } from '../src/model/framing.ts'

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

// ---------------------------------------------------------------- glb build
/** Uncompressed GLB from raw positions + triangles (+ optional camera node). */
function makeGlb(positions, tris, camera) {
  const pos = new Float32Array(positions.flat())
  const idx = new Uint16Array(tris)
  const pad = (n) => (4 - (n % 4)) % 4
  const idxAt = pos.byteLength
  const binLen = idxAt + idx.byteLength + pad(idxAt + idx.byteLength)
  const bin = new Uint8Array(binLen)
  bin.set(new Uint8Array(pos.buffer), 0)
  bin.set(new Uint8Array(idx.buffer), idxAt)

  const min = [0, 1, 2].map((i) => Math.min(...positions.map((p) => p[i])))
  const max = [0, 1, 2].map((i) => Math.max(...positions.map((p) => p[i])))
  const nodes = [{ mesh: 0 }]
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5123, count: tris.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength },
      { buffer: 0, byteOffset: idxAt, byteLength: idx.byteLength },
    ],
    buffers: [{ byteLength: binLen }],
  }
  if (camera) {
    json.cameras = [{ type: 'perspective', perspective: { yfov: 0.7, znear: 0.001, zfar: 1e6 } }]
    nodes.push({ camera: 0, translation: camera.eye, rotation: camera.rotation ?? [0, 0, 0, 1] })
    json.scenes[0].nodes = [0, 1]
  }
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const jsonChunk = jsonBytes.length + pad(jsonBytes.length)
  const total = 12 + 8 + jsonChunk + 8 + binLen
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonChunk, true)
  view.setUint32(16, 0x4e4f534a, true)
  out.set(jsonBytes, 20)
  for (let i = jsonBytes.length; i < jsonChunk; i++) out[20 + i] = 0x20
  const binAt = 20 + jsonChunk
  view.setUint32(binAt, binLen, true)
  view.setUint32(binAt + 4, 0x004e4942, true)
  out.set(bin, binAt + 8)
  return out
}

const engine = new NullEngine()
const scene = new Scene(engine)
new HemisphericLight('l', new Vector3(0, 1, 0), scene)

/** Load a GLB, frame it for `cell`, and report the placed vertex positions. */
async function frameIt(bytes, cell, cameraIndex = 0) {
  const container = await LoadAssetContainerAsync(bytes, scene, { pluginExtension: '.glb' })
  container.addAllToScene()
  const frame = frameModel(container, cameraIndex, cell.w / cell.h)
  const at = placeFrame(frame, cell)
  // Reproduce the pool's chain: root(scale, pos) → orient(rot) → fit(-pivot)
  const rot = new Matrix()
  frame.rot.toRotationMatrix(rot)
  const place = (v) => {
    const p = v.subtract(frame.pivot)
    Vector3.TransformCoordinatesToRef(p, rot, p)
    return new Vector3(p.x * at.scale + at.x, p.y * at.scale + at.y, p.z * at.scale + at.z)
  }
  const pts = []
  for (const mesh of container.meshes) {
    if (mesh.getTotalVertices() <= 0) continue
    mesh.computeWorldMatrix(true)
    const data = mesh.getVerticesData('position')
    const w = mesh.getWorldMatrix()
    for (let i = 0; i + 2 < data.length; i += 3) {
      pts.push(place(Vector3.TransformCoordinates(new Vector3(data[i], data[i + 1], data[i + 2]), w)))
    }
  }
  container.removeAllFromScene()
  container.dispose()
  return { frame, at, pts }
}

const finite = (...ns) => ns.every((n) => Number.isFinite(n))
const bounds = (pts) => {
  const mn = new Vector3(Infinity, Infinity, Infinity)
  const mx = new Vector3(-Infinity, -Infinity, -Infinity)
  for (const p of pts) {
    mn.x = Math.min(mn.x, p.x); mn.y = Math.min(mn.y, p.y); mn.z = Math.min(mn.z, p.z)
    mx.x = Math.max(mx.x, p.x); mx.y = Math.max(mx.y, p.y); mx.z = Math.max(mx.z, p.z)
  }
  return { mn, mx, cx: (mn.x + mx.x) / 2, cy: (mn.y + mx.y) / 2, w: mx.x - mn.x, h: mx.y - mn.y }
}

const CELL = { x: 4, y: -3, z: 0, w: 16, h: 10, depth: 4 }

/** Sanity every framing must satisfy, whatever the model. */
async function sane(name, bytes, cell = CELL, cameraIndex = 0, opts = {}) {
  let res
  try {
    res = await frameIt(bytes, cell, cameraIndex)
  } catch (err) {
    check(`${name}: frames without throwing`, false, String(err).slice(0, 120))
    return null
  }
  const { at, pts } = res
  check(`${name}: finite transform`, finite(at.scale, at.x, at.y, at.z) && at.scale > 0,
    `scale=${at.scale} pos=(${at.x.toFixed(2)},${at.y.toFixed(2)},${at.z.toFixed(2)})`)
  const b = bounds(pts)
  check(`${name}: finite geometry`, finite(b.mn.x, b.mn.y, b.mx.x, b.mx.y))
  if (opts.contained !== false) {
    check(`${name}: stays inside its cell`,
      b.w <= cell.w + 1e-3 && b.h <= cell.h + 1e-3, `${b.w.toFixed(2)}x${b.h.toFixed(2)} in ${cell.w}x${cell.h}`)
    check(`${name}: centred on its cell`,
      Math.abs(b.cx - cell.x) < 0.02 * cell.w && Math.abs(b.cy - cell.y) < 0.02 * cell.h,
      `(${b.cx.toFixed(2)},${b.cy.toFixed(2)}) want (${cell.x},${cell.y})`)
    check(`${name}: big enough to see`, Math.max(b.w / cell.w, b.h / cell.h) > 0.2,
      `fill=${Math.max(b.w / cell.w, b.h / cell.h).toFixed(2)}`)
  }
  check(`${name}: back stays in front of the backdrop`, b.mx.z <= cell.z + cell.depth / 2 + 1e-3,
    `back=${b.mx.z.toFixed(2)}`)
  return { ...res, b }
}

// ------------------------------------------------------------------ shapes
/** Flat, asymmetric "L" in the XY plane — a stand-in for a wordmark. */
const L_PTS = [[0, 0, 0], [3, 0, 0], [3, 1, 0], [1, 1, 0], [1, 4, 0], [0, 4, 0]]
const L_TRIS = [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5]
const scaled = (pts, k, off = [0, 0, 0]) => pts.map((p) => [p[0] * k + off[0], p[1] * k + off[1], p[2] * k + off[2]])

// A flat plate must not come out MIRRORED. Signed area of the L's outline in
// the card's XY plane keeps its sign only if the model was rotated, not
// flipped — with the plate's front (+Z here) turned toward the flat camera
// at -Z, the winding seen on screen is the model's own front-side winding.
{
  const res = await sane('flat plate', makeGlb(L_PTS, L_TRIS))
  if (res) {
    const area = (pts) => {
      let a = 0
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length]
        a += p.x * q.y - q.x * p.y
      }
      return a / 2
    }
    // outline order is the vertex order; the model's own front view is the
    // XY plane seen from +Z (dominantFacing for a plate with +Z normals)
    const front = area(L_PTS.map((p) => ({ x: p[0], y: p[1] })))
    const shown = area(res.pts.slice(0, L_PTS.length))
    check('flat plate is NOT mirrored on the card',
      Math.sign(front) === Math.sign(shown) && Math.abs(shown) > 1e-6,
      `model=${front.toFixed(2)} card=${shown.toFixed(2)}`)
    check('flat plate is not edge-on (thin axis faces the camera)',
      res.b.w > 0.2 && res.b.h > 0.2, `${res.b.w.toFixed(2)}x${res.b.h.toFixed(2)}`)
  }
}

// The same plate authored BACK-TO-FRONT (reversed winding, so its normals
// point at -Z) must also come out readable, not mirrored. This is the exact
// shape of the AMENDMENT 77 "inverted models" regression: the auto-fit turns
// the model's own front toward the viewer, and a wordmark seen from behind
// is unreadable even though every pixel is "there".
{
  const flipped = L_TRIS.slice()
  for (let i = 0; i < flipped.length; i += 3) { const t = flipped[i + 1]; flipped[i + 1] = flipped[i + 2]; flipped[i + 2] = t }
  const res = await sane('back-to-front plate', makeGlb(L_PTS, flipped))
  if (res) {
    const area = (pts) => {
      let a = 0
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length]
        a += p.x * q.y - q.x * p.y
      }
      return a / 2
    }
    // Its front is -Z now, so its own front view mirrors X: the outline seen
    // from the readable side has the OPPOSITE sign to the +Z view.
    const front = -area(L_PTS.map((p) => ({ x: p[0], y: p[1] })))
    const shown = area(res.pts.slice(0, L_PTS.length))
    check('back-to-front plate is shown from ITS front (not mirrored)',
      Math.sign(front) === Math.sign(shown) && Math.abs(shown) > 1e-6,
      `model=${front.toFixed(2)} card=${shown.toFixed(2)}`)
  }
}

// A plate lying FLAT (in the XZ plane, facing +Y) forces the up-vector
// fallback (+Z instead of +Y). It must still be framed face-on, not edge-on.
{
  const lying = L_PTS.map(([x, y]) => [x, 0, y])
  const lyingTris = [0, 2, 1, 0, 3, 2, 0, 4, 3, 0, 5, 4]
  const res = await sane('plate lying flat (faces +Y)', makeGlb(lying, lyingTris))
  if (res) {
    check('a flat-lying plate is framed face-on', res.b.w > 0.2 && res.b.h > 0.2,
      `${res.b.w.toFixed(2)}x${res.b.h.toFixed(2)}`)
  }
}

// An authored camera ROLLED about its own view axis: the roll is part of the
// view the author composed, so the card must be rolled the same way.
{
  const roll = Math.PI / 6
  // quaternion: look down -Z (identity) then roll about Z
  const q = [0, 0, Math.sin(roll / 2), Math.cos(roll / 2)]
  const res = await sane('rolled authored camera', makeGlb(L_PTS, L_TRIS, { eye: [1.5, 2, 8], rotation: q }),
    CELL, 0, { contained: false })
  if (res) {
    // The plate's left edge runs straight up +Y in the model (vertices 0→5),
    // so on an unrolled card it is vertical; a 30° camera roll must tilt it
    // by exactly 30°.
    const a = res.pts[5], b = res.pts[0]
    const tilt = Math.abs(Math.atan2(a.x - b.x, a.y - b.y) * 180 / Math.PI)
    check('camera roll is reproduced on the card', Math.abs(tilt - 30) < 3, `tilt=${tilt.toFixed(1)}° want 30°`)
  }
}

// Dust-sized and kilometre-sized models must land at the same cell size.
{
  const tiny = await sane('dust-sized model', makeGlb(scaled(L_PTS, 0.0005), L_TRIS))
  const huge = await sane('kilometre-sized model', makeGlb(scaled(L_PTS, 4000), L_TRIS))
  if (tiny && huge) {
    check('scale-invariant framing (0.0005 vs 4000 units land the same)',
      Math.abs(tiny.b.h - huge.b.h) < 0.02 * CELL.h, `${tiny.b.h.toFixed(2)} vs ${huge.b.h.toFixed(2)}`)
  }
}

// Geometry parked far from the origin (a common authoring accident).
await sane('model 100k units from the origin', makeGlb(scaled(L_PTS, 1, [100000, -50000, 20000]), L_TRIS))

// A degenerate mesh (all vertices identical) must not divide by zero.
await sane('degenerate zero-size mesh', makeGlb([[1, 1, 1], [1, 1, 1], [1, 1, 1]], [0, 1, 2]),
  CELL, 0, { contained: false })

// A camera INSIDE the model: half the geometry is behind the lens. The frame
// must stay finite (the visible half drives it) and never invert.
{
  const cube = [
    [-2, -2, -2], [2, -2, -2], [2, 2, -2], [-2, 2, -2],
    [-2, -2, 2], [2, -2, 2], [2, 2, 2], [-2, 2, 2],
  ]
  const cubeTris = [
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
  ]
  await sane('camera inside the model', makeGlb(cube, cubeTris, { eye: [0, 0, 0] }), CELL, 0, { contained: false })
}

// A camera a hair away from the surface (macro close-up): cropped, finite.
{
  const plate = makeGlb(L_PTS, L_TRIS, { eye: [1.5, 2, 0.01], rotation: [0, 1, 0, 0] })
  const res = await sane('macro close-up camera', plate, CELL, 0, { contained: false })
  if (res) {
    check('macro close-up keeps a sane scale', res.at.scale > 0 && res.at.scale < 1e5,
      `scale=${res.at.scale.toExponential(2)}`)
  }
}

// Extreme cell shapes (a 1-column phone card, a sliver of a thread node).
for (const cell of [
  { x: 0, y: 0, z: 0, w: 6, h: 20, depth: 2 },
  { x: 0, y: 0, z: 0, w: 40, h: 3, depth: 1 },
]) {
  await sane(`cell ${cell.w}x${cell.h}`, makeGlb(L_PTS, L_TRIS), cell)
}

engine.dispose()
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nall checks passed')
process.exit(fails.length ? 1 : 0)
