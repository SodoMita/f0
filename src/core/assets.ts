import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture'
import { Scene } from '@babylonjs/core/scene'
import { get, put } from '../protocol/storage'
import { sha256Hex, BlossomClient } from '../protocol/blossom'
import type { ThreadMeta } from '../protocol/thread-index'
import { PosterRenderer, POSTER_W, POSTER_H, type Footprint } from '../model/poster'

// Bump when the poster pipeline changes visually (framing, transparency…):
// cached PNGs from an older pipeline must not be reused.
const POSTER_CACHE_V = 'p3:'

const MAX_POSTER_CONCURRENT = 3 // concurrent downloads; the shared render scene serializes renders internally
const AUTO_POSTER_MAX_BYTES = 8 * 1024 * 1024
// Decoded GLBs stay in IndexedDB; RAM only keeps the few most recent, or a
// board full of 20 MiB models parks hundreds of megabytes for nothing.
const MODEL_RAM_BUDGET = 48 * 1024 * 1024
const MODEL_RAM_MAX_ITEMS = 6

interface Job { meta: ThreadMeta; resolve: (tex: Texture | undefined) => void }

export class AssetCache {
  private posterTex = new Map<string, Texture>()
  private modelBlobs = new Map<string, Blob>() // insertion order == LRU order
  private modelInflight = new Map<string, Promise<Blob | undefined>>()
  private byPostId = new Map<string, ThreadMeta>()
  private animatedBySha = new Map<string, boolean>()
  private footprintBySha = new Map<string, Footprint | null>()
  private queue: Job[] = []
  private inflight = new Map<string, Promise<Texture | undefined>>()
  private active = 0
  private paused = false
  private poster: PosterRenderer

  constructor(private blossoms: BlossomClient, private scene: Scene) {
    this.poster = new PosterRenderer(scene.getEngine())
  }

  getModelBlobByPostId(postId: string): Promise<Blob | undefined> {
    const meta = this.byPostId.get(postId)
    return meta ? this.getModel(meta) : Promise.resolve(undefined)
  }

