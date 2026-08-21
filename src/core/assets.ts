import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { Scene } from '@babylonjs/core/scene'
import { clearStore, del, get, put } from '../protocol/storage'
import { BlossomClient } from '../protocol/blossom'
import { blobMatchesHash, blobToBytes, bytesToBlob, isHashMismatch, isSha256Hex, sha256Hex } from '../protocol/hash'
import type { ThreadMeta } from '../protocol/thread-index'
import { PosterRenderer, POSTER_W, POSTER_H, type Footprint, type PosterResult } from '../model/poster'
import { LIMITS } from '../theme'

// Metadata only (anim / footprint). The card texture is the live RTT —
// we do not cache pixels (that was VRAM→RAM→VRAM).
const POSTER_CACHE_V = 'p7:'

const MAX_POSTER_CONCURRENT = 3 // concurrent downloads; the shared render scene serializes renders internally
// Decoded GLBs stay in IndexedDB; RAM only keeps the few most recent, or a
// board full of 20 MiB models parks hundreds of megabytes for nothing.
let MODEL_RAM_BUDGET = 48 * 1024 * 1024
const MODEL_RAM_MAX_ITEMS = 6
/** Resident card textures (settings → Memory). Posters are ~0.5 MB each. */
let POSTER_TEX_BUDGET = 32

interface Job { meta: ThreadMeta; resolve: (tex: Texture | undefined) => void }

export class AssetCache {
  private posterTex = new Map<string, Texture>()
  private modelBlobs = new Map<string, Blob>() // keyed by sha256; insertion order == LRU order
  private modelInflight = new Map<string, Promise<Blob | undefined>>() // keyed by sha256
  private modelBytes = new Map<string, Uint8Array>() // insertion order == LRU
  private byPostId = new Map<string, ThreadMeta>()
  private animatedBySha = new Map<string, boolean>()
  private footprintBySha = new Map<string, Footprint | null>()
  private hashFailed = new Set<string>()
  /** Blob / byte-array objects already verified against a hex64 digest. */
  private verified = new WeakMap<object, string>()
  private queue: Job[] = []
  private inflight = new Map<string, Promise<Texture | undefined>>()
  private active = 0
  private paused = false
  private poster: PosterRenderer
  /** Last per-replica download failure per event — feeds the E101 detail. */
  private lastFailure = new Map<string, string>()
  /** Fired once per post when downloaded/cached bytes do not match `x`. */
  onHashFailed: ((meta: ThreadMeta) => void) | null = null

  constructor(private blossoms: BlossomClient, private scene: Scene) {
    this.poster = new PosterRenderer(scene.getEngine())
  }

  isHashFailed(eventId: string): boolean { return this.hashFailed.has(eventId) }

  /**
   * Clear the failure marks for an event so a retry REALLY re-attempts the
   * download (AMENDMENT 72). A failed fetch used to mark the post for the
   * rest of the session with no way back — one transient bad fetch of a
   * seconds-old blob (a fresh upload racing its own CDN propagation) turned
   * into E101 on every later tap, forever. Verified local bytes, when
   * present (seeded at publish), serve immediately after this.
   */
  unfail(eventId: string): void {
    this.hashFailed.delete(eventId)
    this.lastFailure.delete(eventId)
  }

  private failHash(meta: ThreadMeta): void {
    if (this.hashFailed.has(meta.eventId)) return
    this.hashFailed.add(meta.eventId)
    this.posterTex.get(meta.eventId)?.dispose()
    this.posterTex.delete(meta.eventId)
    this.onHashFailed?.(meta)
  }

  /** Re-hash `data` against the claimed sha. Key-exists ≠ bytes match. */
  private async matchesClaimed(data: Blob | Uint8Array, claimed: string): Promise<boolean> {
    if (!isSha256Hex(claimed)) return false
    const expect = claimed.toLowerCase()
    const known = this.verified.get(data)
    if (known) return known === expect
    const ok = data instanceof Blob
      ? await blobMatchesHash(data, expect)
      : (await sha256Hex(data)) === expect
    if (ok) this.verified.set(data, expect)
    return ok
  }

