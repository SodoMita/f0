import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture'
import { Scene } from '@babylonjs/core/scene'
import { clearStore, del, get, put } from '../protocol/storage'
import { sha256Hex, BlossomClient } from '../protocol/blossom'
import { blobMatchesHash, isHashMismatch } from '../protocol/hash'
import type { ThreadMeta } from '../protocol/thread-index'
import { PosterRenderer, POSTER_W, POSTER_H, type Footprint } from '../model/poster'

// Bump when the poster pipeline changes visually (framing, transparency…):
// cached PNGs from an older pipeline must not be reused. p5 = format v4:
// posters are ONLY rendered locally (no thumb fetch), sized by `dim`, and
// the cache key carries the post's declared size.
const POSTER_CACHE_V = 'p5:'

const MAX_POSTER_CONCURRENT = 3 // concurrent downloads; the shared render scene serializes renders internally
const AUTO_POSTER_MAX_BYTES = 8 * 1024 * 1024
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
  private queue: Job[] = []
  private inflight = new Map<string, Promise<Texture | undefined>>()
  private active = 0
  private paused = false
  private poster: PosterRenderer
  /** Fired once per post when downloaded/cached bytes do not match `x`. */
  onHashFailed: ((meta: ThreadMeta) => void) | null = null

  constructor(private blossoms: BlossomClient, private scene: Scene) {
    this.poster = new PosterRenderer(scene.getEngine())
  }

  isHashFailed(eventId: string): boolean { return this.hashFailed.has(eventId) }

  private failHash(meta: ThreadMeta): void {
    if (this.hashFailed.has(meta.eventId)) return
    this.hashFailed.add(meta.eventId)
    this.posterTex.get(meta.eventId)?.dispose()
    this.posterTex.delete(meta.eventId)
    this.modelBlobs.delete(meta.sha256)
    this.modelBytes.delete(meta.sha256)
    this.onHashFailed?.(meta)
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
   * Model bytes, decoded once and shared. `blob.arrayBuffer()` copies the
   * whole file every call, and poster + preview + viewer each did it (plus
   * Babylon's own File/FileReader copy on top).
   */
  async getModelBytes(meta: ThreadMeta): Promise<Uint8Array | undefined> {
    if (this.hashFailed.has(meta.eventId) || meta.hashFailed) return undefined
    const hit = this.modelBytes.get(meta.sha256)
    if (hit) return hit
    const blob = await this.getModel(meta)
    if (!blob) return undefined
    const bytes = new Uint8Array(await blob.arrayBuffer())
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
      // Fast path: freshly rendered posters go straight from the GPU readback
      // to a RawTexture. The old path went pixels -> PNG -> Image -> canvas ->
      // getImageData -> texture, i.e. an encode and a decode per poster.
      const direct = await this.renderLocalPixels(meta)
      if (direct) {
        const tex = RawTexture.CreateRGBATexture(
          direct.pixels, direct.width, direct.height, this.scene, false, false, Texture.BILINEAR_SAMPLINGMODE,
        )
        tex.name = 'poster-' + meta.eventId.slice(0, 8)
        tex.wrapU = Texture.CLAMP_ADDRESSMODE
        tex.wrapV = Texture.CLAMP_ADDRESSMODE
        this.posterTex.set(meta.eventId, tex)
        this.evictPosters()
        return tex
      }
      // No fresh render (model > AUTO_POSTER_MAX_BYTES, render failed…):
      // decode a previously rendered (locally cached) copy if one exists.
      // Format v4: a poster PNG is NEVER fetched from a server.
      const blob = await this.cachedPoster(meta)
      if (!blob) return undefined
      // Decode the PNG to raw RGBA and upload directly (RawTexture). This
      // sidesteps both the async blob-URL Texture load and DynamicTexture's
      // canvas handling, which blank out on strict drivers.
      const img = await loadImage(blob)
      const w = img.naturalWidth || 512
      const h = img.naturalHeight || 320
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const ctx = c.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const id = ctx.getImageData(0, 0, w, h)
      const tex = RawTexture.CreateRGBATexture(id.data, w, h, this.scene, false, true, Texture.BILINEAR_SAMPLINGMODE)
      tex.name = 'poster-' + meta.eventId.slice(0, 8)
      tex.wrapU = Texture.CLAMP_ADDRESSMODE
      tex.wrapV = Texture.CLAMP_ADDRESSMODE
      this.posterTex.set(meta.eventId, tex)
      return tex
    } catch { return undefined }
  }

  /** Cache key for a post's locally rendered poster at its declared size. */
  private static posterKey(meta: ThreadMeta): string {
    return `${POSTER_CACHE_V}${meta.sha256}@${meta.width}x${meta.height}`
  }

  /** Previously rendered poster (PNG) from IndexedDB, if any. */
  private async cachedPoster(meta: ThreadMeta): Promise<Blob | undefined> {
    const key = AssetCache.posterKey(meta)
    const cached = await get<Blob>('posterCache', key)
    if (!cached) return undefined
    const fp = await get<Footprint>('posterCache', key + ':fp')
    this.footprintBySha.set(meta.sha256, fp ?? null)
    // The animated flag is part of the poster cache record: without it a
    // reload "forgot" which posts animate (events carry no anim hint), so
    // live previews were never requested again — posts stopped animating
    // for everyone with a warm cache.
    if (!this.animatedBySha.has(meta.sha256)) {
      const anim = await get<boolean>('posterCache', key + ':anim')
      if (anim !== undefined) this.animatedBySha.set(meta.sha256, anim)
    }
    return cached
  }

  /** Render a poster now and hand back the raw GPU pixels (no PNG round trip). */
  private async renderLocalPixels(meta: ThreadMeta): Promise<{ pixels: Uint8Array; width: number; height: number } | undefined> {
    if (meta.size > AUTO_POSTER_MAX_BYTES) return undefined // no auto-poster >8 MiB
    if (await this.cachedPoster(meta)) return undefined     // decode the cached PNG instead
    const bytes = await this.getModelBytes(meta)
    if (!bytes) return undefined
    // Format v4: render at the post's declared `dim` size.
    const result = await this.poster.render(bytes, meta.sha256, meta.width, meta.height)
    this.animatedBySha.set(meta.sha256, result.animated)
    this.footprintBySha.set(meta.sha256, result.footprint)
    // Encode the cache copy when the browser is idle — the card is already up
    // and canvas.toBlob is another chunk of main thread.
    const key = AssetCache.posterKey(meta)
    const idle = (fn: () => void) => (typeof requestIdleCallback === 'function'
      ? requestIdleCallback(fn, { timeout: 4000 })
      : setTimeout(fn, 400))
    idle(() => {
      void result.toPng().then((png) => {
        void put('posterCache', key, png)
        if (result.footprint) void put('posterCache', key + ':fp', result.footprint)
        void put('posterCache', key + ':anim', result.animated)
      }).catch(() => undefined)
    })
    return { pixels: result.pixels, width: result.width, height: result.height }
  }

  async getModel(meta: ThreadMeta): Promise<Blob | undefined> {
    this.byPostId.set(meta.eventId, meta)
    // Key the RAM blob cache and the in-flight dedup by the CONTENT hash
    // (sha256), not by eventId. Two posts that embed the same GLB are the
    // same bytes: keying by eventId downloaded/held one blob per post, so a
    // board full of reposts (or a poster render racing its own preview) hit
    // the network once per post instead of once per model.
    const hit = this.modelBlobs.get(meta.sha256)
    if (hit) {
      // refresh LRU position
      this.modelBlobs.delete(meta.sha256)
      this.modelBlobs.set(meta.sha256, hit)
      return hit
    }
    const inflight = this.modelInflight.get(meta.sha256)
    if (inflight) return inflight
    const job = (async () => {
      try {
        const cached = await get<Blob>('modelCache', meta.sha256)
        if (cached) {
          // Cached bytes must still match the event `x` tag: a poisoned
          // IndexedDB entry (torn upload, pre-hash-check build) must not
          // render. Drop it and flag the post so the board hides the card.
          if (!(await blobMatchesHash(cached, meta.sha256))) {
            await del('modelCache', meta.sha256)
            this.failHash(meta)
            return undefined
          }
          this.modelBlobs.set(meta.sha256, cached)
          this.evictModels()
          return cached
        }
        let blob: Blob
        try {
          blob = await this.blossoms.download(meta.urls, meta.sha256, meta.size)
        } catch (err) {
          // A hash mismatch is permanent for this post (hide the card); a
          // network failure is not — the caller may retry, so only the
          // mismatch is recorded.
          if (isHashMismatch(err)) this.failHash(meta)
          throw err
        }
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
   * Pre-publish poster render for an arbitrary (not-yet-published) model
   * blob. Format v4: the PNG stays LOCAL (it is never uploaded); the publish
   * flow needs the validated render size for the event's `dim` tag, and the
   * bytes are returned for verification/pixel checks only.
   * A blank render (transparent/empty/invisible) does not hard-block — the
   * caller warns and the post still publishes.
   */
  async renderPosterFor(model: Blob): Promise<{ blob: Blob; width: number; height: number; blank: boolean }> {
    // PosterRenderer takes shared bytes + a content hash (see SPEC 30)
    const bytes = new Uint8Array(await model.arrayBuffer())
    const sha = await sha256Hex(bytes)
    try {
      const result = await this.poster.render(bytes, sha)
      return { blob: await result.toPng(), width: result.width, height: result.height, blank: false }
    } catch (err) {
      if (err instanceof Error && /rendered empty|blank/i.test(err.message)) {
        return { blob: new Blob(), width: POSTER_W, height: POSTER_H, blank: true }
      }
      throw err
    }
  }

  dispose(): void {
    for (const t of this.posterTex.values()) t.dispose()
    this.posterTex.clear()
    this.modelBlobs.clear()
    this.poster.dispose()
  }
}

export { sha256Hex }

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('poster decode failed')) }
    img.src = url
  })
}
