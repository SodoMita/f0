import { Texture, Scene } from '@babylonjs/core'
import { get, cacheBlob } from '../protocol/storage'
import type { ThreadMeta } from '../protocol/thread-index'
import { BlossomClient } from '../protocol/blossom'

export class AssetCache {
  private posterTex = new Map<string, Texture>()
  private modelBlobs = new Map<string, Blob>()
  private inflight = new Map<string, Promise<Blob | Texture | undefined>>()

  constructor(private blossoms: BlossomClient, private scene: Scene) {}

  async getPoster(meta: ThreadMeta): Promise<Texture | undefined> {
    if (!meta.thumbUrl) return undefined
    if (this.posterTex.has(meta.eventId)) return this.posterTex.get(meta.eventId)
    const existing = this.inflight.get('poster-' + meta.eventId) as Promise<Texture | undefined> | undefined
    if (existing) return existing
    const p = (async () => {
      try {
        const cached = meta.thumbSha256 ? await get<Blob>('posterCache', meta.thumbSha256) : undefined
        const blob = cached ?? await this.blossoms.download(
          [meta.thumbUrl!],
          meta.thumbSha256 ?? '',
          meta.thumbSize ?? 0,
        )
        if (meta.thumbSha256) void cacheBlob('posterCache', meta.thumbSha256, blob)
        const url = URL.createObjectURL(blob)
        const tex = new Texture(url, this.scene, false, false)
        tex.onLoadObservable.addOnce(() => URL.revokeObjectURL(url))
        this.posterTex.set(meta.eventId, tex)
        return tex
      } catch {
        return undefined
      } finally {
        this.inflight.delete('poster-' + meta.eventId)
      }
    })()
    this.inflight.set('poster-' + meta.eventId, p as Promise<Blob | Texture | undefined>)
    return p
  }

  async getModel(meta: ThreadMeta): Promise<Blob | undefined> {
    if (this.modelBlobs.has(meta.eventId)) return this.modelBlobs.get(meta.eventId)
    try {
      const cached = await get<Blob>('modelCache', meta.sha256)
      const blob = cached ?? await this.blossoms.download(meta.urls, meta.sha256, meta.size)
      if (!cached) void cacheBlob('modelCache', meta.sha256, blob)
      this.modelBlobs.set(meta.eventId, blob)
      return blob
    } catch {
      return undefined
    }
  }

  dispose(): void {
    for (const t of this.posterTex.values()) t.dispose()
    this.posterTex.clear()
    this.modelBlobs.clear()
  }
}
