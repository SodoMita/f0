import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Plane } from '@babylonjs/core/Maths/math.plane'
import { Camera } from '@babylonjs/core/Cameras/camera'
import type { AssetContainer } from '@babylonjs/core/assetContainer'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { worldBox, dominantFacing, frameDistance } from './facing'

/**
 * 3D-MODE FRAMING (spec AMENDMENT 43 / 75).
 *
 * In 3D mode the board and the thread map show the post's REAL model in the
 * visible flat scene. The flat camera is orthographic, parked at -Z and never
 * moves — it "is just a position". So the model itself has to carry the view:
 * it is transformed by its own MAIN CAMERA's view matrix, then scaled so the
 * camera's frame maps onto the card / node cell. A card is then literally the
 * author's camera view of the post.
 *
 * The transform a card applies is
 *
 *     world = ((v - pivot) · rot) · scale + cell
 *
 * with `pivot` = the authored camera's position, `rot` = the inverse of its
 * rotation and `scale` = cellHeight / frameHeight, i.e. the camera's frame
 * height AT THE MODEL's depth mapped onto the cell height. Cell width follows
 * from the same uniform scale, exactly like a poster rendered at the card's
 * aspect. Depth is flattened at the model's centre (an ortho camera cannot
 * foreshorten), everything else — direction, composition, how much of the
 * frame the model fills — matches the authored camera.
 *
 * Fallback (no camera, or a camera that frames nothing — the model is behind
 * it or a speck in the corner): auto-fit, the same view the poster pipeline
 * renders (dominantFacing turned toward the viewer, `AUTOFIT_FILL` of the
 * cell).
 */

/** Fill passed to `frameDistance()` when building the auto-fit camera — the
 *  SAME call, with the same value, that the poster pipeline makes, so a
 *  camera-less post is exactly the same size in 2D and in 3D. (Note it is not
 *  "86% of the card": frameDistance fits the model's NEAREST corners into the
 *  frustum, so a deep model legitimately ends up smaller. Reproducing the
 *  poster is the point.) */
export const AUTOFIT_FILL = 0.86
/** Vertical fov of the poster/preview camera (model/poster.ts, previewPool). */
const AUTOFIT_FOV = 0.7
/** Containment for AUTO-FIT models: they are framed by us, so they simply fit.
 *  Camera-framed models are cropped by the cell instead (see makeCellClip) —
 *  exactly what a poster does — because shrinking them to swallow geometry
 *  the author left OUT of frame would throw away their framing. */
const MAX_FILL = 0.98
/** Cap on how far a very deep model may be pushed toward the camera so it
 *  can never cross the ortho near plane (flat cameras sit 30 units out). */
const MAX_FORWARD = 40

export interface ModelFrame {
  /** Rotation applied to the model: inverse of the main camera's rotation. */
  rot: Quaternion
  /** Model-space point that lands at the centre of the cell (the authored
   *  camera's position, or the bounding-box centre when auto-fitting). */
  pivot: Vector3
  /** Bounds of the model AFTER pivot+rot, BEFORE scale ("card space"). */
  min: Vector3
  max: Vector3
  /** Height, in card-space units, that maps onto the full cell height. */
  frameHeight: number
  /** true = the model's own authored camera; false = the auto-fit camera we
   *  built for it (the poster's). Authored framings are never rescaled to
   *  contain the model — they are cropped, like a poster. */
  authored: boolean
}

/** Placement result: the transform for the root → orient → fit chain. */
export interface FramePlacement {
  scale: number
  x: number
  y: number
  z: number
  /** Where the model actually sits INSIDE the cell, in 0..1 cell coordinates
   *  (x from the left, y from the bottom) — the contact shadow uses it, the
   *  same shape the poster pipeline measures from its render. */
  footprint: { cx: number; bottom: number; w: number }
}

/** The cell a model has to live in (world units of the flat scene). */
export interface FrameCell {
  x: number
  y: number
  z: number
  w: number
  h: number
  /** How far the model may extend BEHIND the cell plane before it would sink
   *  into the backdrop. Models deeper than this are pushed toward the camera
   *  instead of being shrunk — an ortho view does not change size with z. */
  depth: number
}

function pickCamera(container: AssetContainer, cameraIndex: number): Camera | null {
  const cams = container.cameras
  if (!cams.length) return null
  const i = cameraIndex >= 0 && cameraIndex < cams.length ? cameraIndex : 0
  return cams[i] ?? null
}

/** Bounds of the model's world AABB after `(v - pivot) · rot`. */
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
    min.x = Math.min(min.x, p.x); min.y = Math.min(min.y, p.y); min.z = Math.min(min.z, p.z)
    max.x = Math.max(max.x, p.x); max.y = Math.max(max.y, p.y); max.z = Math.max(max.z, p.z)
  }
  const e = 1e-4
  if (max.x - min.x < e) { min.x -= e / 2; max.x += e / 2 }
  if (max.y - min.y < e) { min.y -= e / 2; max.y += e / 2 }
  if (max.z - min.z < e) { min.z -= e / 2; max.z += e / 2 }
  return { min, max }
}

