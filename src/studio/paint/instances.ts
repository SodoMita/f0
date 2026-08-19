import { Scene } from '@babylonjs/core/scene'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder'
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder'
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder'
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder'
import { CreatePolyhedron } from '@babylonjs/core/Meshes/Builders/polyhedronBuilder'
import { SHAPES, STRIDE, type ShapeKind, type Stamp } from './types'
import type { StampStore } from './store'

const NAME = 'studio-paint-'

/**
 * One thin-instance source mesh per shape. Buffers rebuilt from the store
 * once per dirty flush (coalesced — never per-stamp draw calls).
 */
export class PaintInstances {
  readonly meshes = new Map<ShapeKind, Mesh>()
  private dirty = true
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
    this.meshes.set('cube', mk('cube', CreateBox('p-cube', { size: 1 }, scene)))
    this.meshes.set('sphere', mk('sphere', CreateSphere('p-sphere', { diameter: 1, segments: 8 }, scene)))
    this.meshes.set('cylinder', mk('cylinder', CreateCylinder('p-cyl', { height: 1, diameter: 1, tessellation: 8 }, scene)))
    this.meshes.set('tetra', mk('tetra', CreatePolyhedron('p-tetra', { type: 0, size: 0.5 }, scene)))
    this.meshes.set('quad', mk('quad', CreatePlane('p-quad', { size: 1 }, scene)))

    this.matrices = emptyBuf()
    this.colors = emptyBuf()
  }

  isSource(m: Mesh | { name?: string } | null): boolean {
    return !!m && typeof m.name === 'string' && m.name.startsWith(NAME)
  }

  sourceMeshes(): Mesh[] { return [...this.meshes.values()] }

  markDirty(): void { this.dirty = true }

  flush(store: StampStore): void {
    if (!this.dirty) return
    this.dirty = false
    const buckets: Record<ShapeKind, Stamp[]> = {
      cube: [], sphere: [], cylinder: [], tetra: [], quad: [],
    }
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
      mesh.thinInstanceSetBuffer('matrix', mats, 16)
      mesh.thinInstanceSetBuffer('color', cols, 4)
      mesh.thinInstanceCount = n
      mesh.thinInstanceRefreshBoundingInfo(false, false)
    }
  }

  dispose(): void {
    for (const m of this.meshes.values()) m.dispose(false, true)
    this.meshes.clear()
  }
}

function emptyBuf(): Record<ShapeKind, Float32Array> {
  const z = () => new Float32Array(0)
  return { cube: z(), sphere: z(), cylinder: z(), tetra: z(), quad: z() }
}

function nextPow2(n: number): number {
  let c = 16
  while (c < n) c *= 2
  return c
}

export { STRIDE }
