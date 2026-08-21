// Direct-3D framing unit — no browser needed:
//   bun scripts/direct3d-camera-unit.mjs
//
// SPEC AMENDMENT 43: in 3D mode (board cards + thread nodes) a model is shown
// THROUGH ITS OWN MAIN CAMERA. The flat scene camera is only a position, so
// the model itself carries the authored camera's view rotation. This unit
// proves it geometrically: the model's vertices, as they end up in the flat
// scene, must be a pure translate+uniform-scale of the same vertices seen in
// the authored camera's own view space (no leftover rotation, no mirror).
//
// Guard for the "3D mode ignores the model's main camera" regression.
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { Vector3, Matrix } from '@babylonjs/core/Maths/math.vector'
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
import '../src/model/gltf.ts'
import { Direct3DPool } from '../src/board/modelCard3d.ts'

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

// ---------------------------------------------------------------- glb build
/** Asymmetric tetrahedron so any stray rotation/mirror shows up immediately. */
const TETRA = [
  [0, 0, 0],
  [2, 0, 0],
  [0, 3, 0],
  [0, 0, 5],
]
const TRIS = [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3]

/** Right-handed look-at rotation quaternion for a glTF camera (looks down -Z). */
function lookAtQuat(eye, target, up = [0, 1, 0]) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const norm = (a) => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l] }
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const z = norm(sub(eye, target))          // camera +Z is BACKWARD in glTF
  const x = norm(cross(up, z))
  const y = cross(z, x)
  // column-major basis -> quaternion
  const m = [x, y, z]
  const t = m[0][0] + m[1][1] + m[2][2]
  let q
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2
    q = [(m[1][2] - m[2][1]) / s, (m[2][0] - m[0][2]) / s, (m[0][1] - m[1][0]) / s, s / 4]
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2
    q = [s / 4, (m[1][0] + m[0][1]) / s, (m[2][0] + m[0][2]) / s, (m[1][2] - m[2][1]) / s]
  } else if (m[1][1] > m[2][2]) {
    const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2
    q = [(m[1][0] + m[0][1]) / s, s / 4, (m[2][1] + m[1][2]) / s, (m[2][0] - m[0][2]) / s]
  } else {
    const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2
    q = [(m[2][0] + m[0][2]) / s, (m[2][1] + m[1][2]) / s, s / 4, (m[0][1] - m[1][0]) / s]
  }
  const l = Math.hypot(...q)
  return q.map((v) => v / l)
}

/** GLB of the tetrahedron, optionally with `cameras` authored look-at poses. */
function makeGlb(cameras = []) {
  const positions = new Float32Array(TETRA.flat())
  const indices = new Uint16Array(TRIS)
  const posBytes = positions.byteLength
  const idxBytes = indices.byteLength
  const pad = (n) => (4 - (n % 4)) % 4
  const idxAt = posBytes
  const binLen = idxAt + idxBytes + pad(idxAt + idxBytes)
  const bin = new Uint8Array(binLen)
  bin.set(new Uint8Array(positions.buffer), 0)
  bin.set(new Uint8Array(indices.buffer), idxAt)

  const nodes = [{ mesh: 0 }]
  const gltfCameras = []
  cameras.forEach((c, i) => {
    gltfCameras.push(c.ymag
      ? { type: 'orthographic', orthographic: { xmag: c.ymag * 1.6, ymag: c.ymag, znear: 0.01, zfar: 100 } }
      : { type: 'perspective', perspective: { yfov: 0.7, znear: 0.01, zfar: 100 } })
    nodes.push({ camera: i, translation: c.eye, rotation: lookAtQuat(c.eye, c.target) })
  })
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [2, 3, 5] },
      { bufferView: 1, componentType: 5123, count: TRIS.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes },
      { buffer: 0, byteOffset: idxAt, byteLength: idxBytes },
    ],
    buffers: [{ byteLength: binLen }],
  }
  if (gltfCameras.length) json.cameras = gltfCameras
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

// ------------------------------------------------------------------ helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitUntil(pred, tries = 60, ms = 20) {
  for (let i = 0; i < tries; i++) { if (pred()) return true; await sleep(ms) }
  return pred()
}

/** World-space vertices of every mesh in a scene subtree. */
function worldVertices(meshes) {
  const out = []
  for (const mesh of meshes) {
    const data = mesh.getVerticesData(VertexBuffer.PositionKind)
    if (!data) continue
    mesh.computeWorldMatrix(true)
    const w = mesh.getWorldMatrix()
    for (let i = 0; i + 2 < data.length; i += 3) {
      const p = new Vector3(data[i], data[i + 1], data[i + 2])
      out.push(Vector3.TransformCoordinates(p, w))
    }
  }
  return out
}

