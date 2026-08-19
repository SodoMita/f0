/**
 * Ink path: pressure → width/alpha, path smoothing, stamp spacing.
 * Stamps along a smoothed polyline — never raw event positions.
 */

export interface InkPoint {
  x: number
  y: number
  z: number
  pressure: number
  t: number
}

export function effectivePressure(raw: number, pointerType: string): number {
  // Mouse typically reports 0.5 while down / 0 while up. Treat those as a
  // constant mid-press so letters don't collapse to dots.
  if (pointerType === 'mouse' || raw <= 0) return 0.72
  return Math.min(1, Math.max(0.06, raw))
}

export function widthFromPressure(pressure: number, base: number): number {
  return base * (0.32 + 0.68 * pressure)
}

export function alphaFromPressure(pressure: number, base = 1): number {
  return base * (0.42 + 0.58 * pressure)
}

export function speedTaper(dist: number, dtMs: number): number {
  const speed = dist / Math.max(1, dtMs) // world-units per ms
  return 1 / (1 + speed * 10)
}

/** 3-point moving average. Keeps endpoints so letterforms stay sharp. */
export function smoothPath(pts: InkPoint[], window = 3): InkPoint[] {
  if (pts.length < 3 || window < 2) return pts.slice()
  const out: InkPoint[] = [pts[0]]
  const half = Math.max(1, Math.floor(window / 2))
  for (let i = 1; i < pts.length - 1; i++) {
    let x = 0, y = 0, z = 0, p = 0, t = 0, n = 0
    const a = Math.max(0, i - half)
    const b = Math.min(pts.length - 1, i + half)
    for (let k = a; k <= b; k++) {
      x += pts[k].x; y += pts[k].y; z += pts[k].z
      p += pts[k].pressure; t += pts[k].t
      n++
    }
    out.push({ x: x / n, y: y / n, z: z / n, pressure: p / n, t: t / n })
  }
  out.push(pts[pts.length - 1])
  return out
}

export function lerpPoint(a: InkPoint, b: InkPoint, u: number): InkPoint {
  return {
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    z: a.z + (b.z - a.z) * u,
    pressure: a.pressure + (b.pressure - a.pressure) * u,
    t: a.t + (b.t - a.t) * u,
  }
}

/**
 * Walk a polyline emitting stamps every `spacing` units. `carry` is leftover
 * distance from the previous chunk (so coalesced-event batches stay gapless).
 */
export function stampAlong(
  pts: InkPoint[],
  spacing: number,
  carry: number,
): { emitted: InkPoint[]; carry: number } {
  const space = Math.max(1e-4, spacing)
  if (pts.length < 2) return { emitted: [], carry }
  const emitted: InkPoint[] = []
  let acc = carry
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
    const len = Math.hypot(dx, dy, dz)
    if (len < 1e-8) continue
    let walked = 0
    while (acc + (len - walked) >= space) {
      const need = space - acc
      walked += need
      emitted.push(lerpPoint(a, b, walked / len))
      acc = 0
    }
    acc += len - walked
  }
  return { emitted, carry: acc }
}

export function tangentAt(a: InkPoint, b: InkPoint): [number, number, number] {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
  const len = Math.hypot(dx, dy, dz)
  if (len < 1e-8) return [1, 0, 0]
  return [dx / len, dy / len, dz / len]
}
