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
// Side-effect import: registers the KHR_materials_unlit EXPORTER so image
// planes (unlit materials) publish as unlit GLBs instead of lit ones.
import '@babylonjs/serializers/glTF/2.0/Extensions/KHR_materials_unlit'
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

/**
 * White means "no tint": the library piece keeps the colours its palette
 * texture was authored with (AMENDMENT 86). Such a pick must not become the
 * post's `color` tag — that tag drives the card placeholder tint.
 */
const NEUTRAL_TINT = '#FFFFFF'

function isNeutral(hex: string): boolean {
  return /^#?f{3}$|^#?f{6}$/i.test(hex.trim())
}

function normalizeYaw(deg: number): number {
  let y = deg % 360
  if (y > 180) y -= 360
  if (y <= -180) y += 360
  return y
}

import { buildTextMesh, type TextMeshResult } from './textTool'
import { decodeImageFile, buildImagePlane, waitTextureReady, type ImagePlane } from './imageTool'
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
import { HighlightLayer } from '@babylonjs/core/Layers/highlightLayer'
// Side-effect import: registers the EffectLayerSceneComponent that every
// HighlightLayer in the scene needs (project convention — same as `pick`).
import '@babylonjs/core/Layers/effectLayerSceneComponent'

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
  /** Uploaded pictures placed as flat textured planes (image tab). */
  private imagePlanes: ImagePlane[] = []
  private imported: ImportedModel | null = null
  private tint: string = theme.accent
  /** Per-symbol color override, keyed by AssetContainer. Empty string means use global tint. */
  private extraColors: Map<AssetContainer, string> = new Map()
  /** Color for text, separate from the global tint / symbol colors. */
  private textColor: string = theme.accent
  private textMesh: TextMeshResult | null = null
  private textBuildToken = 0
  private textValue = ''
  private textAlign: 'left' | 'center' | 'right' = 'center'
  private form: FormEngine
  private gizmoLayer: UtilityLayerRenderer
  private gizmos: GizmoManager
  private selection: AbstractMesh | null = null
  /** Mesh currently outlined by the studio highlight layer (object or paint source). */
  private highlightMesh: AbstractMesh | null = null
  private highlightLayer: HighlightLayer
  /** Selection outline preferences (live-driven from settings.apply). */
  private hlOn = true
  private hlColor = '#FFFFFF'
  /** Outline thickness as the HighlightLayer blur kernel — 1 = hairline, 8 = thick rim. */
  private hlThickness = 2
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
    // Do NOT attachControl here: the studio shares the one canvas with the
    // board. Attaching at construction stole pointer events while the board
    // was on screen (and left the feed feeling "still open" inside studio).
    // attach() / detach() own the canvas for the studio's lifetime.
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

    // Babylon highlight layer outlines the currently-selected mesh (text / a
    // placed symbol / an imported mesh / a paint stamp's source). Outer-glow
    // only — the inner colour tints whatever the mesh draws anyway. Additive
    // blending + bright colour so the outline stays visible against any mesh
    // tint (the accent often matches the mesh colour). Thickness and colour
    // are live-configurable through the settings schema (settings.selection
    // Highlight*), see `setSelectionHighlight`.
    this.highlightLayer = new HighlightLayer('studio-highlight', this.scene, {
      mainTextureRatio: 0.5,
      blurHorizontalSize: 2.0,
      blurVerticalSize: 2.0,
      alphaBlendingMode: 2, // ADDITIVE: outline shows on top of the mesh
    })
    this.highlightLayer.innerGlow = false
    this.highlightLayer.outerGlow = true
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
    // Paint mode's select tool picks stamps AND studio objects: while the
    // paint tab is active the brush owns the left button, so without this
    // hook symbols / text / imported meshes could never be selected there.
    this.paint.onSelectObject = (x, y) => {
      // About to highlight an object — drop any lingering stamp highlight.
      this.highlightPaintStamp(null)
      return this.pickObjectAt(x, y)
    }
    this.paint.onClearObjectSelection = () => this.select(null)
    this.paint.onSelectStamp = (shape) => this.highlightPaintStamp(shape)
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
    // Babylon only applies inertia DURING a scene render, so any threshold
    // tight enough to "stop soon" leaves the offset frozen at the threshold
    // value once the probe flips false — the camera "jumps" forward in
    // visible chunks (one tick ≈ the next time the user kicks the engine).
    // The right fix is to keep rendering until the inertia is genuinely
    // zero; the cost is ~30 extra frames during a typical 0.5–1 s glide,
    // which is negligible compared to the input-driven burst that started
    // it. A small absolute floor guards against runaway perpetual renders
    // if Babylon ever hands us an underflow (extremely rare in practice).
    const cam = this.camera
    return cam.inertialAlphaOffset !== 0
      || cam.inertialBetaOffset !== 0
      || cam.inertialRadiusOffset !== 0
  }

  /** Accent/tint applied to the published model's `color` tag. */
  get tintColor(): string { return this.tint }

  /**
   * Change the accent tint (the color the NEXT placed symbol takes when no
   * item is selected, and the event `color` tag fallback). Existing symbols
   * keep their per-item colors; text has its own textColor (AMENDMENT 68
   * corrected 2026-08-21).
   */
  setTintColor(hex: string): void {
    this.tint = hex
    this.notifyEdit()
    this.form.kick(300)
  }

  /**
   * Return the color of the selected item (symbol or text), or null when the
   * selection is something we do not colour (an imported model mesh).
   *
   * A library piece placed with no explicit tint reports NEUTRAL white
   * (AMENDMENT 86) — it is showing its own palette texture, not the studio
   * accent. Reporting the accent here used to leak it into the pickers, so
   * the second piece a player placed came out tinted even though they never
   * touched the colour control.
   */
  getSelectedColor(): string | null {
    if (this.textMesh && this.selection === this.textMesh.mesh) return this.textColor
    if (this.selection) {
      const extra = this.extras.find((c) => c.meshes.includes(this.selection!) || c.rootNodes.includes(this.selection!))
      if (extra) return this.extraColors.get(extra) ?? NEUTRAL_TINT
    }
    return null
  }

  /** Set the color of the selected item (symbol or text) without affecting others. */
  setSelectedColor(hex: string): void {
    if (this.frozen) return
    if (this.textMesh && this.selection === this.textMesh.mesh) {
      this.textColor = hex
      void this.rebuildText() // text color is baked into the mesh at build time
      this.notifyEdit()
      return
    }
    if (this.selection) {
      const extra = this.extras.find((c) => c.meshes.includes(this.selection!) || c.rootNodes.includes(this.selection!))
      if (extra) {
        this.extraColors.set(extra, hex)
        const seen = new Set<Material>()
        for (const mesh of extra.meshes) this.tintMesh(mesh, seen, hex)
        this.form.kick(300)
        this.notifyEdit()
        return
      }
    }
    // No selection or not an item we own — set the global fallback.
    this.tint = hex
    this.notifyEdit()
    this.form.kick(300)
  }

  /** Request a render (render-on-demand engine). */
  kick(ms?: number): void { this.form.kick(ms) }

  /**
   * Recompute an orthographic frustum from the LIVE engine aspect.
   *
   * Babylon re-derives a perspective camera's aspect from the engine on every
   * projection-matrix recompute, so those self-correct after a resize;
   * `orthoLeft/Right/Top/Bottom` are cached values and do not. This is the
   * single place the studio's ortho bounds are computed (AMENDMENT 79) —
   * previously the same four lines were duplicated at four call sites and
   * only ever ran when the camera state changed.
   */
  private applyOrtho(cam: ArcRotateCamera): void {
    if (cam.mode !== 1) return
    const eng = this.form.engine
    const aspect = eng.getRenderWidth() / Math.max(1, eng.getRenderHeight())
    const h = Math.max(0.1, cam.radius * 0.55)
    cam.orthoTop = h
    cam.orthoBottom = -h
    cam.orthoLeft = -h * aspect
    cam.orthoRight = h * aspect
  }

  /**
   * The drawing buffer changed (window resize, page zoom, resolution policy).
   * Perspective cameras follow the engine on their own; the ortho ones have
   * to be re-derived or the scene keeps the aspect it was authored at and
   * renders stretched.
   */
  resize(): void {
    this.applyOrtho(this.camera)
    for (const node of this.storedCameraNodes) if (node) this.applyOrtho(node)
    // 9g: a visual change outside a render must ask for a frame.
    this.form.invalidate()
  }

  attach(): void {
    if (this.freeCam) this.freeCam.attachControl(true, false)
    else this.camera.attachControl(true)
    const canvas = this.form.engine.getRenderingCanvas()
    if (canvas) this.paint.attach(canvas)
    this.applyOrbitButtons()
    // The window may have changed size while another view owned the canvas.
    this.resize()
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

  /**
   * Raycast an editable (non-paint) object at screen coordinates and select
   * it. Used by the paint select tool so symbols, text and imported meshes
   * stay selectable while the paint tab is active (the brush otherwise owns
   * the left button). Returns true when an object was picked.
   */
  pickObjectAt(clientX: number, clientY: number): boolean {
    const canvas = this.form.engine.getRenderingCanvas()
    if (!canvas) return false
    const rect = canvas.getBoundingClientRect()
    const pick = this.scene.pick(
      clientX - rect.left,
      clientY - rect.top,
      (m) => this.isEditable(m) && !this.paint.isPaintMesh(m),
    )
    const mesh = pick?.hit ? pick.pickedMesh : null
    this.select(mesh)
    return mesh !== null
  }

  /** Fired whenever the selection changes (the HUD color picker follows it). */
  onSelect: ((mesh: AbstractMesh | null) => void) | null = null

  select(mesh: AbstractMesh | null): void {
    if (this.frozen && mesh) return
    this.selection = mesh
    this.gizmos.attachToMesh(mesh)
    this.setHighlight(mesh)
    this.kick(2000)
    try { this.onSelect?.(mesh) } catch { /* HUD only */ }
  }
  get selected(): AbstractMesh | null { return this.selection }

  /**
   * Highlight a paint stamp by outlining its source mesh. Used when the
   * paint select tool picks an individual stamp without an object
   * selection — Babylon's HighlightLayer only outlines meshes, so two
   * stamps of the same shape highlight together (still better than nothing).
   */
  highlightPaintStamp(shape: string | null): void {
    if (!shape) {
      this.setHighlight(null)
      return
    }
    const mesh = this.paint.instances.meshes.get(shape as any) ?? null
    this.setHighlight(mesh)
  }

  /**
   * Live-update the selection outline (settings → Interface → Selection
   * outline). `on=false` removes any current outline; `color`/`thickness`
   * are applied immediately so the next selection picks them up AND any
   * already-outlined mesh re-tints without a re-pick.
   */
  setSelectionHighlight(on: boolean, color: string, thickness: number): void {
    this.hlOn = !!on
    if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) this.hlColor = color
    const t = Number.isFinite(thickness) ? Math.max(1, Math.min(8, Math.round(thickness))) : 2
    this.hlThickness = t
    // HighlightLayer thickness is the blur kernel — the larger it is, the
    // further the glow extends past the mesh silhouette. A linear-ish
    // mapping keeps 1 close to a hairline and 8 close to a thick rim.
    const kernel = 0.4 + t * 0.5
    this.highlightLayer.blurHorizontalSize = kernel
    this.highlightLayer.blurVerticalSize = kernel
    // Re-tint the currently-selected mesh in place so the user sees the
    // change without re-clicking.
    if (this.highlightMesh instanceof Mesh) {
      try {
        this.highlightLayer.removeMesh(this.highlightMesh)
        if (this.hlOn) {
          this.highlightLayer.addMesh(this.highlightMesh, Color3.FromHexString(this.hlColor))
        }
      } catch { /* mesh gone */ }
    }
    this.kick(200)
  }
  /** Update the highlight layer outline; ignored while publishing. */
  private setHighlight(mesh: AbstractMesh | null): void {
    if (this.frozen) return
    if (!this.hlOn) {
      // Highlight disabled: keep the layer clean so a re-enable doesn't
      // leave a stale mesh attached.
      if (this.highlightMesh instanceof Mesh) {
        try { this.highlightLayer.removeMesh(this.highlightMesh as Mesh) } catch { /* mesh gone */ }
        this.highlightMesh = null
      }
      return
    }
    if (this.highlightMesh === mesh) return
    if (this.highlightMesh instanceof Mesh) {
      try { this.highlightLayer.removeMesh(this.highlightMesh as Mesh) } catch { /* mesh gone */ }
    }
    this.highlightMesh = mesh
    if (mesh instanceof Mesh) {
      // Highlight colour follows the studio selection palette (settings).
      const color = Color3.FromHexString(this.hlColor)
      this.highlightLayer.addMesh(mesh, color)
    }
    this.kick(120)
  }

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
      this.extraColors.delete(extra)
    } else {
      const image = this.imagePlanes.find((p) => p.mesh === m)
      if (image) {
        image.texture.dispose()
        this.imagePlanes = this.imagePlanes.filter((p) => p !== image)
      }
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
    return this.imported !== null || this.textValue.trim().length > 0 || this.paint.count > 0
      || this.extras.length > 0 || this.imagePlanes.length > 0
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
    this.clearImagePlanes()
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
    this.extraColors.clear()
  }

  /**
   * Drop a studio-library GLB into the scene WITHOUT clearing existing
   * content. Used by the symbols tab (emotions / reactions / primitives).
   * @param color Optional per-item color hex; defaults to global tint.
   */
  async addLibraryItem(bytes: Uint8Array, opts?: { faceCamera?: boolean; color?: string }): Promise<void> {
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
    const color = opts?.color ?? ''
    if (color && !isNeutral(color)) {
      this.extraColors.set(container, color)
      // The event `color` tag is a single value per post; let it follow the
      // most recently placed symbol so a symbol-heavy post carries a
      // representative tint (AMENDMENT 68 corrected 2026-08-21). A NEUTRAL
      // (white) pick means "no tint, show the authored palette", so it must
      // not overwrite the post's colour tag with white.
      this.tint = color
    }
    const tint = color || this.tint
    const seen = new Set<Material>()
    for (const mesh of container.meshes) this.tintMesh(mesh, seen, tint)
    container.addAllToScene()
    this.extras.push(container)
    this.markDirty()
    const first = container.meshes.find((m) => m.name !== '__root__' && m.getTotalVertices() > 0) ?? null
    if (first) this.select(first)
    this.fitSelected()
    this.form.kick(800)
  }

  /**
   * Colour a library mesh by modulating its material with the studio tint.
   *
   * Library pieces carry their colour in the shared PALETTE TEXTURE
   * (AMENDMENT 86, 2026-08-21): a 32x32 PNG inside the GLB, one 4x4 swatch per
   * palette slot, sampled NEAREST through a UV per vertex. Babylon multiplies
   * `albedoColor` INTO `albedoTexture`, so the tint modulates the palette the
   * same way it used to modulate COLOR_0 — and the neutral white default
   * shows the art exactly as authored. Vertex colours stay enabled because
   * user-imported meshes (and the older traced 2D plates) still use them; a
   * mesh without COLOR_0 simply ignores the flag.
   */
  private tintMesh(mesh: AbstractMesh, seen: Set<Material>, color: string): void {
    mesh.useVertexColors = true
    mesh.hasVertexAlpha = false
    const mat = mesh.material
    if (!mat || seen.has(mat)) return
    seen.add(mat)
    const pbr = mat as PBRMaterial
    pbr.albedoColor = Color3.FromHexString(color)
    pbr.emissiveColor = Color3.Black()
    pbr.metallic = 0
    pbr.backFaceCulling = false
  }

  /**
   * Decode a picture file and place it as a flat plane (image tab). The
   * image keeps its native resolution — the post's own size limit bounds
   * how large it can be (only the engine's hard texture-side ceiling is
   * refused up front, with a clear error). The plane is selectable,
   * gizmo-transformable and deleteable like any other studio object, and
   * the export review/publish pipeline embeds its texture in the GLB.
   * @returns the decoded pixel size.
   */
  async addImage(file: File, worldWidth = 4): Promise<{ width: number; height: number }> {
    if (this.frozen) throw new Error('publish in progress')
    const decoded = await decodeImageFile(file)
    const n = this.imagePlanes.length
    const plane = buildImagePlane(this.scene, decoded, worldWidth)
    plane.sourceName = file.name
    try {
      await waitTextureReady(plane.texture)
    } catch {
      plane.texture.dispose()
      plane.mesh.dispose(false, true)
      throw new Error('could not decode the image texture')
    }
    // Grid placement, like library pieces: avoid stacking on the origin.
    plane.mesh.position.set((n % 6) * 1.2, 0, Math.floor(n / 6) * 1.2 + 0.2)
    this.imagePlanes.push(plane)
    this.markDirty()
    this.select(plane.mesh)
    this.fitSelected()
    this.form.kick(800)
    return { width: decoded.width, height: decoded.height }
  }

  get imageCount(): number { return this.imagePlanes.length }

  /** Total decoded pixels of every placed picture (status readout). */
  get imagePixels(): number {
    let total = 0
    for (const p of this.imagePlanes) total += p.pixelW * p.pixelH
    return total
  }

  private clearImagePlanes(): void {
    for (const p of this.imagePlanes) {
      p.texture.dispose()
      p.mesh.dispose(false, true)
    }
    this.imagePlanes = []
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
    // Text has its own per-item color (AMENDMENT 68 corrected 2026-08-21);
    // this does NOT touch the global tint or placed symbols.
    this.textColor = hex
    if (this.textMesh) void this.rebuildText()
    this.form?.kick()
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
      color: this.textColor,
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
      color: this.textColor,
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
    this.applyOrtho(this.camera)
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
    cam.mode = state.projection === 'ortho' ? 1 : 0
    this.applyOrtho(cam)
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
    node.mode = state.projection === 'ortho' ? 1 : 0
    // BUGFIX (AMENDMENT 79): this set `mode` but never refreshed the ortho
    // bounds, so a stored ortho camera kept whatever frustum it was born with.
    this.applyOrtho(node)
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
    if (this.imported && !hasUserCams && !hasPaint && !hasText && !this.meshEdits && this.imagePlanes.length === 0) {
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
    for (const p of this.imagePlanes) exportableMeshes.add(p.mesh)
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
    const imageBase = this.imagePlanes[0]?.sourceName.replace(/\.[^.]+$/, '') || 'image'
    const baseName = this.textMesh ? 'text'
      : this.imagePlanes.length ? imageBase
      : (this.imported?.file.name.replace(/\.[^.]+$/, '') || 'model')
    const res = await GLTF2Export.GLBAsync(this.scene, baseName, {
      shouldExportNode: exportableMeshes.size === 0 && exportableCams.size === 0 ? (n: any) => n === this.textMesh?.mesh : shouldExportNode,
    })
    const file = Object.values((res as any).glTFFiles ?? (res as any).files ?? res)[0] as any
    const raw = file instanceof Blob ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array(file as ArrayBuffer)
    const bytes = copyBytes(raw)
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'model/gltf-binary' })
    const outName = this.textMesh ? 'text.glb'
      : this.imagePlanes.length ? `${imageBase}.glb`
      : (this.imported?.file.name ?? 'model.glb')
    return { blob, filename: outName, sourceFormat: this.imported ? this.imported.sourceFormat : 'generated' }
  }

  dispose(): void {
    this.clearModel()
    this.paint.dispose()
    this.gizmos.dispose()
    this.gizmoLayer.dispose()
    this.highlightLayer.dispose()
    if (this.freeCam) { this.freeCam.dispose(); this.freeCam = null }
    this.scene.dispose()
  }
}
