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
import '../model/gltf'
import { configureDraco } from '../model/draco'
import { dominantFacing, worldBox, frameDistance } from '../model/facing'
import { validateGLBCached } from '../model/limits'
import { graphics } from '../render/graphics'

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
  postId: string | null
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
  opts: PreviewPoolOptions
  onLive: ((postId: string, rtt: RenderTargetTexture) => void) | null = null
  /** A live slot was evicted (or scrolled away) — drop the card back to its poster. */
  onRelease: ((postId: string) => void) | null = null
  /** A load finished (success or not) — callers may retry queued requests. */
  onLoadDone: (() => void) | null = null

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
   */
  hasWork(visible?: ReadonlySet<string>): boolean {
    if (this.byPost.size === 0) return false
    const now = performance.now()
    const minGap = 1000 / Math.max(1, this.opts.targetFps)
    for (const slot of this.slots) {
      if (!slot.postId) continue
      if (visible && !visible.has(slot.postId)) continue
      if (now - slot.lastRenderAt >= minGap) return true
    }
    return false
  }

  /** Free every live slot (used when the board/thread goes off screen). */
  releaseAll(): void {
    for (const id of [...this.byPost.keys()]) this.release(id)
  }
  isRejected(postId: string): boolean { return this.rejected.has(postId) }
  rejectReason(postId: string): 'STATIC' | 'FAILED' | undefined { return this.rejected.get(postId) }
  retry(postId: string): void { this.rejected.delete(postId) }

  request(postId: string): boolean {
    if (this.byPost.has(postId) || this.loading.has(postId)) return true
    if (this.rejected.has(postId)) return false
    // Reuse a released slot first — the old code counted spent slots against
    // the budget forever, so past the first screenful NOTHING could animate.
    let slot: Slot | null | undefined = this.slots.find((s) => !s.postId && !s.pending)
    if (!slot && this.slots.length < this.opts.maxSlots) {
      slot = this.makeSlot()
      this.slots.push(slot)
    }
    if (!slot) slot = this.pickEvictable()
    if (!slot) return false // every slot mid-load; retry on onLoadDone
    // An evicted slot still holds its previous model: free it first (also
    // fires onRelease so its card falls back to its poster).
    if (slot.postId) this.release(slot.postId)
    slot.pending = true
    this.loading.add(postId)
    void this.load(slot, postId)
    return true
  }

  release(postId: string): void {
    const slot = this.byPost.get(postId)
    if (!slot) return
    const had = this.byPost.delete(postId)
    for (const a of slot.anims) a.stop()
    slot.anims = []
    if (slot.container) { slot.container.removeAllFromScene(); slot.container.dispose() }
    slot.container = null
    slot.postId = null
    slot.visible = false
    if (had) this.onRelease?.(postId)
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
      if (now - slot.lastRenderAt < minGap) continue
      this.renderSlot(slot)
      slot.lastRenderAt = now
      if (--budget <= 0) break
    }
  }

  /**
   * Choose a live slot to recycle for a new request. Only slots that scrolled
   * out of view are eligible: evicting a VISIBLE card would make the caller
   * re-request it immediately (its request gate only clears when the post
   * goes offscreen), ping-ponging cards between poster and live preview.
   */
  private pickEvictable(): Slot | null {
    const offscreen = this.slots.filter((s) => s.postId && !s.pending && !s.visible)
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
    rtt.wrapU = Texture.CLAMP_ADDRESSMODE
    rtt.wrapV = Texture.CLAMP_ADDRESSMODE
    // Transparent background: the card shows the board backdrop through the
    // model, so previews never sit in an opaque rectangle that mismatches the
    // page background. RGB keeps the poster blank-check comparable.
    rtt.clearColor = new Color4(0, 0, 0, 0)
    const camera = new FreeCamera(`slot-cam-${index}`, Vector3.Zero(), this.stage)
    const slot: Slot = {
      index, rtt, camera, container: null, anims: [], postId: null, pending: false, visible: false,
      facing: new Vector3(0, 0, 1), lastRenderAt: 0,
    }
    return slot
  }

  private async load(slot: Slot, postId: string): Promise<void> {
    let container: AssetContainer | null = null
    // setMaxSlots() may dispose this slot while the download/parse is in
    // flight — bail out before touching its dead rtt/camera.
    const alive = (): boolean => this.slots.includes(slot) && !slot.camera.isDisposed()
    try {
      const model = await this.getModel(postId)
      if (!model || !alive()) throw new Error('download failed')
      const report = validateGLBCached(model.bytes, model.sha256)
      if (!report.ok) throw new Error(report.reason)

      container = await LoadAssetContainerAsync(model.bytes, this.stage, { pluginExtension: '.glb' })
      if (!alive()) { container.dispose(); throw new Error('slot recycled') }
      graphics.applyToContainer(container)
      for (const m of container.meshes) {
        if (m.material) m.material.backFaceCulling = false
      }

      const { min, max, center, radius } = worldBox(container)
      const offset = new Vector3(slot.index * 800, 0, 0)
      const root = new TransformNode(`stage-${slot.index}`, this.stage)
      for (const node of container.rootNodes) node.parent = root
      root.position = offset
      const wc = center.add(offset)

      // Camera policy matches the poster: the model's own camera when it has
      // one (v3 preview-camera index → first imported), auto-fit as fallback.
      const cameraIndex = model.cameraIndex ?? 0
      const authored = cameraIndex >= 0 && cameraIndex < container.cameras.length ? container.cameras[cameraIndex] : null
      if (authored) {
        authored.computeWorldMatrix()
        const quat = new Quaternion()
        authored.getWorldMatrix().decompose(undefined, quat, slot.camera.position)
        slot.camera.rotationQuaternion.copyFrom(quat)
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
      slot.postId = postId
      for (const a of slot.anims) a.start(true)

      // Render the first frame through the scene path (compiles shaders).
      this.renderSlot(slot)

      if (slot.anims.length === 0) {
        // Static model: free the slot for the next request. (The old code
        // called release() here, which looks the post up in byPost — but a
        // slot only enters byPost AFTER this check, so the container leaked
        // and the slot stayed spent forever.)
        slot.postId = null
        if (slot.container) { slot.container.removeAllFromScene(); slot.container.dispose() }
        slot.container = null
        this.rejected.set(postId, 'STATIC')
        return
      }
      this.byPost.set(postId, slot)
      this.onLive?.(postId, slot.rtt)
    } catch {
      if (container) { container.removeAllFromScene(); container.dispose() }
      slot.postId = null
      this.rejected.set(postId, 'FAILED')
    } finally {
      slot.pending = false
      this.loading.delete(postId)
      this.onLoadDone?.()
    }
  }
}