/**
 * Auto-fit frame: BUILD the camera the poster pipeline would build and then
 * frame through it, exactly like an authored one. Dominant face toward the
 * viewer, `frameDistance()` for the distance (same fov, same fill, aspect of
 * the cell) — so a camera-less post is the same size on a poster and on a 3D
 * card. Fitting the oriented box to a fraction of the cell instead looked
 * right but was 65% too big for deep models: frameDistance fits the NEAREST
 * corners, not the bounding box at its centre depth.
 *
 * `LookAtLH(eye=facing, target=0)` IS the inverse of that camera's world
 * rotation. A `FromUnitVectorsToRef(facing, -Z)` shortcut is NOT equivalent —
 * for opposite vectors it picks an arbitrary 180° axis and flat models come
 * out upside-down or mirrored (the "inverted models" regression).
 */
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
  // The poster's camera: on the facing side, far enough to frame the model.
  const dist = frameDistance(box.min, box.max, box.center, facing.scale(-1), AUTOFIT_FOV, aspect, AUTOFIT_FILL)
  const pivot = box.center.add(facing.scale(dist))
  const bounds = orientedBounds(box, pivot, rot)
  const depth = (bounds.min.z + bounds.max.z) / 2
  // Same rule as an authored camera: the frame height at the model's depth
  // maps onto the cell height.
  const frameHeight = 2 * Math.max(1e-4, depth) * Math.tan(AUTOFIT_FOV / 2)
  return { rot, pivot, min: bounds.min, max: bounds.max, frameHeight, authored: false }
}

/** World-space AABB of one mesh, expressed in card space ((v - pivot)·rot). */
function meshCardBounds(mesh: AbstractMesh, pivot: Vector3, rot: Quaternion): { min: Vector3; max: Vector3 } | null {
  if (mesh.getTotalVertices() <= 0) return null
  mesh.computeWorldMatrix(true)
  const info = mesh.getBoundingInfo()
  if (!info) return null
  return orientedBounds({ min: info.boundingBox.minimumWorld, max: info.boundingBox.maximumWorld }, pivot, rot)
}

/**
 * Does a card-space box show up inside the camera's frame? Corners are
 * projected the way the authored camera projects them (perspective divide, or
 * a plain ortho scale) and the resulting rect is tested against [-1,1]².
 */
function projectsIntoFrame(
  b: { min: Vector3; max: Vector3 },
  tanY: number,
  aspect: number,
  orthoHalfH: number | null,
): boolean {
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity
  let seen = false
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? b.max.x : b.min.x
    const y = i & 2 ? b.max.y : b.min.y
    const z = i & 4 ? b.max.z : b.min.z
    let u: number, v: number
    if (orthoHalfH !== null) {
      u = x / (orthoHalfH * aspect); v = y / orthoHalfH
    } else {
      if (z <= 1e-4) continue          // behind the camera: contributes nothing
      u = x / (z * tanY * aspect); v = y / (z * tanY)
    }
    seen = true
    u0 = Math.min(u0, u); u1 = Math.max(u1, u)
    v0 = Math.min(v0, v); v1 = Math.max(v1, v)
  }
  if (!seen) return false
  return u1 >= -1 && u0 <= 1 && v1 >= -1 && v0 <= 1
}

/**
 * Build the framing for one model. `cameraIndex` is the post's v3
 * `preview-camera` tag (the author's main camera); out-of-range falls back to
 * the first imported camera, no camera at all falls back to auto-fit.
 * `cellAspect` is the width/height of the card or node the model will live in
 * (the authored camera's horizontal frame follows the target's aspect, just
 * like the poster and live-preview renders).
 */
export function frameModel(container: AssetContainer, cameraIndex: number, cellAspect = 1.6): ModelFrame {
  const box = worldBox(container)
  const aspect = Math.max(0.2, Math.min(5, cellAspect))
  const authored = pickCamera(container, cameraIndex)
  if (!authored) return autoFitFrame(container, box, aspect)

  // Camera.computeWorldMatrix() takes no arguments (it only reads the cached
  // matrix) — force the recompute through the Node-level method, or a camera
  // that was just reparented still reports its pre-import pose.
  ;(authored as unknown as { computeWorldMatrix: (force?: boolean) => unknown }).computeWorldMatrix(true)
  const view = authored.getViewMatrix(true)
  const rot = new Quaternion()
  view.decompose(undefined, rot, undefined)
  const pivot = Matrix.Invert(view).getTranslation()

  // The view matrix is the ground truth (Babylon's glTF loader mirrors the
  // imported scene and gives cameras `ignoreParentScaling`, so hand-built
  // rotations from the camera's world matrix can silently disagree). Verify
  // that (v - pivot)·rot really reproduces v·view before trusting it; if it
  // does not, the model is better off auto-fitted than mirrored.
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

  // Scale reference = only what the camera actually SEES. A prop parked
  // outside the frame (or behind the lens) must not drag the reference depth
  // out with it — that is what turned a close-up into a distant speck.
  const min = new Vector3(Infinity, Infinity, Infinity)
  const max = new Vector3(-Infinity, -Infinity, -Infinity)
  let visible = false
  for (const mesh of container.meshes) {
    const b = meshCardBounds(mesh, pivot, rot)
    if (!b || !projectsIntoFrame(b, tanY, aspect, orthoHalfH)) continue
    visible = true
    min.minimizeInPlace(b.min)
    max.maximizeInPlace(b.max)
  }
  // A camera that frames NOTHING (parked far away, aimed elsewhere, tiny fov)
  // gets the poster's treatment: auto-fit, never a blank card.
  if (!visible) return autoFitFrame(container, box, aspect)

  const depth = (min.z + max.z) / 2
  if (!ortho && !(depth > 1e-4)) return autoFitFrame(container, box, aspect)
  const frameHeight = ortho ? orthoHalfH! * 2 : 2 * depth * tanY
  if (!(frameHeight > 1e-6)) return autoFitFrame(container, box, aspect)
  // Nothing but an invisible speck in the frame: auto-fit instead.
  const span = Math.max((max.x - min.x) / (frameHeight * aspect), (max.y - min.y) / frameHeight)
  if (span < 0.02) return autoFitFrame(container, box, aspect)

  return { rot, pivot, min, max, frameHeight, authored: true }
}

