import { Scene } from '@babylonjs/core/scene'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import type { AssetContainer } from '@babylonjs/core/assetContainer'
import type { AnimationGroup } from '@babylonjs/core/Animations/animationGroup'
import type { Sound } from '@babylonjs/core/Audio/sound'
// Registers the scene's mainSoundTrack (MSFT_audio_emitter sounds land there).
import '@babylonjs/core/Audio/audioSceneComponent'
import '../model/gltf'
import { configureDraco } from '../model/draco'
import { worldBox, dominantFacing } from '../model/facing'
import { validateGLBCached } from '../model/limits'
import { graphics } from '../render/graphics'

/** Model bytes + content hash + the authored camera index (v3 `preview-camera`). */
export interface DirectModel {
  bytes: Uint8Array
  sha256: string
  cameraIndex?: number
}

/** Where a direct-3D model should sit (world units, in the flat scene). */
export interface Place3D {
  x: number
  y: number
  z: number
  w: number
  h: number
  /** depth allowance — how far the model may extend along ±Z. */
  depth: number
}

interface Slot {
  postId: string | null
  pending: boolean
  visible: boolean
  playing: boolean
  started: boolean
  root: TransformNode | null
  orient: TransformNode | null
  fit: TransformNode | null
  container: AssetContainer | null
  anims: AnimationGroup[]
  sounds: Sound[]
  soundTimer: number | null
  /** oriented extents in model space AFTER the display rotation (unit size). */
  ext: { x: number; y: number; z: number } | null
  place: Place3D | null
  placedAt: number
}

/** How much of the card cell the model should fill (margin for badges). */
const FILL = 0.7

/**
 * Direct 3D cards: real GLB meshes rendered in the VISIBLE scene — no
 * render-to-texture, no poster. One slot per resident model; slots are
 * reused and evicted by the owning view (board / thread), which releases
 * models as they scroll or pan out of the viewport (same pipeline budget
 * as the poster/preview path).
 *
 * Framing (spec AMENDMENT 43): each model is rotated by
 * inverse(main-camera rotation) so a static camera looking along +Z sees
 * exactly the view the author framed; models without a camera fall back to
 * auto-fit (dominant facing turned toward the camera). Uniform scale then
 * fits the oriented box into the card cell.
 */
export class Direct3DPool {
  private slots: Slot[] = []
  private byPost = new Map<string, Slot>()
  private loading = new Set<string>()
  private rejected = new Set<string>()
  /** Latest target cell for a post whose load is still in flight. The card
   *  may scroll while the GLB parses; the model must land where the card is
   *  NOW, not where it was when the request fired (a stale place left models
   *  floating over the wrong card — "positions off sometimes"). */
  private pendingPlace = new Map<string, Place3D>()
  /** In-flight loads whose result nobody wants any more (toggled off). */
  private cancelled = new Set<string>()
  private claimedSounds = new Set<Sound>()
  private maxSlots: number
  private epoch = 0

  onPlaced: ((postId: string) => void) | null = null
  onReleased: ((postId: string) => void) | null = null
  onFailed: ((postId: string) => void) | null = null
  onLoadDone: (() => void) | null = null

  constructor(
    private scene: Scene,
    private getModel: (postId: string) => Promise<DirectModel | undefined>,
    opts?: { maxSlots?: number },
  ) {
    this.maxSlots = opts?.maxSlots ?? 12
    configureDraco()
    // Light rig for the lit (PBR/Standard) materials of direct models. The
    // flat card quads use an unlit ShaderMaterial, so these lights only
    // illuminate the 3D models — nothing else changes. No IBL (AGENTS rule 5:
    // scene.environmentTexture rendered every PBR model black).
    new HemisphericLight('d3-hemi', new Vector3(0, 1, 0), this.scene).intensity = 0.9
    const key = new DirectionalLight('d3-key', new Vector3(-0.4, -0.6, 0.8), this.scene)
    key.intensity = 0.8
    const fill = new DirectionalLight('d3-fill', new Vector3(0.5, 0.2, -0.6), this.scene)
    fill.intensity = 0.35
    // A fixed "front" light aimed along +Z (toward the flat camera) so the
    // side facing the viewer is always readable.
    const front = new DirectionalLight('d3-front', new Vector3(0, 0, 1), this.scene)
    front.intensity = 0.5
  }

  isLive(postId: string): boolean { return this.byPost.has(postId) }
  isLoading(postId: string): boolean { return this.loading.has(postId) }
  isRejected(postId: string): boolean { return this.rejected.has(postId) }
  isPlaying(postId: string): boolean { return this.byPost.get(postId)?.playing ?? false }
  hasAnims(postId: string): boolean { return (this.byPost.get(postId)?.anims.length ?? 0) > 0 }