const mean = (pts) => {
  const c = new Vector3()
  for (const p of pts) c.addInPlace(p)
  return c.scaleInPlace(1 / Math.max(1, pts.length))
}

/** Axis-aligned bounds of a point cloud (centre + size), not the centroid:
 *  an asymmetric model's centroid is nowhere near its bounding-box centre. */
function bounds(pts) {
  const mn = new Vector3(Infinity, Infinity, Infinity)
  const mx = new Vector3(-Infinity, -Infinity, -Infinity)
  for (const p of pts) {
    mn.x = Math.min(mn.x, p.x); mn.y = Math.min(mn.y, p.y); mn.z = Math.min(mn.z, p.z)
    mx.x = Math.max(mx.x, p.x); mx.y = Math.max(mx.y, p.y); mx.z = Math.max(mx.z, p.z)
  }
  return {
    min: mn, max: mx,
    center: new Vector3((mn.x + mx.x) / 2, (mn.y + mx.y) / 2, (mn.z + mx.z) / 2),
    size: new Vector3(mx.x - mn.x, mx.y - mn.y, mx.z - mn.z),
  }
}

/**
 * Max residual (relative to model size) between two point clouds after the
 * best translate + uniform-scale fit. ~0 means SAME orientation; a rotation
 * or a mirror leaves a large residual.
 */
function shapeMismatch(a, b) {
  if (a.length !== b.length || !a.length) return Infinity
  const ca = mean(a), cb = mean(b)
  const da = a.map((p) => p.subtract(ca))
  const db = b.map((p) => p.subtract(cb))
  const rmsA = Math.sqrt(da.reduce((s, p) => s + p.lengthSquared(), 0) / da.length)
  const rmsB = Math.sqrt(db.reduce((s, p) => s + p.lengthSquared(), 0) / db.length)
  if (rmsA < 1e-9 || rmsB < 1e-9) return Infinity
  const k = rmsA / rmsB
  let worst = 0
  for (let i = 0; i < da.length; i++) worst = Math.max(worst, da[i].subtract(db[i].scale(k)).length())
  return worst / rmsA
}

/** Vertices AND world-AABB corners of the model in the AUTHORED camera's view
 *  space. framing.ts derives the frame depth from the AABB corners (the same
 *  box every fit in this codebase uses), so the reference must too. */
async function authoredViewCloud(bytes, cameraIndex) {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  new HemisphericLight('l', new Vector3(0, 1, 0), scene)
  const container = await LoadAssetContainerAsync(bytes, scene, { pluginExtension: '.glb' })
  container.addAllToScene()
  const cam = container.cameras[cameraIndex]
  if (!cam) throw new Error('no authored camera')
  scene.activeCamera = cam
  cam.computeWorldMatrix(true)
  const view = cam.getViewMatrix(true)
  const world = worldVertices(container.meshes.filter((m) => m.getTotalVertices() > 0))
  const cloud = world.map((p) => Vector3.TransformCoordinates(p, view))
  const wb = bounds(world)
  const corners = []
  for (let i = 0; i < 8; i++) {
    corners.push(Vector3.TransformCoordinates(new Vector3(
      i & 1 ? wb.max.x : wb.min.x, i & 2 ? wb.max.y : wb.min.y, i & 4 ? wb.max.z : wb.min.z,
    ), view))
  }
  engine.dispose()
  cloud.box = corners
  return cloud
}

/** Vertices of the model as the FLAT scene shows it in 3D mode. */
async function direct3dCloud(bytes, cameraIndex, place) {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  new HemisphericLight('l', new Vector3(0, 1, 0), scene)
  const pool = new Direct3DPool(
    scene,
    async () => ({ bytes, sha256: '0'.repeat(64), cameraIndex }),
    { maxSlots: 1 },
  )
  pool.request('post', place)
  const ok = await waitUntil(() => pool.isLive('post'))
  if (!ok) { engine.dispose(); throw new Error('model never went live') }
  const meshes = scene.meshes.filter((m) => m.getTotalVertices() > 0)
  const cloud = worldVertices(meshes)
  const root = scene.transformNodes.find((n) => n.name.startsWith('d3-') && !n.name.includes('orient') && !n.name.includes('fit'))
  const pos = root ? root.position.clone() : new Vector3()
  engine.dispose()
  return { cloud, pos }
}

// -------------------------------------------------------------- the checks
const place = { x: 12, y: -7, z: 0, w: 16, h: 10, depth: 6 }

