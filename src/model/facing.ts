import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer'
import type { AssetContainer } from '@babylonjs/core/assetContainer'

// Sampling budget. We STRIDE over the whole model instead of taking the first
// N triangles: same answer, a fraction of the work, and no bias toward
// whichever mesh happens to be first (this runs for every poster, every live
// preview and every viewer open).
const MAX_TRIANGLES = 12_000

/** Diagnostics for test/facing.ts (never used in production paths). */
export let lastFacingDebug: { sum: Vector3; mag: Vector3; triangles: number } | null = null

/**
 * Dominant facing direction of a model: the axis with the most surface area,
 * signed by the net outward normal. Area-weighted normals of closed shapes
 * (thin boxes, capsules) cancel out, so the magnitude is accumulated
 * component-wise (|area|) to pick the axis, and the sign is taken from the
 * signed sum. Auto-fit cameras sit on this side or flat content (text)
 * renders mirrored (spec 05b §2.7), and closed shapes render edge-on.
 */
/**
 * Dominant facing direction of a model: the axis with the most surface area,
 * signed by the net outward normal (authored normals when the GLB has them,
 * left-handed winding otherwise). The poster/preview camera is placed on this
 * side, so getting the sign wrong renders flat content — signs, screens,
 * text planes — from behind, i.e. MIRRORED.
 */
export function dominantFacing(container: AssetContainer, out?: Vector3): Vector3 {
  const sum = out ?? new Vector3()
  sum.set(0, 0, 0)
  const mag = new Vector3()
  let triangles = 0
  const a = new Vector3(), b = new Vector3(), c = new Vector3()
  const e1 = new Vector3(), e2 = new Vector3(), geo = new Vector3()
  const n0 = new Vector3(), n1 = new Vector3(), n2 = new Vector3(), nAuthored = new Vector3()
  for (const mesh of container.meshes) {
    if (triangles >= MAX_TRIANGLES) break
    const data = mesh.getVerticesData(VertexBuffer.PositionKind)
    const indices = mesh.getIndices()
    if (!data || !indices) continue
    const normals = mesh.getVerticesData(VertexBuffer.NormalKind)
    const world = mesh.getWorldMatrix()
    const triCount = Math.floor(indices.length / 3)
    const stride = Math.max(1, Math.ceil(triCount / Math.max(1, MAX_TRIANGLES - triangles))) * 3
    for (let i = 0; i + 2 < indices.length; i += stride) {
      if (triangles >= MAX_TRIANGLES) break
      const i0 = indices[i] * 3, i1 = indices[i + 1] * 3, i2 = indices[i + 2] * 3
      a.set(data[i0], data[i0 + 1], data[i0 + 2])
      b.set(data[i1], data[i1 + 1], data[i1 + 2])
      c.set(data[i2], data[i2 + 1], data[i2 + 2])
      Vector3.TransformCoordinatesToRef(a, world, a)
      Vector3.TransformCoordinatesToRef(b, world, b)
      Vector3.TransformCoordinatesToRef(c, world, c)
      b.subtractToRef(a, e1)
      c.subtractToRef(a, e2)
      // LEFT-HANDED winding: Babylon's own CreatePlane (indices 0,1,2 over a
      // CCW quad) has normal (0,0,-1), i.e. cross(e2, e1) — NOT cross(e1, e2).
      // The old code used cross(e1, e2), so `facing` pointed at the BACK of
      // every flat model and posters of signs/screens came out MIRRORED.
      Vector3.CrossToRef(e2, e1, geo)
      const area = geo.length() * 0.5
      if (area < 1e-12) continue
      if (normals) {
        // Authored normals are the ground truth when the file has them.
        n0.set(normals[i0], normals[i0 + 1], normals[i0 + 2])
        n1.set(normals[i1], normals[i1 + 1], normals[i1 + 2])
        n2.set(normals[i2], normals[i2 + 1], normals[i2 + 2])
        Vector3.TransformNormalToRef(n0, world, n0)
        Vector3.TransformNormalToRef(n1, world, n1)
        Vector3.TransformNormalToRef(n2, world, n2)
        nAuthored.set((n0.x + n1.x + n2.x) / 3, (n0.y + n1.y + n2.y) / 3, (n0.z + n1.z + n2.z) / 3)
        const len = nAuthored.length()
        if (len > 1e-9) nAuthored.scaleInPlace(area / len)
        else nAuthored.copyFrom(geo).scaleInPlace(0.5)
      } else {
        nAuthored.copyFrom(geo).scaleInPlace(0.5)
      }
      sum.addInPlace(nAuthored)
      mag.x += Math.abs(nAuthored.x); mag.y += Math.abs(nAuthored.y); mag.z += Math.abs(nAuthored.z)
      triangles++
    }
  }

  lastFacingDebug = { sum: sum.clone(), mag: mag.clone(), triangles }
  lastFacingDebug = { sum: sum.clone(), mag: mag.clone(), triangles }

  // Axis: a clearly FLAT model is faced along its thin axis (a sign, a screen,
  // a text plate); otherwise take the axis carrying the most surface area.
  const box = worldBox(container)
  const ext = [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z]
  const maxExt = Math.max(ext[0], ext[1], ext[2])
  const thin = ext.indexOf(Math.min(ext[0], ext[1], ext[2]))
  const axes = ['x', 'y', 'z'] as const
  let axis: 'x' | 'y' | 'z'
  if (maxExt > 0 && ext[thin] < 0.25 * maxExt) {
    axis = axes[thin]
  } else if (mag.x + mag.y + mag.z < 1e-9) {
    axis = 'z'
  } else if (mag.x >= mag.y && mag.x >= mag.z) {
    axis = 'x'
  } else if (mag.y >= mag.x && mag.y >= mag.z) {
    axis = 'y'
  } else {
    axis = 'z'
  }

  // Sign: the net outward normal when it says something. Closed shapes cancel
  // out (sum == 0 for a cube, an extruded word, a capsule…) and then the
  // answer is +axis: glTF content imported into Babylon reads correctly from
  // the POSITIVE side — measured with test/facing.ts on live board content,
  // where the negative side rendered every wordmark mirrored.
  const signal = mag[axis] > 1e-9 ? Math.abs(sum[axis]) / mag[axis] : 0
  const facing = new Vector3()
  facing[axis] = signal < 0.02 ? 1 : (sum[axis] >= 0 ? 1 : -1)
  return facing
}

