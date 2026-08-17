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
// Deep import (SPEC 24 discipline): the '@babylonjs/serializers/glTF'
// barrel drags every serializer extension into the bundle (+330 KB).
import { GLTF2Export } from '@babylonjs/serializers/glTF/2.0/glTFSerializer'
import type { FormEngine } from '../core/engine'
import { toFile } from '../model/poster'
import { validateGLB, type LimitReport } from '../model/limits'
import { worldCenter, worldRadius } from '../model/facing'

import { theme } from '../theme'

export interface CameraState {
  projection: 'perspective' | 'ortho'
  target: [number, number, number]
  /** euler XYZ in degrees */
  rotationDeg: [number, number, number]
  radius: number
  /** vertical field of view in degrees (perspective) */
  fovDeg: number
}

const deg2rad = (d: number): number => (d * Math.PI) / 180
const rad2deg = (r: number): number => (r * 180) / Math.PI

import { buildTextMesh, type TextMeshResult } from './textTool'
import { importModelFiles } from '../model/importSidecar'

export interface ImportedModel {
  file: File
  bytes: Uint8Array
  report: LimitReport
  sourceFormat: 'glb' | 'gltf' | 'generated'
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
  private textMesh: TextMeshResult | null = null
  private textValue = '/0'
  private textAlign: 'left' | 'center' | 'right' = 'center'
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

  /** Request a render (render-on-demand engine). */
  kick(ms?: number): void { this.form.kick(ms) }

  attach(): void { this.camera.attachControl(true) }
  detach(): void { this.camera.detachControl() }

  get currentModel(): ImportedModel | null { return this.imported }

  hasModel(): boolean { return this.imported !== null }
  hasContent(): boolean { return this.imported !== null || this.textValue.trim().length > 0 }

  /** Clear the current preview so a new import does not stack meshes. */
  clearModel(): void {
    this.form?.kick()
    if (this.container) {
      this.container.removeAllFromScene()
      this.container.dispose()
      this.container = null
    }
    if (this.textMesh) {
      this.textMesh.mesh.dispose()
      this.textMesh = null
    }
    this.imported = null
  }

  // ---- typed text tool (SPEC TEXT+ANIM: flat low-poly geometry) ----
  setText(text: string): void {
    this.textValue = text
    this.form?.kick()
  }
  setTextColor(hex: string): void {
    this.tint = hex
    this.form?.kick()
  }
  setTextAlign(align: 'left' | 'center' | 'right'): void {
    this.textAlign = align
    this.form?.kick()
  }
  get text(): string { return this.textValue }

  /** Build/rebuild the text geometry and frame it. */
  rebuildText(): void {
    if (this.textMesh) {
      this.textMesh.mesh.dispose()
      this.textMesh = null
    }
    if (!this.textValue.trim()) return
    const result = buildTextMesh(this.scene, this.textValue, this.tint, this.textAlign)
    this.textMesh = result
    const dist = Math.max(result.width, result.height, 1) * 2.4 + 1
    this.camera.radius = dist
    this.camera.setTarget(Vector3.Zero())
  }

  // ---- camera settings ----
  // ArcRotateCamera: position is a function of (alpha,beta,radius,target).
  // Rotation is exposed as euler degrees so it is directly editable.
  getCameraState(): CameraState {
    // ArcRotateCamera orients around the target by alpha (azimuth) and beta
    // (polar angle, 0 = +Y). Convert to editable yaw/pitch degrees.
    const yaw = -this.camera.alpha - Math.PI / 2
    const pitch = Math.PI / 2 - this.camera.beta
    return {
      projection: this.camera.mode === 1 ? 'ortho' : 'perspective',
      target: this.camera.target.asArray() as [number, number, number],
      rotationDeg: [0, rad2deg(yaw), rad2deg(pitch)],
      radius: this.camera.radius,
      fovDeg: rad2deg(this.camera.fov),
    }
  }