  /** Poster: thumb tag = fast path; local render = normal path (00 §2.2). */
  getPoster(meta: ThreadMeta): Promise<Texture | undefined> {
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
    try {
      // Fast path: freshly rendered posters go straight from the GPU readback
      // to a RawTexture. The old path went pixels -> PNG -> Image -> canvas ->
      // getImageData -> texture, i.e. an encode and a decode per poster.
      if (!meta.thumbUrl) {
        const direct = await this.renderLocalPixels(meta)
        if (direct) {
          const tex = RawTexture.CreateRGBATexture(
            direct.pixels, direct.width, direct.height, this.scene, false, false, Texture.BILINEAR_SAMPLINGMODE,
          )
          tex.name = 'poster-' + meta.eventId.slice(0, 8)
          tex.wrapU = Texture.CLAMP_ADDRESSMODE
          tex.wrapV = Texture.CLAMP_ADDRESSMODE
          this.posterTex.set(meta.eventId, tex)
          return tex
        }
      }
      const blob = meta.thumbUrl ? await this.fetchThumb(meta) : await this.cachedPoster(meta)
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

  /** Previously rendered poster (PNG) from IndexedDB, if any. */
  private async cachedPoster(meta: ThreadMeta): Promise<Blob | undefined> {
    const cached = await get<Blob>('posterCache', POSTER_CACHE_V + meta.sha256)
    if (!cached) return undefined
    const fp = await get<Footprint>('posterCache', POSTER_CACHE_V + meta.sha256 + ':fp')
    this.footprintBySha.set(meta.sha256, fp ?? null)
    return cached
  }

  /** Render a poster now and hand back the raw GPU pixels (no PNG round trip). */
  private async renderLocalPixels(meta: ThreadMeta): Promise<{ pixels: Uint8Array; width: number; height: number } | undefined> {
    if (meta.size > AUTO_POSTER_MAX_BYTES) return undefined // no auto-poster >8 MiB
    if (await this.cachedPoster(meta)) return undefined     // decode the cached PNG instead
    const model = await this.getModel(meta)
    if (!model) return undefined
    const result = await this.poster.render(model)
    this.animatedBySha.set(meta.sha256, result.animated)
    this.footprintBySha.set(meta.sha256, result.footprint)
    // Encode the cache copy off the critical path — the card is already up.
    setTimeout(() => {
      void result.toPng().then((png) => {
        void put('posterCache', POSTER_CACHE_V + meta.sha256, png)
        if (result.footprint) void put('posterCache', POSTER_CACHE_V + meta.sha256 + ':fp', result.footprint)
      }).catch(() => undefined)
    }, 0)
    return { pixels: result.pixels, width: result.width, height: result.height }
  }

  private async fetchThumb(meta: ThreadMeta): Promise<Blob | undefined> {
    if (!meta.thumbUrl) return undefined
    const cached = meta.thumbSha256 ? await get<Blob>('posterCache', POSTER_CACHE_V + meta.thumbSha256) : undefined
    if (cached) return cached
    const blob = await this.blossoms.download([meta.thumbUrl], meta.thumbSha256 ?? '', meta.thumbSize ?? 0)
    if (meta.thumbSha256) void put('posterCache', POSTER_CACHE_V + meta.thumbSha256, blob)
    return blob
  }

  async getModel(meta: ThreadMeta): Promise<Blob | undefined> {
    this.byPostId.set(meta.eventId, meta)
    const hit = this.modelBlobs.get(meta.eventId)
    if (hit) {
      // refresh LRU position
      this.modelBlobs.delete(meta.eventId)
      this.modelBlobs.set(meta.eventId, hit)
      return hit
    }
    const inflight = this.modelInflight.get(meta.eventId)
    if (inflight) return inflight
    const job = (async () => {
      try {
        const cached = await get<Blob>('modelCache', meta.sha256)
        const blob = cached ?? await this.blossoms.download(meta.urls, meta.sha256, meta.size)
        if (!cached) void put('modelCache', meta.sha256, blob)
        this.modelBlobs.set(meta.eventId, blob)
        this.evictModels()
        return blob
      } catch {
        return undefined
      } finally {
        this.modelInflight.delete(meta.eventId)
      }
    })()
    this.modelInflight.set(meta.eventId, job)
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
   * Falls back to a generated placeholder if the model renders blank
   * (transparent/empty/invisible) so publishing is not hard-blocked.
   */
  async renderPosterFor(model: Blob, tint = '#FF5C35'): Promise<{ blob: Blob; blank: boolean }> {
    try {
      const result = await this.poster.render(model)
      return { blob: await result.toPng(), blank: false }
    } catch (err) {
      if (err instanceof Error && /rendered empty|blank/i.test(err.message)) {
        return { blob: placeholderPoster(tint), blank: true }
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


/** A deterministic 448x280 placeholder used when a model renders blank. */
function placeholderPoster(tint: string): Blob {
  const canvas = document.createElement('canvas')
  canvas.width = POSTER_W
  canvas.height = POSTER_H
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#121213'
  ctx.fillRect(0, 0, POSTER_W, POSTER_H)
  ctx.strokeStyle = 'rgba(255,255,255,0.05)'
  ctx.lineWidth = 1
  for (let x = 0; x <= POSTER_W; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, POSTER_H); ctx.stroke() }
  for (let y = 0; y <= POSTER_H; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(POSTER_W, y); ctx.stroke() }
  ctx.fillStyle = tint
  const cx = POSTER_W / 2, cy = POSTER_H / 2
  ctx.beginPath()
  ctx.moveTo(cx, cy - 26); ctx.lineTo(cx + 26, cy); ctx.lineTo(cx, cy + 26); ctx.lineTo(cx - 26, cy); ctx.closePath()
  ctx.fill()
  // toBlob sync-ish
  const data = canvas.toDataURL('image/png')
  const bin = atob(data.slice(data.indexOf(',') + 1))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: 'image/png' })
}