// A camera looking at the tetra from an awkward angle: every axis differs, so
// a wrong rotation (or a mirror) cannot accidentally pass.
const eye = [7, 4, -6]
const target = [0.5, 0.75, 1.25]
const withCam = makeGlb([{ eye, target }])
const FOV = 0.7

/**
 * Where the authored camera would put each vertex ON THE CARD: project into
 * the camera frame, then map that frame onto the cell (an ortho card cannot
 * foreshorten, so the projection is flattened at the model's centre depth —
 * the same approximation model/framing.ts makes).
 */
function expectedCardPoints(view, cell) {
  const c = bounds(view.box ?? view).center
  const frameH = 2 * c.z * Math.tan(FOV / 2)
  const k = cell.h / frameH
  return view.map((p) => new Vector3(cell.x + p.x * k, cell.y + p.y * k, 0))
}

{
  const ref = await authoredViewCloud(withCam, 0)
  const { cloud, pos } = await direct3dCloud(withCam, 0, place)
  const miss = shapeMismatch(cloud, ref)
  check('3D card shows the model through its MAIN camera', miss < 0.01, `mismatch=${miss.toFixed(4)}`)

  // The framing itself: same size AND same off-centre composition the
  // authored camera has, not a bounding-box auto-fit.
  const want = expectedCardPoints(ref, place)
  let worst = 0
  for (let i = 0; i < want.length; i++) {
    worst = Math.max(worst, Math.hypot(cloud[i].x - want[i].x, cloud[i].y - want[i].y))
  }
  check('3D card reproduces the MAIN-CAMERA framing (size + composition)',
    worst < 0.02 * place.h, `worst=${worst.toFixed(3)} world units`)

  const b = bounds(cloud)
  const ex = b.size.x, ey = b.size.y, zmax = b.max.z
  check('framed model stays inside the card cell', ex <= place.w + 1e-3 && ey <= place.h + 1e-3,
    `w=${ex.toFixed(2)} h=${ey.toFixed(2)}`)
  // A deep model is pushed TOWARD the camera (free in an ortho view) instead
  // of being shrunk, so its back never reaches the backdrop.
  check('model never pokes behind the cell plane budget', zmax <= place.z + place.depth / 2 + 1e-3,
    `back z=${zmax.toFixed(2)} budget=${place.z + place.depth / 2}`)
  check('model sits at the requested cell', Math.abs(pos.x - place.x) < 1e-4 && Math.abs(pos.y - place.y) < 1e-4,
    `x=${pos.x} y=${pos.y}`)
}

// Second camera pose: a *second* authored camera, selected by preview-camera.
{
  const two = makeGlb([{ eye: [0, 0, -9], target: [0, 0, 0] }, { eye: [-6, 8, 3], target: [0.5, 0.75, 1.25] }])
  const ref = await authoredViewCloud(two, 1)
  const { cloud } = await direct3dCloud(two, 1, place)
  const miss = shapeMismatch(cloud, ref)
  check('preview-camera index picks the right authored camera', miss < 0.01, `mismatch=${miss.toFixed(4)}`)
  const want = expectedCardPoints(ref, place)
  let worst = 0
  for (let i = 0; i < want.length; i++) worst = Math.max(worst, Math.hypot(cloud[i].x - want[i].x, cloud[i].y - want[i].y))
  check('preview-camera framing matches that camera too', worst < 0.02 * place.h, `worst=${worst.toFixed(3)}`)
}

// A camera that frames NOTHING (aimed away, tiny fov) must fall back to
// auto-fit instead of rendering an invisible speck (rig flavour `f`).
{
  const blind = makeGlb([{ eye: [60, 60, 60], target: [120, 120, 120] }])
  const { cloud } = await direct3dCloud(blind, 0, place)
  const b = bounds(cloud)
  const c = b.center, ex = b.size.x, ey = b.size.y
  check('a camera that frames nothing falls back to auto-fit',
    Math.max(ex / place.w, ey / place.h) > 0.5 && ex <= place.w + 1e-3 && ey <= place.h + 1e-3,
    `w=${ex.toFixed(2)} h=${ey.toFixed(2)}`)
  check('auto-fit fallback is centred on the cell',
    Math.abs(c.x - place.x) < 0.05 && Math.abs(c.y - place.y) < 0.05, `x=${c.x.toFixed(2)} y=${c.y.toFixed(2)}`)
}

