import {
  MAX_STAMPS, SHAPE_FROM_ID, SHAPE_ID, STRIDE,
  OFF_PX, OFF_QX, OFF_SX, OFF_R, OFF_SHAPE,
  type ShapeKind, type Stamp,
} from './types'

/**
 * Packed stamp store. Source of truth for the paint editor.
 * Delete is swap-with-last + shrink (spec 05 §8) so thin-instance buffers
 * stay contiguous. Never dedupes by cell — stamps freely overlap.
 */
export class StampStore {
  private data: Float32Array
  private ids: Uint32Array
  private _count = 0
  private _nextId = 1
  private readonly indexOf = new Map<number, number>()

  constructor(capacity = 1024) {
    const cap = Math.max(16, capacity)
    this.data = new Float32Array(cap * STRIDE)
    this.ids = new Uint32Array(cap)
  }

  get count(): number { return this._count }

  at(i: number): Stamp {
    const o = i * STRIDE
    const d = this.data
    const shape = SHAPE_FROM_ID[d[o + OFF_SHAPE] | 0] ?? 'cube'
    return {
      id: this.ids[i],
      shape,
      px: d[o + OFF_PX], py: d[o + OFF_PX + 1], pz: d[o + OFF_PX + 2],
      qx: d[o + OFF_QX], qy: d[o + OFF_QX + 1], qz: d[o + OFF_QX + 2], qw: d[o + OFF_QX + 3],
      sx: d[o + OFF_SX], sy: d[o + OFF_SX + 1], sz: d[o + OFF_SX + 2],
      r: d[o + OFF_R], g: d[o + OFF_R + 1], b: d[o + OFF_R + 2], a: d[o + OFF_R + 3],
    }
  }

  get(id: number): Stamp | null {
    const i = this.indexOf.get(id)
    return i === undefined ? null : this.at(i)
  }

  indexOfId(id: number): number { return this.indexOf.get(id) ?? -1 }

  add(partial: Omit<Stamp, 'id'> & { id?: number }): Stamp {
    if (this._count >= MAX_STAMPS) throw new Error('paint stamp budget')
    this.ensure(this._count + 1)
    const id = partial.id ?? this._nextId++
    if (partial.id !== undefined && partial.id >= this._nextId) this._nextId = partial.id + 1
    const i = this._count++
    this.ids[i] = id
    this.indexOf.set(id, i)
    this.write(i, id, partial)
    return this.at(i)
  }

  /** Swap-last delete. Returns the removed stamp, or null. */
  removeId(id: number): Stamp | null {
    const i = this.indexOf.get(id)
    if (i === undefined) return null
    const removed = this.at(i)
    const last = this._count - 1
    if (i !== last) {
      this.data.copyWithin(i * STRIDE, last * STRIDE, (last + 1) * STRIDE)
      const movedId = this.ids[last]
      this.ids[i] = movedId
      this.indexOf.set(movedId, i)
    }
    this.indexOf.delete(id)
    this._count = last
    return removed
  }

  removeIds(ids: Iterable<number>): Stamp[] {
    const out: Stamp[] = []
    for (const id of ids) {
      const s = this.removeId(id)
      if (s) out.push(s)
    }
    return out
  }

  setTransform(id: number, px: number, py: number, pz: number, qx: number, qy: number, qz: number, qw: number, sx: number, sy: number, sz: number): boolean {
    const i = this.indexOf.get(id)
    if (i === undefined) return false
    const o = i * STRIDE
    const d = this.data
    d[o + OFF_PX] = px; d[o + OFF_PX + 1] = py; d[o + OFF_PX + 2] = pz
    d[o + OFF_QX] = qx; d[o + OFF_QX + 1] = qy; d[o + OFF_QX + 2] = qz; d[o + OFF_QX + 3] = qw
    d[o + OFF_SX] = sx; d[o + OFF_SX + 1] = sy; d[o + OFF_SX + 2] = sz
    return true
  }

  setColor(id: number, r: number, g: number, b: number, a: number): boolean {
    const i = this.indexOf.get(id)
    if (i === undefined) return false
    const o = i * STRIDE + OFF_R
    this.data[o] = r; this.data[o + 1] = g; this.data[o + 2] = b; this.data[o + 3] = a
    return true
  }

  clear(): void {
    this._count = 0
    this.indexOf.clear()
  }

  /** Snapshot every stamp — used by tests and full-store mementos. */
  toArray(): Stamp[] {
    const out: Stamp[] = []
    for (let i = 0; i < this._count; i++) out.push(this.at(i))
    return out
  }

  private write(i: number, _id: number, s: Omit<Stamp, 'id'>): void {
    const o = i * STRIDE
    const d = this.data
    d[o + OFF_PX] = s.px; d[o + OFF_PX + 1] = s.py; d[o + OFF_PX + 2] = s.pz
    d[o + OFF_QX] = s.qx; d[o + OFF_QX + 1] = s.qy; d[o + OFF_QX + 2] = s.qz; d[o + OFF_QX + 3] = s.qw
    d[o + OFF_SX] = s.sx; d[o + OFF_SX + 1] = s.sy; d[o + OFF_SX + 2] = s.sz
    d[o + OFF_R] = s.r; d[o + OFF_R + 1] = s.g; d[o + OFF_R + 2] = s.b; d[o + OFF_R + 3] = s.a
    d[o + OFF_SHAPE] = SHAPE_ID[s.shape] ?? 0
    d[o + OFF_SHAPE + 1] = 0
  }

  private ensure(n: number): void {
    if (n * STRIDE <= this.data.length) return
    let cap = this.data.length / STRIDE
    while (cap < n) cap *= 2
    const next = new Float32Array(cap * STRIDE)
    next.set(this.data)
    this.data = next
    const nextIds = new Uint32Array(cap)
    nextIds.set(this.ids)
    this.ids = nextIds
  }
}

export function stampFromParts(
  shape: ShapeKind,
  px: number, py: number, pz: number,
  qx: number, qy: number, qz: number, qw: number,
  sx: number, sy: number, sz: number,
  r: number, g: number, b: number, a: number,
): Omit<Stamp, 'id'> {
  return { shape, px, py, pz, qx, qy, qz, qw, sx, sy, sz, r, g, b, a }
}