  setMaxSlots(n: number): void {
    this.maxSlots = Math.max(0, Math.round(n))
    while (this.slots.length > this.maxSlots) {
      const slot = this.slots.pop()
      if (slot?.postId) this.release(slot.postId)
    }
  }

  /**
   * Load a post's model directly into the scene. Returns false when the post
   * was already rejected (a failed load) or the pool is at capacity with
   * nothing evictable — the caller falls back to the poster.
   */
  request(postId: string, place: Place3D): boolean {
    const live = this.byPost.get(postId)
    if (live) { this.place(postId, place); return true }
    if (this.loading.has(postId)) {
      this.cancelled.delete(postId)
      this.pendingPlace.set(postId, place) // card moved while parsing
      return true
    }
    if (this.rejected.has(postId)) return false

    let slot = this.slots.find((s) => !s.postId && !s.pending)
    if (!slot && this.slots.length < this.maxSlots) {
      slot = this.makeSlot()
      this.slots.push(slot)
    }
    if (!slot) slot = this.pickEvictable()
    if (!slot) return false
    if (slot.postId) this.release(slot.postId)
    slot.pending = true
    this.loading.add(postId)
    this.pendingPlace.set(postId, place)
    void this.load(slot, postId)
    return true
  }

  /** Move an already-resident model (the card scrolled / the map panned). */
  place(postId: string, place: Place3D): void {
    const slot = this.byPost.get(postId)
    if (slot) { this.applyPlace(slot, place); return }
    if (this.loading.has(postId)) this.pendingPlace.set(postId, place)
  }

  release(postId: string): void {
    const slot = this.byPost.get(postId)
    if (!slot) {
      if (this.loading.has(postId)) { this.loading.delete(postId); this.cancelled.add(postId) }
      this.pendingPlace.delete(postId)
      return
    }
    this.byPost.delete(postId)
    this.pendingPlace.delete(postId)
    this.clearSlot(slot)
    this.onReleased?.(postId)
  }

  releaseAll(): void {
    // In-flight loads keep parsing; mark them cancelled so their result is
    // discarded instead of landing in a scene that no longer wants them.
    for (const id of this.loading) this.cancelled.add(id)
    for (const id of [...this.byPost.keys()]) this.release(id)
  }

  play(postId: string, sound = false): void {
    const slot = this.byPost.get(postId)
    if (!slot || slot.anims.length === 0) return
    if (slot.started) for (const a of slot.anims) a.play(true)
    else { for (const a of slot.anims) a.start(true); slot.started = true }
    slot.playing = true
    if (sound) this.playSounds(slot)
  }

  pause(postId: string): void {
    const slot = this.byPost.get(postId)
    if (!slot) return
    if (slot.soundTimer !== null) { clearInterval(slot.soundTimer); slot.soundTimer = null }
    for (const a of slot.anims) a.pause()
    for (const s of slot.sounds) if (s.isPlaying) s.pause()
    slot.playing = false
  }

  resume(postId: string, sound = false): void { this.play(postId, sound) }

  /** True while any VISIBLE model is animating (the scene must keep drawing). */
  hasWork(visible?: ReadonlySet<string>): boolean {
    for (const slot of this.slots) {
      if (!slot.postId || !slot.playing || slot.anims.length === 0) continue
      if (visible && !visible.has(slot.postId)) continue
      return true
    }
    return false
  }

  /** Per-frame upkeep. Animations advance with the scene's own render loop,
   *  so this only tracks visibility for eviction preference. */
  tick(visible?: ReadonlySet<string>): void {
    for (const slot of this.slots) {
      if (slot.postId) slot.visible = !visible || visible.has(slot.postId)
    }
  }

  dispose(): void {
    for (const id of [...this.byPost.keys()]) this.release(id)
    this.slots = []
    this.byPost.clear()
  }

  // ------------------------------------------------------------------ internals

  private makeSlot(): Slot {
    return {
      postId: null, pending: false, visible: false, playing: false, started: false,
      root: null, orient: null, fit: null, container: null, anims: [], sounds: [],
      soundTimer: null, ext: null, place: null, placedAt: 0,
    }
  }

  private pickEvictable(): Slot | undefined {
    const offscreen = this.slots.filter((s) => s.postId && !s.pending && !s.visible)
    if (!offscreen.length) return undefined
    offscreen.sort((a, b) => a.placedAt - b.placedAt)
    return offscreen[0]
  }

