import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera'
import type { Camera } from '@babylonjs/core/Cameras/camera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import type { AssetContainer } from '@babylonjs/core/assetContainer'
import type { AnimationGroup } from '@babylonjs/core/Animations/animationGroup'
import '../model/gltf'
import type { FormEngine } from '../core/engine'
import type { ThreadMeta } from '../protocol/thread-index'
import { toFile } from '../model/poster'
import { validateGLB } from '../model/limits'
import { worldBox, frameDistance, dominantFacing } from '../model/facing'
import type { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial'
import {
  makeCardMaterial, setCardTexture, setCardTint, setCardWhite, setCardFlip, setCardOpacity,
} from '../board/cardMaterial'
import { makeSpotlightTexture, paintSpotlight, makeContactShadow, luminance } from '../core/gfx'
import { theme } from '../theme'

/**
 * Detail viewer: exactly one interactive model. Uses the model's own cameras
 * when present (switchable), else an orbit camera auto-fit to the model.
 */
export class Viewer {
  readonly scene: Scene
  private orbit: ArcRotateCamera
  private container: AssetContainer | null = null
  private anims: AnimationGroup[] = []
  private active: AnimationGroup | null = null
  private imported: Camera[] = []
  private camIdx = -1 // -1 = orbit/auto
  private counts = { meshes: 0, vertices: 0 }
  private backdrop: Mesh
  private backdropTex: DynamicTexture
  private glow: Mesh
  private glowMat: ShaderMaterial
  private background: string = theme.background
  private backdropDistance = 120
  // Guards against overlapping models: every load takes a ticket, and a load
  // whose ticket is stale by the time its GLB finishes parsing throws its
  // container away instead of adding it to the scene.
  private loadToken = 0
  private pending = false
  private form: FormEngine
  private camHash = ''

  constructor(engine: FormEngine) {
    this.form = engine
    this.scene = new Scene(engine.engine)
    this.scene.clearColor = Color4.FromHexString(this.background + 'FF')
    this.orbit = new ArcRotateCamera('viewer-orbit', -Math.PI / 2, Math.PI / 2.2, 6, Vector3.Zero(), this.scene)
    this.orbit.wheelPrecision = 50
    this.orbit.lowerRadiusLimit = 0.1
    this.orbit.upperRadiusLimit = 200
    this.orbit.panningSensibility = 120
    this.orbit.pinchPrecision = 60
    this.orbit.useNaturalPinchZoom = true
    this.scene.activeCamera = this.orbit

    // Neutral light rig (lights only — the environment-texture IBL path
    // blackened PBR models on this GL driver, so it is deliberately absent).
    const hemi = new HemisphericLight('vl', new Vector3(0, 1, 0), this.scene)
    hemi.intensity = 0.95
    hemi.groundColor = new Color3(0.24, 0.24, 0.27)
    const key = new DirectionalLight('vk', new Vector3(-0.4, -0.6, 0.8), this.scene)
    key.intensity = 1.25
    const fill = new DirectionalLight('vf', new Vector3(0.5, 0.2, -0.6), this.scene)
    fill.intensity = 0.45

    // Spotlight backdrop. It is a child of the camera placed at local +Z
    // (a camera's forward axis is +Z in Babylon's left-handed space — the
    // old code used -Z, i.e. BEHIND the camera, which is why the viewer was
    // a black void with a stray white band) and it is OPAQUE, so it draws in
    // the opaque pass behind the model instead of over it.
    this.backdrop = MeshBuilder.CreatePlane('viewer-backdrop', { width: 1, height: 1 }, this.scene)
    this.backdrop.isPickable = false
    this.backdrop.parent = this.orbit
    this.backdrop.rotation.set(0, 0, 0)
    const bm = makeCardMaterial(this.scene, false)
    this.backdrop.material = bm
    this.backdropTex = makeSpotlightTexture(this.scene, 'viewer-bg-tex', this.background)
    setCardTexture(bm, this.backdropTex)
    setCardWhite(bm)
    setCardFlip(bm, 'dyn')

    // Soft elliptical contact shadow under the model — a spatial reference
    // (the old version was a huge 38%-white disc that read as a white floor).
    this.glow = MeshBuilder.CreatePlane('viewer-glow', { width: 4, height: 4 }, this.scene)
    this.glow.isPickable = false
    this.glow.rotation.x = Math.PI / 2
    this.glow.setEnabled(false)
    const gm = makeCardMaterial(this.scene)
    this.glow.material = gm
    this.glowMat = gm
    setCardTexture(gm, makeContactShadow(this.scene, 'viewer-shadow-tex'))
    setCardTint(gm, '#000000')
    setCardOpacity(gm, 0.5)
    setCardFlip(gm, 'dyn')

    this.scene.onBeforeRenderObservable.add(() => this.frameBackdrop())
  }

  /** Keep the backdrop glued to the active camera and filling its frustum. */
  private frameBackdrop(): void {
    const cam = this.scene.activeCamera
    if (!cam) return
    if (this.backdrop.parent !== cam) {
      this.backdrop.parent = cam
      this.backdrop.rotation.set(0, 0, 0)
    }
    const eng = this.scene.getEngine()
    const aspect = eng.getRenderWidth() / Math.max(1, eng.getRenderHeight())
    const fov = (cam as ArcRotateCamera).fov || 0.8
    const far = (cam.maxZ || 1000)
    const d = Math.max(cam.minZ * 4 + 0.01, Math.min(far * 0.86, this.backdropDistance))
    const hh = Math.tan(fov / 2) * d * 1.06
    this.backdrop.position.set(0, 0, d)
    this.backdrop.scaling.set(hh * 2 * aspect, hh * 2, 1)
  }

  setBackground(hex: string): void {
    this.form.invalidate(3)
    this.background = hex
    this.scene.clearColor = Color4.FromHexString(hex + 'FF')
    paintSpotlight(this.backdropTex, hex)
    setCardTint(this.glowMat, luminance(hex) < 0.5 ? '#000000' : '#1a1a20')
    setCardOpacity(this.glowMat, luminance(hex) < 0.5 ? 0.5 : 0.22)
  }

  get cameraCount(): number { return this.imported.length }
  get camIndex(): number { return this.camIdx }

  attach(): void {
    if (this.scene.activeCamera === this.orbit) this.orbit.attachControl(true)
  }
  detach(): void { this.orbit.detachControl() }

  async load(blob: Blob, meta: ThreadMeta): Promise<void> {
    this.clear()
    const token = ++this.loadToken
    this.pending = true
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const report = validateGLB(bytes)
      if (!report.ok) throw new Error(report.reason)
      const container = await LoadAssetContainerAsync(toFile(blob, 'model.glb'), this.scene)
      // Superseded while we were parsing (fast prev/next, or the user went
      // back to the board): drop it on the floor. Without this, BOTH models
      // ended up in the single-model view, stacked on top of each other, and
      // the older container was never disposed.
      if (token !== this.loadToken) {
        container.removeAllFromScene()
        container.dispose()
        return
      }
      this.pending = false
      container.addAllToScene()
      for (const m of container.meshes) {
        if (m.material) m.material.backFaceCulling = false
      }
      this.container = container
      this.imported = container.cameras.slice()
      this.anims = container.animationGroups

      let verts = 0
      for (const m of container.meshes) verts += m.getTotalVertices() || 0
      this.counts = { meshes: container.meshes.length, vertices: verts }

      // Camera policy (04 §5): preview-camera index -> first imported -> orbit.
      let idx = -1
      if (meta.previewCamera !== undefined && meta.previewCamera >= 0 && meta.previewCamera < this.imported.length) idx = meta.previewCamera
      else if (this.imported.length > 0) idx = 0
      this.applyCamera(idx)

      this.form.invalidate(4)
      if (this.anims.length) {
        const a = meta.previewAnimation ?? 0
        this.active = this.anims[Math.min(a, this.anims.length - 1)]
        this.active.start(true)
      }
    } catch (err) {
      if (token === this.loadToken) { this.pending = false; this.clear() }
      throw new Error('model failed to load: ' + (err as Error)?.message)
    }
  }

  /** True while a model is being fetched/parsed for this view. */
  get busy(): boolean { return this.pending }

  /**
   * Render-on-demand probe (see core/engine.ts): the viewer needs frames
   * while an animation plays, while a model is loading, or while the camera
   * is still moving — including ArcRotate's inertia glide after a drag.
   */
  isAnimating(): boolean {
    if (this.pending) return true
    if (this.active?.isPlaying) return true
    const cam = this.scene.activeCamera
    if (!cam) return false
    const p = cam.position
    const t = (cam as ArcRotateCamera).target
    const hash = `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)},${t ? t.x.toFixed(4) + ',' + t.y.toFixed(4) + ',' + t.z.toFixed(4) : ''}`
    if (hash !== this.camHash) { this.camHash = hash; return true }
    return false
  }

  /**
   * Meshes in the scene that are NOT the viewer's own helpers. Must always
   * equal the current container's mesh count — anything more means a stale
   * model leaked into the single-model view (scripts/interact.mjs asserts it).
   */
  sceneModelMeshCount(): number {
    let n = 0
    for (const m of this.scene.meshes) if (m !== this.backdrop && m !== this.glow) n++
    return n
  }

  applyCamera(idx: number): void {
    this.camIdx = idx
    if (idx >= 0 && this.imported[idx]) {
      this.orbit.detachControl()
      const cam = this.imported[idx]
      if (cam instanceof FreeCamera) { cam.minZ = 0.001; cam.maxZ = 100000 }
      this.scene.activeCamera = cam
    } else {
      this.camIdx = -1
      this.fitOrbit()
      this.scene.activeCamera = this.orbit
      this.orbit.attachControl(true)
    }
  }

  cycleCamera(): void {
    const n = this.imported.length
    const next = this.camIdx + 1
    this.applyCamera(next >= n ? -1 : next)
  }

  private fitOrbit(): void {
    if (!this.container) return
    const { min, max, center, radius } = worldBox(this.container)
    const eng = this.scene.getEngine()
    const aspect = eng.getRenderWidth() / Math.max(1, eng.getRenderHeight())
    // Open on the SAME side the poster was rendered from. The orbit camera used
    // to start at alpha=-PI/2 (the -Z side), i.e. behind flat content, so the
    // viewer showed mirrored wordmarks even though the card was correct.
    const facing = dominantFacing(this.container)
    const TILT = 0.12 // a few degrees of elevation for a little depth
    const dir = facing.scale(Math.cos(TILT)).add(new Vector3(0, Math.sin(TILT), 0)).normalize()
    const dist = frameDistance(min, max, center, dir.scale(-1), this.orbit.fov || 0.8, aspect, 0.8)
    this.orbit.setTarget(center)
    this.orbit.setPosition(center.add(dir.scale(Math.max(0.6, dist))))
    this.orbit.lowerRadiusLimit = Math.max(0.05, radius * 0.1)
    this.orbit.upperRadiusLimit = Math.max(1, radius * 12)
    this.orbit.minZ = Math.max(0.001, (dist - radius) * 0.2)
    this.orbit.maxZ = dist + radius * 8
    this.orbit.wheelPrecision = Math.max(1, 60 / Math.max(0.05, radius))
    this.orbit.panningSensibility = Math.max(10, 900 / Math.max(0.05, radius))
    // contact shadow on the ground plane under the model
    this.glow.setEnabled(true)
    this.glow.position.set(center.x, min.y - radius * 0.02, center.z)
    this.glow.scaling.set(radius * 1.9, radius * 1.9, 1)
    this.backdropDistance = Math.max(20, Math.min(dist * 6, radius * 26))
  }

  isPlaying(): boolean { return !!this.active?.isPlaying }

  toggleAnimation(): void {
    if (!this.active && this.anims[0]) this.active = this.anims[0]
    if (!this.active) return
    if (this.active.isPlaying) this.active.pause()
    else this.active.play(true)
  }

  stats(): { meshes: number; vertices: number; animations: number; cameras: number } {
    return { ...this.counts, animations: this.anims.length, cameras: this.imported.length }
  }

  clear(): void {
    // cancel anything still in flight so it cannot land in the scene later
    this.loadToken++
    this.pending = false
    this.glow?.setEnabled(false)
    this.active?.stop()
    this.active = null
    this.anims = []
    this.imported = []
    this.camIdx = -1
    if (this.container) { this.container.removeAllFromScene(); this.container.dispose() }
    this.container = null
    // Safety net: anything that is not one of the viewer's own helpers must
    // not survive a clear (a leaked container would otherwise stack up).
    for (const mesh of [...this.scene.meshes]) {
      if (mesh !== this.backdrop && mesh !== this.glow) mesh.dispose()
    }
    for (const tn of [...this.scene.transformNodes]) tn.dispose()
    for (const cam of [...this.scene.cameras]) if (cam !== this.orbit) cam.dispose()
    this.scene.activeCamera = this.orbit
  }

  dispose(): void { this.clear(); this.scene.dispose() }
}
