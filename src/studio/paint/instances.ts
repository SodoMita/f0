import { Scene } from '@babylonjs/core/scene'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { SHAPES, STRIDE, type ShapeKind, type Stamp } from './types'
import { createPaintShapeMesh } from './shapes'
import type { StampStore } from './store'

const NAME = 'studio-paint-'

/**
 * One thin-instance source mesh per shape. Buffers rebuilt from the store
 * once per dirty flush (coalesced — never per-stamp draw calls).
 */
export class PaintInstances {
  readonly meshes = new Map<ShapeKind, Mesh>()
  private dirty = true
  /** Stamps per shape that have already been uploaded to the GPU. Used by
   *  `appendNew` to flush only the delta during a stroke (old path rebuilt
   *  the entire matrix+color buffer every frame, scaling O(N) per frame
   *  — at a few hundred stamps the studio became unworkable). */
  private flushedPerShape: Record<ShapeKind, number> = emptyShapeCounts()
  private readonly tmpS = new Vector3()
  private readonly tmpP = new Vector3()
  private readonly tmpQ = new Quaternion()
  private readonly tmpM = new Matrix()
  private matrices: Record<ShapeKind, Float32Array>
  private colors: Record<ShapeKind, Float32Array>

  constructor(private readonly scene: Scene) {
    const mat = new StandardMaterial('studio-paint-mat', scene)
    // Lights-only rig (no IBL). Emissive keeps ink readable; instance
    // colour tints both channels so each stamp keeps its own ink.
    mat.diffuseColor = Color3.White()
    mat.emissiveColor = new Color3(0.55, 0.55, 0.55)
    mat.specularColor = Color3.Black()
    mat.backFaceCulling = false
    mat.alpha = 1

    const mk = (name: string, mesh: Mesh): Mesh => {
      mesh.name = NAME + name
      mesh.material = mat
      mesh.isPickable = true
      mesh.thinInstanceEnablePicking = true
      mesh.alwaysSelectAsActiveMesh = true
      mesh.thinInstanceCount = 0
      mesh.isVisible = true
      return mesh
    }
    for (const shape of SHAPES) {
      this.meshes.set(shape, mk(shape, createPaintShapeMesh(shape, scene)))
    }

    this.matrices = emptyBuf()
    this.colors = emptyBuf()
  }

  isSource(m: Mesh | { name?: string } | null): boolean {
    return !!m && typeof m.name === 'string' && m.name.startsWith(NAME)
  }

  sourceMeshes(): Mesh[] { return [...this.meshes.values()] }

  markDirty(): void { this.dirty = true }
  /** Expose dirty flag so session's observer can route to incremental vs full. */
  get isDirty(): boolean { return this.dirty }