  /**
   * The display rotation: inverse of the authored main camera's world
   * rotation when the model ships a camera (the static display camera looks
   * along +Z with identity rotation, so R_d·R_a⁻¹ = R_a⁻¹ — spec AMENDMENT
   * 43). Without a camera, the auto-fit camera the poster pipeline would
   * build (positioned at center + facing·d, targeting center, up = +Y) is
   * inverted the same way, so the flat camera shows exactly the poster's
   * view. A FromUnitVectorsToRef(facing, -Z) fallback is NOT equivalent: for
   * opposite vectors it picks an arbitrary 180° axis, which flips flat models
   * upside-down or mirror-inverts them (the "inverted models" regression).
   */
  private displayRotation(container: AssetContainer, cameraIndex: number): Quaternion {
    const authored = cameraIndex >= 0 && cameraIndex < container.cameras.length ? container.cameras[cameraIndex] : null
    if (authored) {
      // Camera.computeWorldMatrix() takes no args (it just reads the cached
      // world matrix) — force the recompute through the Node-level method.
      ;(authored as unknown as { computeWorldMatrix: (force?: boolean) => unknown }).computeWorldMatrix(true)
      const quat = new Quaternion()
      authored.getWorldMatrix().decompose(undefined, quat, undefined)
      return quat.invertInPlace()
    }
    // Auto-fit: model front (dominantFacing) turned toward the camera at -Z,
    // up kept as +Y (or +Z when facing is vertical). LookAtLH(eye=facing,
    // target=0) IS the inverse of the auto-fit camera's world rotation —
    // exactly what rotating the model needs to reproduce the poster view.
    const facing = dominantFacing(container).normalizeToNew()
    const up = Math.abs(facing.y) > 0.99 ? new Vector3(0, 0, 1) : Vector3.Up()
    const view = new Matrix()
    Matrix.LookAtLHToRef(facing, Vector3.Zero(), up, view)
    const quat = new Quaternion()
    Quaternion.FromRotationMatrixToRef(view, quat)
    return quat
  }

