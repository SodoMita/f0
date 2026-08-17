import { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine'
import { Scene } from '@babylonjs/core/scene'
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera'
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
import '@babylonjs/loaders/glTF'
import { configureDraco } from '../model/draco'
import { dominantFacing, worldBox, frameDistance } from '../model/facing'
import { toFile } from '../model/poster'
import { validateGLB } from '../model/limits'

interface Slot {
  index: number
  rtt: RenderTargetTexture
  camera: FreeCamera
  container: AssetContainer | null
  anims: AnimationGroup[]
  postId: string | null
  phase: number
  facing: Vector3
}

export interface PreviewPoolOptions { maxSlots: number; rttWidth: number; rttHeight: number; slotsPerFrame: number }

const PREVIEW_FPS = 20 // live-card refresh cap (imperceptible vs 60, ~3x cheaper)

/**
 * Bounded RenderTargetTexture pool (step 6 / 03 §5). One hidden stage scene;
 * each slot gets its own camera + RTT with an isolated renderList. Refresh is
 * interleaved (00 §3.12). Static/failed posts are remembered (00 §3.5).
 */
export class PreviewPool {
  private stage: Scene
  private headlight: DirectionalLight
  private slots: Slot[] = []
  private byPost = new Map<string, Slot>()
  private rejected = new Map<string, 'STATIC' | 'FAILED'>()
  private loading = new Set<string>()
  private frame = 0
  private lastTickAt = 0
  readonly opts: PreviewPoolOptions
  onLive: ((postId: string, rtt: RenderTargetTexture) => void) | null = null

  constructor(engine: AbstractEngine, private getModel: (postId: string) => Promise<Blob | undefined>, opts?: Partial<PreviewPoolOptions>) {
    this.opts = { maxSlots: 6, rttWidth: 512, rttHeight: 320, slotsPerFrame: 2, ...opts }
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

  get activeCount(): number { return this.byPost.size }
  isRejected(postId: string): boolean { return this.rejected.has(postId) }
  rejectReason(postId: string): 'STATIC' | 'FAILED' | undefined { return this.rejected.get(postId) }
  retry(postId: string): void { this.rejected.delete(postId) }

  request(postId: string): boolean {
    if (this.byPost.has(postId) || this.loading.has(postId)) return true
    if (this.rejected.has(postId)) return false
    if (this.slots.length >= this.opts.maxSlots) return false
    const slot = this.makeSlot()
    this.loading.add(postId)
    void this.load(slot, postId)
    return true
  }

  release(postId: string): void {
    const slot = this.byPost.get(postId)
    if (!slot) return
    this.byPost.delete(postId)
    for (const a of slot.anims) a.stop()
    slot.anims = []
    if (slot.container) { slot.container.removeAllFromScene(); slot.container.dispose() }
    slot.container = null
    slot.postId = null
  }

  /** Advance one frame; render only the slots whose turn it is.
   * Each slot renders the stage scene into its own RTT via
   * camera.outputRenderTarget — the same path the poster pipeline uses. The
   * manual rtt.render()/renderList path did not compile materials and left
   * the live preview blank. Models sit 800 units apart, so each slot's
   * frustum (maxZ) excludes the others.
   */
  tick(): void {
    // PERF: live previews refresh at PREVIEW_FPS, not at the host frame
    // rate — an RTT re-render per board frame per slot was the single
    // biggest GPU cost on the board (each one re-renders the whole stage).
    const now = performance.now()
    if (now - this.lastTickAt < 1000 / PREVIEW_FPS) return
    this.lastTickAt = now
    this.frame++
    const n = Math.max(1, this.byPost.size)
    const rate = Math.max(1, Math.ceil(n / this.opts.slotsPerFrame))
    for (const slot of this.slots) {
      if (!slot.postId) continue
      if ((this.frame + slot.phase) % rate === 0) this.renderSlot(slot)
    }
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
    const slot: Slot = { index, rtt, camera, container: null, anims: [], postId: null, phase: index, facing: new Vector3(0, 0, 1) }
    this.slots.push(slot)
    return slot
  }

  private async load(slot: Slot, postId: string): Promise<void> {
    let container: AssetContainer | null = null
    try {
      const blob = await this.getModel(postId)
      if (!blob) throw new Error('download failed')
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const report = validateGLB(bytes)
      if (!report.ok) throw new Error(report.reason)

      container = await LoadAssetContainerAsync(toFile(blob, 'model.glb'), this.stage)
      for (const m of container.meshes) {
        if (m.material) m.material.backFaceCulling = false
      }

      const { min, max, center, radius } = worldBox(container)
      const facing = dominantFacing(container)

      const offset = new Vector3(slot.index * 800, 0, 0)
      const root = new TransformNode(`stage-${slot.index}`, this.stage)
      for (const node of container.rootNodes) node.parent = root
      root.position = offset
      const wc = center.add(offset)

      slot.facing = facing.clone()
      const fov = 0.7
      const dist = frameDistance(min, max, center, facing.scale(-1), fov, this.opts.rttWidth / this.opts.rttHeight, 0.86)
      slot.camera.position = wc.add(facing.scale(dist))
      slot.camera.setTarget(wc)
      slot.camera.fov = fov
      slot.camera.minZ = Math.max(0.001, (dist - radius) * 0.2)
      slot.camera.maxZ = dist + radius * 6

      slot.container = container
      slot.anims = container.animationGroups.filter((g) => g.targetedAnimations.length > 0)
      slot.postId = postId
      for (const a of slot.anims) a.start(true)

      // Render the first frame through the scene path (compiles shaders).
      this.renderSlot(slot)

      if (slot.anims.length === 0) {
        this.release(postId)
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
      this.loading.delete(postId)
    }
  }
}
