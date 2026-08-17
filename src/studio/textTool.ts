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
 * under the SPEC <120-tri budget for short labels.
 *
 * Babylon port of the old Three.js createTextObject flat-mesh branch.
 */

const PIXEL = 16 // Unifont em-square
const SCALE = 0.07
const FAMILY = 'UnifontSubset, monospace'

let fontReady: Promise<void> | null = null

/** Load the embedded subset font so the first frame is correct. */
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

function measureLine(ctx: CanvasRenderingContext2D, line: string): number {
  ctx.font = `${PIXEL}px ${FAMILY}`
  return Math.max(1, Math.ceil(ctx.measureText(line || ' ').width))
}

export interface TextMeshResult { mesh: Mesh; width: number; height: number; triangles: number }

export async function buildTextMesh(
  scene: Scene,
  text: string,
  color = '#FF5C35',
  align: 'left' | 'center' | 'right' = 'center',
): Promise<TextMeshResult> {
  await ensureTextFont()

  const lines = String(text || '/0').replace(/\r/g, '').split('\n').slice(0, 4)
  const probe = document.createElement('canvas').getContext('2d')!
  probe.textBaseline = 'top'
  const colCounts = lines.map((l) => measureLine(probe, l))
  const cols = Math.max(1, ...colCounts)
  const rows = lines.length * PIXEL

  const canvas = document.createElement('canvas')
  canvas.width = cols
  canvas.height = rows
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.clearRect(0, 0, cols, rows)
  ctx.fillStyle = '#fff'
  ctx.font = `${PIXEL}px ${FAMILY}`
  ctx.textBaseline = 'top'
  lines.forEach((line, i) => {
    let x = 0
    if (align === 'center') x = Math.round((cols - measureLine(ctx, line)) / 2)
    else if (align === 'right') x = cols - measureLine(ctx, line)
    ctx.fillText(line || ' ', x, i * PIXEL)
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

  // Precompute per-line x offsets for alignment, so we can mirror within the line
  // and keep left/center/right placement stable (otherwise a global cols/2 - x
  // flips right-aligned to left). The bug was a left-right mirror from seeing
  // the plane from -Z; mirroring each run inside its line fixes readability
  // while preserving alignment.
  const lineOffsets: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const w = colCounts[i] ?? 0
    let off = 0
    if (align === 'center') off = Math.round((cols - w) / 2)
    else if (align === 'right') off = cols - w
    lineOffsets.push(off)
  }

  const positions: number[] = []
  const indices: number[] = []
  let v = 0
  for (const r of runs) {
    const lineIdx = Math.min(lines.length - 1, Math.max(0, Math.floor(r.y / PIXEL)))
    const w = colCounts[lineIdx] ?? cols
    const off = lineOffsets[lineIdx] ?? 0
    // mirror within the line's own box [off, off+w)
    const mx0 = 2 * off + w - r.x1
    const mx1 = 2 * off + w - r.x0
    const x0 = (mx0 - cols / 2) * SCALE
    const x1 = (mx1 - cols / 2) * SCALE
    const topY = (rows / 2 - r.y) * SCALE
    const botY = topY - SCALE
    positions.push(x0, topY, 0, x1, topY, 0, x1, botY, 0, x0, botY, 0)
    indices.push(v, v + 1, v + 2, v, v + 2, v + 3)
    v += 4
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

  return { mesh, width: cols * SCALE, height: rows * SCALE, triangles: runs.length * 2 }
}
