import { Scene } from '@babylonjs/core/scene'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder'
import { CreateLineSystem } from '@babylonjs/core/Meshes/Builders/linesBuilder'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { CUBE } from './types'

const HALF = 12

/** Faint writing plane + a coarse guide grid (CUBE spacing, not the snap cell). */
export class PaintPlane {
  readonly mesh: Mesh
  private readonly lines: Mesh
  visible = true

  constructor(scene: Scene) {
    this.mesh = CreatePlane('studio-paint-plane', { size: HALF * 2 }, scene)
    // XY writing plane facing +Z (studio orbit sits near +Z).
    this.mesh.rotation.x = 0
    const mat = new StandardMaterial('studio-paint-plane-mat', scene)
    mat.diffuseColor = new Color3(0.6, 0.6, 0.62)
    mat.emissiveColor = new Color3(0.07, 0.07, 0.08)
    mat.specularColor = Color3.Black()
    mat.alpha = 0.06
    mat.backFaceCulling = false
    mat.transparencyMode = 2
    this.mesh.material = mat
    this.mesh.isPickable = false
    this.mesh.isVisible = true

    const paths: Vector3[][] = []
    for (let i = -HALF; i <= HALF; i += CUBE) {
      paths.push([new Vector3(i, -HALF, 0), new Vector3(i, HALF, 0)])
      paths.push([new Vector3(-HALF, i, 0), new Vector3(HALF, i, 0)])
    }
    this.lines = CreateLineSystem('studio-paint-grid', {
      lines: paths,
      colors: paths.map(() => [new Color4(1, 1, 1, 0.08), new Color4(1, 1, 1, 0.08)]),
    }, scene)
    this.lines.isPickable = false
  }

  setVisible(on: boolean): void {
    this.visible = on
    this.mesh.isVisible = on
    this.lines.isVisible = on
  }

  dispose(): void {
    this.mesh.dispose()
    this.lines.dispose()
  }
}
