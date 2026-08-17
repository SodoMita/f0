import { finalizeEvent, generateSecretKey, type EventTemplate } from 'nostr-tools'
import { LIMITS } from '../theme'
import { normalizeRelay } from './nostr'

function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return crypto.subtle.digest('SHA-256', buf).then((digest) =>
    Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(''),
  )
}

function normalizeBlossom(value: string): string | null {
  try {
    const u = new URL(value.trim())
    if (u.protocol !== 'https:') return null
    u.username = ''
    u.password = ''
    u.hash = ''
    u.search = ''
    if (u.pathname === '/') u.pathname = ''
    return u.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

export class BlossomClient {
  servers: string[]
  constructor(servers: string[] = []) {
    this.servers = Array.from(new Set(servers.map(normalizeBlossom).filter(Boolean) as string[]))
  }

  setServers(servers: string[]): void {
    this.servers = Array.from(new Set(servers.map(normalizeBlossom).filter(Boolean) as string[]))
  }

  private auth(method: 'upload' | 'delete' | 'list', hash: string, secret: Uint8Array): Promise<string> {
    return new Promise((resolve) => {
      const t: EventTemplate = {
        kind: 24242,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['t', method],
          ['x', hash],
          ['expiration', String(Math.floor(Date.now() / 1000) + 600)],
        ],
        content: '',
      }
      const signed = finalizeEvent(t, secret)
      resolve(btoa(JSON.stringify(signed)))
    })
  }

  async upload(blob: Blob, secret: Uint8Array, onProgress?: (done: number, total: number, server: string) => void): Promise<{ url: string; sha256: string }[]> {
    if (blob.size > LIMITS.modelBytesHard) throw new Error(`Final GLB exceeds 20 MiB (${(blob.size / 1048576).toFixed(1)} MiB).`)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const hash = await sha256Hex(bytes)
    const results: { url: string; sha256: string }[] = []
    await Promise.all(
      this.servers.map(async (server) => {
        const auth = await this.auth('upload', hash, secret)
        const res = await fetch(`${server}/upload`, {
          method: 'PUT',
          headers: { Authorization: `Nostr ${auth}` },
          body: blob,
          credentials: 'omit',
          signal: AbortSignal.timeout(60000),
        })
        if (!res.ok) throw new Error(`${server} upload failed (${res.status})`)
        const json = await res.json()
        const url: string | undefined = json?.url
        if (!url || !/^https:\/\//i.test(url)) throw new Error(`${server} returned invalid URL`)
        onProgress?.(blob.size, blob.size, server)
        results.push({ url, sha256: hash })
      }),
    )
    if (!results.length) throw new Error('No Blossom replica completed.')
    return results
  }

  async download(urls: string[], hash: string, expectedSize: number, signal?: AbortSignal): Promise<Blob> {
    const allowed = new Set(this.servers.map((s) => new URL(s).origin))
    for (const url of urls) {
      try {
        const u = new URL(url)
        if (!allowed.has(u.origin)) continue
        const res = await fetch(url, { credentials: 'omit', signal: signal ?? AbortSignal.timeout(30000) })
        if (!res.ok || !res.body) continue
        const reader = res.body.getReader()
        const chunks: Uint8Array[] = []
        let total = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.length
          if (total > LIMITS.modelBytesHard) throw new Error('stream exceeded size cap')
          chunks.push(value)
        }
        if (total !== expectedSize) continue
        const blob = new Blob(chunks as BlobPart[], { type: 'model/gltf-binary' })
        const actualHash = await sha256Hex(new Uint8Array(await blob.arrayBuffer()))
        if (actualHash !== hash) continue
        return blob
      } catch {
        // try next replica
      }
    }
    throw new Error('No verified replica available.')
  }
}

export { generateSecretKey, normalizeBlossom, normalizeRelay }
