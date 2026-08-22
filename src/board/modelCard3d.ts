import { Scene } from '@babylonjs/core/scene'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import type { Plane } from '@babylonjs/core/Maths/math.plane'
import type { AssetContainer } from '@babylonjs/core/assetContainer'
import type { AnimationGroup } from '@babylonjs/core/Animations/animationGroup'
import type { Sound } from '@babylonjs/core/Audio/sound'
import '../model/gltf'
import { configureDraco } from '../model/draco'
import { frameModel, placeFrame, makeCellClip, updateCellClip, type ModelFrame } from '../model/framing'
import { validateGLBCached } from '../model/limits'
import { graphics } from '../render/graphics'
import { claimModelSounds, playModelSounds } from './modelSounds'

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
  /** Centre of the model on the card/node plane (z = 0). Depth is capped so
   *  the mesh stays in front of the backdrop (board z=2) and the contact
   *  shadow (z≈1.9 in 3D). Overlays render in group 1 so they stay on top
   *  even when the mesh extends a little toward the camera. */
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
  frame: ModelFrame | null
  clip: Plane[] | null
  footprint: { cx: number; bottom: number; w: number } | null
  /** false while the model's shaders are still compiling (see hasWork). */
  warm: boolean
  warmUntil: number
  place: Place3D | null
  placedAt: number
}

/** How long to keep asking for frames while a model's shaders compile. */
const WARMUP_MS = 10_000

