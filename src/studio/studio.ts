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
import { copyBytes } from '../protocol/hash'
import { worldCenter, worldRadius, frameDistance } from '../model/facing'

import { theme } from '../theme'

export interface CameraState {
  projection: 'perspective' | 'ortho' | 'free'
  target: [number, number, number]
  /** euler XYZ in degrees */
  rotationDeg: [number, number, number]
  radius: number
  /** vertical field of view in degrees (perspective) */
  fovDeg: number
}

const deg2rad = (d: number): number => (d * Math.PI) / 180
const rad2deg = (r: number): number => (r * 180) / Math.PI

function normalizeYaw(deg: number): number {
  let y = deg % 360
  if (y > 180) y -= 360
  if (y <= -180) y += 360
  return y
}

import { buildTextMesh, type TextMeshResult } from './textTool'
import { PaintSession } from './paint/session'
import { importModelFiles } from '../model/importSidecar'
import { UtilityLayerRenderer } from '@babylonjs/core/Rendering/utilityLayerRenderer'
import { GizmoManager } from '@babylonjs/core/Gizmos/gizmoManager'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import type { Material } from '@babylonjs/core/Materials/material'
import { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents'
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera'
import { Vector3 as V3 } from '@babylonjs/core/Maths/math.vector'

export interface ImportedModel {
  file: File
  bytes: Uint8Array
  report: LimitReport
  sourceFormat: 'glb' | 'gltf' | 'obj' | 'generated'
}

/**
 * Studio: import -> edit -> publish.
 *
 * For the BUD-01 publish flow the studio holds the *original* self-contained
 * GLB bytes (pass-through, no re-export) and renders a live preview container.
 * When the user adds cameras, we re-export so those cameras are included.
 */
export class Studio {
  readonly scene: Scene
  private camera: ArcRotateCamera
  private container: AssetContainer | null = null
  private extras: AssetContainer[] = []
  private imported: ImportedModel | null = null
  private tint: string = theme.accent
  private textMesh: TextMeshResult | null = null
  private textBuildToken = 0
  private textValue = '/0'
  private textAlign: 'left' | 'center' | 'right' = 'center'
  private form: FormEngine
  private gizmoLayer: UtilityLayerRenderer
  private gizmos: GizmoManager
  private selection: AbstractMesh | null = null
  private freeCam: FreeCamera | null = null
  readonly paint: PaintSession
  private paintMode = false
  private frozen = false
  private frozenGizmo: 'position' | 'rotation' | 'scale' | 'none' = 'position'
  // Sticky "imported meshes were edited" flag (gizmo move / mesh delete).
  // Text, paint and user cameras are NOT sticky: they are observable state
  // (textValue / paint.count / storedCameras), so removing them restores the
  // byte-for-byte pass-through by itself (AMENDMENT 66).
  private meshEdits = false

  // ---- user added cameras (publishable) ----
  private storedCameras: CameraState[] = []
  private storedCameraNodes: ArcRotateCamera[] = []
  private activeCamIndex = -1 // -1 = orbit (current view), >=0 = editing that stored camera

  constructor(engine: FormEngine) {
    this.form = engine
    this.scene = new Scene(engine.engine)
    // PERF: studio renders only during camera inertia glides (input kicks
    // cover active drags; the stub scene has no other animation).
    engine.addAnimationSource(() => engine.activeScene === this.scene && this.isAnimating())
    this.scene.clearColor = Color4.FromHexString(theme.background + 'FF')
    this.camera = new ArcRotateCamera('studio-cam', Math.PI / 2, Math.PI / 2.2, 8, Vector3.Zero(), this.scene)
    this.camera.attachControl(true)
    this.camera.wheelPrecision = 50
    this.camera.lowerRadiusLimit = 0.001
    this.camera.upperRadiusLimit = 1e6
    this.scene.activeCamera = this.camera
    // Lights-only rig (no IBL — see SPEC AMENDMENT 8).
    new HemisphericLight('sl-hemi', new Vector3(0, 1, 0), this.scene)
    const key = new DirectionalLight('sl-key', new Vector3(-0.4, -1, -0.6), this.scene)
    key.intensity = 0.8
    key.diffuse = Color3.White()

    // Gizmos for moving/rotating/scaling the selected object (SPEC editor).
    this.gizmoLayer = new UtilityLayerRenderer(this.scene)
    this.gizmos = new GizmoManager(this.scene, 1.2, this.gizmoLayer)
    this.gizmos.positionGizmoEnabled = true
    this.gizmos.rotationGizmoEnabled = true
    this.gizmos.scaleGizmoEnabled = true
    this.gizmos.usePointerToAttachGizmos = false
    ;(this.gizmos as any).onAttachedToMeshObservable?.add((m: AbstractMesh | null) => { if (m) this.kick(2000) })
    const markMoved = () => {
      // Dragging the text mesh is baked at export time — only a drag of an
      // IMPORTED mesh is a sticky edit (the bytes can no longer pass through).
      if (this.selection && this.textMesh?.mesh !== this.selection) this.markDirty()
      else this.notifyEdit()
    }
    this.gizmos.gizmos.positionGizmo?.onDragEndObservable.add(markMoved)
    this.gizmos.gizmos.rotationGizmo?.onDragEndObservable.add(markMoved)
    this.gizmos.gizmos.scaleGizmo?.onDragEndObservable.add(markMoved)
    this.paint = new PaintSession(this.scene, (ms) => this.kick(ms), () => this.scene.activeCamera ?? this.camera)
    this.paint.onChange = () => this.notifyEdit()
    // Tap a mesh to select it; tap empty space to deselect.
    // Paint mode owns the left button (ink / erase / pick) — don't steal taps.
    this.scene.onPointerObservable.add((info) => {
      if (info.type !== PointerEventTypes.POINTERTAP) return
      if (this.frozen || this.paintMode) return
      const picked = info.pickInfo?.pickedMesh ?? null
      this.select(picked && this.isEditable(picked) ? picked : null)
    })
  }

  setBackground(hex: string): void {
    this.form.kick() // demand rendering (SPEC 17): background change must redraw
    this.scene.clearColor = Color4.FromHexString(hex + 'FF')
  }

  /** Render-on-demand probe: camera inertia glide (drags arrive as kicks). */
  isAnimating(): boolean {
    // Pointer input already kicks frames while a gizmo is dragged; merely
    // having a selected mesh must not latch the demand loop on forever.
    if (this.paint.isStroking()) return true
    if (this.scene.activeCamera !== this.camera) return false
    return Math.abs(this.camera.inertialAlphaOffset) > 1e-5
      || Math.abs(this.camera.inertialBetaOffset) > 1e-5
      || Math.abs(this.camera.inertialRadiusOffset) > 1e-4
  }

  /** Accent/tint applied to the published model's `color` tag. */
  get tintColor(): string { return this.tint }

  /**
   * Change the accent tint. Text rebuilds on its own (textTool reads this.tint
   * at build time); library symbols re-tint live, the same way the text tool
   * re-renders when the color input changes (AMENDMENT 68).
   */
  setTintColor(hex: string): void {
    this.tint = hex
    this.retintLibrary()
    this.notifyEdit()
    this.form.kick(300)
  }

  /** Request a render (render-on-demand engine). */
  kick(ms?: number): void { this.form.kick(ms) }

  attach(): void {
    if (this.freeCam) this.freeCam.attachControl(true, false)
    else this.camera.attachControl(true)
    const canvas = this.form.engine.getRenderingCanvas()
    if (canvas) this.paint.attach(canvas)
    this.applyOrbitButtons()
  }
  detach(): void {
    this.camera.detachControl()
    this.freeCam?.detachControl()
    this.paint.setActive(false)
    this.paint.detach()
  }

  /** Enable the ink tool: left-drag writes, right/middle still orbit. */
  setPaintMode(on: boolean): void {
    if (this.frozen) return
    this.paintMode = on
    this.paint.setActive(on)
    this.applyOrbitButtons()
    this.kick(200)
  }

  /**
   * Lock the scene for publish. Export/hash/upload must see a still model:
   * gizmo drags and paint strokes used to mutate the same buffers the
   * serializer / XHR were reading, which corrupted the event `x` tag.
   */
  setFrozen(on: boolean): void {
    if (this.frozen === on) return
    this.frozen = on
    if (on) {
      this.frozenGizmo = this.gizmos.positionGizmoEnabled ? 'position'
        : this.gizmos.rotationGizmoEnabled ? 'rotation'
          : this.gizmos.scaleGizmoEnabled ? 'scale' : 'none'
      this.select(null)
      this.paint.setActive(false)
      this.gizmos.positionGizmoEnabled = false
      this.gizmos.rotationGizmoEnabled = false
      this.gizmos.scaleGizmoEnabled = false
    } else {
      this.setTransformMode(this.frozenGizmo)
      if (this.paintMode) this.paint.setActive(true)
    }
    this.kick(200)
  }

  get isFrozen(): boolean { return this.frozen }

  /** A sticky edit of the imported meshes (move/rotate/scale/delete) — after
   *  this the publish bytes can no longer be the original file. */
  markDirty(): void { if (!this.frozen) { this.meshEdits = true; this.notifyEdit() } }

  /** A non-sticky content change (text/paint/cameras): re-renders the card
   *  preview but does not, by itself, break byte-for-byte pass-through. */
  touched(): void { if (!this.frozen) this.notifyEdit() }

  /** Fired on any content-affecting change (the HUD card preview listens to
   *  re-render; this has NO publish semantics — meshEdits is separate). */
  onDirty: (() => void) | null = null
  private notifyEdit(): void { try { this.onDirty?.() } catch { /* HUD only */ } }

  get isPaintMode(): boolean { return this.paintMode }

  private applyOrbitButtons(): void {
    const ptr = this.camera.inputs?.attached?.pointers as { buttons?: number[] } | undefined
    if (ptr) ptr.buttons = this.paintMode ? [1, 2] : [0, 1, 2]
  }

  private isEditable(m: AbstractMesh): boolean {
    // The root __root__ container and gizmo-layer meshes are not selectable.
    if (m.name === '__root__') return false
    if (m.name.startsWith('studio-paint')) return false
    if (m.getScene() !== this.scene) return false
    return true
  }

  select(mesh: AbstractMesh | null): void {
    if (this.frozen && mesh) return
    this.selection = mesh
    this.gizmos.attachToMesh(mesh)
    this.kick(2000)
  }
  get selected(): AbstractMesh | null { return this.selection }

  setTransformMode(mode: 'position' | 'rotation' | 'scale' | 'none'): void {
    if (this.frozen && mode !== 'none') return
    this.gizmos.positionGizmoEnabled = mode === 'position'
    this.gizmos.rotationGizmoEnabled = mode === 'rotation'
    this.gizmos.scaleGizmoEnabled = mode === 'scale'
    this.kick(400)
  }

  /** Delete the currently selected mesh (text or part of an imported model). */
  deleteSelection(): void {
    if (this.frozen) return
    if (this.paint.deleteSelection()) { this.touched(); return }
    if (!this.selection) return
    const m = this.selection
    this.select(null)
    const isText = this.textMesh?.mesh === m
    if (isText) {
      this.textBuildToken++
      this.textMesh = null
      this.textValue = ''
    }
    const extra = this.extras.find((c) => c.meshes.includes(m) || c.rootNodes.includes(m) || c.meshes.some((x) => x === m.parent))
    if (extra) {
      extra.removeAllFromScene()
      extra.dispose()
      this.extras = this.extras.filter((c) => c !== extra)
    } else {
      m.dispose(false, true)
    }
    if (isText) this.touched() // empty text = no text in the export at all
    else this.markDirty()
    this.kick(500)
  }

  /** Toggle between orbit (ArcRotate) and a free fly camera. */
  toggleFreeCamera(on: boolean): void {
    if (on && !this.freeCam) {
      this.freeCam = new FreeCamera('studio-free', this.camera.position.clone(), this.scene)
      this.freeCam.setTarget(this.camera.getTarget().clone())
      this.freeCam.minZ = 0.01
      this.freeCam.speed = 0.4
      this.scene.activeCamera = this.freeCam
      this.camera.detachControl()
      this.freeCam.attachControl(true, false)
    } else if (!on && this.freeCam) {
      this.camera.position.copyFrom(this.freeCam.position)
      this.camera.setTarget(this.freeCam.getTarget())
      this.scene.activeCamera = this.camera
      this.freeCam.detachControl()
      this.freeCam.dispose()
      this.freeCam = null
      this.camera.attachControl(true)
    }
    this.kick(2000)
  }

  get currentModel(): ImportedModel | null { return this.imported }

  hasModel(): boolean { return this.imported !== null }
  hasContent(): boolean {
    return this.imported !== null || this.textValue.trim().length > 0 || this.paint.count > 0 || this.extras.length > 0
  }
  get libraryCount(): number { return this.extras.length }

  /** Clear the current preview so a new import does not stack meshes. */
  clearModel(): void {
    this.textBuildToken++
    this.select(null)
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
    this.clearCameras()
    this.clearExtras()
    this.imported = null
    this.paint.clear()
    this.meshEdits = false
  }

  /**
   * Remove every studio addition and restore the imported model to its
   * original bytes (AMENDMENT 66): typed text, paint strokes and user cameras
   * are cleared, and the container is re-loaded from a pristine copy of the
   * imported file so gizmo moves / mesh deletes are reverted too. Afterwards
   * `getContentForPublish()` takes the pass-through branch again — the model
   * publishes bit-identical to the imported file (unless that file itself
   * fails the safety scan, in which case it is refused at import).
   */
  async resetAdditions(): Promise<boolean> {
    if (this.frozen) return false
    this.textValue = '' // the HUD textarea is synced by the caller
    if (this.imported) {
      // A detached copy: the live File may alias the container's buffers.
      const file = toFile(new Blob([copyBytes(this.imported.bytes).buffer as ArrayBuffer], { type: 'model/gltf-binary' }), this.imported.file.name)
      await this.importFiles([file]) // clearModel() resets text/paint/cams/meshEdits
    } else {
      this.textBuildToken++
      this.select(null)
      if (this.textMesh) { this.textMesh.mesh.dispose(); this.textMesh = null }
      this.clearCameras()
      this.paint.clear()
      this.meshEdits = false
      this.notifyEdit()
      this.kick(500)
    }
    return true
  }

  private clearExtras(): void {
    for (const extra of this.extras) {
      extra.removeAllFromScene()
      extra.dispose()
    }
    this.extras = []
  }

  /**
   * Drop a studio-library GLB into the scene WITHOUT clearing existing
   * content. Used by the symbols tab (emotions / reactions / primitives).
   */
  async addLibraryItem(bytes: Uint8Array, opts?: { faceCamera?: boolean }): Promise<void> {
    if (this.frozen) throw new Error('publish in progress')
    const report = validateGLB(bytes)
    if (!report.ok) throw new Error(report.reason)
    const container = await LoadAssetContainerAsync(bytes, this.scene, { pluginExtension: '.glb' })
    const n = this.extras.length
    const cam = this.scene.activeCamera
    for (const root of container.rootNodes) {
      const anyRoot = root as { position?: { x: number; y: number; z: number }; lookAt?: (t: Vector3) => void }
      if (!anyRoot.position) continue
      anyRoot.position.x += (n % 6) * 1.2
      anyRoot.position.z += Math.floor(n / 6) * 1.2
      // 2D plates are authored facing +Z; the studio orbit sits on +X, so
      // without this they land edge-on.
      if (opts?.faceCamera && cam && anyRoot.lookAt) {
        anyRoot.lookAt(cam.globalPosition ?? cam.position)
      }
    }
    const seen = new Set<Material>()
    for (const mesh of container.meshes) this.tintMesh(mesh, seen)
    container.addAllToScene()
    this.extras.push(container)
    this.markDirty()
    const first = container.meshes.find((m) => m.name !== '__root__' && m.getTotalVertices() > 0) ?? null
    if (first) this.select(first)
    this.fitSelected()
    this.form.kick(800)
  }

  /**
   * Colour a library mesh from the studio tint exactly like the text tool
   * (emissive tint over a black base). The library GLBs carry quantized
   * per-vertex COLOR_0 (VEC4), which the glTF loader maps to
   * `useVertexColors` + `hasVertexAlpha`; the alpha flag pushed the PBR
   * shader onto a vertexColor × baseColor path that rendered BLACK, so both
   * flags are cleared here and the tint drives the colour (AMENDMENT 68).
   */
  private tintMesh(mesh: AbstractMesh, seen: Set<Material>): void {
    mesh.useVertexColors = false
    mesh.hasVertexAlpha = false
    const mat = mesh.material
    if (!mat || seen.has(mat)) return
    seen.add(mat)
    const pbr = mat as PBRMaterial
    pbr.albedoColor = Color3.Black()
    pbr.emissiveColor = Color3.FromHexString(this.tint)
    pbr.metallic = 0
    pbr.backFaceCulling = false
  }

  /** Re-apply the tint to every placed library symbol (live color change). */
  private retintLibrary(): void {
    if (!this.extras.length) return
    const seen = new Set<Material>()
    for (const extra of this.extras) {
      for (const mesh of extra.meshes) this.tintMesh(mesh, seen)
    }
  }

  // ---- typed text tool (SPEC TEXT+ANIM: flat low-poly geometry) ----
  private textScale = 1
  private textLetterSpacing = 0
  private textLineSpacing = 1
  private textDepth = 0

  setText(text: string): void {
    this.textValue = text
    this.form?.kick()
  }
  setTextColor(hex: string): void {
    // The text tool reads this.tint at build time; symbols re-tint live
    // inside setTintColor (AMENDMENT 68).
    this.setTintColor(hex)
  }
  setTextAlign(align: 'left' | 'center' | 'right'): void {
    this.textAlign = align
    this.form?.kick()
  }
  setTextScale(v: number): void { if (!Number.isFinite(v)) return; this.textScale = v; this.form?.kick() }
  setTextLetterSpacing(v: number): void { if (!Number.isFinite(v)) return; this.textLetterSpacing = v; this.form?.kick() }
  setTextLineSpacing(v: number): void { if (!Number.isFinite(v)) return; this.textLineSpacing = v; this.form?.kick() }
  setTextDepth(v: number): void { if (!Number.isFinite(v)) return; this.textDepth = v; this.form?.kick() }

  get text(): string { return this.textValue }
  get textOptions(): { scale: number; letterSpacing: number; lineSpacing: number; depth: number; align: 'left'|'center'|'right'; color: string } {
    return {
      scale: this.textScale,
      letterSpacing: this.textLetterSpacing,
      lineSpacing: this.textLineSpacing,
      depth: this.textDepth,
      align: this.textAlign,
      color: this.tint,
    }
  }

  /** Build/rebuild the text geometry and frame it. */
  async rebuildText(): Promise<void> {
    if (this.frozen) return
    const hadText = this.textMesh !== null
    const wantsText = this.textValue.trim().length > 0
    // Empty text adds NO geometry (AMENDMENT 66): the no-op rebuild must
    // stay a no-op so an untouched model keeps its byte-for-byte pass-through.
    if (!hadText && !wantsText) return
    this.touched()
    const token = ++this.textBuildToken
    if (this.textMesh) {
      this.textMesh.mesh.dispose()
      this.textMesh = null
    }
    if (!wantsText) return
    const result = await buildTextMesh(this.scene, this.textValue, {
      color: this.tint,
      align: this.textAlign,
      scale: this.textScale,
      letterSpacing: this.textLetterSpacing,
      lineSpacing: this.textLineSpacing,
      depth: this.textDepth,
    })
    if (token !== this.textBuildToken) {
      result.mesh.dispose()
      return
    }
    this.textMesh = result
    const dist = Math.max(result.width, result.height, 1) * 2.4 + 1
    // Frame the ACTIVE camera: in free-fly mode writing only the orbit
    // camera left the text out of view — "the text exists but is invisible".
    this.lookAt(Vector3.Zero(), dist)
    this.select(result.mesh)
    this.form.kick(300)
  }

  // ---- camera settings ----
  // ArcRotateCamera: position is a function of (alpha,beta,radius,target).
  // Rotation is exposed as euler degrees (yaw, pitch) so it is directly editable.
  getCameraState(): CameraState {
    // ArcRotateCamera orients around the target by alpha (azimuth) and beta
    // (polar angle, 0 = +Y). Convert to editable yaw/pitch degrees with yaw=0 facing +Z.
    const yaw = normalizeYaw(rad2deg(Math.PI / 2 - this.camera.alpha))
    const pitch = Math.max(-89.9, Math.min(89.9, rad2deg(Math.PI / 2 - this.camera.beta)))
    return {
      projection: this.freeCam ? 'free' : (this.camera.mode === 1 ? 'ortho' : 'perspective'),
      target: this.camera.target.asArray() as [number, number, number],
      rotationDeg: [0, Number.isFinite(yaw) ? parseFloat(yaw.toFixed(1)) : 0, Number.isFinite(pitch) ? parseFloat(pitch.toFixed(1)) : 0],
      radius: this.camera.radius,
      fovDeg: rad2deg(this.camera.fov),
    }
  }

  setCameraState(patch: Partial<CameraState>): void {
    if (patch.projection === 'free') {
      this.toggleFreeCamera(true)
    } else {
      if (this.freeCam) this.toggleFreeCamera(false)
      if (patch.projection === 'perspective') this.camera.mode = 0
      else if (patch.projection === 'ortho') this.camera.mode = 1
    }
    if (patch.target) {
      this.camera.setTarget(new Vector3(patch.target[0], patch.target[1], patch.target[2]))
    }
    if (patch.radius !== undefined && Number.isFinite(patch.radius)) this.camera.radius = Math.max(0.001, patch.radius)
    if (patch.fovDeg !== undefined && Number.isFinite(patch.fovDeg)) {
      this.camera.fov = deg2rad(patch.fovDeg)
    }
    if (patch.rotationDeg) {
      // alpha/beta are derived from the look direction (roll is ignored by
      // ArcRotateCamera): yaw -> alpha (front +Z at yaw 0), pitch -> beta.
      const [, yaw, pitch] = patch.rotationDeg
      if (Number.isFinite(yaw)) this.camera.alpha = -deg2rad(yaw) + Math.PI / 2
      if (Number.isFinite(pitch)) {
        const clampedPitch = Math.max(-89.9, Math.min(89.9, pitch))
        this.camera.beta = Math.PI / 2 - deg2rad(clampedPitch)
      }
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
    // keep stored camera in sync when editing the active one
    if (this.activeCamIndex >= 0 && this.activeCamIndex < this.storedCameras.length) {
      const cur = this.getCameraState()
      this.storedCameras[this.activeCamIndex] = { ...cur }
      this.syncCameraNode(this.activeCamIndex)
    }
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

  // ---- view helpers: the camera does NOT auto-look at content any more.
  // Importing a model keeps the composed view; these buttons frame it.

  /**
   * The meshes the view helpers operate on.
   * `withDescendants` controls whether a selection expands to its subtree:
   * the ORIGIN look-at uses the direct pick only (an "origin" that is the
   * subtree centroid would just be the bbox centre again), while the
   * bbox/fit helpers include descendants so the framed extent is real.
   */
  private selectedSet(withDescendants = true): AbstractMesh[] {
    if (this.selection) {
      const out = [this.selection]
      if (withDescendants) {
        for (const d of this.selection.getDescendants(true)) {
          if (d instanceof Mesh) out.push(d)
        }
      }
      return out
    }
    const extras: AbstractMesh[] = []
    for (const extra of this.extras) {
      for (const m of extra.meshes) if (m.name !== '__root__') extras.push(m)
    }
    if (this.container) return this.container.meshes.filter((m) => m.name !== '__root__').concat(extras)
    if (extras.length) return extras
    if (this.textMesh) return [this.textMesh.mesh]
    if (this.paint.count > 0) return this.paint.sourceMeshes().filter((m) => m.thinInstanceCount > 0)
    return []
  }

  /** Average of the world origins (pivots) of the selected meshes. */
  private selectionOrigin(): Vector3 | null {
    const set = this.selectedSet(false) // origins, not the subtree centroid
    if (!set.length) return null
    const acc = new Vector3()
    for (const m of set) {
      m.computeWorldMatrix(true)
      acc.addInPlace(m.getAbsolutePosition())
    }
    return acc.scaleInPlace(1 / set.length)
  }

  /** World AABB of the selection (union over the selected meshes). */
  private selectionBounds(): { min: Vector3; max: Vector3; center: Vector3; radius: number } | null {
    const set = this.selectedSet()
    if (!set.length) return null
    const min = new Vector3(Infinity, Infinity, Infinity)
    const max = new Vector3(-Infinity, -Infinity, -Infinity)
    for (const m of set) {
      m.computeWorldMatrix(true)
      const bb = m.getBoundingInfo().boundingBox
      min.minimizeInPlace(bb.minimumWorld)
      max.maximizeInPlace(bb.maximumWorld)
    }
    const center = min.add(max).scaleInPlace(0.5)
    const radius = Math.max(0.001, Vector3.Distance(min, max) / 2)
    return { min, max, center, radius }
  }

  /**
   * Apply a look-at target (and optionally a framing distance) to the camera
   * the user is ACTUALLY using. setCameraState() only writes the orbit
   * camera, so in free-fly mode the view buttons used to be dead.
   */
  private lookAt(target: Vector3, distance?: number): void {
    if (this.freeCam && this.scene.activeCamera === this.freeCam) {
      const pos = this.freeCam.position
      // NOTE: Vector3.subtract mutates in place — it must never be called
      // on the caller's target (that corrupted the look-at point so the
      // fly camera aimed at "origin - cameraPos" instead of the origin).
      const dir = new Vector3()
      target.subtractToRef(pos, dir)
      const len = dir.length()
      if (len > 1e-6) dir.scaleInPlace(1 / len)
      this.freeCam.setTarget(target.clone())
      if (distance !== undefined && Number.isFinite(distance) && distance > 0) {
        // move the fly camera to the framing distance along its look ray
        const at = target.clone()
        const back = dir.scale(distance) // fresh vector — no aliasing
        at.subtractToRef(back, pos)
      }
      this.form.kick(300)
      return
    }
    const patch: Partial<CameraState> = { target: [target.x, target.y, target.z] }
    if (distance !== undefined && Number.isFinite(distance)) patch.radius = Math.max(0.05, distance)
    this.setCameraState(patch)
  }

  /** Point the camera at the average origin of the selected meshes. */
  lookAtSelectedOrigin(): void {
    const origin = this.selectionOrigin()
    if (!origin) return
    this.lookAt(origin)
  }

  /** Point the camera at the bounding-box centre of the selected meshes. */
  lookAtSelectedCenter(): void {
    const b = this.selectionBounds()
    if (!b) return
    this.lookAt(b.center)
  }

  /** Fit the selected meshes in view (keeps the current view direction). */
  fitSelected(): void {
    const b = this.selectionBounds()
    if (!b) return
    const eng = this.form.engine
    const aspect = eng.getRenderWidth() / Math.max(1, eng.getRenderHeight())
    if (this.freeCam && this.scene.activeCamera === this.freeCam) {
      // Free fly camera: frame the bounds along the current look direction.
      const dir = this.freeCam.getDirection(Vector3.Forward())
      const dist = frameDistance(b.min, b.max, b.center, dir, this.freeCam.fov || 0.7, aspect, 0.86)
      this.lookAt(b.center, Math.max(0.05, dist))
      return
    }
    if (this.camera.mode === 1) {
      // ortho: size the frustum to the bounds (half-height drives left/right
      // via aspect; radius keeps the state panel's "dist" consistent).
      const h = Math.max(0.1, Math.max(b.max.y - b.min.y, (b.max.x - b.min.x) / Math.max(0.2, aspect)) * 0.55)
      this.lookAt(b.center, h / 0.55)
    } else {
      const dir = this.camera.getDirection(Vector3.Forward())
      const dist = frameDistance(b.min, b.max, b.center, dir, this.camera.fov || 0.7, aspect, 0.86)
      this.lookAt(b.center, Math.max(0.05, dist))
    }
  }

  // ---- user cameras: add / select / edit / remove ----
  private makeCameraNode(state: CameraState, name: string): ArcRotateCamera {
    const target = new Vector3(state.target[0], state.target[1], state.target[2])
    const cam = new ArcRotateCamera(name, Math.PI / 2, Math.PI / 2.2, state.radius, target, this.scene)
    cam.fov = deg2rad(state.fovDeg ?? 46)
    const [, yaw, pitch] = state.rotationDeg ?? [0, 0, 0]
    if (Number.isFinite(yaw)) cam.alpha = -deg2rad(yaw) + Math.PI / 2
    if (Number.isFinite(pitch)) cam.beta = Math.PI / 2 - deg2rad(Math.max(-89.9, Math.min(89.9, pitch)))
    if (state.projection === 'ortho') {
      cam.mode = 1
      const eng = this.form.engine
      const aspect = eng.getRenderWidth() / Math.max(1, eng.getRenderHeight())
      const h = Math.max(0.1, cam.radius * 0.55)
      cam.orthoTop = h; cam.orthoBottom = -h; cam.orthoLeft = -h * aspect; cam.orthoRight = h * aspect
    } else {
      cam.mode = 0
    }
    cam.minZ = 0.01
    cam.maxZ = 4000
    return cam
  }

  private syncCameraNode(index: number): void {
    const node = this.storedCameraNodes[index]
    const state = this.storedCameras[index]
    if (!node || !state) return
    node.setTarget(new V3(state.target[0], state.target[1], state.target[2]))
    node.radius = state.radius
    node.fov = deg2rad(state.fovDeg)
    const [, yaw, pitch] = state.rotationDeg ?? [0, 0, 0]
    if (Number.isFinite(yaw)) node.alpha = -deg2rad(yaw) + Math.PI / 2
    if (Number.isFinite(pitch)) node.beta = Math.PI / 2 - deg2rad(Math.max(-89.9, Math.min(89.9, pitch)))
    if (state.projection === 'ortho') node.mode = 1
    else node.mode = 0
  }

  getCameras(): CameraState[] { return this.storedCameras.slice() }
  getActiveCameraIndex(): number { return this.activeCamIndex }

  addCamera(): number {
    if (this.frozen) return this.storedCameras.length - 1
    const state = this.getCameraState()
    // force perspective for stored cameras (free cam stored as perspective at current pos)
    const toStore: CameraState = { ...state, projection: state.projection === 'free' ? 'perspective' : state.projection }
    const idx = this.storedCameras.length
    this.storedCameras.push(toStore)
    const node = this.makeCameraNode(toStore, `studio-user-cam-${idx}`)
    this.storedCameraNodes.push(node)
    this.activeCamIndex = idx
    this.notifyEdit()
    this.kick(200)
    return idx
  }

  selectCamera(index: number): void {
    if (index < 0 || index >= this.storedCameras.length) {
      this.activeCamIndex = -1
      this.kick(200)
      return
    }
    this.activeCamIndex = index
    const state = this.storedCameras[index]
    this.setCameraState(state)
    // avoid recursive sync overwriting while we are selecting
    this.activeCamIndex = index
    this.kick(200)
  }

  updateStoredCamera(index: number, patch: Partial<CameraState>): void {
    if (index < 0 || index >= this.storedCameras.length) return
    this.storedCameras[index] = { ...this.storedCameras[index], ...patch }
    this.syncCameraNode(index)
    if (this.activeCamIndex === index) {
      this.setCameraState(this.storedCameras[index])
    }
    if (!this.frozen) this.notifyEdit()
    this.kick(200)
  }

  removeCamera(index: number): void {
    if (this.frozen) return
    if (index < 0 || index >= this.storedCameras.length) return
    const node = this.storedCameraNodes[index]
    try { node?.dispose() } catch {}
    this.storedCameras.splice(index, 1)
    this.storedCameraNodes.splice(index, 1)
    // re-name remaining nodes to keep indices stable for export
    this.storedCameraNodes.forEach((n, i) => { n.name = `studio-user-cam-${i}` })
    if (this.activeCamIndex === index) this.activeCamIndex = -1
    else if (this.activeCamIndex > index) this.activeCamIndex--
    this.notifyEdit()
    this.kick(200)
  }

  clearCameras(): void {
    for (const n of this.storedCameraNodes) { try { n.dispose() } catch {} }
    this.storedCameraNodes = []
    this.storedCameras = []
    this.activeCamIndex = -1
  }

  /**
   * Import one or more files: a self-contained GLB, a .gltf with .bin/
   * texture sidecars, or an .obj (+.mtl/textures). Sidecars are repacked
   * into a self-contained GLB so publishing is always a single BLOB.
   * The resulting GLB bytes are validated (the crash guard, rule 3).
   */
  async importFiles(files: File[]): Promise<ImportedModel> {
    if (this.frozen) throw new Error('publish in progress')
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
    // The camera keeps the composed view: importing must NOT snap it to the
    // model. Framing is explicit (frame / fit-selected / look-at buttons).
    const imported: ImportedModel = { file, bytes, report, sourceFormat: result.sourceFormat }
    this.imported = imported
    this.meshEdits = false
    this.notifyEdit()
    const first = result.container.meshes.find((m) => m.name !== '__root__') ?? null
    if (first) this.select(first as AbstractMesh)
    this.form.kick(1000)
    return imported
  }

  /** Backwards-compatible single-file import. */
  importGLB(file: File): Promise<ImportedModel> {
    return this.importFiles([file])
  }

  /**
   * The bytes + filename to publish. If a self-contained GLB was imported
   * WITHOUT added cameras, returns those original bytes pass-through
   * (no re-export). Otherwise exports the studio scene to GLB including
   * added cameras.
   */
  async getContentForPublish(): Promise<{ blob: Blob; filename: string; sourceFormat: 'glb' | 'gltf' | 'obj' | 'generated' }> {
    const hasUserCams = this.storedCameras.length > 0
    const hasPaint = this.paint.count > 0
    const hasText = this.textValue.trim().length > 0
    // Empty text adds nothing to the model (AMENDMENT 66). A stale mesh can
    // outlive the textarea by the rebuild debounce — drop it before deciding.
    if (!hasText && this.textMesh) {
      this.textBuildToken++
      this.textMesh.mesh.dispose()
      this.textMesh = null
    }
    // Pass-through only when the published bytes are still the imported GLB.
    // A detached copy: the File may alias live import buffers.
    if (this.imported && !hasUserCams && !hasPaint && !hasText && !this.meshEdits) {
      const bytes = copyBytes(this.imported.bytes)
      return {
        blob: new Blob([bytes.buffer as ArrayBuffer], { type: 'model/gltf-binary' }),
        filename: this.imported.file.name,
        sourceFormat: this.imported.sourceFormat,
      }
    }
    // Text mode OR imported + user cameras: make sure font geometry exists.
    if (!this.textMesh && hasText) await this.rebuildText()

    // Ensure camera nodes exist for all stored cameras (they should, but recreate if missing)
    while (this.storedCameraNodes.length < this.storedCameras.length) {
      const i = this.storedCameraNodes.length
      this.storedCameraNodes.push(this.makeCameraNode(this.storedCameras[i], `studio-user-cam-${i}`))
    }

    // Build export filter: text mesh + all imported meshes + user cameras
    const exportableMeshes = new Set<any>()
    if (this.textMesh?.mesh) exportableMeshes.add(this.textMesh.mesh)
    if (this.container) {
      for (const m of this.container.meshes) {
        if (m.name === '__root__') continue
        exportableMeshes.add(m)
      }
    }
    for (const extra of this.extras) {
      for (const m of extra.meshes) {
        if (m.name === '__root__') continue
        exportableMeshes.add(m)
      }
    }
    // Thin-instance sources must not export (unit mesh at origin). Bake first.
    const baked = hasPaint ? this.paint.bake() : []
    for (const m of baked) exportableMeshes.add(m)
    const exportableCams = new Set<any>(this.storedCameraNodes)
    // include original imported cameras if we have a container (they are already in scene)
    const originalCams: any[] = this.container ? (this.container as any).cameras ?? [] : []
    for (const c of originalCams) exportableCams.add(c)

    const shouldExportNode = (n: any): boolean => {
      if (typeof n?.name === 'string' && n.name.startsWith('studio-paint')) return false
      if (exportableMeshes.has(n)) return true
      if (exportableCams.has(n)) return true
      // also keep transform nodes that are parents of exportable meshes/cameras
      if (this.container && (this.container as any).transformNodes?.includes(n)) return true
      if (this.extras.some((extra) => extra.transformNodes.includes(n) || extra.meshes.includes(n))) return true
      if (this.textMesh && n === this.textMesh.mesh.parent) return true
      return false
    }

    // If we have only user cameras but no mesh (edge), still export cameras + text if present.
    // When there is no text and no container (should not happen due to hasContent check) fallback to original path.
    const res = await GLTF2Export.GLBAsync(this.scene, this.textMesh ? 'text' : (this.imported?.file.name.replace(/\.[^.]+$/, '') || 'model'), {
      shouldExportNode: exportableMeshes.size === 0 && exportableCams.size === 0 ? (n: any) => n === this.textMesh?.mesh : shouldExportNode,
    })
    const file = Object.values((res as any).glTFFiles ?? (res as any).files ?? res)[0] as any
    const raw = file instanceof Blob ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array(file as ArrayBuffer)
    const bytes = copyBytes(raw)
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'model/gltf-binary' })
    return { blob, filename: this.textMesh ? 'text.glb' : (this.imported?.file.name ?? 'model.glb'), sourceFormat: this.imported ? this.imported.sourceFormat : 'generated' }
  }

  dispose(): void {
    this.clearModel()
    this.paint.dispose()
    this.gizmos.dispose()
    this.gizmoLayer.dispose()
    if (this.freeCam) { this.freeCam.dispose(); this.freeCam = null }
    this.scene.dispose()
  }
}