  private dropModelRam(sha: string): void {
    this.modelBlobs.delete(sha)
    this.modelBytes.delete(sha)
  }

  /**
   * Remember a post so its model can be fetched by event id alone.
   *
   * `getPoster()` used to be the ONLY thing that filled this map, which made
   * every by-post-id download depend on a poster having been requested
   * first. In 3D mode no poster is ever requested, so cards/nodes that came
   * into view while the toggle was on failed with "download failed", were
   * latched as rejected and fell back to 2D forever (thread replies never
   * went 3D at all — they had no poster from the board either).
   */
  noteMeta(meta: ThreadMeta): void {
    this.byPostId.set(meta.eventId, meta)
  }

  getModelBlobByPostId(postId: string): Promise<Blob | undefined> {
    const meta = this.byPostId.get(postId)
    return meta ? this.getModel(meta) : Promise.resolve(undefined)
  }

  /** Shared bytes + content hash + camera hint for a post (preview pool). */
  async getModelBytesByPostId(postId: string): Promise<{ bytes: Uint8Array; sha256: string; cameraIndex?: number } | undefined> {
    const meta = this.byPostId.get(postId)
    if (!meta) return undefined
    const bytes = await this.getModelBytes(meta)
    // v3 `preview-camera` index: the live preview must use the camera the
    // author picked, not blindly camera 0. (The field is named cameraIndex
    // here to match PreviewModel — it IS meta.previewCamera.)
    return bytes ? { bytes, sha256: meta.sha256, cameraIndex: meta.previewCamera } : undefined
  }

  /**
   * Seed the verified model caches with bytes we already hold (AMENDMENT
   * 71) — publishModel's frozen upload snapshot. The event `x` tag IS the
   * hash of exactly these bytes, so a fresh own post loads from here with
   * no network round trip at all: replicas that serve bad bytes, redirect,
   * or are simply unreachable cannot break the author's own view. The hash
   * check still runs on every cache read (matchesClaimed), so a poisoned
   * seed can never reach Babylon — it falls back to the replicas instead.
   * Returns false when the bytes do not hash to `sha256`.
   */
  async seedModelBytes(sha256: string, bytes: Uint8Array): Promise<boolean> {
    const sha = sha256.toLowerCase()
    if (!isSha256Hex(sha) || bytes.length === 0 || bytes.length > LIMITS.modelBytesHard) return false
    try {
      if ((await sha256Hex(bytes)) !== sha) return false
    } catch { return false }
    const blob = bytesToBlob(bytes, 'model/gltf-binary')
    this.verified.set(bytes, sha)
    this.verified.set(blob, sha)
    this.modelBytes.set(sha, bytes)
    this.modelBlobs.set(sha, blob)
    this.evictModels()
    void put('modelCache', sha, blob)
    return true
  }

  /** Per-replica failure detail of the last failed download (E101 sheet). */
  failureDetail(eventId: string): string {
    return this.lastFailure.get(eventId) ?? ''
  }

  /**
   * Model bytes, decoded once and shared. `blob.arrayBuffer()` copies the
   * whole file every call, and poster + preview + viewer each did it (plus
   * Babylon's own File/FileReader copy on top).
   */
  async getModelBytes(meta: ThreadMeta): Promise<Uint8Array | undefined> {
    if (this.hashFailed.has(meta.eventId) || meta.hashFailed) return undefined
    if (!isSha256Hex(meta.sha256)) { this.failHash(meta); return undefined }
    const hit = this.modelBytes.get(meta.sha256)
    if (hit) {
      if (await this.matchesClaimed(hit, meta.sha256)) return hit
      this.dropModelRam(meta.sha256)
    }
    const blob = await this.getModel(meta)
    if (!blob) return undefined
    const bytes = await blobToBytes(blob)
    if (!(await this.matchesClaimed(bytes, meta.sha256))) {
      this.dropModelRam(meta.sha256)
      this.failHash(meta)
      return undefined
    }
    this.modelBytes.set(meta.sha256, bytes)
    // bytes are heavier than blobs (blobs can live on disk) — keep very few
    while (this.modelBytes.size > 3) {
      const oldest = this.modelBytes.keys().next()
      if (oldest.done) break
      this.modelBytes.delete(oldest.value)
    }
    return bytes
  }