  /**
   * Incremental GPU upload during a stroke. Walks only the new stamps
   * added since `startStampCount`, writes them directly into the tail
   * of the per-shape Float32Arrays, and pushes the changes to the GPU.
   * O(Δ) per call instead of O(N) full rebuild.
   *
   * Called once per render frame by the session's onBeforeRender hook.
   */
  appendNew(store: StampStore, startStampCount: number): void {
    if (startStampCount >= store.count) return
    const touched = new Set<ShapeKind>()
    for (let i = startStampCount; i < store.count; i++) {
      const s = store.at(i)
      const shape = s.shape
      const prevN = this.flushedPerShape[shape]
      const slot = prevN
      let mats = this.matrices[shape]
      let cols = this.colors[shape]
      // Grow if needed. First-time use: capacity 64; thereafter double.
      if (mats.length <= slot * 16) {
        const newCap = slot === 0 ? 64 : Math.max(slot * 2, slot + 16)
        const newMats = new Float32Array(newCap * 16)
        if (mats.length > 0) newMats.set(mats.subarray(0, prevN * 16))
        const newCols = new Float32Array(newCap * 4)
        if (cols.length > 0) newCols.set(cols.subarray(0, prevN * 4))
        this.matrices[shape] = newMats
        this.colors[shape] = newCols
        mats = newMats
        cols = newCols
        const mesh = this.meshes.get(shape)!
        mesh.thinInstanceSetBuffer('matrix', mats, 16, false)
        mesh.thinInstanceSetBuffer('color', cols, 4, false)
      }
      // Compose + write the new stamp directly.
      this.tmpS.set(s.sx, s.sy, s.sz)
      this.tmpQ.set(s.qx, s.qy, s.qz, s.qw)
      this.tmpP.set(s.px, s.py, s.pz)
      Matrix.ComposeToRef(this.tmpS, this.tmpQ, this.tmpP, this.tmpM)
      mats.set(this.tmpM.m, slot * 16)
      const o = slot * 4
      cols[o] = s.r; cols[o + 1] = s.g; cols[o + 2] = s.b; cols[o + 3] = s.a
      this.flushedPerShape[shape] = slot + 1
      touched.add(shape)
    }
    // Push touched shapes to GPU — thinInstanceBufferUpdated calls
    // buffer.updateDirectly on the updatable buffer, O(totalStampCount) bytes
    // per upload but no JS-side rebuild.
    for (const shape of touched) {
      const mesh = this.meshes.get(shape)!
      mesh.thinInstanceCount = this.flushedPerShape[shape]
      mesh.isVisible = true
      mesh.thinInstanceBufferUpdated('matrix')
      mesh.thinInstanceBufferUpdated('color')
    }
  }

  flush(store: StampStore): void {
    if (!this.dirty) return
    this.dirty = false
    const buckets = emptyShapeBuckets()
    for (let i = 0; i < store.count; i++) {
      const s = store.at(i)
      buckets[s.shape].push(s)
    }
    for (const shape of SHAPES) {
      const list = buckets[shape]
      const mesh = this.meshes.get(shape)!
      const n = list.length
      if (n === 0) {
        mesh.thinInstanceCount = 0
        mesh.isVisible = false
        continue
      }
      mesh.isVisible = true
      let mats = this.matrices[shape]
      let cols = this.colors[shape]
      if (mats.length < n * 16) {
        mats = new Float32Array(nextPow2(n) * 16)
        this.matrices[shape] = mats
      }
      if (cols.length < n * 4) {
        cols = new Float32Array(nextPow2(n) * 4)
        this.colors[shape] = cols
      }
      for (let i = 0; i < n; i++) {
        const s = list[i]
        this.tmpS.set(s.sx, s.sy, s.sz)
        this.tmpQ.set(s.qx, s.qy, s.qz, s.qw)
        this.tmpP.set(s.px, s.py, s.pz)
        Matrix.ComposeToRef(this.tmpS, this.tmpQ, this.tmpP, this.tmpM)
        mats.set(this.tmpM.m, i * 16)
        const o = i * 4
        cols[o] = s.r; cols[o + 1] = s.g; cols[o + 2] = s.b; cols[o + 3] = s.a
      }
      mesh.thinInstanceSetBuffer('matrix', mats, 16, false)
      mesh.thinInstanceSetBuffer('color', cols, 4, false)
      mesh.thinInstanceCount = n
      mesh.thinInstanceRefreshBoundingInfo(false, false)
      this.flushedPerShape[shape] = n
    }
  }

  dispose(): void {
    for (const m of this.meshes.values()) m.dispose(false, true)
    this.meshes.clear()
  }
}

function emptyBuf(): Record<ShapeKind, Float32Array> {
  return Object.fromEntries(SHAPES.map((shape) => [shape, new Float32Array(0)])) as Record<ShapeKind, Float32Array>
}

function emptyShapeCounts(): Record<ShapeKind, number> {
  return Object.fromEntries(SHAPES.map((shape) => [shape, 0])) as Record<ShapeKind, number>
}

function emptyShapeBuckets(): Record<ShapeKind, Stamp[]> {
  return Object.fromEntries(SHAPES.map((shape) => [shape, [] as Stamp[]])) as unknown as Record<ShapeKind, Stamp[]>
}

function nextPow2(n: number): number {
  let c = 16
  while (c < n) c *= 2
  return c
}

export { STRIDE }
