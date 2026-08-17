import {
  Scene,
  ArcRotateCamera,
  Vector3,
  HemisphericLight,
  Color3,
  Color4,
  LoadAssetContainerAsync,
  AssetContainer,
  AnimationGroup,
  AbstractMesh,
} from '@babylonjs/core'
import '@babylonjs/loaders/glTF'
import type { FormEngine } from '../core/engine'
import { theme, LIMITS } from '../theme'
import type { ThreadMeta } from '../protocol/thread-index'

export class Viewer {
  readonly scene: Scene
  private camera: ArcRotateCamera
  private container: AssetContainer | null = null
  private animGroups: AnimationGroup[] = []
  private activeAnim: AnimationGroup | null = null

  constructor(private engine: FormEngine) {
    this.scene = new Scene(engine.engine)
    this.scene.clearColor = Color4.FromColor3(Color3.FromHexString(theme.background), 1)
    this.camera = new ArcRotateCamera('viewer-cam', -Math.PI / 2, Math.PI / 2.2, 6, Vector3.Zero(), this.scene)
    this.camera.attachControl(true)
    this.camera.wheelPrecision = 50
    this.camera.lowerRadiusLimit = 0.5
    this.camera.upperRadiusLimit = 40
    this.scene.activeCamera = this.camera
    new HemisphericLight('vl', new Vector3(0, 1, 0), this.scene)
  }

  async load(blob: Blob, meta: ThreadMeta): Promise<void> {
    this.clear()
    const url = URL.createObjectURL(blob)
    try {
      const result = await LoadAssetContainerAsync(url, this.scene)
      this.container = result
      let verts = 0
      result.meshes.forEach((m) => {
        const total = (m as AbstractMesh).getTotalVertices?.() ?? 0
        verts += total
      })
      if (verts > LIMITS.vertices) throw new Error('Model exceeds vertex limit.')
      result.addAllToScene()
      this.animGroups = result.animationGroups
      this.fitCamera()
      if (this.animGroups.length) {
        const idx = meta.previewAnimation ?? 0
        this.activeAnim = this.animGroups[Math.min(idx, this.animGroups.length - 1)]
        this.activeAnim.start(true)
      }
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 4000)
    }
  }

  private fitCamera(): void {
    if (!this.container) return
    this.camera.setTarget(Vector3.Zero())
    this.scene.activeCamera = this.camera
  }

  toggleAnimation(): void {
    if (!this.activeAnim && this.animGroups[0]) this.activeAnim = this.animGroups[0]
    if (!this.activeAnim) return
    if (this.activeAnim.isPlaying) this.activeAnim.pause()
    else this.activeAnim.play(true)
  }

  clear(): void {
    this.activeAnim?.stop()
    this.activeAnim = null
    this.animGroups = []
    this.container?.dispose()
    this.container = null
  }

  dispose(): void {
    this.clear()
    this.scene.dispose()
  }
}