  /**
   * Synchronous RAM-cache lookup. The board uses this to re-apply a poster
   * the moment a scrolled-back card is rebound to a slot — the texture never
   * left the GPU, so there is nothing to wait for (game-engine style
   * enable/disable, not reload).
   */
  peekPoster(meta: ThreadMeta): Texture | undefined {
    if (this.hashFailed.has(meta.eventId) || meta.hashFailed) return undefined
    return this.posterTex.get(meta.eventId)
  }

  /** Scenes that render offscreen content (posters) — graphics settings apply. */
  offscreenScenes(): import('@babylonjs/core/scene').Scene[] {
    return [this.poster.scene]
  }

  /** Wipe the on-disk caches (settings → Memory). */
  async clearCaches(): Promise<void> {
    for (const t of this.posterTex.values()) t.dispose()
    this.posterTex.clear()
    this.modelBlobs.clear()
    this.modelBytes.clear()
    this.footprintBySha.clear()
    await clearStore('posterCache')
    await clearStore('modelCache')
  }

  /** Settings → Memory. */
  setBudgets(o: { modelRamMiB?: number; textures?: number }): void {
    if (o.modelRamMiB) MODEL_RAM_BUDGET = Math.max(4, o.modelRamMiB) * 1024 * 1024
    if (o.textures) POSTER_TEX_BUDGET = Math.max(4, Math.round(o.textures))
    this.evictModels()
    this.evictPosters()
  }

  /** Drop the least recently shown poster textures over budget. */
  private evictPosters(): void {
    while (this.posterTex.size > POSTER_TEX_BUDGET) {
      const oldest = this.posterTex.keys().next()
      if (oldest.done) break
      this.posterTex.get(oldest.value)?.dispose()
      this.posterTex.delete(oldest.value)
    }
  }

  /** Poster: always a LOCAL render from the model, at the post's `dim` size. */
  getPoster(meta: ThreadMeta): Promise<Texture | undefined> {
    if (this.hashFailed.has(meta.eventId) || meta.hashFailed) return Promise.resolve(undefined)
    this.byPostId.set(meta.eventId, meta)
    const hit = this.posterTex.get(meta.eventId)
    if (hit) return Promise.resolve(hit)
    const key = 'poster-' + meta.eventId
    const existing = this.inflight.get(key)
    if (existing) return existing
    const p = new Promise<Texture | undefined>((resolve) => {
      this.queue.push({ meta, resolve })
      this.queue.sort((a, b) => a.meta.size - b.meta.size)
      this.drain()
    })
    this.inflight.set(key, p)
    return p
  }

  /**
   * Drop a queued poster job that nobody is waiting for any more (the card
   * scrolled away and its slot was recycled). Jobs already rendering finish.
   */
  cancelPoster(eventId: string): void {
    const at = this.queue.findIndex((j) => j.meta.eventId === eventId)
    if (at < 0) return
    const [job] = this.queue.splice(at, 1)
    this.inflight.delete('poster-' + eventId)
    job.resolve(undefined)
  }

  isAnimated(meta: ThreadMeta): boolean | undefined {
    return this.animatedBySha.get(meta.sha256)
  }

  /** Where the model sits inside its poster (for the card contact shadow). */
  getFootprint(meta: ThreadMeta): Footprint | null | undefined {
    return this.footprintBySha.get(meta.sha256)
  }

