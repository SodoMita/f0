import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture'
import { Scene } from '@babylonjs/core/scene'
import { get, put } from '../protocol/storage'
import { sha256Hex, BlossomClient } from '../protocol/blossom'
import type { ThreadMeta } from '../protocol/thread-index'
import { PosterRenderer, type Footprint } from '../model/poster'

// Bump when the poster pipeline changes visually (framing, transparency…):
// cached PNGs from an older pipeline must not be reused.
const POSTER_CACHE_V = 'p3:'

const MAX_POSTER_CONCURRENT = 3 // concurrent downloads; the shared render scene serializes renders internally
const AUTO_POSTER_MAX_BYTES = 8 * 1024 * 1024

interface Job { meta: ThreadMeta; resolve: (tex: Texture | undefined) => void }

export class AssetCache {
  private posterTex = new Map<string, Texture>()
  private modelBlobs = new Map<string, Blob>()
  private byPostId = new Map<string, ThreadMeta>()
  private animatedBySha = new Map<string, boolean>()
  private footprintBySha = new Map<string, Footprint | null>()
  private queue: Job[] = []
  private inflight = new Map<string, Promise<Texture | undefined>>()
  private active = 0
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

  isAnimated(meta: ThreadMeta): boolean | undefined {
    return this.animatedBySha.get(meta.sha256)
  }

  /** Where the model sits inside its poster (for the card contact shadow). */
  getFootprint(meta: ThreadMeta): Footprint | null | undefined {
    return this.footprintBySha.get(meta.sha256)
  }

  private drain(): void {
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
      const blob = meta.thumbUrl ? await this.fetchThumb(meta) : await this.renderLocal(meta)
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

  private async renderLocal(meta: ThreadMeta): Promise<Blob | undefined> {
    if (meta.size > AUTO_POSTER_MAX_BYTES) return undefined // no auto-poster >8 MiB
    const cached = await get<Blob>('posterCache', POSTER_CACHE_V + meta.sha256)
    if (cached) {
      const fp = await get<Footprint>('posterCache', POSTER_CACHE_V + meta.sha256 + ':fp')
      this.footprintBySha.set(meta.sha256, fp ?? null)
      return cached
    }
    const model = await this.getModel(meta)
    if (!model) return undefined
    const result = await this.poster.render(model)
    this.animatedBySha.set(meta.sha256, result.animated)
    this.footprintBySha.set(meta.sha256, result.footprint)
    void put('posterCache', POSTER_CACHE_V + meta.sha256, result.blob)
    if (result.footprint) void put('posterCache', POSTER_CACHE_V + meta.sha256 + ':fp', result.footprint)
    return result.blob
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
    if (hit) return hit
    try {
      const cached = await get<Blob>('modelCache', meta.sha256)
      const blob = cached ?? await this.blossoms.download(meta.urls, meta.sha256, meta.size)
      if (!cached) void put('modelCache', meta.sha256, blob)
      this.modelBlobs.set(meta.eventId, blob)
      return blob
    } catch { return undefined }
  }

  /** Render a poster for an arbitrary (not-yet-published) model blob. */
  async renderPosterFor(model: Blob): Promise<Blob> {
    const result = await this.poster.render(model)
    return result.blob
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
