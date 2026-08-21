import { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine'
import { Scene } from '@babylonjs/core/scene'
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera'
import { Camera } from '@babylonjs/core/Cameras/camera'
import { Quaternion } from '@babylonjs/core/Maths/math.vector'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import type { AssetContainer } from '@babylonjs/core/assetContainer'
import type { AnimationGroup } from '@babylonjs/core/Animations/animationGroup'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import type { Sound } from '@babylonjs/core/Audio/sound'
import '../model/gltf'
import { configureDraco } from '../model/draco'
import { dominantFacing, worldBox, frameDistance } from '../model/facing'
import { validateGLBCached } from '../model/limits'
import { graphics } from '../render/graphics'
import { claimModelSounds, playModelSounds } from './modelSounds'

const EMPTY_SOUNDS: ReadonlySet<Sound> = new Set()

/** Model bytes + the preferred authored camera (v3 `preview-camera` index). */
export interface PreviewModel {
  bytes: Uint8Array
  sha256: string
  cameraIndex?: number
}

interface Slot {
  index: number
  rtt: RenderTargetTexture
  camera: FreeCamera
  container: AssetContainer | null
  anims: AnimationGroup[]
  /** MSFT_audio_emitter sounds owned by this slot's model (via mixer bus). */
  sounds: Sound[]
  /** bounded retry timer for sounds that were still decoding at play time */
  soundTimer: number | null
  /** animation + audio currently running (paused slots render nothing) */
  playing: boolean
  postId: string | null
  /** stage root TransformNode holding the slot's model (offset per slot) */
  root: TransformNode | null
  /** a load is in flight for this slot (the slot may not be live yet) */
  pending: boolean
  /** whether the post was in the last visible set handed to tick() */
  visible: boolean
  facing: Vector3
  lastRenderAt: number
}

// kestrel/perf named this PREVIEW_FPS; it is now the default of the per-slot
// budget below (each slot re-renders the whole stage scene).
export const PREVIEW_FPS = 20

export interface PreviewPoolOptions {
  maxSlots: number
  rttWidth: number
  rttHeight: number
  slotsPerFrame: number
  /** per-slot refresh cap; live cards do not need 60 fps */
  targetFps: number
}

export interface PreviewHooks {
  onLive?: (postId: string, rtt: RenderTargetTexture) => void
  onRelease?: (postId: string) => void
  onResize?: (postId: string, rtt: RenderTargetTexture) => void
  onLoadDone?: () => void
}

/**
 * Bounded RenderTargetTexture pool (step 6 / 03 §5). One hidden stage scene;
 * each slot gets its own camera + RTT. Refresh is interleaved (00 §3.12).
 * Static/failed posts are remembered (00 §3.5).
 *
 * Slots are REUSED, not spent: a released slot goes back into the free list
 * and the next request reuses it (previously every request allocated a new
 * slot up to maxSlots and the pool then silently refused every later post —
 * only the first N cards of a feed could ever animate). At capacity the pool
 * evicts a live slot — preferring one that scrolled out of view, then the
 * least recently rendered — and notifies via onRelease so the card can fall
 * back to its poster.
 */
export class PreviewPool {
  readonly stage: Scene
  private headlight: DirectionalLight
  private slots: Slot[] = []
  private byPost = new Map<string, Slot>()
  private rejected = new Map<string, 'STATIC' | 'FAILED'>()
  private loading = new Set<string>()
  /** Posts whose in-flight load was cancelled (card scrolled away mid-parse). */
  private cancelled = new Set<string>()
  /**
   * Sounds already owned by a slot. MSFT_audio_emitter registers every Sound
   * on the stage scene's mainSoundTrack, so slots find theirs by container
   * attachment; this set stops one sound from being claimed twice (which
   * would double-dispose it when two concurrent loads race).
   */
  private claimedSounds = new Set<Sound>()
  opts: PreviewPoolOptions
  onLive: ((postId: string, rtt: RenderTargetTexture) => void) | null = null
  /** A live slot was evicted (or scrolled away) — drop the card back to its poster. */
  onRelease: ((postId: string) => void) | null = null
  /** The RTT backing a live slot was just resized — card material must rebind
   *  to the new handle, otherwise it samples a disposed texture. */
  onResize: ((postId: string, rtt: RenderTargetTexture) => void) | null = null
  /** A load finished (success or not) — callers may retry queued requests. */
  onLoadDone: (() => void) | null = null
  private hooks: PreviewHooks[] = []

  /** Extra listeners (board + thread share one pool). */
  watch(h: PreviewHooks): void { this.hooks.push(h) }

  private emitLive(postId: string, rtt: RenderTargetTexture): void {
    this.onLive?.(postId, rtt)
    for (const h of this.hooks) h.onLive?.(postId, rtt)
  }
  private emitRelease(postId: string): void {
    this.onRelease?.(postId)
    for (const h of this.hooks) h.onRelease?.(postId)
  }
  private emitResize(postId: string, rtt: RenderTargetTexture): void {
    this.onResize?.(postId, rtt)
    for (const h of this.hooks) h.onResize?.(postId, rtt)
  }
  private emitLoadDone(): void {
    this.onLoadDone?.()
    for (const h of this.hooks) h.onLoadDone?.()
  }

  constructor(
    engine: AbstractEngine,
    private getModel: (postId: string) => Promise<PreviewModel | undefined>,
    opts?: Partial<PreviewPoolOptions>,
  ) {
    this.opts = { maxSlots: 6, rttWidth: 448, rttHeight: 280, slotsPerFrame: 2, targetFps: PREVIEW_FPS, ...opts }
    configureDraco()
    this.stage = new Scene(engine)
    // Transparent clear per render (see model/poster.ts): the scene owns the
    // clear when rendering through camera.outputRenderTarget, so `rtt.clearColor`
    // alone left live previews sitting on an opaque black rectangle.
    this.stage.autoClear = true
    this.stage.autoClearDepthAndStencil = true
    this.stage.clearColor = new Color4(0, 0, 0, 0)
    const hemi = new HemisphericLight('ph', new Vector3(0, 1, 0), this.stage)
    hemi.intensity = 1.0
    hemi.groundColor = new Color3(0.12, 0.12, 0.13)
    const key = new DirectionalLight('pk', new Vector3(-0.4, -0.6, 0.8), this.stage)
    key.intensity = 0.8
    const fill = new DirectionalLight('pf', new Vector3(0.5, 0.2, -0.6), this.stage)
    fill.intensity = 0.35
    // Per-slot headlight (see model/poster.ts): dark models must still read
    // on a transparent card.
    this.headlight = new DirectionalLight('ph2', new Vector3(0, 0, 1), this.stage)
    this.headlight.intensity = 0.55
  }

  get scene(): Scene { return this.stage }

  get activeCount(): number { return this.byPost.size }

  /** Settings → Textures: rebuild all slot RTTs at a new size.
   *  Disposes the old RenderTargetTextures (which the card shader was sampling)
   *  and creates new ones at (w,h); the slot's loaded model is kept in the
   *  scene (its handle doesn't change), so cards rebind to a fresh RTT without
   *  re-parsing the GLB. Posts that were waiting for a free slot don't move
   *  — setMaxSlots/load handle that ordering. */
  setRttSize(width: number, height: number): void {
    const w = Math.max(16, Math.round(width))
    const h = Math.max(16, Math.round(height))
    if (w === this.opts.rttWidth && h === this.opts.rttHeight) return
    this.opts.rttWidth = w
    this.opts.rttHeight = h
    for (const slot of this.slots) {
      // Allocate the new RTT FIRST so the caller can bind it to the card
      // material BEFORE we release the GPU handle the material currently
      // samples. (Disposing then re-assigning in the same tick is fine in
      // JS, but the caller's setCardTexture may run a render immediately
      // via invalidate(2) — we must not be holding a disposed handle.)
      const oldRtt = slot.rtt
      slot.rtt = new RenderTargetTexture(`slot-${slot.index}`, { width: w, height: h }, this.stage)
      slot.rtt.renderTargetOptions.generateDepthBuffer = true
      slot.rtt.renderTargetOptions.generateMipMaps = false
      slot.rtt.samples = 1
      slot.rtt.wrapU = Texture.CLAMP_ADDRESSMODE
      slot.rtt.wrapV = Texture.CLAMP_ADDRESSMODE
      slot.rtt.hasAlpha = true
      // Transparent background: see comment in makeSlot().
      slot.rtt.clearColor = new Color4(0, 0, 0, 0)
      // Card material still holds the OLD RTT handle; tell the board to swap
      // immediately. Empty slots (no live post) need no notification.
      if (slot.postId) this.emitResize(slot.postId, slot.rtt)
      oldRtt.dispose()
    }
  }

  /** Settings → Memory: how many cards may animate at once. */
  setMaxSlots(n: number): void {
    const next = Math.max(0, Math.round(n))
    this.opts.maxSlots = next
    while (this.slots.length > next) {
      const slot = this.slots.pop()
      if (!slot) break
      if (slot.postId) this.release(slot.postId)
      slot.rtt.dispose()
      slot.camera.dispose()
    }
  }

  /**
   * Is any VISIBLE live slot due for a refresh right now? The board uses this
   * as its render-on-demand probe, so one animated card makes the board draw
   * at the preview refresh rate (targetFps) instead of at display rate.
   * Paused slots are not work: their frame is frozen, so they must not keep
   * the whole board drawing at preview rate.
   */
  hasWork(visible?: ReadonlySet<string>): boolean {
    if (this.byPost.size === 0) return false
    const now = performance.now()
    const minGap = 1000 / Math.max(1, this.opts.targetFps)
    for (const slot of this.slots) {
      if (!slot.postId || !slot.playing) continue
      if (visible && !visible.has(slot.postId)) continue
      if (now - slot.lastRenderAt >= minGap) return true
    }
    return false
  }

  /** True while a post's animation (+ sound) is actually running. */
  isPlaying(postId: string): boolean {
    return this.byPost.get(postId)?.playing ?? false
  }

  /**
   * Pause a live post in place: the animation freezes on its current frame
   * (AnimationGroup.pause) and its sound pauses with it (AMENDMENT 69 — the
   * per-card ⏸ button). The slot and its RTT stay bound, so resuming is
   * instant and the frozen frame keeps showing.
   */
  pause(postId: string): void {
    const slot = this.byPost.get(postId)
    if (!slot) return
    if (slot.soundTimer !== null) {
      clearInterval(slot.soundTimer)
      slot.soundTimer = null
    }
    for (const a of slot.anims) a.pause()
    for (const s of slot.sounds) if (s.isPlaying) s.pause()
    slot.playing = false
  }

  /**
   * Resume a paused live post. `sound` is true only from the ▶ button tap (a
   * user gesture) — turning autoplay back on must NOT start audio, so that
   * path resumes animation only.
   */
  resume(postId: string, sound = false): void {
    const slot = this.byPost.get(postId)
    if (!slot) return
    // play() restarts paused animatables from their pause point instead of
    // resetting to frame 0 (AnimationGroup.start would).
    for (const a of slot.anims) a.play(true)
    if (sound) playModelSounds(slot)
    slot.playing = true
  }

  /** Free every live slot (used when the board/thread goes off screen). */
  releaseAll(): void {
    for (const id of [...this.byPost.keys()]) this.release(id)
  }

  /**
   * Dispose IDLE slots (their RTTs + cameras) after releaseAll(). Called
   * when a scene leaves the active route so the pool holds no GPU targets
   * for the rest of the session — slots are re-created lazily on the next
   * request() (a pool is not a permanent allocation).
   */
  prune(): void {
    for (let i = this.slots.length - 1; i >= 0; i--) {
      const s = this.slots[i]
      if (s.postId || s.pending) continue
      s.rtt.dispose()
      s.camera.dispose()
      this.slots.splice(i, 1)
    }
  }
  isRejected(postId: string): boolean { return this.rejected.has(postId) }
  rejectReason(postId: string): 'STATIC' | 'FAILED' | undefined { return this.rejected.get(postId) }
  retry(postId: string): void { this.rejected.delete(postId) }

  /**
   * Load a post into a live slot and start it. `sound` is true ONLY when the
   * user pressed a card's ▶ button — autoplay animation stays silent (the
   * browser's autoplay policy AND the SPEC "no autoplay" audio line).
   */
  request(postId: string, visible?: ReadonlySet<string>, sound = false): boolean {
    const live = this.byPost.get(postId)
    if (live) {
      // Already resident (view hop board↔thread): re-emit so the incoming
      // view binds the RTT. Without this, request() returned true and the
      // new card/node stayed on its poster forever.
      this.emitLive(postId, live.rtt)
      return true
    }
    // Scroll-back while a parse is in flight: un-cancel so the result is kept
    // (Direct3DPool does this; leaving cancelled discarded a still-wanted load).
    if (this.loading.has(postId)) {
      this.cancelled.delete(postId)
      return true
    }
    if (this.cancelled.has(postId)) return true
    if (this.rejected.has(postId)) return false
    // Reuse a released slot first — the old code counted spent slots against
    // the budget forever, so past the first screenful NOTHING could animate.
    let slot: Slot | null | undefined = this.slots.find((s) => !s.postId && !s.pending)
    if (!slot && this.slots.length < this.opts.maxSlots) {
      slot = this.makeSlot()
      this.slots.push(slot)
    }
    if (!slot) slot = this.pickEvictable(visible)
    if (!slot) return false // no eligible slot; the caller re-requests later
    // An evicted slot still holds its previous model: free it first (also
    // fires onRelease so its card falls back to its poster).
    if (slot.postId) this.release(slot.postId)
    slot.pending = true
    this.loading.add(postId)
    void this.load(slot, postId, sound)
    return true
  }

  release(postId: string): void {
    const slot = this.byPost.get(postId)
    if (!slot) {
      // The post is still loading: mark it cancelled so the load discards
      // its result instead of binding a slot for a card nobody wants. (The
      // parse cannot be aborted; the result is just not kept.)
      if (this.loading.has(postId)) this.cancelled.add(postId)
      return
    }
    const had = this.byPost.delete(postId)
    this.clearSlotModel(slot)
    if (had) this.emitRelease(postId)
  }

  /**
   * Free everything a slot holds: anims, sounds, container (un-reparented
   * first so the container hierarchy stays valid for removeAllFromScene) and
   * the stage root TransformNode. The slot is then reusable by request().
   */
  private clearSlotModel(slot: Slot): void {
    if (slot.soundTimer !== null) {
      clearInterval(slot.soundTimer)
      slot.soundTimer = null
    }
    for (const a of slot.anims) a.stop()
    slot.anims = []
    for (const s of slot.sounds) {
      this.claimedSounds.delete(s)
      s.stop()
      s.dispose()
    }
    slot.sounds = []
    slot.playing = false
    if (slot.container) {
      // rootNodes were reparented under the stage root, which is NOT part
      // of the container — detach them again or removeAllFromScene warns
      // "hierarchy is not valid" and the scene may keep stray nodes.
      for (const n of slot.container.rootNodes) n.parent = null
      slot.container.removeAllFromScene()
      slot.container.dispose()
      slot.container = null
    }
    if (slot.root) { slot.root.dispose(true); slot.root = null }
    slot.postId = null
    slot.visible = false
  }

  /**
   * Hand off the LIVE container for a post atomically. The caller MUST
   * invoke either `commit()` (the handoff succeeded — release the slot)
   * or `rollback()` (the handoff failed — restore the slot to its live,
   * animating state). Calling neither leaks the parsed container in
   * previewScene; calling both is a no-op. Returns null when the post
   * is not live (caller falls back to a fresh parse).
   *
   * Why a transaction instead of a one-shot handoff: the parse result
   * already lives in previewScene, so a "soft" reservation (slot stays in
   * byPost, anims paused, slot.root detached) lets the caller either keep
   * the slot free post-handoff OR put everything back if the hand-off
   * throws. Without the rollback path, a parse error in handoffContainer
   * would silently strand the meshes in previewScene with no slot to
   * bind them to.
   */
  acquire(postId: string): {
    container: AssetContainer
    offset: Vector3
    anims: AnimationGroup[]
    /** `keepSounds` = sounds the hand-off already moved to the viewer scene;
     *  the viewer owns them, so commit must NOT dispose them. */
    commit(keepSounds?: ReadonlySet<Sound>): void
    /** `dropped` = sounds the caller disposed after a failed hand-off. */
    rollback(dropped?: ReadonlySet<Sound>): void
  } | null {
    const slot = this.byPost.get(postId)
    if (!slot || !slot.container) return null
    const container = slot.container
    const offset = slot.root ? slot.root.position.clone() : new Vector3(0, 0, 0)
    const anims = slot.anims.slice()
    for (const a of slot.anims) a.stop()
    // Pause the model's sound with the animation (it belongs to the stage
    // scene; the viewer adopts no audio, so commit() just releases it).
    for (const s of slot.sounds) if (s.isPlaying) s.pause()
    // Detach rootNodes from slot.root so handoffContainer's
    // instantiateModelsToScene finds them at the root level and the move
    // does not warn about the soon-to-be-disposed offset root.
    for (const n of container.rootNodes) n.parent = null

    type State = 'open' | 'committed' | 'rolledback'
    let state: State = 'open'
    const self = this
    const reservation = {
      container,
      offset,
      anims,
      commit(keepSounds: ReadonlySet<Sound> = EMPTY_SOUNDS): void {
        if (state !== 'open') return
        state = 'committed'
        slot.root?.dispose()
        slot.root = null
        slot.container = null
        slot.anims = []
        // The stage no longer owns the model: release its sounds so they
        // cannot keep registered (and sounding) in the hidden stage scene.
        // A sound handoffContainer MOVED to the viewer scene is the
        // viewer's now (AMENDMENT 87) — never dispose it here.
        for (const s of slot.sounds) {
          self.claimedSounds.delete(s)
          if (keepSounds.has(s) || (s as unknown as { _scene?: Scene })._scene !== self.scene) continue
          s.stop()
          s.dispose()
        }
        slot.sounds = []
        slot.playing = false
        slot.postId = null
        slot.visible = false
        // Tell the board/thread this post is no longer live - their cards
        // fall back to posters. byPost is removed last so the slot is still
        // "intact" until every local ref is cleared.
        self.byPost.delete(postId)
        self.emitRelease(postId)
      },
      rollback(dropped: ReadonlySet<Sound> = EMPTY_SOUNDS): void {
        if (state !== 'open') return
        state = 'rolledback'
        // A failed hand-off disposes the sounds it already moved (their
        // source nodes are gone); keep the slot's list honest.
        if (dropped.size) slot.sounds = slot.sounds.filter((s) => !dropped.has(s))
        // The model is still in previewScene with parent=null (we detached
        // above). The slot stays in byPost, so tick() will re-render it
        // once the anims spin back up.
        for (const a of anims) a.start(true)
        playModelSounds(slot)
        slot.playing = true
      },
    }
    return reservation
  }

  /** Advance one frame; render only the slots whose turn it is.
   * Each slot renders the stage scene into its own RTT via
   * camera.outputRenderTarget — the same path the poster pipeline uses. The
   * manual rtt.render()/renderList path did not compile materials and left
   * the live preview blank. Models sit 800 units apart, so each slot's
   * frustum (maxZ) excludes the others.
   */
  tick(visible?: ReadonlySet<string>): void {
    // Two throttles: a per-slot frame budget (targetFps) and a cap on how
    // many slots may be drawn in one frame. A live preview is a full offscreen
    // model render at 512x320 — running every slot at display rate was the
    // board's biggest continuous GPU cost.
    const now = performance.now()
    const minGap = 1000 / Math.max(1, this.opts.targetFps)
    let budget = Math.max(1, this.opts.slotsPerFrame)
    for (const slot of this.slots) {
      if (!slot.postId) continue
      slot.visible = !visible || visible.has(slot.postId)
      // offscreen cards keep their model but stop drawing
      if (!slot.visible) continue
      // paused slots render a frozen frame — no refresh needed
      if (!slot.playing) continue
      if (now - slot.lastRenderAt < minGap) continue
      this.renderSlot(slot)
      slot.lastRenderAt = now
      if (--budget <= 0) break
    }
  }

  /**
   * Choose a live slot to recycle for a new request. Only slots that scrolled
   * out of view are eligible: evicting a VISIBLE card would make the caller
   * re-request it immediately, ping-ponging cards between poster and live
   * preview. The caller's fresh visible set wins over the slot's own flag —
   * that flag is only updated in tick(), which runs AFTER the caller's
   * request pass in the same frame, so relying on it deadlocks: request()
   * sees all slots "visible", fails, and nothing ever retries.
   */
  private pickEvictable(visible?: ReadonlySet<string>): Slot | null {
    const offscreen = this.slots.filter((s) => {
      if (!s.postId || s.pending) return false
      return visible ? !visible.has(s.postId) : !s.visible
    })
    if (!offscreen.length) return null
    offscreen.sort((a, b) => a.lastRenderAt - b.lastRenderAt)
    return offscreen[0]
  }

  private renderSlot(slot: Slot): void {
    // the headlight is shared by the stage, so aim it per slot before drawing
    this.headlight.direction = slot.facing.scale(-1)
    this.stage.activeCamera = slot.camera
    slot.camera.outputRenderTarget = slot.rtt
    this.stage.render()
    slot.camera.outputRenderTarget = null
  }

  dispose(): void {
    for (const slot of this.slots) { slot.container?.dispose(); slot.rtt.dispose(); slot.camera.dispose() }
    this.slots = []
    this.byPost.clear()
    this.stage.dispose()
  }

  private makeSlot(): Slot {
    const index = this.slots.length
    const rtt = new RenderTargetTexture(`slot-${index}`, { width: this.opts.rttWidth, height: this.opts.rttHeight }, this.stage)
    rtt.renderTargetOptions.generateDepthBuffer = true
    rtt.renderTargetOptions.generateMipMaps = false
    rtt.samples = 1
    rtt.wrapU = Texture.CLAMP_ADDRESSMODE
    rtt.wrapV = Texture.CLAMP_ADDRESSMODE
    rtt.hasAlpha = true
    // Transparent background: the card shows the board backdrop through the
    // model, so previews never sit in an opaque rectangle that mismatches the
    // page background. RGB keeps the poster blank-check comparable.
    rtt.clearColor = new Color4(0, 0, 0, 0)
    const camera = new FreeCamera(`slot-cam-${index}`, Vector3.Zero(), this.stage)
    const slot: Slot = {
      index, rtt, camera, container: null, root: null, anims: [], sounds: [], soundTimer: null, playing: false,
      postId: null, pending: false, visible: false,
      facing: new Vector3(0, 0, 1), lastRenderAt: 0,
    }
    return slot
  }

  private async load(slot: Slot, postId: string, sound: boolean): Promise<void> {
    let container: AssetContainer | null = null
    // setMaxSlots() may dispose this slot while the download/parse is in
    // flight — bail out before touching its dead rtt/camera.
    const alive = (): boolean => this.slots.includes(slot) && !slot.camera.isDisposed()
    try {
      const model = await this.getModel(postId)
      if (!model || !alive()) throw new Error('download failed')
      if (this.cancelled.has(postId)) throw new Error('cancelled while loading')
      const report = validateGLBCached(model.bytes, model.sha256)
      if (!report.ok) throw new Error(report.reason)

      // Sounds register on the stage's mainSoundTrack during the parse; the
      // baseline lets claimSounds() pick up scene-level (unattached) ones.
      const soundBaseline = this.stage.mainSoundTrack.soundCollection.length
      container = await LoadAssetContainerAsync(model.bytes, this.stage, { pluginExtension: '.glb' })
      if (!alive()) { container.dispose(); throw new Error('slot recycled') }
      if (this.cancelled.has(postId)) { container.dispose(); throw new Error('cancelled while loading') }
      // THE bug that made live previews blank since forever: the container
      // was never added to the stage scene (the poster pipeline does
      // addAllToScene; the pool didn't). The stage rendered NOTHING, every
      // live RTT was transparent, and animated cards showed the backdrop.
      container.addAllToScene()
      graphics.applyToContainer(container)
      for (const m of container.meshes) {
        if (m.material) m.material.backFaceCulling = false
      }

      const { min, max, center, radius } = worldBox(container)
      const offset = new Vector3(slot.index * 800, 0, 0)
      const root = new TransformNode(`stage-${slot.index}`, this.stage)
      for (const node of container.rootNodes) node.parent = root
      root.position = offset
      slot.root = root
      // Reparenting dirtied the WHOLE chain's world matrices: the container
      // root was moved under the offset node, and any cached matrix below it
      // (the authored camera's in particular — the loader computes it) still
      // holds the un-offset pose. Force every level, or the camera films
      // empty space 800*index units away and camera'd previews render blank.
      root.computeWorldMatrix(true)
      for (const n of container.rootNodes) {
        ;(n as unknown as { computeWorldMatrix: (force?: boolean) => unknown }).computeWorldMatrix(true)
      }
      const wc = center.add(offset)

      // Camera policy matches the poster: the model's own camera when it has
      // one (v3 preview-camera index → first imported), auto-fit as fallback.
      const cameraIndex = model.cameraIndex ?? 0
      const authored = cameraIndex >= 0 && cameraIndex < container.cameras.length ? container.cameras[cameraIndex] : null
      // Runtime note: Camera.rotationQuaternion is null until assigned (the
      // .d.ts declares a non-null Quaternion — that is wrong, so any
      // `.copyFrom()` on it throws for models WITH cameras).
      const camQuat = slot.camera as unknown as { rotationQuaternion: Quaternion | null }
      if (authored) {
        // Camera.computeWorldMatrix() takes no arguments (it just reads
        // getWorldMatrix()); to FORCE the recompute after the reparent,
        // call the Node-level method through a cast.
        ;(authored as unknown as { computeWorldMatrix: (force?: boolean) => unknown }).computeWorldMatrix(true)
        const quat = new Quaternion()
        authored.getWorldMatrix().decompose(undefined, quat, slot.camera.position)
        camQuat.rotationQuaternion = quat
        slot.camera.fov = authored.fov || 0.7
        if (authored.mode === Camera.ORTHOGRAPHIC_CAMERA) {
          slot.camera.mode = Camera.ORTHOGRAPHIC_CAMERA
          slot.camera.orthoTop = authored.orthoTop ?? 1
          slot.camera.orthoBottom = authored.orthoBottom ?? -1
          slot.camera.orthoLeft = authored.orthoLeft ?? -1
          slot.camera.orthoRight = authored.orthoRight ?? 1
        } else {
          slot.camera.mode = Camera.PERSPECTIVE_CAMERA
        }
        slot.facing = authored.getDirection(Vector3.Forward())
      } else {
        const facing = dominantFacing(container)
        const fov = 0.7
        const dist = frameDistance(min, max, center, facing.scale(-1), fov, this.opts.rttWidth / this.opts.rttHeight, 0.86)
        camQuat.rotationQuaternion = null
        slot.camera.mode = Camera.PERSPECTIVE_CAMERA
        slot.camera.position = wc.add(facing.scale(dist))
        slot.camera.setTarget(wc)
        slot.camera.fov = fov
        slot.facing = facing.clone()
      }
      // Display-only clips: authored near/far often cuts tiny/offset models.
      const dist = Vector3.Distance(slot.camera.position, wc)
      slot.camera.minZ = Math.max(0.0001, Math.min(slot.camera.minZ, (dist - radius) * 0.2))
      slot.camera.maxZ = Math.max(slot.camera.maxZ, dist + radius * 6)

      slot.container = container
      slot.anims = container.animationGroups.filter((g) => g.targetedAnimations.length > 0)
      // Claim the model's sounds even for STATIC posts so clearSlotModel can
      // dispose them — otherwise they stay registered (and silent) in the
      // stage scene's mainSoundTrack for the whole session.
      slot.sounds = claimModelSounds(this.stage, container, soundBaseline, this.claimedSounds)
      slot.postId = postId

      // Render the first frame through the scene path (compiles shaders).
      this.renderSlot(slot)

      if (slot.anims.length === 0) {
        // Static model: free the slot for the next request. (The old code
        // called release() here, which looks the post up in byPost — but a
        // slot only enters byPost AFTER this check, so the container leaked
        // and the slot stayed spent forever.)
        this.clearSlotModel(slot)
        this.rejected.set(postId, 'STATIC')
        return
      }
      slot.playing = true
      for (const a of slot.anims) a.start(true)
      // Sound only ever starts from the per-card ▶ button (a user gesture):
      // autoplay animation stays silent (SPEC: audio "no autoplay").
      if (sound) playModelSounds(slot)
      this.byPost.set(postId, slot)
      this.emitLive(postId, slot.rtt)
    } catch {
      this.clearSlotModel(slot)
      // Do not mark a post FAILED when the slot itself was recycled mid-load
      // (a settings shrink) or when the request was cancelled — nothing
      // about the model was wrong in either case.
      if (alive() && !this.cancelled.has(postId)) this.rejected.set(postId, 'FAILED')
    } finally {
      this.cancelled.delete(postId)
      slot.pending = false
      this.loading.delete(postId)
      this.emitLoadDone()
    }
  }
}
