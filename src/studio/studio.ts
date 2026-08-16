import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color4 } from '@babylonjs/core/Maths/math.color'
import '@babylonjs/loaders/glTF'
import type { FormEngine } from '../core/engine'
import { toFile } from '../model/poster'
import { validateGLB } from '../model/limits'
import { worldCenter, worldRadius } from '../model/facing'
import { theme } from '../theme'

/** Studio: import -> edit -> publish. Foundation for step 8/9 (editors next). */
export class Studio {
  readonly scene: Scene
  private camera: ArcRotateCamera

  constructor(engine: FormEngine) {
    this.scene = new Scene(engine.engine)
    this.scene.clearColor = Color4.FromHexString(theme.background + 'FF')
    this.camera = new ArcRotateCamera('studio-cam', -Math.PI / 2, Math.PI / 2.2, 8, Vector3.Zero(), this.scene)
    this.camera.attachControl(true)
    this.scene.activeCamera = this.camera
    new HemisphericLight('sl', new Vector3(0, 1, 0), this.scene)
  }

  setBackground(hex: string): void {
    this.scene.clearColor = Color4.FromHexString(hex + 'FF')
  }

  attach(): void { this.camera.attachControl(true) }
  detach(): void { this.camera.detachControl() }

  /** Import a self-contained GLB (byte-for-byte; no parse/export round trip). */
  async importGLB(file: File): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const report = validateGLB(bytes)
    if (!report.ok) throw new Error(report.reason)
    const container = await LoadAssetContainerAsync(toFile(file, file.name || 'model.glb'), this.scene)
    container.addAllToScene()
    const center = worldCenter(container)
    const radius = worldRadius(container)
    this.camera.setTarget(center)
    this.camera.radius = Math.max(0.6, radius * 2.6)
  }

  dispose(): void { this.scene.dispose() }
}