  /** Oriented world extents of the AABB after `rot` is applied (unit size). */
  private orientedExtents(box: { min: Vector3; max: Vector3 }, rot: Quaternion): { x: number; y: number; z: number } {
    const m = new Matrix()
    rot.toRotationMatrix(m)
    const mn = new Vector3(Infinity, Infinity, Infinity)
    const mx = new Vector3(-Infinity, -Infinity, -Infinity)
    const p = new Vector3()
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)
      Vector3.TransformCoordinatesToRef(p, m, p)
      mn.x = Math.min(mn.x, p.x); mn.y = Math.min(mn.y, p.y); mn.z = Math.min(mn.z, p.z)
      mx.x = Math.max(mx.x, p.x); mx.y = Math.max(mx.y, p.y); mx.z = Math.max(mx.z, p.z)
    }
    const e = 1e-4
    return {
      x: Math.max(e, mx.x - mn.x),
      y: Math.max(e, mx.y - mn.y),
      z: Math.max(e, mx.z - mn.z),
    }
  }

  private applyPlace(slot: Slot, place: Place3D): void {
    slot.place = place
    slot.placedAt = ++this.epoch
    if (!slot.root || !slot.fit || !slot.ext) return
    const { w, h, depth } = place
    const s = FILL * Math.min(w / slot.ext.x, h / slot.ext.y, Math.max(0.001, depth) / slot.ext.z)
    const clamp = Math.max(1e-4, Math.min(1000, s))
    slot.fit.scaling.setAll(clamp)
    slot.root.position.set(place.x, place.y, place.z)
  }

  private async load(slot: Slot, postId: string): Promise<void> {
    let container: AssetContainer | null = null
    const alive = (): boolean => this.slots.includes(slot)
    try {
      const model = await this.getModel(postId)
      if (!model || !alive()) throw new Error('download failed')
      if (this.cancelled.has(postId)) throw new Error('cancelled while loading')
      const report = validateGLBCached(model.bytes, model.sha256)
      if (!report.ok) throw new Error(report.reason)

      const soundBaseline = this.scene.mainSoundTrack.soundCollection.length
      container = await LoadAssetContainerAsync(model.bytes, this.scene, { pluginExtension: '.glb' })
      if (!alive()) { container.dispose(); throw new Error('slot recycled') }
      container.addAllToScene()
      slot.container = container // clearSlot() owns the cleanup from here on
      graphics.applyToContainer(container)
      for (const m of container.meshes) {
        if (m.material) m.material.backFaceCulling = false
        // Background content: taps must hit the card/node quads, never a mesh.
        m.isPickable = false
      }

      // Framing is computed BEFORE reparenting: the authored camera's world
      // matrix must reflect its authored transform, not the fit chain.
      const box = worldBox(container)
      const rot = this.displayRotation(container, model.cameraIndex ?? 0)
      const ext = this.orientedExtents(box, rot)

      const root = new TransformNode(`d3-${postId.slice(0, 8)}`, this.scene)
      const orient = new TransformNode(`d3-orient-${postId.slice(0, 8)}`, this.scene)
      const fit = new TransformNode(`d3-fit-${postId.slice(0, 8)}`, this.scene)
      orient.parent = root
      fit.parent = orient
      orient.rotationQuaternion = rot
      fit.position = box.center.scale(-1)
      for (const n of container.rootNodes) n.parent = fit
      // Reparenting dirtied the whole chain — force it or the first frame
      // renders the model at its pre-fit transform.
      root.computeWorldMatrix(true)
      orient.computeWorldMatrix(true)
      fit.computeWorldMatrix(true)
      for (const n of container.rootNodes) {
        ;(n as unknown as { computeWorldMatrix: (force?: boolean) => unknown }).computeWorldMatrix(true)
      }

      slot.root = root
      slot.orient = orient
      slot.fit = fit
      slot.anims = container.animationGroups.filter((g) => g.targetedAnimations.length > 0)
      slot.sounds = this.claimSounds(container, soundBaseline)
      slot.ext = ext
      slot.postId = postId
      slot.started = false
      slot.playing = false
      // Land at the LATEST cell, not the one captured when the request fired
      // (the board may have scrolled during the parse).
      this.applyPlace(slot, this.pendingPlace.get(postId) ?? { x: 0, y: 0, z: 0, w: 1, h: 1, depth: 1 })
      this.byPost.set(postId, slot)
      this.onPlaced?.(postId)
    } catch {
      // One cleanup path: clearSlot() disposes the container, the transform
      // chain and any claimed sounds, whatever stage the load reached.
      this.clearSlot(slot)
      if (alive() && !this.cancelled.has(postId)) this.rejected.add(postId)
      if (!this.cancelled.has(postId)) this.onFailed?.(postId)
    } finally {
      this.cancelled.delete(postId)
      this.pendingPlace.delete(postId)
      slot.pending = false
      this.loading.delete(postId)
      this.onLoadDone?.()
    }
  }

  private clearSlot(slot: Slot): void {
    if (slot.soundTimer !== null) { clearInterval(slot.soundTimer); slot.soundTimer = null }
    for (const a of slot.anims) a.stop()
    slot.anims = []
    for (const s of slot.sounds) { this.claimedSounds.delete(s); s.stop(); s.dispose() }
    slot.sounds = []
    slot.playing = false
    slot.started = false
    if (slot.container) {
      for (const n of slot.container.rootNodes) n.parent = null
      slot.container.removeAllFromScene()
      slot.container.dispose()
      slot.container = null
    }
    if (slot.root) { slot.root.dispose(true); slot.root = null; slot.orient = null; slot.fit = null }
    slot.ext = null
    slot.place = null
    slot.postId = null
    slot.visible = false
  }

  /** Find the MSFT_audio_emitter Sounds this container's load created
   *  (same ownership inference as the preview pool: node-attached emitters
   *  first, then a bounded delta of unattached ones). */
  private claimSounds(container: AssetContainer, baseline: number): Sound[] {
    const all = this.scene.mainSoundTrack.soundCollection
    const meshes = new Set(container.meshes)
    const owned: Sound[] = []
    const attachedOf = (s: Sound): TransformNode | null =>
      (s as unknown as { _connectedTransformNode?: TransformNode })._connectedTransformNode ?? null
    for (const s of all) {
      if (this.claimedSounds.has(s)) continue
      const node = attachedOf(s)
      if (node && meshes.has(node as never)) { this.claimedSounds.add(s); owned.push(s) }
    }
    for (const s of all.slice(baseline)) {
      if (this.claimedSounds.has(s) || owned.includes(s)) continue
      if (!attachedOf(s)) { this.claimedSounds.add(s); owned.push(s) }
    }
    return owned
  }

  /** Start a slot's sounds, retrying briefly for clips still decoding. */
  private playSounds(slot: Slot): void {
    if (slot.soundTimer !== null) { clearInterval(slot.soundTimer); slot.soundTimer = null }
    const pending = slot.sounds.filter((s) => !s.isReady())
    for (const s of slot.sounds) if (s.isReady()) s.play()
    if (!pending.length) return
    let tries = 0
    slot.soundTimer = window.setInterval(() => {
      if (slot.soundTimer === null) return
      tries++
      for (const s of pending) if (s.isReady()) s.play()
      if (pending.every((s) => s.isReady()) || tries >= 15) {
        clearInterval(slot.soundTimer)
        slot.soundTimer = null
      }
    }, 200)
  }
}
