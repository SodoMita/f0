import { finalizeEvent, generateSecretKey, type EventTemplate } from 'nostr-tools'
import { BLOSSOM_AUTH_KIND, LIMITS } from '../theme'

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
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
  } catch { return null }
}

const GLB_MAGIC = [0x67, 0x6c, 0x54, 0x46] // 'glTF'
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] // '\x89PNG'

export type BlobKind = 'glb' | 'png'

function magicOk(bytes: Uint8Array, kind: BlobKind): boolean {
  const magic = kind === 'png' ? PNG_MAGIC : GLB_MAGIC
  return bytes[0] === magic[0] && bytes[1] === magic[1] && bytes[2] === magic[2] && bytes[3] === magic[3]
}

export class BlossomClient {
  servers: string[]
  constructor(servers: string[] = []) {
    this.servers = Array.from(new Set(servers.map(normalizeBlossom).filter((x): x is string => !!x)))
  }
  setServers(servers: string[]): void {
    this.servers = Array.from(new Set(servers.map(normalizeBlossom).filter((x): x is string => !!x)))
  }

  /**
   * One-shot reachability probe (network panel). HEAD a well-known path;
   * ANY HTTP response (even 404) proves the server answers — network-level
   * failure/timeout is the only "offline". no-cors keeps CORS-restricted
   * servers probeable (opaque responses still resolve).
   */
  static async probe(url: string, timeoutMs = 5000): Promise<boolean> {
    const normalized = normalizeBlossom(url)
    if (!normalized) return false
    try {
      await fetch(normalized + '/', { method: 'HEAD', mode: 'no-cors', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) })
      return true
    } catch { return false }
  }

  /**
   * Download + verify: replicas in order, stream cap, SHA-256, magic bytes
   * (06 §3.2). `kind` selects WHICH magic: this used to hardcode GLB, which
   * silently rejected every poster PNG after a successful download — thumbs
   * for published posts never rendered.
   */
  async download(urls: string[], hash: string, expectedSize: number, maxBytes = LIMITS.modelBytesHard, kind: BlobKind = 'glb'): Promise<Blob> {
    for (const url of urls) {
      try {
        const res = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(30000) })
        if (!res.ok || !res.body) continue
        const reader = res.body.getReader()
        const chunks: Uint8Array[] = []
        let total = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.length
          if (total > maxBytes) throw new Error('stream exceeded size cap')
          chunks.push(value)
        }
        if (expectedSize > 0 && total !== expectedSize) continue
        const bytes = new Uint8Array(total)
        let off = 0
        for (const c of chunks) { bytes.set(c, off); off += c.length }
        if (hash && (await sha256Hex(bytes)) !== hash) continue
        if (!magicOk(bytes, kind)) continue
        return new Blob([bytes.buffer as ArrayBuffer], { type: kind === 'png' ? 'image/png' : 'model/gltf-binary' })
      } catch { /* next replica */ }
    }
    throw new Error('No verified replica available.')
  }

  private auth(method: string, hash: string, secret: Uint8Array): string {
    const t: EventTemplate = {
      kind: BLOSSOM_AUTH_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['t', method], ['x', hash], ['expiration', String(Math.floor(Date.now() / 1000) + 600)]],
      content: '',
    }
    return btoa(JSON.stringify(finalizeEvent(t, secret)))
  }

  /** BUD-01 upload. Returns replica URLs. */
  async upload(blob: Blob, secret: Uint8Array): Promise<{ url: string; sha256: string }[]> {
    if (blob.size > LIMITS.modelBytesHard) throw new Error(`Final GLB exceeds ${LIMITS.modelBytesHard / 1048576} MiB.`)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const hash = await sha256Hex(bytes)
    const results = await Promise.allSettled(
      this.servers.map(async (server) => {
        const res = await fetch(`${server}/upload`, {
          method: 'PUT',
          headers: { Authorization: `Nostr ${this.auth('upload', hash, secret)}` },
          body: blob,
          credentials: 'omit',
          signal: AbortSignal.timeout(60000),
        })
        if (!res.ok) throw new Error(`${server} upload failed (${res.status})`)
        const json = (await res.json()) as { url?: string }
        if (!json.url || !/^https:\/\//i.test(json.url)) throw new Error(`${server} returned invalid URL`)
        return { url: json.url, sha256: hash }
      }),
    )
    const out = results.filter((r): r is PromiseFulfilledResult<{ url: string; sha256: string }> => r.status === 'fulfilled').map((r) => r.value)
    if (!out.length) throw new Error('No Blossom replica completed.')
    return out
  }
}

export { generateSecretKey }
