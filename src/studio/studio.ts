import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
import type { AssetContainer } from '@babylonjs/core/assetContainer'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color4, Color3 } from '@babylonjs/core/Maths/math.color'
// curated glTF loader (SPEC 24): NOT the '@babylonjs/loaders/glTF' barrel
import '../model/gltf'
import type { FormEngine } from '../core/engine'
import { toFile } from '../model/poster'
import { validateGLB, type LimitReport } from '../model/limits'
import { worldCenter, worldRadius } from '../model/facing'
import { theme } from '../theme'

export interface ImportedModel {
  file: File
  bytes: Uint8Array
  report: LimitReport
}

/**
 * Studio: import -> edit -> publish.
 *
 * For the BUD-01 publish flow the studio holds the *original* self-contained
 * GLB bytes (pass-through, no re-export) and renders a live preview container.
 * Editor tools (paint/animation/audio) build on this; they are not here yet.
 */
export class Studio {
  readonly scene: Scene
  private camera: ArcRotateCamera
  private container: AssetContainer | null = null
  private imported: ImportedModel | null = null
  private tint: string = theme.accent
  private form: FormEngine

  constructor(engine: FormEngine) {
    this.form = engine
    this.scene = new Scene(engine.engine)
    // PERF: studio renders only during camera inertia glides (input kicks
    // cover active drags; the stub scene has no other animation).
    engine.addAnimationSource(() => engine.activeScene === this.scene && this.isAnimating())
    this.scene.clearColor = Color4.FromHexString(theme.background + 'FF')
    this.camera = new ArcRotateCamera('studio-cam', -Math.PI / 2, Math.PI / 2.2, 8, Vector3.Zero(), this.scene)
    this.camera.attachControl(true)
    this.camera.wheelPrecision = 50
    this.camera.lowerRadiusLimit = 0.3
    this.camera.upperRadiusLimit = 40
    this.scene.activeCamera = this.camera
    // Lights-only rig (no IBL — see SPEC AMENDMENT 8).
    new HemisphericLight('sl-hemi', new Vector3(0, 1, 0), this.scene)
    const key = new DirectionalLight('sl-key', new Vector3(-0.4, -1, -0.6), this.scene)
    key.intensity = 0.8
    key.diffuse = Color3.White()
  }

  setBackground(hex: string): void {
    this.form.kick() // demand rendering (SPEC 17): background change must redraw
    this.scene.clearColor = Color4.FromHexString(hex + 'FF')
  }

  /** Render-on-demand probe: camera inertia glide (drags arrive as kicks). */
  isAnimating(): boolean {
    return Math.abs(this.camera.inertialAlphaOffset) > 1e-5
      || Math.abs(this.camera.inertialBetaOffset) > 1e-5
      || Math.abs(this.camera.inertialRadiusOffset) > 1e-4
  }

  /** Accent/tint applied to the published model's `color` tag. */
  get tintColor(): string { return this.tint }
  setTintColor(hex: string): void { this.tint = hex }

  attach(): void { this.camera.attachControl(true) }
  detach(): void { this.camera.detachControl() }

  get currentModel(): ImportedModel | null { return this.imported }

  hasModel(): boolean { return this.imported !== null }

  /** Clear the current preview so a new import does not stack meshes. */
  clearModel(): void {
    this.form?.kick()
    if (this.container) {
      this.container.removeAllFromScene()
      this.container.dispose()
      this.container = null
    }
    this.imported = null
  }

  /**
   * Import a self-contained GLB. The bytes are validated before Babylon
   * touches them (validateGLB is the crash guard, SPEC/AGENTS rule 3).
   * Original bytes are retained for byte-for-byte pass-through publishing.
   */
  async importGLB(file: File): Promise<ImportedModel> {
    this.clearModel()
    const bytes = new Uint8Array(await file.arrayBuffer())
    const report = validateGLB(bytes)
    if (!report.ok) throw new Error(report.reason)
    const container = await LoadAssetContainerAsync(toFile(file, file.name || 'model.glb'), this.scene)
    container.addAllToScene()
    this.container = container
    const center = worldCenter(container)
    const radius = worldRadius(container)
    this.camera.setTarget(center)
    this.camera.radius = Math.max(0.6, radius * 2.6)
    const imported: ImportedModel = { file, bytes, report }
    this.imported = imported
    // demand rendering (SPEC 17): a new model + camera retarget changes the
    // picture outside the input path — without this kick the studio stays
    // black until the user wiggles the mouse.
    this.form.kick(1000)
    return imported
  }

  dispose(): void {
    this.clearModel()
    this.scene.dispose()
  }
}