  /**
   * Suspend poster work. A GLB parse plus an offscreen render blocks the main
   * thread for tens to hundreds of milliseconds; the board pauses the queue
   * while the feed is being flung so those stalls don't land mid-scroll.
   */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return
    this.paused = paused
    if (!paused) this.drain()
  }

  private drain(): void {
    if (this.paused) return
    while (this.active < MAX_POSTER_CONCURRENT && this.queue.length) {
      this.active++
      const job = this.queue.shift()!
      this.produce(job.meta)
        .then((t) => job.resolve(t))
        .catch(() => job.resolve(undefined))
        .finally(() => { this.active--; this.inflight.delete('poster-' + job.meta.eventId); this.drain() })
    }
  }

  private async produce(meta: ThreadMeta): Promise<Texture | undefined> {
    if (this.hashFailed.has(meta.eventId) || meta.hashFailed) return undefined
    try {
      await this.restorePosterMeta(meta)
      const result = await this.renderLocal(meta)
      if (!result) return undefined
      if (this.hashFailed.has(meta.eventId) || meta.hashFailed) {
        result.texture.dispose()
        return undefined
      }
      // The RTT stays on the GPU. Cards sample it directly — no readPixels,
      // no RawTexture upload.
      result.texture.hasAlpha = true
      result.texture.name = 'poster-' + meta.eventId.slice(0, 8)
      this.posterTex.set(meta.eventId, result.texture)
      this.evictPosters()
      return result.texture
    } catch { return undefined }
  }

  /** Cache key for a post's locally rendered poster at its declared size. */
  private static posterKey(meta: ThreadMeta): string {
    return `${POSTER_CACHE_V}${meta.sha256}@${meta.width}x${meta.height}`
  }

  /** Restore anim/footprint flags from IDB (no pixel payload). */
  private async restorePosterMeta(meta: ThreadMeta): Promise<void> {
    const key = AssetCache.posterKey(meta)
    if (!this.footprintBySha.has(meta.sha256)) {
      const fp = await get<Footprint>('posterCache', key + ':fp')
      if (fp !== undefined) this.footprintBySha.set(meta.sha256, fp)
    }
    if (!this.animatedBySha.has(meta.sha256)) {
      const anim = await get<boolean>('posterCache', key + ':anim')
      if (anim !== undefined) this.animatedBySha.set(meta.sha256, anim)
    }
  }

  /** Render a poster now into a dedicated transparent RTT. Stays on the GPU. */
  private async renderLocal(meta: ThreadMeta): Promise<PosterResult | undefined> {
    const bytes = await this.getModelBytes(meta)
    if (!bytes) return undefined
    const result = await this.poster.render(bytes, meta.sha256, meta.width, meta.height)
    this.animatedBySha.set(meta.sha256, result.animated)
    this.footprintBySha.set(meta.sha256, result.footprint)
    const key = AssetCache.posterKey(meta)
    if (result.footprint) void put('posterCache', key + ':fp', result.footprint)
    void put('posterCache', key + ':anim', result.animated)
    return result
  }

  async getModel(meta: ThreadMeta): Promise<Blob | undefined> {
    this.byPostId.set(meta.eventId, meta)
    if (this.hashFailed.has(meta.eventId) || meta.hashFailed) return undefined
    // parse already requires hex64 `x`. Empty / garbage hash is a refuse.
    if (!isSha256Hex(meta.sha256)) { this.failHash(meta); return undefined }
    // Key the RAM blob cache and the in-flight dedup by the CONTENT hash
    // (sha256), not by eventId. Two posts that embed the same GLB are the
    // same bytes: keying by eventId downloaded/held one blob per post, so a
    // board full of reposts (or a poster render racing its own preview) hit
    // the network once per post instead of once per model.
    const hit = this.modelBlobs.get(meta.sha256)
    if (hit) {
      if (await this.matchesClaimed(hit, meta.sha256)) {
        this.modelBlobs.delete(meta.sha256)
        this.modelBlobs.set(meta.sha256, hit)
        return hit
      }
      this.dropModelRam(meta.sha256)
    }
    const inflight = this.modelInflight.get(meta.sha256)
    if (inflight) {
      const blob = await inflight
      if (blob && await this.matchesClaimed(blob, meta.sha256)) return blob
      return undefined
    }
    const job = (async () => {
      try {
        const cached = await get<Blob>('modelCache', meta.sha256)
        if (cached) {
          // Key exists ≠ bytes match. A poisoned IndexedDB entry (torn
          // upload, pre-hash-check build) must not reach Babylon. Drop it
          // and redownload — do NOT failHash: the event `x` may be honest.
          if (await this.matchesClaimed(cached, meta.sha256)) {
            this.modelBlobs.set(meta.sha256, cached)
            this.evictModels()
            return cached
          }
          await del('modelCache', meta.sha256)
        }
        let blob: Blob
        try {
          blob = await this.blossoms.download(meta.urls, meta.sha256, meta.size)
        } catch (err) {
          // A hash mismatch is permanent for this post (hide the card); a
          // network / oversize failure is not — the caller may retry.
          // AMENDMENT 71: keep the per-replica detail for the E101 sheet.
          this.lastFailure.set(meta.eventId, err instanceof Error ? err.message : String(err))
          if (isHashMismatch(err)) this.failHash(meta)
          throw err
        }
        if (!(await this.matchesClaimed(blob, meta.sha256))) {
          this.lastFailure.set(meta.eventId, `replica bytes did not hash to ${meta.sha256.slice(0, 12)}…`)
          this.failHash(meta)
          return undefined
        }
        // Hash wins: a stale size tag is not corruption. Fix local meta so
        // the next transfer meter is honest.
        if (meta.size !== blob.size) meta.size = blob.size
        void put('modelCache', meta.sha256, blob)
        this.modelBlobs.set(meta.sha256, blob)
        this.evictModels()
        return blob
      } catch {
        return undefined
      } finally {
        this.modelInflight.delete(meta.sha256)
      }
    })()
    this.modelInflight.set(meta.sha256, job)
    return job
  }

  /** Keep the in-RAM blob cache bounded (IndexedDB still has everything). */
  private evictModels(): void {
    let bytes = 0
    for (const b of this.modelBlobs.values()) bytes += b.size
    while (this.modelBlobs.size > MODEL_RAM_MAX_ITEMS || bytes > MODEL_RAM_BUDGET) {
      const oldest = this.modelBlobs.keys().next()
      if (oldest.done) break
      bytes -= this.modelBlobs.get(oldest.value)?.size ?? 0
      this.modelBlobs.delete(oldest.value)
    }
  }

  /**
   * Render a poster for an arbitrary (not-yet-published) model blob.
   * NOT part of publishing (format v4: the studio generates no poster at
   * all) — this is a direct probe of the local render pipeline, used by the
   * verification rig to pixel-check the camera policy and by the studio
   * card preview. Returns raw GL-order RGBA (no PNG).
   */
  async renderPosterFor(model: Blob, width = POSTER_W, height = POSTER_H): Promise<{
    pixels: Uint8Array; width: number; height: number
  }> {
    const bytes = new Uint8Array(await model.arrayBuffer())
    const sha = await sha256Hex(bytes)
    const result = await this.poster.render(bytes, sha, width, height)
    // Studio / tests need a CPU copy. The board never takes this path.
    const pixels = await this.poster.snapshot(result.texture, result.width, result.height)
    result.texture.dispose()
    return { pixels, width: result.width, height: result.height }
  }

  dispose(): void {
    for (const t of this.posterTex.values()) t.dispose()
    this.posterTex.clear()
    this.modelBlobs.clear()
    this.poster.dispose()
  }
}

export { sha256Hex }
