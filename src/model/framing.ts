import { Camera } from '@babylonjs/core/Cameras/camera'
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Plane } from '@babylonjs/core/Maths/math.plane'
import type { AssetContainer } from '@babylonjs/core/assetContainer'
import { worldBox, dominantFacing, frameDistance } from './facing'

/** Match the poster pipeline (poster.ts auto-fit). */
const AUTOFIT_FOV = 0.7
const AUTOFIT_FILL = 0.86
const MAX_FILL = 0.92
const MAX_FORWARD = 1.2

export interface ModelFrame {
  rot: Quaternion
  pivot: Vector3
  min: Vector3
  max: Vector3
  frameHeight: number
  authored: boolean
}

export interface FramePlacement {
  scale: number
  x: number
  y: number
  z: number
  footprint: { cx: number; bottom: number; w: number }
}

export interface FrameCell {
  x: number
  y: number
  z: number
  w: number
  h: number
  depth: number
}

function orientedBounds(
  box: { min: Vector3; max: Vector3 },
  pivot: Vector3,
  rot: Quaternion,
): { min: Vector3; max: Vector3 } {
  const m = new Matrix()
  rot.toRotationMatrix(m)
  const min = new Vector3(Infinity, Infinity, Infinity)
  const max = new Vector3(-Infinity, -Infinity, -Infinity)
  const p = new Vector3()
  for (let i = 0; i < 8; i++) {
    p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)
    p.subtractInPlace(pivot)
    Vector3.TransformCoordinatesToRef(p, m, p)
    min.minimizeInPlace(p)
    max.maximizeInPlace(p)
  }
  const e = 1e-4
  if (max.x - min.x < e) { min.x -= e / 2; max.x += e / 2 }
  if (max.y - min.y < e) { min.y -= e / 2; max.y += e / 2 }
  if (max.z - min.z < e) { min.z -= e / 2; max.z += e / 2 }
  return { min, max }
}

/** Build the poster's auto-fit camera and frame through it (same size as 2D). */
function autoFitFrame(
  container: AssetContainer,
  box: { min: Vector3; max: Vector3; center: Vector3 },
  aspect: number,
): ModelFrame {
  const facing = dominantFacing(container).normalizeToNew()
  const up = Math.abs(facing.y) > 0.99 ? new Vector3(0, 0, 1) : Vector3.Up()
  const view = new Matrix()
  Matrix.LookAtLHToRef(facing, Vector3.Zero(), up, view)
  const rot = new Quaternion()
  Quaternion.FromRotationMatrixToRef(view, rot)
  const dist = frameDistance(box.min, box.max, box.center, facing.scale(-1), AUTOFIT_FOV, aspect, AUTOFIT_FILL)
  const pivot = box.center.add(facing.scale(dist))
  const bounds = orientedBounds(box, pivot, rot)
  const depth = (bounds.min.z + bounds.max.z) / 2
  const frameHeight = 2 * Math.max(1e-4, depth) * Math.tan(AUTOFIT_FOV / 2)
  return { rot, pivot, min: bounds.min, max: bounds.max, frameHeight, authored: false }
}

/**
 * Frame a model for a 3D card: authored main-camera view when the GLB has one,
 * else the poster's auto-fit. `cellAspect` is the card/node width/height.
 */
