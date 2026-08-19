/**
 * Amanatides–Woo 3D grid DDA. Technique for walking a ray through grid
 * cells in O(cells crossed) — used for eraser / surface hit tests.
 * Using a grid traversal does NOT make this a voxel editor.
 */
export function walkGrid(
  origin: readonly [number, number, number],
  dir: readonly [number, number, number],
  cell: number,
  maxDist: number,
  visit: (ix: number, iy: number, iz: number, tEnter: number) => boolean,
): void {
  const len = Math.hypot(dir[0], dir[1], dir[2])
  const ox = origin[0], oy = origin[1], oz = origin[2]
  if (len < 1e-12 || cell <= 0) {
    visit(Math.floor(ox / cell), Math.floor(oy / cell), Math.floor(oz / cell), 0)
    return
  }
  const dx = dir[0] / len, dy = dir[1] / len, dz = dir[2] / len
  let ix = Math.floor(ox / cell)
  let iy = Math.floor(oy / cell)
  let iz = Math.floor(oz / cell)
  const stepX = dx >= 0 ? 1 : -1
  const stepY = dy >= 0 ? 1 : -1
  const stepZ = dz >= 0 ? 1 : -1
  const tDeltaX = dx === 0 ? Infinity : Math.abs(cell / dx)
  const tDeltaY = dy === 0 ? Infinity : Math.abs(cell / dy)
  const tDeltaZ = dz === 0 ? Infinity : Math.abs(cell / dz)
  const first = (i: number, step: number, o: number, d: number): number => {
    if (d === 0) return Infinity
    const boundary = (step > 0 ? i + 1 : i) * cell
    return (boundary - o) / d
  }
  let tMaxX = first(ix, stepX, ox, dx)
  let tMaxY = first(iy, stepY, oy, dy)
  let tMaxZ = first(iz, stepZ, oz, dz)
  let t = 0
  // Hard cap so a degenerate ray cannot loop forever.
  const maxSteps = Math.max(4, Math.ceil(maxDist / cell) + 3)
  for (let n = 0; n < maxSteps && t <= maxDist; n++) {
    if (!visit(ix, iy, iz, t)) return
    if (tMaxX < tMaxY) {
      if (tMaxX < tMaxZ) { ix += stepX; t = tMaxX; tMaxX += tDeltaX }
      else { iz += stepZ; t = tMaxZ; tMaxZ += tDeltaZ }
    } else if (tMaxY < tMaxZ) {
      iy += stepY; t = tMaxY; tMaxY += tDeltaY
    } else {
      iz += stepZ; t = tMaxZ; tMaxZ += tDeltaZ
    }
  }
}

export function rayPlane(
  origin: readonly [number, number, number],
  dir: readonly [number, number, number],
  point: readonly [number, number, number],
  normal: readonly [number, number, number],
): [number, number, number] | null {
  const denom = dir[0] * normal[0] + dir[1] * normal[1] + dir[2] * normal[2]
  if (Math.abs(denom) < 1e-8) return null
  const t = (
    (point[0] - origin[0]) * normal[0] +
    (point[1] - origin[1]) * normal[1] +
    (point[2] - origin[2]) * normal[2]
  ) / denom
  if (t < 0) return null
  return [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t]
}
