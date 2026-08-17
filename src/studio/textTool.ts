import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import type { Scene } from '@babylonjs/core/scene'

/**
 * Low-poly typed text.
 *
 * Per SPEC (TEXT+ANIM): "real flat low-poly geometry (NOT a textured
 * quad), FORM <120 tris; pixel-font table + run-merge." Each glyph is a
 * 5x7 bitmap; covered runs on a row are merged into ONE rectangle instead
 * of one quad per pixel, so the triangle count stays tiny (a run is two
 * triangles regardless of length). Output is a single merged mesh with a
 * double-sided unlit material.
 *
 * This is the typed-text fallback for the Studio. The primary text path
 * is the hand-writing paint editor (AMENDMENT 10); typed text is for
 * labels/quick forms.
 */

// 5 wide x 7 tall bitmap font (each string is one ROW; 'X' = filled).
// Compact 5x7 set covering ASCII needed for labels. Unknown glyphs -> box.
const FONT: Record<string, string[]> = {
  A: ['.XXX.', 'X...X', 'X...X', 'XXXXX', 'X...X', 'X...X', 'X...X'],
  B: ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X...X', 'X...X', 'XXXX.'],
  C: ['.XXX.', 'X...X', 'X....', 'X....', 'X....', 'X...X', '.XXX.'],
  D: ['XXXX.', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', 'XXXX.'],
  E: ['XXXXX', 'X....', 'X....', 'XXXX.', 'X....', 'X....', 'XXXXX'],
  F: ['XXXXX', 'X....', 'X....', 'XXXX.', 'X....', 'X....', 'X....'],
  G: ['.XXX.', 'X...X', 'X....', 'X.XXX', 'X...X', 'X...X', '.XXX.'],
  H: ['X...X', 'X...X', 'X...X', 'XXXXX', 'X...X', 'X...X', 'X...X'],
  I: ['XXXXX', '..X..', '..X..', '..X..', '..X..', '..X..', 'XXXXX'],
  J: ['..XXX', '...X.', '...X.', '...X.', '...X.', 'X..X.', '.XX..'],
  K: ['X...X', 'X..X.', 'X.X..', 'XX...', 'X.X..', 'X..X.', 'X...X'],
  L: ['X....', 'X....', 'X....', 'X....', 'X....', 'X....', 'XXXXX'],
  M: ['X...X', 'XX.XX', 'X.X.X', 'X...X', 'X...X', 'X...X', 'X...X'],
  N: ['X...X', 'XX..X', 'X.X.X', 'X..XX', 'X...X', 'X...X', 'X...X'],
  O: ['.XXX.', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.XXX.'],
  P: ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X....', 'X....', 'X....'],
  Q: ['.XXX.', 'X...X', 'X...X', 'X...X', 'X.X.X', 'X..X.', '.XX.X'],
  R: ['XXXX.', 'X...X', 'X...X', 'XXXX.', 'X.X..', 'X..X.', 'X...X'],
  S: ['.XXXX', 'X....', 'X....', '.XXX.', '....X', '....X', 'XXXX.'],
  T: ['XXXXX', '..X..', '..X..', '..X..', '..X..', '..X..', '..X..'],
  U: ['X...X', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.XXX.'],
  V: ['X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.X.X.', '..X..'],
  W: ['X...X', 'X...X', 'X...X', 'X...X', 'X.X.X', 'XX.XX', 'X...X'],
  X: ['X...X', 'X...X', '.X.X.', '..X..', '.X.X.', 'X...X', 'X...X'],
  Y: ['X...X', 'X...X', '.X.X.', '..X..', '..X..', '..X..', '..X..'],
  Z: ['XXXXX', '....X', '...X.', '..X..', '.X...', 'X....', 'XXXXX'],
  '0': ['.XXX.', 'X...X', 'X..XX', 'X.X.X', 'XX..X', 'X...X', '.XXX.'],
  '1': ['..X..', '.XX..', '..X..', '..X..', '..X..', '..X..', '.XXX.'],
  '2': ['.XXX.', 'X...X', '....X', '..XX.', '.X...', 'X....', 'XXXXX'],
  '3': ['XXXX.', '....X', '....X', '.XXX.', '....X', '....X', 'XXXX.'],
  '4': ['X...X', 'X...X', 'X...X', 'XXXXX', '....X', '....X', '....X'],
  '5': ['XXXXX', 'X....', 'XXXX.', '....X', '....X', 'X...X', '.XXX.'],
  '6': ['.XXX.', 'X....', 'XXXX.', 'X...X', 'X...X', 'X...X', '.XXX.'],
  '7': ['XXXXX', '....X', '...X.', '..X..', '.X...', '.X...', '.X...'],
  '8': ['.XXX.', 'X...X', 'X...X', '.XXX.', 'X...X', 'X...X', '.XXX.'],
  '9': ['.XXX.', 'X...X', 'X...X', '.XXXX', '....X', '....X', '.XXX.'],
  '/': ['....X', '....X', '...X.', '..X..', '.X...', 'X....', 'X....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '..X..', '..X..'],
  ',': ['.....', '.....', '.....', '.....', '..X..', '..X..', '.X...'],
  '!': ['..X..', '..X..', '..X..', '..X..', '..X..', '.....', '..X..'],
  '?': ['.XXX.', 'X...X', '....X', '..XX.', '..X..', '.....', '..X..'],
  '-': ['.....', '.....', '.....', 'XXXXX', '.....', '.....', '.....'],
  '_': ['.....', '.....', '.....', '.....', '.....', '.....', 'XXXXX'],
  '+': ['.....', '..X..', '..X..', 'XXXXX', '..X..', '..X..', '.....'],
  '=': ['.....', '.....', 'XXXXX', '.....', 'XXXXX', '.....', '.....'],
  ':': ['.....', '..X..', '.....', '.....', '.....', '..X..', '.....'],
  '(': ['..X..', '.X...', 'X....', 'X....', 'X....', '.X...', '..X..'],
  ')': ['..X..', '...X.', '....X', '....X', '....X', '...X.', '..X..'],
  "'": ['..X..', '..X..', '.X...', '.....', '.....', '.....', '.....'],
  '"': ['.X.X.', '.X.X.', '......', '......', '......', '......', '......'],
  '#': ['.X.X.', 'XXXXX', '.X.X.', 'XXXXX', '.X.X.', '.....', '.....'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
}

const GLYPH_W = 5
const GLYPH_H = 7
const KERN = 1
const SCALE = 0.11

export interface TextMeshResult {
  mesh: Mesh
  width: number
  height: number
  triangles: number
}

function glyph(ch: string): string[] {
  return FONT[ch] ?? FONT['?'] ?? FONT[' ']
}

/**
 * Build a single merged quad mesh. Adjacent filled pixels on the same row
 * are run-length merged into one rectangle (2 tris). This keeps well under
 * the 120-tri budget for short labels even at full coverage.
 */
export function buildTextMesh(
  scene: Scene,
  text: string,
  color = '#FF5C35',
  align: 'left' | 'center' | 'right' = 'center',
): TextMeshResult {
  const lines = String(text || '').toUpperCase().split('\n').slice(0, 4)

  // Per-line runs: build per-glyph runs, then MERGE runs that are adjacent
  // across glyph boundaries on the same pixel row. Without the second pass a
  // word with many glyphs blows past the 120-tri budget (each run = 2 tris).
  const lineRuns: { x0: number; x1: number; y: number }[][] = []
  let maxWidth = 0
  for (const line of lines) {
    const byRow = new Map<number, { x0: number; x1: number }[]>()
    let cursor = 0
    for (const ch of line || ' ') {
      const g = glyph(ch)
      for (let gy = 0; gy < GLYPH_H; gy += 1) {
        const row = g[gy]
        let runStart = -1
        for (let gx = 0; gx <= GLYPH_W; gx += 1) {
          const filled = gx < GLYPH_W && row[gx] === 'X'
          if (filled && runStart < 0) runStart = cursor + gx
          if ((!filled || gx === GLYPH_W) && runStart >= 0) {
            const arr = byRow.get(gy) ?? []
            arr.push({ x0: runStart, x1: cursor + gx })
            byRow.set(gy, arr)
            runStart = -1
          }
        }
      }
      cursor += GLYPH_W + KERN
    }
    // Adjacency-merge within each row (runs touch or overlap at x).
    const runs: { x0: number; x1: number; y: number }[] = []
    for (let gy = 0; gy < GLYPH_H; gy += 1) {
      const rowRuns = (byRow.get(gy) ?? []).sort((a, b) => a.x0 - b.x0)
      for (const r of rowRuns) {
        const last = runs[runs.length - 1]
        if (last && last.y === gy && r.x0 <= last.x1 + KERN) {
          last.x1 = Math.max(last.x1, r.x1)
        } else {
          runs.push({ x0: r.x0, x1: r.x1, y: gy })
        }
      }
    }
    const width = cursor - KERN
    maxWidth = Math.max(maxWidth, width)
    lineRuns.push(runs)
  }

  // Apply alignment + center, collect rectangles.
  const positions: number[] = []
  const indices: number[] = []
  const rows = lines.length * GLYPH_H
  let v = 0
  let triCount = 0

  lineRuns.forEach((runs, lineIdx) => {
    const lineWidth = runs.length ? Math.max(...runs.map((r) => r.x1)) : 0
    let xShift = 0
    if (align === 'center') xShift = Math.round((maxWidth - lineWidth) / 2)
    else if (align === 'right') xShift = maxWidth - lineWidth
    for (const r of runs) {
      const x0 = (r.x0 + xShift) * SCALE
      const x1 = (r.x1 + xShift) * SCALE
      // Pixel rows top-to-bottom; flip Y so the glyph sits upright.
      const topY = -(lineIdx * (GLYPH_H + 1) + r.y) * SCALE
      const botY = topY - SCALE
      positions.push(x0, topY, 0, x1, topY, 0, x1, botY, 0, x0, botY, 0)
      indices.push(v, v + 1, v + 2, v, v + 2, v + 3)
      v += 4
      triCount += 2
    }
  })

  // Center the whole block on origin.
  const halfW = (maxWidth * SCALE) / 2
  const halfH = (rows * SCALE) / 2
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] -= halfW
    positions[i + 1] += halfH
  }

  const mesh = new Mesh('studio-text', scene)
  const vd = new VertexData()
  vd.positions = positions
  vd.indices = indices
  vd.applyToMesh(mesh)

  const mat = new StandardMaterial('studio-text-mat', scene)
  mat.emissiveColor = Color3.FromHexString(color)
  mat.diffuseColor = Color3.Black()
  mat.specularColor = Color3.Black()
  mat.backFaceCulling = false
  mesh.material = mat

  return { mesh, width: maxWidth * SCALE, height: rows * SCALE, triangles: triCount }
}
