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

const GLB_MAGIC = [0x67, 0x6c, 0x54, 0x46]

export class BlossomClient {
  servers: string[]
  constructor(servers: string[] = []) {
    this.servers = Array.from(new Set(servers.map(normalizeBlossom).filter((x): x is string => !!x)))
  }
  setServers(servers: string[]): void {
    this.servers = Array.from(new Set(servers.map(normalizeBlossom).filter((x): x is string => !!x)))
  }

  /** Download + verify: replicas in order, stream cap, SHA-256, GLB magic (06 §3.2). */
  async download(urls: string[], hash: string, expectedSize: number, maxBytes = LIMITS.modelBytesHard): Promise<Blob> {
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
        if (!(bytes[0] === GLB_MAGIC[0] && bytes[1] === GLB_MAGIC[1] && bytes[2] === GLB_MAGIC[2] && bytes[3] === GLB_MAGIC[3])) continue
        return new Blob([bytes.buffer as ArrayBuffer], { type: 'model/gltf-binary' })
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
          headers: { Authorization: this.auth('upload', hash, secret) },
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
