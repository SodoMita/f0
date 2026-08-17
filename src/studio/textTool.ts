import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import type { Scene } from '@babylonjs/core/scene'

/**
 * Low-poly typed text.
 *
 * Uses the embedded UnifontSubset pixel font (loaded via @font-face),
 * rasterized at the font's native 16px cell and tessellated to one quad
 * (2 triangles) per covered pixel. Adjacent pixels on the same row are
 * run-length merged into one rectangle so even a full line stays well
 * under the SPEC <120-tri budget for short labels (without extrusion).
 *
 * Now supports:
 * - unlimited lines / chars (limits removed)
 * - newline via \n (textarea)
 * - scale, letterSpacing, lineSpacing, depth (extrusion)
 * - mirrored fix for -Z camera + alignment-preserving
 */

const PIXEL = 16 // Unifont em-square
const BASE_SCALE = 0.07
const FAMILY = 'UnifontSubset, monospace'

let fontReady: Promise<void> | null = null

export function ensureTextFont(): Promise<void> {
  if (fontReady) return fontReady
  fontReady = (async () => {
    const fonts = (document as any).fonts
    if (fonts && typeof fonts.load === 'function') {
      try { await fonts.load(`${PIXEL}px UnifontSubset`); await fonts.ready } catch { /* monospace fallback */ }
    }
  })()
  return fontReady
}

function measureChar(ctx: CanvasRenderingContext2D, ch: string): number {
  // measure single char; fallback to 8px if tofu
  const m = ctx.measureText(ch || ' ')
  return Math.max(1, Math.ceil(m.width))
}

function measureLineWithSpacing(ctx: CanvasRenderingContext2D, line: string, letterSpacing: number): number {
  if (!line) return Math.max(1, Math.ceil(ctx.measureText(' ').width))
  let w = 0
  const chars = [...line] // spread handles unicode
  for (let i = 0; i < chars.length; i++) {
    w += measureChar(ctx, chars[i])
    if (i < chars.length - 1) w += letterSpacing
  }
  return Math.max(1, w)
}

export interface TextMeshResult { mesh: Mesh; width: number; height: number; triangles: number }

export interface TextBuildOptions {
  color?: string
  align?: 'left' | 'center' | 'right'
  scale?: number // multiplier of BASE_SCALE, default 1
  letterSpacing?: number // extra pixels between chars, default 0
  lineSpacing?: number // multiplier of PIXEL, default 1
  depth?: number // extrusion depth in world units, default 0
}

type LegacyColor = string
type LegacyAlign = 'left' | 'center' | 'right'