/**
 * Direct 3D cards: real GLB meshes rendered in the VISIBLE scene — no
 * render-to-texture, no poster. One slot per resident model; slots are
 * reused and evicted by the owning view (board / thread), which releases
 * models as they scroll or pan out of the viewport (same pipeline budget
 * as the poster/preview path).
 *
 * Framing (spec AMENDMENT 43 / 81, see model/framing.ts): each model is
 * shown through its MAIN CAMERA (rotated about the camera position, scaled
 * so that frame maps onto the card). No camera → the poster's auto-fit.
 * Close-up models are cropped to the card with clip planes.
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
    // The board scene ships a leftover dummy hemi for unlit card quads (which
    // ignore lights). Stacking another hemi + 3 directionals on top of it
    // double-lit every PBR model. Disable anything that isn't our rig.
    for (const l of this.scene.lights) {
      if (!l.name.startsWith('d3-')) l.setEnabled(false)
    }
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
  footprintOf(postId: string): { cx: number; bottom: number; w: number } | null {
    return this.byPost.get(postId)?.footprint ?? null
  }
  isPlaying(postId: string): boolean { return this.byPost.get(postId)?.playing ?? false }
  hasAnims(postId: string): boolean { return (this.byPost.get(postId)?.anims.length ?? 0) > 0 }

  setMaxSlots(n: number): void {
    this.maxSlots = Math.max(0, Math.round(n))
    while (this.slots.length > this.maxSlots) {
      const slot = this.slots.pop()
      if (slot?.postId) this.release(slot.postId)
    }
  }

  /** Place an already-parsed container (2D preview hand-off). No getModel. */
  adopt(postId: string, container: AssetContainer, place: Place3D, cameraIndex?: number, sounds?: Sound[]): boolean {
    if (this.byPost.has(postId)) { this.place(postId, place); return true }
    if (this.rejected.has(postId) || container.scene !== this.scene) return false
    const slot = this.reserveSlot(new Set([postId]))
    if (!slot) return false
    this.pendingPlace.set(postId, place)
    try {
      container.addAllToScene()
      slot.container = container
      this.install(slot, postId, container, cameraIndex, sounds ?? claimModelSounds(
        this.scene, container, this.scene.mainSoundTrack.soundCollection.length, this.claimedSounds,
      ))
      return true
    } catch {
      this.clearSlot(slot)
      this.pendingPlace.delete(postId)
      return false
    }
  }

  /**
   * Load a post's model directly into the scene. Returns false when the post
   * was already rejected (a failed load) or the pool is at capacity with
   * nothing evictable — the caller MUST retry on the next visibility pass,
   * not latch the card onto the poster path (that was the "only the first
   * N cards ever go 3D" bug).
   *
   * `visible` is the caller's fresh on-screen set. Eviction uses it instead
   * of `slot.visible`, which is only updated in tick() AFTER the request
   * pass (the same deadlock AMENDMENT 48 documented for the preview pool).
   */
  request(postId: string, place: Place3D, visible?: ReadonlySet<string>): boolean {
    const live = this.byPost.get(postId)
    if (live) { this.place(postId, place); return true }
    // Still parsing: un-cancel so a card that scrolled away and back keeps
    // the in-flight result instead of discarding it and starting over, and
    // refresh the landing cell (the card may have moved while we parsed).
    if (this.loading.has(postId)) {
      this.cancelled.delete(postId)
      this.pendingPlace.set(postId, place)
      return true
    }
    if (this.rejected.has(postId)) return false
    const slot = this.reserveSlot(visible)
    if (!slot) return false
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
      // Still loading: mark cancelled so the parse discards its result
      // instead of binding a model to a card nobody wants. Do NOT delete
      // from `loading` — request() uses that to un-cancel a scroll-back.
      // (Deleting it was the race: the parse landed on a recycled slot.)
      if (this.loading.has(postId)) this.cancelled.add(postId)
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
    for (const id of this.loading) {
      this.cancelled.add(id)
      this.pendingPlace.delete(id)
    }
    for (const id of [...this.byPost.keys()]) this.release(id)
  }

  play(postId: string, sound = false): void {
    const slot = this.byPost.get(postId)
    if (!slot || slot.anims.length === 0) return
    if (slot.started) for (const a of slot.anims) a.play(true)
    else { for (const a of slot.anims) a.start(true); slot.started = true }
    slot.playing = true
    if (sound) playModelSounds(slot)
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

  /**
   * True while any VISIBLE model still needs frames: it is animating, or its
   * shaders have not finished compiling. Demand-driven rendering only compiles
   * a material on first draw, so without this the place-frame draws nothing
   * and the next frame never comes — cards stayed blank until the user scrolled.
   */
  hasWork(visible?: ReadonlySet<string>): boolean {
    let work = false
    const now = performance.now()
    for (const slot of this.slots) {
      if (!slot.postId) continue
      if (visible && !visible.has(slot.postId)) continue
      if (slot.playing && slot.anims.length > 0) work = true
      if (!slot.warm) {
        // Keep asking on the poll that FLIPS warm — that frame is the one
        // that finally draws the model. A broken effect must not pin 30 fps
        // forever, hence the deadline.
        slot.warm = now > slot.warmUntil || this.effectsReady(slot)
        work = true
      }
    }
    return work
  }

  private effectsReady(slot: Slot): boolean {
    if (!slot.container) return true
    for (const mesh of slot.container.meshes) {
      if (mesh.getTotalVertices() <= 0) continue
      if (!mesh.isReady(true)) return false
    }
    return true
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

  private reserveSlot(visible?: ReadonlySet<string>): Slot | null {
    let slot = this.slots.find((s) => !s.postId && !s.pending)
    if (!slot && this.slots.length < this.maxSlots) {
      slot = this.makeSlot()
      this.slots.push(slot)
    }
    if (!slot) slot = this.pickEvictable(visible)
    if (!slot) return null
    if (slot.postId) this.release(slot.postId)
    return slot
  }

  private makeSlot(): Slot {
    return {
      postId: null, pending: false, visible: false, playing: false, started: false,
      root: null, orient: null, fit: null, container: null, anims: [], sounds: [],
      soundTimer: null, frame: null, clip: null, footprint: null,
      warm: false, warmUntil: 0, place: null, placedAt: 0,
    }
  }

  private pickEvictable(visible?: ReadonlySet<string>): Slot | undefined {
    // Only offscreen slots: evicting a VISIBLE card makes the caller
    // re-request it immediately (poster↔3D ping-pong). The caller's fresh
    // visible set wins over slot.visible, which tick() updates too late.
    const offscreen = this.slots.filter((s) => {
      if (!s.postId || s.pending) return false
      return visible ? !visible.has(s.postId) : !s.visible
    })
    if (!offscreen.length) return undefined
    offscreen.sort((a, b) => a.placedAt - b.placedAt)
    return offscreen[0]
  }

  /**
   * Apply a cell to a resident model. Framing was computed once at load;
   * this only maps it onto the current card / node. SCALE lives on the root
   * so the pivot translation below it is scaled too (scale on `fit` drifted
   * off-origin models by pivot·(1-scale)).
   */
  private applyPlace(slot: Slot, place: Place3D): void {
    slot.place = place
    slot.placedAt = ++this.epoch
    if (!slot.root || !slot.fit || !slot.frame) return
    const at = placeFrame(slot.frame, place)
    slot.root.scaling.setAll(at.scale)
    slot.root.position.set(at.x, at.y, at.z)
    slot.footprint = at.footprint
    if (slot.clip) updateCellClip(slot.clip, place)
  }

  /** Frame + parent a container that is already in this scene. */
  private install(
    slot: Slot,
    postId: string,
    container: AssetContainer,
    cameraIndex: number | undefined,
    sounds: Sound[],
  ): void {
    graphics.applyToContainer(container)
    const clip = makeCellClip()
    for (const mat of container.materials) {
      mat.clipPlane = clip[0]
      mat.clipPlane2 = clip[1]
      mat.clipPlane3 = clip[2]
      mat.clipPlane4 = clip[3]
    }
    for (const m of container.meshes) {
      if (m.material) m.material.backFaceCulling = false
      // Background content: taps must hit the card/node quads, never a mesh.
      m.isPickable = false
    }
    // Imported GLB lights/cameras lit neighbouring cards. The pool's own
    // rig is the only light; the flat camera is the only camera.
    for (const l of container.lights) l.setEnabled(false)
    for (const c of container.cameras) c.setEnabled(false)

    const cell = this.pendingPlace.get(postId)
    const aspect = cell && cell.h > 0 ? cell.w / cell.h : 1.6
    const frame = frameModel(container, cameraIndex ?? 0, aspect)

    const root = new TransformNode(`d3-${postId.slice(0, 8)}`, this.scene)
    const orient = new TransformNode(`d3-orient-${postId.slice(0, 8)}`, this.scene)
    const fit = new TransformNode(`d3-fit-${postId.slice(0, 8)}`, this.scene)
    orient.parent = root
    fit.parent = orient
    orient.rotationQuaternion = frame.rot
    fit.position = frame.pivot.scale(-1)
    for (const n of container.rootNodes) n.parent = fit
    root.computeWorldMatrix(true)
    orient.computeWorldMatrix(true)
    fit.computeWorldMatrix(true)
    for (const n of container.rootNodes) {
      ;(n as unknown as { computeWorldMatrix: (force?: boolean) => unknown }).computeWorldMatrix(true)
    }

    slot.root = root
    slot.orient = orient
    slot.fit = fit
    slot.clip = clip
    slot.anims = container.animationGroups.filter((g) => g.targetedAnimations.length > 0)
    for (const g of container.animationGroups) g.stop()
    for (const s of sounds) this.claimedSounds.add(s)
    slot.sounds = sounds
    slot.frame = frame
    slot.postId = postId
    slot.started = false
    slot.playing = false
    slot.warm = false
    slot.warmUntil = performance.now() + WARMUP_MS
    this.applyPlace(slot, this.pendingPlace.get(postId) ?? { x: 0, y: 0, z: 0, w: 1, h: 1, depth: 1 })
    this.byPost.set(postId, slot)
    this.onPlaced?.(postId)
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
      const sounds = claimModelSounds(this.scene, container, soundBaseline, this.claimedSounds)
      this.install(slot, postId, container, model.cameraIndex, sounds)
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
    // Recurse: dispose(true) means doNotRecurse, so orient+fit leaked
    // (46 orphan nodes after a few 2D↔3D toggles). Container roots were
    // unparented above, so this only reaches the two helper nodes.
    if (slot.root) { slot.root.dispose(); slot.root = null; slot.orient = null; slot.fit = null }
    slot.clip = null
    slot.footprint = null
    slot.warm = false
    slot.warmUntil = 0
    slot.frame = null
    slot.place = null
    slot.postId = null
    slot.visible = false
  }

}
