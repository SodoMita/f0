import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector'
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer'
import type { AssetContainer } from '@babylonjs/core/assetContainer'

const MAX_TRIANGLES = 100_000

/**
 * Dominant facing direction of a model: the axis with the most surface area,
 * signed by the net outward normal. Area-weighted normals of closed shapes
 * (thin boxes, capsules) cancel out, so the magnitude is accumulated
 * component-wise (|area|) to pick the axis, and the sign is taken from the
 * signed sum. Auto-fit cameras sit on this side or flat content (text)
 * renders mirrored (spec 05b §2.7), and closed shapes render edge-on.
 */
export function dominantFacing(container: AssetContainer, out?: Vector3): Vector3 {
  const sum = out ?? new Vector3()
  sum.set(0, 0, 0)
  const mag = new Vector3()
  let triangles = 0
  const v = new Vector3(), a = new Vector3(), b = new Vector3(), c = new Vector3(), n = new Vector3()
  for (const mesh of container.meshes) {
    if (triangles >= MAX_TRIANGLES) break
    const data = mesh.getVerticesData(VertexBuffer.PositionKind)
    const indices = mesh.getIndices()
    if (!data || !indices) continue
    const world = mesh.getWorldMatrix()
    for (let i = 0; i + 2 < indices.length; i += 3) {
      if (triangles >= MAX_TRIANGLES) break
      const i0 = indices[i] * 3, i1 = indices[i + 1] * 3, i2 = indices[i + 2] * 3
      a.set(data[i0], data[i0 + 1], data[i0 + 2])
      b.set(data[i1], data[i1 + 1], data[i1 + 2])
      c.set(data[i2], data[i2 + 1], data[i2 + 2])
      Vector3.TransformCoordinatesToRef(a, world, a)
      Vector3.TransformCoordinatesToRef(b, world, b)
      Vector3.TransformCoordinatesToRef(c, world, c)
      b.subtractToRef(a, v)
      c.subtractToRef(a, n)
      Vector3.CrossToRef(v, n, n)
      sum.addInPlace(n)
      mag.x += Math.abs(n.x); mag.y += Math.abs(n.y); mag.z += Math.abs(n.z)
      triangles++
    }
  }

  if (mag.x + mag.y + mag.z < 1e-9) return Vector3.Up()

  let axis: 'x' | 'y' | 'z' = 'z'
  if (mag.x >= mag.y && mag.x >= mag.z) axis = 'x'
  else if (mag.y >= mag.x && mag.y >= mag.z) axis = 'y'
  const sign = sum[axis] >= 0 ? 1 : -1
  const facing = new Vector3()
  facing[axis] = sign
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

/**
 * True world-space bounds of the whole model: union of every mesh's world AABB.
 * Averaging per-mesh centers (worldCenter) or per-mesh sphere radii can miss
 * offset models and frame the camera on the wrong point.
 */
export function worldBounds(container: AssetContainer): { center: Vector3; radius: number } {
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
  if (!any) return { center: Vector3.Zero(), radius: 1 }
  // NOTE: do not mutate min before computing both values (a previous
  // `min.add(max)` bug halved the radius and over-zoomed every camera).
  const center = new Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2)
  const radius = Math.max(0.001, Vector3.Distance(min, max) / 2)
  return { center, radius }
}

/**
 * Camera distance that frames a bounding sphere of `radius` with margin for a
 * perspective camera with the given vertical fov.
 *
 * Prefer `frameDistance()` — this sphere fit wastes most of a 16:10 frame for
 * wide/flat models (a wide sign has a huge bounding sphere, so it was pushed
 * far away and rendered as a postage stamp in the middle of the card).
 */
export function fitDistance(radius: number, fov: number): number {
  return Math.max(radius * 2, (radius / Math.tan(fov / 2)) * 1.25)
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

export { Matrix }
