import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine'
import type { Scene } from '@babylonjs/core/scene'
import { PreviewPool, type PreviewModel, type PreviewPoolOptions } from './previewPool'
import { Direct3DPool } from './modelCard3d'
import type { Vector3 } from '@babylonjs/core/Maths/math.vector'

export type LiveView = 'board' | 'thread' | 'viewer' | 'idle'

/**
 * ONE preview stage (RTTs) + per-scene Direct3D pools that never hold models
 * at the same time. Board and thread used to each own a PreviewPool — two
 * stage scenes and two RTT sets for the whole session, even though only one
 * view renders. Direct3D meshes must live in the visible scene, so those
 * pools stay per-scene; activate() releases the inactive one so the GPU
 * cost is a single pool.
 */
export class LivePool {
  readonly preview: PreviewPool
  private board3d: Direct3DPool | null = null
  private thread3d: Direct3DPool | null = null
  private previewW: number
  private previewH: number
  view: LiveView = 'idle'

  constructor(
    engine: AbstractEngine,
    private readonly getModel: (postId: string) => Promise<PreviewModel | undefined>,
    opts?: Partial<PreviewPoolOptions>,
  ) {
    this.preview = new PreviewPool(engine, getModel, opts)
    this.previewW = opts?.rttWidth ?? 448
    this.previewH = opts?.rttHeight ?? 280
  }

  attach3d(which: 'board' | 'thread', scene: Scene, maxSlots: number): Direct3DPool {
    const pool = new Direct3DPool(scene, this.getModel, { maxSlots })
    if (which === 'board') this.board3d = pool
    else this.thread3d = pool
    return pool
  }

  /** Per-view card-position providers for spatial audio (2D preview stage).
   *  The stage anchors sounds at the ACTIVE view's card positions, so the
   *  provider is re-applied on every view switch. */
  private soundProviders = new Map<'board' | 'thread', (postId: string) => Vector3 | null>()

  registerSoundPosition(which: 'board' | 'thread', provider: (postId: string) => Vector3 | null): void {
    this.soundProviders.set(which, provider)
    if ((which === 'board' && this.view !== 'thread') || (which === 'thread' && this.view === 'thread')) {
      this.preview.opts.soundPosition = provider
    }
  }

  setMaxSlots(n: number): void { this.preview.setMaxSlots(n) }

  setPreviewSize(width: number, height: number): void {
    this.previewW = width
    this.previewH = height
    if (this.view !== 'thread') this.preview.setRttSize(width, height)
  }

  /** Thread-map zoom: only applied while the map is the active view. */
  setThreadRttSize(width: number, height: number): void {
    if (this.view === 'thread') this.preview.setRttSize(width, height)
  }

  ownsPreview(which: 'board' | 'thread'): boolean {
    return which === 'thread' ? this.view === 'thread' : this.view === 'board' || this.view === 'viewer'
  }

  /**
   * View switch. Preview RTTs are one session-wide set: board↔thread hops
   * keep them so a post already parsed does not re-parse (request() rebinds
   * via onLive; the incoming view evicts what it cannot see). Viewer keeps
   * them for acquire() hand-off. Studio (idle) drops everything.
   */
  activate(view: LiveView): void {
    if (this.view === view) return
    const prev = this.view
    this.view = view
    if (view === 'thread') {
      this.board3d?.releaseAll()
    } else if (view === 'board') {
      this.thread3d?.releaseAll()
      if (prev === 'thread' || prev === 'idle') {
        this.preview.setRttSize(this.previewW, this.previewH)
      }
      if (prev === 'idle') this.preview.releaseAll()
    } else if (view === 'viewer') {
      this.board3d?.releaseAll()
      this.thread3d?.releaseAll()
    } else {
      this.board3d?.releaseAll()
      this.thread3d?.releaseAll()
      this.preview.releaseAll()
      this.preview.prune()
    }
    // Spatial audio: anchor stage sounds at the active view's cards.
    const active = view === 'thread' ? 'thread' : 'board'
    this.preview.opts.soundPosition = this.soundProviders.get(active) ?? undefined
  }

  dispose(): void {
    this.preview.dispose()
    this.board3d?.dispose()
    this.thread3d?.dispose()
  }
}