export function worldCenter(container: AssetContainer, out?: Vector3): Vector3 {
  const c = out ?? new Vector3()
  c.set(0, 0, 0)
  let n = 0
  for (const mesh of container.meshes) {
    mesh.computeWorldMatrix(true)
    const info = mesh.getBoundingInfo()
    if (!info) continue
    info.boundingBox.centerWorld.addToRef(c, c)
    n++
  }
  if (n === 0) return Vector3.Zero()
  return c.scaleInPlace(1 / n)
}

export function worldRadius(container: AssetContainer): number {
  let r = 0
  for (const mesh of container.meshes) {
    mesh.computeWorldMatrix(true)
    const info = mesh.getBoundingInfo()
    if (!info) continue
    const d = info.boundingSphere.radiusWorld
    if (d > r) r = d
  }
  return r || 1
}

/** World-space AABB of the whole model. */
export function worldBox(container: AssetContainer): { min: Vector3; max: Vector3; center: Vector3; radius: number } {
  const min = new Vector3(Infinity, Infinity, Infinity)
  const max = new Vector3(-Infinity, -Infinity, -Infinity)
  let any = false
  for (const mesh of container.meshes) {
    mesh.computeWorldMatrix(true)
    const info = mesh.getBoundingInfo()
    if (!info) continue
    const mi = info.boundingBox.minimumWorld
    const ma = info.boundingBox.maximumWorld
    min.x = Math.min(min.x, mi.x); min.y = Math.min(min.y, mi.y); min.z = Math.min(min.z, mi.z)
    max.x = Math.max(max.x, ma.x); max.y = Math.max(max.y, ma.y); max.z = Math.max(max.z, ma.z)
    any = true
  }
  if (!any) {
    return { min: new Vector3(-1, -1, -1), max: new Vector3(1, 1, 1), center: Vector3.Zero(), radius: 1 }
  }
  const center = new Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2)
  const radius = Math.max(0.001, Vector3.Distance(min, max) / 2)
  return { min, max, center, radius }
}

/**
 * Tight camera distance for an oriented view: projects all eight AABB corners
 * into the camera basis and solves for the smallest distance where every
 * corner is still inside BOTH the horizontal and the vertical frustum planes.
 * `fill` is how much of the frame the model should occupy (0..1).
 *
 * This is what makes a wide model actually fill a 16:10 card instead of being
 * fitted as if it were a sphere.
 */
export function frameDistance(
  min: Vector3,
  max: Vector3,
  center: Vector3,
  forward: Vector3,
  fovY: number,
  aspect: number,
  fill = 0.82,
): number {
  const f = forward.normalizeToNew()
  let upRef = new Vector3(0, 1, 0)
  if (Math.abs(Vector3.Dot(f, upRef)) > 0.95) upRef = new Vector3(0, 0, 1)
  const r = Vector3.Cross(upRef, f).normalize()
  const u = Vector3.Cross(f, r).normalize()
  const tanY = Math.tan(fovY / 2)
  const tanX = tanY * Math.max(0.2, aspect)
  let d = 0
  const p = new Vector3()
  for (let i = 0; i < 8; i++) {
    p.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z)
    p.subtractInPlace(center)
    const a = Math.abs(Vector3.Dot(p, r))
    const b = Math.abs(Vector3.Dot(p, u))
    const c = Vector3.Dot(p, f)
    d = Math.max(d, a / tanX - c, b / tanY - c)
  }
  const radius = Vector3.Distance(min, max) / 2
  return Math.max(radius * 1.15, d / Math.max(0.2, Math.min(1, fill)))
}