export function frameModel(container: AssetContainer, cameraIndex: number, cellAspect = 1.6): ModelFrame {
  const box = worldBox(container)
  const aspect = Math.max(0.2, Math.min(5, cellAspect))
  const cams = container.cameras
  const authored = cameraIndex >= 0 && cameraIndex < cams.length ? cams[cameraIndex] : cams[0] ?? null
  if (!authored) return autoFitFrame(container, box, aspect)

  ;(authored as unknown as { computeWorldMatrix: (force?: boolean) => unknown }).computeWorldMatrix(true)
  const view = authored.getViewMatrix(true)
  const rot = new Quaternion()
  view.decompose(undefined, rot, undefined)
  const pivot = Matrix.Invert(view).getTranslation()
  // glTF cameras can disagree with a hand-built inverse world rotation
  // (ignoreParentScaling). If (v-pivot)·rot ≠ v·view, auto-fit instead of mirroring.
  const rotM = new Matrix()
  rot.toRotationMatrix(rotM)
  const probe = box.center.add(new Vector3(1, 2, 3))
  const viaView = Vector3.TransformCoordinates(probe, view)
  const viaFrame = Vector3.TransformCoordinates(probe.subtract(pivot), rotM)
  if (Vector3.Distance(viaView, viaFrame) > 1e-3 * (1 + probe.length())) {
    return autoFitFrame(container, box, aspect)
  }

  const tanY = Math.tan(Math.max(0.01, authored.fov || 0.7) / 2)
  const ortho = authored.mode === Camera.ORTHOGRAPHIC_CAMERA
  const orthoHalfH = ortho ? Math.abs(((authored.orthoTop ?? 1) - (authored.orthoBottom ?? -1)) / 2) : null
  if (ortho && !(orthoHalfH! > 1e-6)) return autoFitFrame(container, box, aspect)

  const bounds = orientedBounds(box, pivot, rot)
  const depth = (bounds.min.z + bounds.max.z) / 2
  if (!ortho && !(depth > 1e-4)) return autoFitFrame(container, box, aspect)
  const frameHeight = ortho ? orthoHalfH! * 2 : 2 * depth * tanY
  if (!(frameHeight > 1e-6)) return autoFitFrame(container, box, aspect)
  return { rot, pivot, min: bounds.min, max: bounds.max, frameHeight, authored: true }
}

/** Map a frame onto a card/node cell. Authored views crop; auto-fit stays inside. */
export function placeFrame(frame: ModelFrame, cell: FrameCell): FramePlacement {
  const extX = Math.max(1e-4, frame.max.x - frame.min.x)
  const extY = Math.max(1e-4, frame.max.y - frame.min.y)
  const w = Math.max(1e-4, cell.w)
  const h = Math.max(1e-4, cell.h)
  let scale = h / Math.max(1e-6, frame.frameHeight)
  if (!frame.authored) scale *= Math.min(1, (w * MAX_FILL) / (extX * scale), (h * MAX_FILL) / (extY * scale))
  scale = Math.max(1e-5, Math.min(1e5, scale))

  let ox = 0, oy = 0
  if (!frame.authored) {
    const x0 = frame.min.x * scale, x1 = frame.max.x * scale
    const y0 = frame.min.y * scale, y1 = frame.max.y * scale
    if (x1 + ox > w / 2) ox = w / 2 - x1
    if (x0 + ox < -w / 2) ox = -w / 2 - x0
    if (y1 + oy > h / 2) oy = h / 2 - y1
    if (y0 + oy < -h / 2) oy = -h / 2 - y0
  }

  const halfDepth = ((frame.max.z - frame.min.z) / 2) * scale
  let z = cell.z - ((frame.min.z + frame.max.z) / 2) * scale
  const budget = Math.max(0.001, cell.depth) / 2
  if (halfDepth > budget) z -= Math.min(halfDepth - budget, MAX_FORWARD)

  const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))
  return {
    scale, x: cell.x + ox, y: cell.y + oy, z,
    footprint: {
      cx: clamp01(0.5 + ((frame.min.x + frame.max.x) / 2 * scale + ox) / w),
      bottom: clamp01(0.5 + (frame.min.y * scale + oy) / h),
      w: clamp01((extX * scale) / w),
    },
  }
}

/** Four planes that crop a model to its cell (poster edges, for real meshes). */
export function makeCellClip(): Plane[] {
  return [new Plane(1, 0, 0, 0), new Plane(-1, 0, 0, 0), new Plane(0, 1, 0, 0), new Plane(0, -1, 0, 0)]
}

export function updateCellClip(planes: Plane[], cell: FrameCell): void {
  const x0 = cell.x - cell.w / 2, x1 = cell.x + cell.w / 2
  const y0 = cell.y - cell.h / 2, y1 = cell.y + cell.h / 2
  planes[0].normal.set(1, 0, 0); planes[0].d = -x1
  planes[1].normal.set(-1, 0, 0); planes[1].d = x0
  planes[2].normal.set(0, 1, 0); planes[2].d = -y1
  planes[3].normal.set(0, -1, 0); planes[3].d = y0
}
