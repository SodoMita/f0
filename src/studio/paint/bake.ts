import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import type { Scene } from '@babylonjs/core/scene'
import type { StampStore } from './store'
import { SHAPES, type ShapeKind, type Stamp } from './types'

const tmpS = new Vector3()
const tmpQ = new Quaternion()
const tmpP = new Vector3()
const tmpM = new Matrix()
const tmpV = new Vector3()

/**
 * Expand thin instances into real geometry so GLTF2Export includes them.
 * One mesh per shape (vertex colours carry ink). Caller disposes the result.
 */
export function bakeStamps(scene: Scene, store: StampStore, sources: Map<ShapeKind, Mesh>): Mesh[] {
  const buckets = Object.fromEntries(SHAPES.map((shape) => [shape, [] as Stamp[]])) as unknown as Record<ShapeKind, Stamp[]>
  for (let i = 0; i < store.count; i++) {
    const s = store.at(i)
    buckets[s.shape].push(s)
  }
  const out: Mesh[] = []
  for (const shape of SHAPES) {
    const list = buckets[shape]
    const src = sources.get(shape)
    if (!list.length || !src) continue
    const vd = VertexData.ExtractFromMesh(src)
    const sp = vd.positions
    const si = vd.indices
    const sn = vd.normals
    if (!sp || !si) continue
    const vCount = sp.length / 3
    const positions: number[] = []
    const normals: number[] = []
    const colors: number[] = []
    const indices: number[] = []
    let base = 0
    for (const s of list) {
      compose(s)
      for (let i = 0; i < vCount; i++) {
        tmpV.set(sp[i * 3], sp[i * 3 + 1], sp[i * 3 + 2])
        Vector3.TransformCoordinatesToRef(tmpV, tmpM, tmpV)
        positions.push(tmpV.x, tmpV.y, tmpV.z)
        if (sn) {
          tmpV.set(sn[i * 3], sn[i * 3 + 1], sn[i * 3 + 2])
          Vector3.TransformNormalToRef(tmpV, tmpM, tmpV)
          tmpV.normalize()
          normals.push(tmpV.x, tmpV.y, tmpV.z)
        }
        colors.push(s.r, s.g, s.b, s.a)
      }
      for (let i = 0; i < si.length; i++) indices.push(si[i] + base)
      base += vCount
    }
    const mesh = new Mesh('paint-' + shape, scene)
    const data = new VertexData()
    data.positions = positions
    data.indices = indices
    if (normals.length) data.normals = normals
    data.colors = colors
    data.applyToMesh(mesh)
    const mat = new StandardMaterial('paint-bake-' + shape, scene)
    mat.diffuseColor = Color3.White()
    // EXPORT-ONLY material (the studio preview renders thin instances with
    // their own 0.55-emissive material in instances.ts). A grey emissive is
    // fatal here: glTF/PBR never modulates emissiveFactor by COLOR_0, so the
    // 0.55 grey landed as a constant term on top of the vertex-coloured ink
    // and every published stroke washed out to pastel in the viewer / board
    // poster / live preview (2026-08-20 "vertex colors work in studio, not in
    // the post" report). Black emissive = ink hue survives the glTF round-trip.
    mat.emissiveColor = Color3.Black()
    mat.specularColor = Color3.Black()
    mat.backFaceCulling = false
    mesh.material = mat
    mesh.isPickable = false
    out.push(mesh)
  }
  return out
}

function compose(s: Stamp): void {
  tmpS.set(s.sx, s.sy, s.sz)
  tmpQ.set(s.qx, s.qy, s.qz, s.qw)
  tmpP.set(s.px, s.py, s.pz)
  Matrix.ComposeToRef(tmpS, tmpQ, tmpP, tmpM)
}
