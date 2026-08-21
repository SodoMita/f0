import { GRID, stampRadius, type Stamp } from './types'

/** Spatial hash: cell → stamp ids. Cell size = GRID (snapping unit). */
export class SpatialHash {
  private readonly cells = new Map<string, number[]>()
  private readonly where = new Map<number, string[]>()

  constructor(readonly cell = GRID) {}

  clear(): void {
    this.cells.clear()
    this.where.clear()
  }

  insert(s: Stamp): void {
    this.remove(s.id)
    const keys = this.keysFor(s)
    this.where.set(s.id, keys)
    for (const k of keys) {
      const list = this.cells.get(k)
      if (list) list.push(s.id)
      else this.cells.set(k, [s.id])
    }
  }

  remove(id: number): void {
    const keys = this.where.get(id)
    if (!keys) return
    this.where.delete(id)
    for (const k of keys) {
      const list = this.cells.get(k)
      if (!list) continue
      const at = list.indexOf(id)
      if (at >= 0) {
        list[at] = list[list.length - 1]
        list.pop()
      }
      if (list.length === 0) this.cells.delete(k)
    }
  }

  /** Stamp ids whose cells overlap the query sphere. */
  query(x: number, y: number, z: number, radius: number): number[] {
    const seen = new Set<number>()
    const out: number[] = []
    const c = this.cell
    const ix0 = Math.floor((x - radius) / c)
    const iy0 = Math.floor((y - radius) / c)
    const iz0 = Math.floor((z - radius) / c)
    const ix1 = Math.floor((x + radius) / c)
    const iy1 = Math.floor((y + radius) / c)
    const iz1 = Math.floor((z + radius) / c)
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const list = this.cells.get(cellKey(ix, iy, iz))
          if (!list) continue
          for (const id of list) {
            if (seen.has(id)) continue
            seen.add(id)
            out.push(id)
          }
        }
      }
    }
    return out
  }

  idsInCell(ix: number, iy: number, iz: number): readonly number[] {
    return this.cells.get(cellKey(ix, iy, iz)) ?? EMPTY
  }

  private keysFor(s: Stamp): string[] {
    const r = stampRadius(s)
    const c = this.cell
    const ix0 = Math.floor((s.px - r) / c)
    const iy0 = Math.floor((s.py - r) / c)
    const iz0 = Math.floor((s.pz - r) / c)
    const ix1 = Math.floor((s.px + r) / c)
    const iy1 = Math.floor((s.py + r) / c)
    const iz1 = Math.floor((s.pz + r) / c)
    const keys: string[] = []
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let iz = iz0; iz <= iz1; iz++) keys.push(cellKey(ix, iy, iz))
      }
    }
    return keys
  }
}

const EMPTY: readonly number[] = []

export function cellKey(ix: number, iy: number, iz: number): string {
  return ix + ',' + iy + ',' + iz
}
