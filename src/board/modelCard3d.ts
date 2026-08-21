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
// Registers the scene's mainSoundTrack (MSFT_audio_emitter sounds land there).
import '@babylonjs/core/Audio/audioSceneComponent'
import '../model/gltf'
import { configureDraco } from '../model/draco'
import { frameModel, placeFrame, makeCellClip, updateCellClip, type ModelFrame } from '../model/framing'
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
  /** how the model is framed: main-camera view (pivot/rot/frame height) or
   *  auto-fit, plus the oriented bounds the cell fit is computed from. */
  frame: ModelFrame | null
  /** the four planes that crop this model to its card / node rect */
  clip: Plane[] | null
  /** false while the model's shaders are still compiling (see hasWork) */
  warm: boolean
  /** give up waiting for a never-ready effect at this timestamp */
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
 * Framing (spec AMENDMENT 43, see model/framing.ts): each model is
 * transformed by its own MAIN CAMERA's view — rotated by the inverse of the
 * camera's rotation about the CAMERA's position, then scaled so the camera's
 * frame maps onto the card cell. The static flat camera therefore shows
 * exactly what the author framed, at the size and offset they framed it.
 * Models without a usable camera fall back to the poster's auto-fit.
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

    let slot = this.slots.find((s) => !s.postId && !s.pending)
    if (!slot && this.slots.length < this.maxSlots) {
      slot = this.makeSlot()
      this.slots.push(slot)
    }
    if (!slot) slot = this.pickEvictable(visible)
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

  /**
   * True while any VISIBLE model still needs frames: it is animating, or its
   * shaders have not finished compiling.
   *
   * The second half matters as much as the first. The board and the thread
   * render ON DEMAND, and a material is only compiled when it is first
   * rendered — so the frame that placed a model draws nothing, and without
   * this the next frame never comes: cards stayed BLANK on a settled board
   * until the user scrolled (very visible on software GL, where compiling a
   * PBR shader takes hundreds of ms).
   */
  hasWork(visible?: ReadonlySet<string>): boolean {
    let work = false
    const now = performance.now()
    for (const slot of this.slots) {
      if (!slot.postId) continue
      if (visible && !visible.has(slot.postId)) continue
      if (slot.playing && slot.anims.length > 0) work = true
      if (!slot.warm) {
        // A broken effect must not pin the render loop at the animation FPS
        // forever, hence the deadline. NOTE: ask for a frame even on the poll
        // that FLIPS warm — that frame is the one that finally draws the
        // model. Returning false as soon as the shader is ready left the
        // card blank until the next unrelated redraw.
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

  private makeSlot(): Slot {
    return {
      postId: null, pending: false, visible: false, playing: false, started: false,
      root: null, orient: null, fit: null, container: null, anims: [], sounds: [],
      soundTimer: null, frame: null, clip: null, warm: false, warmUntil: 0,
      place: null, placedAt: 0,
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
   * Apply a cell to a resident model. The framing (main-camera view or
   * auto-fit) was computed once at load; this only maps it onto the current
   * card / node rect, so scroll, pan, zoom and resize are pure transforms.
   *
   * The chain is root(scale + position) → orient(rotation) → fit(-pivot):
   * the SCALE lives on the root so the pivot translation below it is scaled
   * too. (It used to sit on `fit`, whose own position is applied AFTER its
   * scaling — an off-origin model was then displaced by pivot·(1-scale) and
   * drifted off its card, which is why models looked "positioned wrong".)
   */
  private applyPlace(slot: Slot, place: Place3D): void {
    slot.place = place
    slot.placedAt = ++this.epoch
    if (!slot.root || !slot.fit || !slot.frame) return
    const at = placeFrame(slot.frame, place)
    slot.root.scaling.setAll(at.scale)
    slot.root.position.set(at.x, at.y, at.z)
    // The crop follows the cell: scrolling a card moves its window too.
    if (slot.clip) updateCellClip(slot.clip, place)
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
      // Crop every material to the card / node rect (the planes are filled in
      // by applyPlace). A poster is cut off by the card's edges; a real model
      // has to be too, or a close-up framing paints over its neighbours.
      // Assigned BEFORE the first render: the board scene sets
      // blockMaterialDirtyMechanism, so a later assignment would never make
      // it into the shader defines.
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

      // Framing is computed BEFORE reparenting: the authored camera's world
      // matrix must reflect its authored transform, not the fit chain. The
      // cell's aspect matters because the authored camera's horizontal frame
      // follows the target it is rendered into (same rule as the poster).
      const cell = this.pendingPlace.get(postId)
      const aspect = cell && cell.h > 0 ? cell.w / cell.h : 1.6
      const frame = frameModel(container, model.cameraIndex ?? 0, aspect)

      const root = new TransformNode(`d3-${postId.slice(0, 8)}`, this.scene)
      const orient = new TransformNode(`d3-orient-${postId.slice(0, 8)}`, this.scene)
      const fit = new TransformNode(`d3-fit-${postId.slice(0, 8)}`, this.scene)
      orient.parent = root
      fit.parent = orient
      orient.rotationQuaternion = frame.rot
      // The model is shown from the camera's position: that point, not the
      // bounding-box centre, is what lands in the middle of the cell.
      fit.position = frame.pivot.scale(-1)
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
      slot.clip = clip
      slot.anims = container.animationGroups.filter((g) => g.targetedAnimations.length > 0)
      // The glTF loader auto-starts the first animation group (its
      // animationStartMode defaults to FIRST). The POOL owns playback — the
      // board/thread call play()/pause() from the autoplay setting and the ▶
      // button — so a loader-started group would animate a card that the
      // user explicitly left paused, and `slot.playing` (false) would never
      // let anyone stop it. Stop before the first render: no frame has been
      // evaluated yet, so the model keeps its authored pose.
      for (const g of container.animationGroups) g.stop()
      slot.sounds = this.claimSounds(container, soundBaseline)
      slot.frame = frame
      slot.postId = postId
      slot.started = false
      slot.playing = false
      slot.warm = false
      slot.warmUntil = performance.now() + WARMUP_MS
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
    slot.clip = null
    slot.warm = false
    slot.warmUntil = 0
    slot.frame = null
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