// A model with NO camera: auto-fit, poster-sized, centred — even though its
// geometry is nowhere near the origin (the pivot must be scaled with it).
{
  const bare = makeGlb([])
  const { cloud } = await direct3dCloud(bare, 0, place)
  const b = bounds(cloud)
  const c = b.center, ex = b.size.x, ey = b.size.y
  check('camera-less model auto-fits its cell',
    Math.max(ex / place.w, ey / place.h) > 0.5 && ex <= place.w + 1e-3 && ey <= place.h + 1e-3,
    `w=${ex.toFixed(2)} h=${ey.toFixed(2)}`)
  check('camera-less model is centred on its cell',
    Math.abs(c.x - place.x) < 0.05 && Math.abs(c.y - place.y) < 0.05, `x=${c.x.toFixed(2)} y=${c.y.toFixed(2)}`)
}

// Re-placing (scroll / pan / zoom / resize) must keep the same framing.
{
  const engine = new NullEngine()
  const scene = new Scene(engine)
  new HemisphericLight('l', new Vector3(0, 1, 0), scene)
  const pool = new Direct3DPool(scene, async () => ({ bytes: withCam, sha256: '0'.repeat(64), cameraIndex: 0 }), { maxSlots: 1 })
  pool.request('p', place)
  await waitUntil(() => pool.isLive('p'))
  const small = { x: -30, y: 5, z: 0, w: 8, h: 5, depth: 3 }
  pool.place('p', small)
  const cloud = worldVertices(scene.meshes.filter((m) => m.getTotalVertices() > 0))
  const ref = await authoredViewCloud(withCam, 0)
  const want = expectedCardPoints(ref, small)
  let worst = 0
  for (let i = 0; i < want.length; i++) worst = Math.max(worst, Math.hypot(cloud[i].x - want[i].x, cloud[i].y - want[i].y))
  check('re-placing into a smaller cell keeps the camera framing', worst < 0.02 * small.h, `worst=${worst.toFixed(3)}`)
  engine.dispose()
}

// An ORTHOGRAPHIC authored camera frames by magnification, not by distance:
// its ymag*2 is what must map onto the cell height, at any distance.
{
  const ortho = makeGlb([{ eye: [6, 5, -7], target: [0.5, 0.75, 1.25], ymag: 4 }])
  const { cloud } = await direct3dCloud(ortho, 0, place)
  const ref = await authoredViewCloud(ortho, 0)
  const miss = shapeMismatch(cloud, ref)
  check('orthographic authored camera: same orientation', miss < 0.01, `mismatch=${miss.toFixed(4)}`)
  // ymag 4 -> an 8-unit frame maps onto the 10-unit cell: scale = 1.25.
  const b = bounds(cloud)
  const rb = bounds(ref)
  const scale = b.size.y / rb.size.y
  check('orthographic authored camera: ymag sets the size (cell/2·ymag)',
    Math.abs(scale - place.h / 8) < 0.02, `scale=${scale.toFixed(3)} want=${(place.h / 8).toFixed(3)}`)
  check('orthographic authored camera: composition is the camera\'s',
    Math.abs(b.center.x - (place.x + rb.center.x * scale)) < 0.05 &&
    Math.abs(b.center.y - (place.y + rb.center.y * scale)) < 0.05,
    `centre=(${b.center.x.toFixed(2)},${b.center.y.toFixed(2)})`)
}

// An out-of-range preview-camera index must fall back to the FIRST authored
// camera (the viewer's policy), not to auto-fit and not to a crash.
{
  const one = makeGlb([{ eye, target }])
  const ref = await authoredViewCloud(one, 0)
  const { cloud } = await direct3dCloud(one, 7, place)
  const want = expectedCardPoints(ref, place)
  let worst = 0
  for (let i = 0; i < want.length; i++) worst = Math.max(worst, Math.hypot(cloud[i].x - want[i].x, cloud[i].y - want[i].y))
  check('a bogus preview-camera index falls back to camera 0', worst < 0.02 * place.h, `worst=${worst.toFixed(3)}`)
}

// A cell with a different aspect keeps the camera's SIZE (height maps to
// height) — a 1:1 node and a 16:10 card show the model at the same scale.
{
  const ref = await authoredViewCloud(withCam, 0)
  const square = { x: 0, y: 0, z: 0, w: 10, h: 10, depth: 6 }
  const { cloud } = await direct3dCloud(withCam, 0, square)
  const want = expectedCardPoints(ref, square)
  let worst = 0
  for (let i = 0; i < want.length; i++) worst = Math.max(worst, Math.hypot(cloud[i].x - want[i].x, cloud[i].y - want[i].y))
  check('cell aspect does not change the framing (height maps to height)',
    worst < 0.02 * square.h, `worst=${worst.toFixed(3)}`)
}

console.log(fails.length ? `\n${fails.length} FAILURES` : '\nall checks passed')
process.exit(fails.length ? 1 : 0)