  setCameraState(patch: Partial<CameraState>): void {
    if (patch.projection === 'perspective') {
      this.camera.mode = 0
    } else if (patch.projection === 'ortho') {
      this.camera.mode = 1
    }
    if (patch.target) {
      this.camera.setTarget(new Vector3(patch.target[0], patch.target[1], patch.target[2]))
    }
    if (patch.radius !== undefined) this.camera.radius = Math.max(0.01, patch.radius)
    if (patch.fovDeg !== undefined) {
      this.camera.fov = deg2rad(patch.fovDeg)
    }
    if (patch.rotationDeg) {
      // alpha/beta are derived from the look direction (roll is ignored by
      // ArcRotateCamera): yaw -> alpha, pitch -> beta.
      const [, yaw, pitch] = patch.rotationDeg
      this.camera.alpha = -deg2rad(yaw) - Math.PI / 2
      this.camera.beta = Math.PI / 2 - deg2rad(pitch)
    }
    // Orthographic framing: drive the ortho half-height from radius so zoom
    // (distance) still makes the subject larger/smaller. Width follows aspect.
    if (this.camera.mode === 1) {
      const eng = this.form.engine
      const aspect = eng.getRenderWidth() / Math.max(1, eng.getRenderHeight())
      const h = Math.max(0.1, this.camera.radius * 0.55)
      this.camera.orthoTop = h
      this.camera.orthoBottom = -h
      this.camera.orthoLeft = -h * aspect
      this.camera.orthoRight = h * aspect
    }
    this.form?.kick(300)
  }
  frameCamera(): void {
    if (this.container) {
      const center = worldCenter(this.container)
      const radius = worldRadius(this.container)
      this.camera.setTarget(center)
      this.camera.radius = Math.max(0.6, radius * 2.6)
    } else if (this.textMesh) {
      const dist = Math.max(this.textMesh.width, this.textMesh.height, 1) * 2.4 + 1
      this.camera.radius = dist
      this.camera.setTarget(Vector3.Zero())
    }
    this.form?.kick(500)
  }

  /**
   * Import one or more files: a self-contained GLB, a .gltf with .bin/
   * texture sidecars, or an .obj (+.mtl/textures). Sidecars are repacked
   * into a self-contained GLB so publishing is always a single BLOB.
   * The resulting GLB bytes are validated (the crash guard, rule 3).
   */
  async importFiles(files: File[]): Promise<ImportedModel> {
    this.clearModel()
    const result = await importModelFiles(this.scene, files)
    this.container = result.container
    const bytes = new Uint8Array(await result.glb.arrayBuffer())
    const report = validateGLB(bytes)
    if (!report.ok) {
      result.container.removeAllFromScene()
      result.container.dispose()
      throw new Error(report.reason)
    }
    const file = toFile(result.glb, result.filename)
    const center = worldCenter(result.container)
    const radius = worldRadius(result.container)
    this.camera.setTarget(center)
    this.camera.radius = Math.max(0.6, radius * 2.6)
    const imported: ImportedModel = { file, bytes, report, sourceFormat: result.filename.endsWith('.glb') ? 'glb' : 'gltf' }
    this.imported = imported
    this.form.kick(1000)
    return imported
  }

  /** Backwards-compatible single-file import. */
  importGLB(file: File): Promise<ImportedModel> {
    return this.importFiles([file])
  }

  /**
   * The bytes + filename to publish. If a self-contained GLB was imported,
   * returns those original bytes pass-through (no re-export). Otherwise
   * (typed text) exports the studio scene to GLB.
   */
  async getContentForPublish(): Promise<{ blob: Blob; filename: string; sourceFormat: 'glb' | 'generated' }> {
    if (this.imported) return { blob: this.imported.file, filename: this.imported.file.name, sourceFormat: 'glb' }
    // Text mode: make sure the geometry exists.
    if (!this.textMesh) this.rebuildText()
    const res = await GLTF2Export.GLBAsync(this.scene, 'text', {
      shouldExportNode: (n) => n === this.textMesh?.mesh,
    })
    const file = Object.values(res.files)[0]
    const blob = file instanceof Blob ? file : new Blob([file], { type: 'model/gltf-binary' })
    return { blob, filename: 'text.glb', sourceFormat: 'generated' }
  }

  dispose(): void {
    this.clearModel()
    this.scene.dispose()
  }
}
