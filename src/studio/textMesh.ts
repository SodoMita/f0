import {
  Mesh,
  StandardMaterial,
  Color3,
  VertexData,
  Scene,
} from '@babylonjs/core'

/**
 * Lowest-poly text using the embedded UnifontSubset pixel font.
 *
 * Each line is rasterized with a 2D canvas at the font's native 16px cell
 * size, then every covered pixel becomes one quad (2 triangles). At depth 0
 * this is a single double-sided plane — the minimum geometry that can show
 * the glyph. No ExtrudeGeometry, no bevel, no per-curve tessellation.
 */
const PIXEL = 16 // Unifont em-square
const SCALE = 0.07

export interface TextMeshResult {
  mesh: Mesh
  width: number
  height: number
}

function measureLine(ctx: CanvasRenderingContext2D, line: string): number {
  return Math.ceil(ctx.measureText(line || ' ').width)
}

export function buildTextMesh(
  scene: Scene,
  text: string,
  color: string,
  align: 'left' | 'center' | 'right' = 'center',
): TextMeshResult {
  const lines = String(text || '/0').split('\n').slice(0, 4)
  const off = document.createElement('canvas').getContext('2d')!
  off.font = `${PIXEL}px UnifontSubset, monospace`
  off.textBaseline = 'top'

  const colCounts = lines.map((l) => measureLine(off, l))
  const cols = Math.max(1, ...colCounts)
  const rows = lines.length * PIXEL

  // Rasterize all lines into one grid.
  const canvas = document.createElement('canvas')
  canvas.width = cols
  canvas.height = rows
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.clearRect(0, 0, cols, rows)
  ctx.fillStyle = '#fff'
  ctx.font = `${PIXEL}px UnifontSubset, monospace`
  ctx.textBaseline = 'top'
  lines.forEach((line, i) => {
    let x = 0
    if (align === 'center') x = Math.round((cols - measureLine(ctx, line)) / 2)
    else if (align === 'right') x = cols - measureLine(ctx, line)
    ctx.fillText(line || ' ', x, i * PIXEL)
  })

  const data = ctx.getImageData(0, 0, cols, rows).data
  const covered: boolean[] = new Array(cols * rows)
  for (let p = 0, i = 0; p < data.length; p += 4, i += 1) covered[i] = data[p + 3] > 24

  // Emit one quad per covered pixel, merged into a single mesh.
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  let v = 0
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      if (!covered[y * cols + x]) continue
      const x0 = x - cols / 2
      const y0 = -(y - rows / 2)
      positions.push(x0, y0, 0, x0 + 1, y0, 0, x0 + 1, y0 - 1, 0, x0, y0 - 1, 0)
      uvs.push(0, 1, 1, 1, 1, 0, 0, 0)
      indices.push(v, v + 1, v + 2, v, v + 2, v + 3)
      v += 4
    }
  }

  for (let i = 0; i < positions.length; i += 3) {
    positions[i] *= SCALE
    positions[i + 1] *= SCALE
  }

  const mesh = new Mesh('text-mesh', scene)
  const vd = new VertexData()
  vd.positions = positions
  vd.uvs = uvs
  vd.indices = indices
  vd.applyToMesh(mesh)

  const mat = new StandardMaterial('text-mat', scene)
  mat.emissiveColor = Color3.FromHexString(color)
  mat.diffuseColor = Color3.Black()
  mat.specularColor = Color3.Black()
  mat.backFaceCulling = false
  mesh.material = mat
  mesh.hasVertexAlpha = false

  return { mesh, width: cols * SCALE, height: rows * SCALE }
}

/** Loads the embedded Unifont subset so the very first frame is ready. */
export async function ensureFontReady(): Promise<void> {
  if ((document as any).fonts && (document as any).fonts.load) {
    try {
      await (document as any).fonts.load(`${PIXEL}px UnifontSubset`)
      await (document as any).fonts.ready
    } catch {
      /* monospace fallback is acceptable */
    }
  }
}