// overloads for backward compat
export async function buildTextMesh(scene: Scene, text: string, color: string, align: 'left' | 'center' | 'right'): Promise<TextMeshResult>
export async function buildTextMesh(scene: Scene, text: string, opts?: TextBuildOptions): Promise<TextMeshResult>
export async function buildTextMesh(
  scene: Scene,
  text: string,
  colorOrOpts?: LegacyColor | TextBuildOptions,
  alignMaybe?: LegacyAlign,
): Promise<TextMeshResult> {
  await ensureTextFont()

  // normalize options
  let opts: TextBuildOptions = {}
  if (typeof colorOrOpts === 'string') {
    opts.color = colorOrOpts
    if (alignMaybe) opts.align = alignMaybe
  } else if (colorOrOpts && typeof colorOrOpts === 'object') {
    opts = colorOrOpts
  }
  const color = opts.color ?? '#FF5C35'
  const align = opts.align ?? 'center'
  const scaleMul = opts.scale ?? 1
  const letterSpacing = opts.letterSpacing ?? 0
  const lineSpacing = opts.lineSpacing ?? 1
  const depth = opts.depth ?? 0

  const raw = String(text ?? '')
  // keep all lines, no limit; trim only trailing empty lines? Keep as is but avoid huge empty tail
  const lines = raw.replace(/\r/g, '').split('\n')
  // if empty, keep one empty line to have a placeholder?
  if (lines.length === 0) lines.push('')

  const probe = document.createElement('canvas').getContext('2d')!
  probe.textBaseline = 'top'
  probe.font = `${PIXEL}px ${FAMILY}`

  const colCounts = lines.map((l) => measureLineWithSpacing(probe, l, letterSpacing))
  const cols = Math.max(1, ...colCounts)
  const lineH = Math.max(1, Math.round(PIXEL * lineSpacing))
  const rows = Math.max(1, lines.length * lineH)

  const canvas = document.createElement('canvas')
  canvas.width = cols
  canvas.height = rows
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.clearRect(0, 0, cols, rows)
  ctx.fillStyle = '#fff'
  ctx.font = `${PIXEL}px ${FAMILY}`
  ctx.textBaseline = 'top'

  lines.forEach((line, i) => {
    const lineW = measureLineWithSpacing(ctx, line, letterSpacing)
    let x = 0
    if (align === 'center') x = Math.round((cols - lineW) / 2)
    else if (align === 'right') x = cols - lineW
    // draw char by char with spacing
    const chars = [...line]
    let cursor = x
    for (let ci = 0; ci < chars.length; ci++) {
      const ch = chars[ci]
      // for space, still advance but don't need to fill? fillText(' ') does nothing, but we still keep run empty
      if (ch !== ' ') ctx.fillText(ch, cursor, i * lineH)
      else {
        // ensure space is still considered empty for run detection (it is transparent)
        // we don't draw, but width still counts
      }
      cursor += measureChar(ctx, ch) + (ci < chars.length - 1 ? letterSpacing : 0)
    }
    // if line empty, nothing to draw (keeps placeholder)
  })

  const data = ctx.getImageData(0, 0, cols, rows).data

  type Run = { x0: number; x1: number; y: number }
  const runs: Run[] = []
  for (let y = 0; y < rows; y++) {
    let start = -1
    for (let x = 0; x <= cols; x++) {
      const filled = x < cols && data[(y * cols + x) * 4 + 3] > 24
      if (filled && start < 0) start = x
      if ((!filled || x === cols) && start >= 0) {
        runs.push({ x0: start, x1: x, y })
        start = -1
      }
    }
  }

  // per-line offsets for alignment mirroring
  const lineOffsets: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const w = colCounts[i] ?? 0
    let off = 0
    if (align === 'center') off = Math.round((cols - w) / 2)
    else if (align === 'right') off = cols - w
    lineOffsets.push(off)
  }

  const SCALE = BASE_SCALE * scaleMul
  const positions: number[] = []
  const indices: number[] = []
  let v = 0

  const hasDepth = depth > 0.0001

  for (const r of runs) {
    const lineIdx = Math.min(lines.length - 1, Math.max(0, Math.floor(r.y / lineH)))
    const w = colCounts[lineIdx] ?? cols
    const off = lineOffsets[lineIdx] ?? 0
    // mirror within line's own box [off, off+w)
    const mx0 = 2 * off + w - r.x1
    const mx1 = 2 * off + w - r.x0
    const x0 = (mx0 - cols / 2) * SCALE
    const x1 = (mx1 - cols / 2) * SCALE
    const topY = (rows / 2 - r.y) * SCALE
    const botY = topY - SCALE

    if (!hasDepth) {
      positions.push(x0, topY, 0, x1, topY, 0, x1, botY, 0, x0, botY, 0)
      indices.push(v, v + 1, v + 2, v, v + 2, v + 3)
      v += 4
    } else {
      const d = depth
      // 8 vertices: 0-3 front (z=0), 4-7 back (z=-d)
      positions.push(
        x0, topY, 0,
        x1, topY, 0,
        x1, botY, 0,
        x0, botY, 0,
        x0, topY, -d,
        x1, topY, -d,
        x1, botY, -d,
        x0, botY, -d,
      )
      // front
      indices.push(v, v + 1, v + 2, v, v + 2, v + 3)
      // back (reversed)
      indices.push(v + 4, v + 6, v + 5, v + 4, v + 7, v + 6)
      // top
      indices.push(v, v + 4, v + 5, v, v + 5, v + 1)
      // right
      indices.push(v + 1, v + 5, v + 6, v + 1, v + 6, v + 2)
      // bottom
      indices.push(v + 2, v + 6, v + 7, v + 2, v + 7, v + 3)
      // left
      indices.push(v + 3, v + 7, v + 4, v + 3, v + 4, v)
      v += 8
    }
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

  const triFactor = hasDepth ? 12 : 2
  return { mesh, width: cols * SCALE, height: rows * SCALE, triangles: runs.length * triFactor }
}