/**
 * Place a framed model into a cell: uniform scale + position for the chain
 * root(scale, position) → orient(rot) → fit(-pivot).
 *
 * Both framings work the same way: the camera's frame height at the model's
 * depth maps onto the cell height, so the model appears exactly as large —
 * and as off-centre — as that camera frames it. The difference is what
 * happens when the model does not fit: an AUTHORED framing is cropped by the
 * cell (a poster is too), an AUTO-FIT one is nudged/shrunk back in, since we
 * chose it. Depth is handled by sliding the model toward the camera (free in
 * an ortho view) rather than scaling it down.
 */
export function placeFrame(frame: ModelFrame, cell: FrameCell): FramePlacement {
  const extX = Math.max(1e-4, frame.max.x - frame.min.x)
  const extY = Math.max(1e-4, frame.max.y - frame.min.y)
  const w = Math.max(1e-4, cell.w)
  const h = Math.max(1e-4, cell.h)
  const camera = frame.authored

  let scale = h / Math.max(1e-6, frame.frameHeight)
  // Auto-fit only: keep the model inside its cell. A camera-framed model is
  // cropped by the cell (like a poster), never rescaled — otherwise a single
  // prop parked outside the authored frame would shrink the whole view.
  if (!camera) scale *= Math.min(1, (w * MAX_FILL) / (extX * scale), (h * MAX_FILL) / (extY * scale))
  scale = Math.max(1e-5, Math.min(1e5, scale))

  // Lateral offset: 0 keeps the camera's own composition (the optical axis at
  // the centre of the cell). Auto-fit nudges an edge back in if it pokes out.
  let ox = 0
  let oy = 0
  if (!camera) {
    const x0 = frame.min.x * scale, x1 = frame.max.x * scale
    const y0 = frame.min.y * scale, y1 = frame.max.y * scale
    if (x1 + ox > w / 2) ox = w / 2 - x1
    if (x0 + ox < -w / 2) ox = -w / 2 - x0
    if (y1 + oy > h / 2) oy = h / 2 - y1
    if (y0 + oy < -h / 2) oy = -h / 2 - y0
  }

  // Depth: centre the model on the cell plane, then — if it is deeper than
  // the budget — slide it toward the camera so its back never reaches the
  // backdrop. An orthographic camera renders it at the same size either way.
  const halfDepth = ((frame.max.z - frame.min.z) / 2) * scale
  let z = cell.z - ((frame.min.z + frame.max.z) / 2) * scale
  const budget = Math.max(0.001, cell.depth) / 2
  if (halfDepth > budget) z -= Math.min(halfDepth - budget, MAX_FORWARD)

  // Where the model ends up inside the cell — the contact shadow follows the
  // real model instead of the fixed guess 3D mode used to draw.
  const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))
  const footprint = {
    cx: clamp01(0.5 + ((frame.min.x + frame.max.x) / 2 * scale + ox) / w),
    bottom: clamp01(0.5 + (frame.min.y * scale + oy) / h),
    w: clamp01((extX * scale) / w),
  }

  return { scale, x: cell.x + ox, y: cell.y + oy, z, footprint }
}

/**
 * The four world-space planes that CROP a model to its cell — the 3D
 * equivalent of a poster/RTT being cut off by the card's edges. Without them
 * a model framed in close-up (or one that animates out of frame) would paint
 * over its neighbours.
 *
 * Babylon discards a fragment where `dot(worldPos, plane) > 0`, so every
 * normal points OUT of the cell. Planes are mutated in place on scroll/pan:
 * assigning a new `Material.clipPlane` re-runs the define preparation on
 * every submesh, which the board's `blockMaterialDirtyMechanism` would then
 * swallow anyway.
 */
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
