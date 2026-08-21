import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import type { Camera } from '@babylonjs/core/Cameras/camera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import type { AssetContainer } from '@babylonjs/core/assetContainer'
import type { HighlightLayer } from '@babylonjs/core/Layers/highlightLayer'
import type { Sound } from '@babylonjs/core/Audio/sound'
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import '../model/gltf'
import type { FormEngine } from '../core/engine'
import type { ThreadMeta } from '../protocol/thread-index'
import { validateGLBCached } from '../model/limits'
import { worldBox, frameDistance, dominantFacing } from '../model/facing'
import { playModelSounds } from '../board/modelSounds'
import type { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial'
import {
  makeCardMaterial, setCardTexture, setCardTint, setCardWhite, setCardFlip, setCardOpacity,
} from '../board/cardMaterial'
import { makeSpotlightTexture, paintSpotlight, makeContactShadow, luminance } from '../core/gfx'
import { graphics } from '../render/graphics'
import { theme } from '../theme'
import { TrackAnimator } from './animator'

/**
 * Detail viewer: exactly one interactive model. One ORBIT camera at a time:
 * auto-fit to the model (A dot), or seeded from one of the model's own
 * authored cameras (numbered dots / C) — the author's position + fov, model
 * center as pivot — so every view is fully navigable (AMENDMENT 87).
 */
export class Viewer {
  readonly scene: Scene
  private orbit: ArcRotateCamera
  private container: AssetContainer | null = null
  /** Multi-track playback driver (tracks / timeline / stepped / dir / speed). */
  readonly animator = new TrackAnimator()
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
  private camPrefs = { fov: 46, near: 0.01, far: 2000, inertia: 0.7, invertY: false }
  private contactStrength = 0.5
  /** The model's world AABB (worldBox), re-derived per adopt. */
  private modelBox: { min: Vector3; max: Vector3; center: Vector3; radius: number } | null = null
  /** Embedded model audio (MSFT_audio_emitter). Off until the user taps it. */
  private readonly soundOwner = { sounds: [] as Sound[], soundTimer: null as number | null }
  private claimedSounds = new Set<Sound>()
  /** Board setting: "everything opens paused" applies to the viewer too. */
  private autoplay = true
  // Model outline (settings: Post-processing -> Model outline). The layer is
  // created on demand so the setting costs nothing while it is off.
  private hl: HighlightLayer | null = null
  private hlOn = false
  private hlColor = '#FF5C35'

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

    this.scene.onBeforeRenderObservable.add(() => {
      this.frameBackdrop()
      this.adaptNearPlane()
      // no dt argument: engine.getDeltaTime() is 0 under FormEngine's
      // demand-driven RAF loop, so the animator measures wall time itself
      this.animator.tick()
    })

    // PERF: playing animation, an in-flight load, or a camera that actually
    // moved (orbit inertia glide included).
    engine.addAnimationSource(() => engine.activeScene === this.scene && this.isAnimating())
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

  /** Test hook (scripts/viewer.mjs): the box orbit/framing use. */
  modelBoxForTest(): { min: Vector3; max: Vector3; center: Vector3; radius: number } | null {
    return this.modelBox
  }

  /** Settings → Camera. FOV is degrees; clips are world units. */
  setCameraSettings(o: { fov: number; near: number; far: number; inertia: number; invertY: boolean }): void {
    this.camPrefs = { ...o }
    this.orbit.fov = (o.fov * Math.PI) / 180
    this.orbit.inertia = Math.max(0, Math.min(0.95, o.inertia))
    this.orbit.panningInertia = this.orbit.inertia
    this.orbit.invertRotation = o.invertY
    if (this.container) {
      this.orbit.minZ = o.near
      this.orbit.maxZ = o.far
    }
    this.form.kick()
  }

  /** Settings → Lighting: ground contact shadow opacity. */
  setContactShadows(strength: number): void {
    this.contactStrength = Math.max(0, Math.min(1, strength))
    setCardOpacity(this.glowMat, this.contactStrength)
    if (this.container) this.glow.setEnabled(this.contactStrength > 0)
    this.form.kick()
  }

  /** The viewer's own helper meshes — graphics excludes these from glow. */
  get overlayMeshes(): Mesh[] { return [this.backdrop, this.glow] }

  /** Settings → Post-processing: rim outline around the loaded model. */
  async setHighlight(on: boolean, colorHex: string): Promise<void> {
    this.hlOn = on
    if (/^#[0-9a-f]{6}$/i.test(colorHex)) this.hlColor = colorHex
    if (on && !this.hl) {
      try {
        const [{ HighlightLayer }] = await Promise.all([
          import('@babylonjs/core/Layers/highlightLayer'),
          import('@babylonjs/core/Layers/effectLayerSceneComponent'),
        ])
        if (this.scene.isDisposed) return
        this.hl ??= new HighlightLayer('viewer-hl', this.scene)
      } catch {
        return // no layer, no outline — the setting already round-trips
      }
    }
    this.syncHighlight()
    this.form.kick()
  }

  /** Rebuild the outline set from the CURRENT container + preference. */
  private syncHighlight(): void {
    const hl = this.hl
    if (!hl) return
    hl.removeAllMeshes()
    if (!this.hlOn || !this.container) return
    const color = Color3.FromHexString(this.hlColor)
    for (const m of this.container.meshes) {
      if (m instanceof Mesh && m.isEnabled() && m.getTotalVertices() > 0) hl.addMesh(m, color)
    }
  }

  setBackground(hex: string): void {
    this.form.kick()
    this.background = hex
    this.scene.clearColor = Color4.FromHexString(hex + 'FF')
    this.repaintBackdrop()
    setCardTint(this.glowMat, luminance(hex) < 0.5 ? '#000000' : '#1a1a20')
    setCardOpacity(this.glowMat, luminance(hex) < 0.5 ? 0.5 : 0.22)
  }

  /** Repaint the spotlight backdrop for the CURRENT viewport aspect (a
   *  square gradient stretched across a phone screen was the flat-grey-slab
   *  regression; the counter-stretch in paintSpotlight needs the aspect). */
  private repaintBackdrop(): void {
    const eng = this.scene.getEngine()
    const aspect = eng.getRenderWidth() / Math.max(1, eng.getRenderHeight())
    paintSpotlight(this.backdropTex, this.background, aspect)
  }

  get cameraCount(): number { return this.imported.length }
  get camIndex(): number { return this.camIdx }

  attach(): void {
    if (this.scene.activeCamera === this.orbit) this.orbit.attachControl(true)
  }
  detach(): void { this.orbit.detachControl() }

  resize(): void { this.repaintBackdrop() }

  async load(bytes: Uint8Array, meta: ThreadMeta): Promise<void> {
    this.clear()
    const token = ++this.loadToken
    this.pending = true
    try {
      const report = validateGLBCached(bytes, meta.sha256)
      if (!report.ok) throw new Error(report.reason)
      const container = await LoadAssetContainerAsync(bytes, this.scene, { pluginExtension: '.glb' })
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
      this.adopt(container, meta)
    } catch (err) {
      if (token === this.loadToken) { this.pending = false; this.clear() }
      throw new Error('model failed to load: ' + (err as Error)?.message)
    }
  }

  /**
   * Take ownership of an ALREADY-PARSED AssetContainer bound to THIS viewer's
   * scene (the caller — the board's preview pool — runs `handoffContainer`
   * which clones meshes/materials/animationGroups from previewScene into
   * viewer.scene and disposes the source). Bypasses LoadAssetContainerAsync,
   * so the viewer opens instantly on a model that was already live-previewing.
   *
   * Falls back to the byte-loading path silently if anything looks off: a
   * stale loadToken, a disposed container, or a stage that is no longer the
   * active scene — the user still gets a working viewer, just with the parse.
   */
  loadFromContainer(container: AssetContainer, meta: ThreadMeta): void {
    this.clear()
    const token = ++this.loadToken
    if (container.scene !== this.scene) {
      // Defensive: only adopt containers already bound to our scene. Throw
      // (don't return silently) so the caller's catch rolls the preview slot
      // back and re-parses from bytes — a silent return would commit the
      // slot and leave a BLANK viewer with no loading ring (AMENDMENT 87).
      this.loadToken++
      throw new Error('handoff container is not bound to the viewer scene')
    }
    try {
      this.pending = false
      this.adopt(container, meta)
    } catch (err) {
      if (token === this.loadToken) { this.pending = false; this.clear() }
      throw new Error('model handoff failed: ' + (err as Error)?.message)
    }
  }

  /** Wire a parsed container into the viewer state (camera, anims, glow, lights, audio). */
  private adopt(container: AssetContainer, meta: ThreadMeta): void {
    container.addAllToScene()
    for (const m of container.meshes) {
      if (m.material) m.material.backFaceCulling = false
    }
    this.container = container
    this.modelBox = worldBox(container)
    graphics.trackContainer(container)
    graphics.applyToContainer(container)
    graphics.setShadowCasters(this.scene, container.meshes.filter((m) => m.getTotalVertices() > 0))
    this.syncHighlight()
    this.imported = container.cameras.slice()
    this.claimSounds(container)

    let verts = 0
    for (const m of container.meshes) verts += m.getTotalVertices() || 0
    this.counts = { meshes: container.meshes.length, vertices: verts }

    // Camera policy (04 §5): preview-camera index -> first imported -> orbit.
    let idx = -1
    if (meta.previewCamera !== undefined && meta.previewCamera >= 0 && meta.previewCamera < this.imported.length) idx = meta.previewCamera
    else if (this.imported.length > 0) idx = 0
    this.applyCamera(idx)

    this.form.kick()
    // Same policy as before: the authored preview-animation (or track 0)
    // starts playing on open — but through the manual driver, and only when
    // the board's "cards start animating in view" setting says so (the
    // viewer obeys the same preference, AMENDMENT 87).
    this.animator.setGroups(container.animationGroups, meta.previewAnimation ?? 0, this.autoplay)
  }

  /** Board setting: "everything opens paused" applies to the viewer too. */
  setAutoplay(on: boolean): void { this.autoplay = on }

  /**
   * Take ownership of this model's MSFT_audio_emitter sounds (loader-created
   * on the byte path, hand-off-transferred on the live-preview path). They
   * stay PAUSED: like the board, sound only starts on an explicit tap
   * (AMENDMENT 87 — the viewer's S key / sound button).
   */
  private claimSounds(container: AssetContainer): void {
    const nodes = new Set<unknown>(container.meshes)
    for (const t of container.transformNodes) nodes.add(t)
    for (const r of container.rootNodes) nodes.add(r)
    for (const s of this.scene.mainSoundTrack.soundCollection) {
      if (this.claimedSounds.has(s)) continue
      const attached = (s as unknown as { _connectedTransformNode?: TransformNode })._connectedTransformNode ?? null
      if (attached && nodes.has(attached)) {
        this.claimedSounds.add(s)
        this.soundOwner.sounds.push(s)
      }
    }
  }

  get soundCount(): number { return this.soundOwner.sounds.length }
  get soundOn(): boolean { return this.soundOwner.sounds.some((s) => s.isPlaying) }

  /** S key / sound button. No-op (and hidden in the HUD) when trackless. */
  toggleSound(): void {
    if (!this.soundOwner.sounds.length) return
    if (this.soundOn) {
      if (this.soundOwner.soundTimer !== null) {
        clearInterval(this.soundOwner.soundTimer)
        this.soundOwner.soundTimer = null
      }
      for (const s of this.soundOwner.sounds) if (s.isPlaying) s.pause()
    } else {
      playModelSounds(this.soundOwner)
    }
    this.form.kick()
  }

  private stopSounds(): void {
    if (this.soundOwner.soundTimer !== null) {
      clearInterval(this.soundOwner.soundTimer)
      this.soundOwner.soundTimer = null
    }
    for (const s of this.soundOwner.sounds) {
      this.claimedSounds.delete(s)
      try { s.dispose() } catch { /* already gone */ }
    }
    this.soundOwner.sounds.length = 0
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
    if (this.animator.playing) return true
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

  /**
   * Switch camera mode: -1 = auto-fit orbit, >=0 = one of the model's own
   * cameras. EITHER WAY the controlled camera is the orbit — an authored
   * camera only SEEDS it (the author's position + fov, model center as
   * pivot) instead of becoming a frozen, control-less view (AMENDMENT 87):
   * the player sees the author's framing and can immediately orbit, zoom
   * and pan from it. Re-clicking a dot re-seeds (snap back to the authored
   * framing); the A dot re-fits from the dominant face.
   */
  applyCamera(idx: number): void {
    const authored = idx >= 0 ? this.imported[idx] : undefined
    if (authored && this.modelBox) {
      this.camIdx = idx
      this.seedFromAuthored(authored)
    } else {
      this.camIdx = -1
      this.fitOrbit()
    }
    this.scene.activeCamera = this.orbit
    this.orbit.attachControl(true)
    this.form.kick()
  }

  /** Re-frame the CURRENT mode (fit button / F key). */
  refit(): void {
    if (this.camIdx >= 0 && this.imported[this.camIdx]) {
      this.seedFromAuthored(this.imported[this.camIdx])
    } else {
      this.fitOrbit()
    }
    this.form.kick()
  }

  cycleCamera(): void {
    const n = this.imported.length
    const next = this.camIdx + 1
    this.applyCamera(next >= n ? -1 : next)
  }

  /**
   * Kill the orbit's residual glide. Under the demand-driven loop a drag's
   * inertia only decays WHILE frames render — if rendering stops mid-glide
   * (static model, paused animation, idle), the offsets FREEZE and the next
   * render trigger (F, a camera dot, a settings kick) applies them, dragging
   * the freshly re-framed pose off (AMENDMENT 87).
   */
  private stopOrbitInertia(): void {
    this.orbit.inertialAlphaOffset = 0
    this.orbit.inertialBetaOffset = 0
    this.orbit.inertialRadiusOffset = 0
    this.orbit.inertialPanningX = 0
    this.orbit.inertialPanningY = 0
  }

  /** Auto-fit orbit from the model's dominant face (the poster's side). */
  private fitOrbit(): void {
    this.stopOrbitInertia()
    const box = this.modelBox
    const container = this.container
    if (!box || !container) return
    const { min, max, center } = box
    const eng = this.scene.getEngine()
    const aspect = eng.getRenderWidth() / Math.max(1, eng.getRenderHeight())
    // Open on the SAME side the poster was rendered from. The orbit camera used
    // to start at alpha=-PI/2 (the -Z side), i.e. behind flat content, so the
    // viewer showed mirrored wordmarks even though the card was correct.
    const facing = dominantFacing(container)
    const TILT = 0.12 // a few degrees of elevation for a little depth
    const dir = facing.scale(Math.cos(TILT)).add(new Vector3(0, Math.sin(TILT), 0)).normalize()
    const dist = frameDistance(min, max, center, dir.scale(-1), this.orbit.fov || 0.8, aspect, 0.8)
    this.orbit.setTarget(center)
    this.orbit.setPosition(center.add(dir.scale(Math.max(0.6, dist))))
    this.applyFraming(Math.max(0.1, dist))
  }

  /**
   * Seed the orbit from an authored camera (AMENDMENT 87): the author's
   * world position as the camera position, the author's fov, and the orbit
   * pivot placed ON the authored forward ray — the authored composition is
   * position + direction + fov, and any pivot distance along that ray keeps
   * the identical view (we use the distance to the model center so
   * orbiting still rotates around the model when it is in view).
   */
  private seedFromAuthored(cam: Camera): void {
    this.stopOrbitInertia()
    const box = this.modelBox!
    const wm = cam.getWorldMatrix()
    const pos = new Vector3(wm.m[12], wm.m[13], wm.m[14])
    // Babylon cameras look down local +Z (left-handed system).
    const fwd = Vector3.TransformNormal(new Vector3(0, 0, 1), wm)
    const toCenter = Vector3.Distance(pos, box.center)
    let target: Vector3
    let dist: number
    if (fwd.lengthSquared() > 0.5) {
      fwd.normalize()
      dist = Math.max(0.5, toCenter)
      target = pos.add(fwd.scale(dist)) // NOT addInPlace: pos is the camera position
    } else if (toCenter >= 0.05) {
      // Degenerate world matrix: look at the model center instead.
      dist = toCenter
      target = box.center
    } else {
      // Parked at the model's center with a degenerate matrix: pivot 0.5
      // units along the dominant face (zero radius = NaN angles).
      target = box.center.add(dominantFacing(this.container!).scale(0.5))
      dist = 0.5
    }
    const fov = (cam as { fov?: number }).fov
    if (typeof fov === 'number' && fov > 0.1 && fov < 1.6) this.orbit.fov = fov
    this.orbit.target.copyFrom(target)
    this.orbit.setPosition(pos)
    this.applyFraming(dist)
  }

  /**
   * Per-model orbit limits (radius-dependent wheel/pan feel + frustum clips)
   * for the current framing distance. The near plane set here is only a
   * STARTING value — adaptNearPlane() keeps it proportional to the live
   * camera-to-model distance so close-ups of small parts never clip
   * (AMENDMENT 87).
   */
  private applyFraming(dist: number): void {
    const { min, center, radius } = this.modelBox!
    this.orbit.lowerRadiusLimit = Math.max(0.05, radius * 0.1)
    this.orbit.upperRadiusLimit = Math.max(1, radius * 12)
    this.orbit.minZ = Math.max(this.camPrefs.near, Math.min(this.camPrefs.near * 100, (dist - radius) * 0.2))
    this.orbit.maxZ = Math.min(this.camPrefs.far, dist + radius * 8)
    this.orbit.wheelPrecision = Math.max(1, 60 / Math.max(0.05, radius))
    this.orbit.panningSensibility = Math.max(10, 900 / Math.max(0.05, radius))
    // contact shadow on the ground plane under the model
    this.glow.setEnabled(this.contactStrength > 0)
    this.glow.position.set(center.x, min.y - radius * 0.02, center.z)
    this.glow.scaling.set(radius * 1.9, radius * 1.9, 1)
    this.backdropDistance = Math.max(20, Math.min(dist * 6, radius * 26))
  }

  /**
   * Keep the near plane proportional to the camera's distance to the model
   * box (10% of it, floored by the user's near setting; the floor alone when
   * the camera is inside the box). The old fixed model-sized minZ let the
   * player wheel-zoom closer than the near plane (lowerRadiusLimit < minZ),
   * slicing any part smaller than the whole model (AMENDMENT 87). Runs per
   * rendered frame — one AABB distance, no allocations.
   */
  private adaptNearPlane(): void {
    const box = this.modelBox
    if (!box || this.scene.activeCamera !== this.orbit) return
    const p = this.orbit.position
    const dx = Math.max(box.min.x - p.x, 0, p.x - box.max.x)
    const dy = Math.max(box.min.y - p.y, 0, p.y - box.max.y)
    const dz = Math.max(box.min.z - p.z, 0, p.z - box.max.z)
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const near = d <= 0 ? this.camPrefs.near : Math.max(this.camPrefs.near, d * 0.1)
    if (Math.abs(near - this.orbit.minZ) > this.orbit.minZ * 0.01 + 1e-5) this.orbit.minZ = near
  }

  isPlaying(): boolean { return this.animator.playing }

  toggleAnimation(): void {
    this.animator.toggle()
    this.form.kick()
  }

  stats(): { meshes: number; vertices: number; animations: number; cameras: number } {
    return { ...this.counts, animations: this.animator.count, cameras: this.imported.length }
  }

  clear(): void {
    // cancel anything still in flight so it cannot land in the scene later
    this.loadToken++
    this.pending = false
    this.glow?.setEnabled(false)
    this.animator.clear()
    this.stopSounds()
    this.imported = []
    this.camIdx = -1
    this.modelBox = null
    if (this.container) {
      graphics.untrackContainer(this.container)
      this.container.removeAllFromScene()
      this.container.dispose()
    }
    this.container = null
    // Safety net: anything that is not one of the viewer's own helpers must
    // not survive a clear (a leaked container would otherwise stack up).
    for (const mesh of [...this.scene.meshes]) {
      if (mesh !== this.backdrop && mesh !== this.glow) mesh.dispose()
    }
    this.syncHighlight()
    for (const tn of [...this.scene.transformNodes]) tn.dispose()
    for (const cam of [...this.scene.cameras]) if (cam !== this.orbit) cam.dispose()
    this.scene.activeCamera = this.orbit
  }

  dispose(): void { this.clear(); this.scene.dispose() }
}
