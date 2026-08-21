/**
 * Paint-editor primitives. This is a Paint 3D-style ink brush, not a
 * voxel editor: stamps freely overlap; GRID is snapping-only.
 */

export const GRID = 0.05
export const CUBE = 0.25
export const MAX_STAMPS = 50_000
export const UNDO_CAP = 100

export const SHAPES = ['cube', 'sphere', 'cylinder', 'tetra', 'square', 'triangle'] as const
export type ShapeKind = (typeof SHAPES)[number]
export const SHAPE_ID: Record<ShapeKind, number> = {
  cube: 0, sphere: 1, cylinder: 2, tetra: 3, square: 4, triangle: 5,
}
export const SHAPE_FROM_ID: readonly ShapeKind[] = SHAPES

export type PaintToolKind = 'brush' | 'eraser' | 'select' | 'picker'

/** Packed stamp: 16 floats. */
export const STRIDE = 16
export const OFF_PX = 0
export const OFF_QX = 3
export const OFF_SX = 7
export const OFF_R = 10
export const OFF_SHAPE = 14

export interface Stamp {
  id: number
  shape: ShapeKind
  px: number
  py: number
  pz: number
  qx: number
  qy: number
  qz: number
  qw: number
  sx: number
  sy: number
  sz: number
  r: number
  g: number
  b: number
  a: number
}

export interface PaintOpts {
  tool: PaintToolKind
  shape: ShapeKind
  color: [number, number, number, number]
  size: number
  /** Fine-grid snap. Off by default — handwriting is the point. */
  snap: boolean
  /** Raycast existing surfaces instead of the writing plane. */
  surface: boolean
  /** Lock the first-hit plane for the rest of the stroke. */
  depthLock: boolean
  /** Rotate stamps to follow the stroke tangent. */
  align: boolean
  /** Random in-plane offset as a fraction of size. 0 for ink. */
  jitter: number
  /** Stamp spacing as a fraction of current width. */
  spacing: number
  /** Scale along the plane normal (flatten cubes into ink). */
  flatten: number
}

export function defaultPaintOpts(): PaintOpts {
  return {
    tool: 'brush',
    shape: 'cube',
    color: [1, 0.361, 0.208, 1],
    size: CUBE,
    snap: false,
    surface: false,
    depthLock: true,
    align: true,
    jitter: 0,
    spacing: 0.32,
    flatten: 0.4,
  }
}

export function snapToGrid(v: number, cell = GRID): number {
  return Math.round(v / cell) * cell
}

export function hexToRgba(hex: string, a = 1): [number, number, number, number] {
  const h = hex.replace('#', '')
  if (h.length !== 6) return [1, 0.361, 0.208, a]
  const n = parseInt(h, 16)
  if (!Number.isFinite(n)) return [1, 0.361, 0.208, a]
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a]
}

export function rgbaToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

export function stampRadius(s: Stamp): number {
  return Math.max(s.sx, s.sy, s.sz) * 0.5
}
