import { finalizeEvent, generateSecretKey, type EventTemplate } from 'nostr-tools'
import { BLOSSOM_AUTH_KIND, LIMITS } from '../theme'
import { transfers } from '../core/transfer'

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
   *
   * redirect: 'error' enforces the spec's "no cross-origin redirects" (06
   * §3.2): a replica URL that redirects (e.g. to a tracking endpoint) is
   * skipped and the next replica is tried. Content is SHA-256-verified
   * either way, but a redirect would still hand the viewer's IP to the
   * redirect target, and the event author controls the URL already.
   */
  async download(urls: string[], hash: string, expectedSize: number, maxBytes = LIMITS.modelBytesHard, kind: BlobKind = 'glb'): Promise<Blob> {
    for (const url of urls) {
      // One meter entry per replica attempt: a replica that stalls stops
      // contributing bytes and the reported speed drops, which is exactly
      // what the HUD should show.
      const xfer = transfers.track('down', expectedSize)
      try {
        const res = await fetch(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000) })
        if (!res.ok || !res.body) continue
        // Prefer the server's own size when the event did not carry one.
        const declared = Number(res.headers.get('content-length') ?? '')
        if (!expectedSize && Number.isFinite(declared)) xfer.setTotal(declared)
        const reader = res.body.getReader()
        const chunks: Uint8Array[] = []
        let total = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.length
          xfer.advance(value.length)
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
      } catch { /* next replica */ } finally {
        xfer.end()
      }
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
        // XHR, not fetch: `fetch` reports nothing about request-body
        // progress, so an upload would sit at "0 bytes sent" until it
        // completed. XHR's upload.onprogress is the only portable way to
        // show a real upload speed. Semantics kept identical to the old
        // fetch call (no credentials, 60 s cap, JSON body).
        const res = await putWithProgress(`${server}/upload`, blob, {
          Authorization: `Nostr ${this.auth('upload', hash, secret)}`,
        }, 60000)
        if (!res.ok) throw new Error(`${server} upload failed (${res.status})`)
        let json: { url?: string }
        try { json = JSON.parse(res.body) as { url?: string } } catch { throw new Error(`${server} returned invalid JSON`) }
        // A regex check alone lets through parseable-garbage like "https://"
        // (no host), which would later crash publish.ts's `new URL(u.url)`
        // while building the server tags. Parse and require a real host.
        if (!json.url) throw new Error(`${server} returned invalid URL`)
        let parsedUrl: URL
        try { parsedUrl = new URL(json.url) } catch { throw new Error(`${server} returned invalid URL`) }
        if (parsedUrl.protocol !== 'https:' || !parsedUrl.hostname) throw new Error(`${server} returned invalid URL`)
        return { url: json.url, sha256: hash }
      }),
    )
    const out = results.filter((r): r is PromiseFulfilledResult<{ url: string; sha256: string }> => r.status === 'fulfilled').map((r) => r.value)
    if (!out.length) throw new Error('No Blossom replica completed.')
    return out
  }
}

/**
 * PUT a blob with upload-progress reporting into the transfer meter.
 * Falls back to `fetch` (no per-byte progress, one lump at the end) where
 * XMLHttpRequest is unavailable, e.g. inside a worker-only environment.
 */
async function putWithProgress(
  url: string,
  blob: Blob,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; body: string }> {
  const xfer = transfers.track('up', blob.size)
  if (typeof XMLHttpRequest === 'undefined') {
    try {
      const res = await fetch(url, {
        method: 'PUT', headers, body: blob, credentials: 'omit',
        signal: AbortSignal.timeout(timeoutMs),
      })
      xfer.advance(blob.size)
      return { ok: res.ok, status: res.status, body: await res.text() }
    } finally { xfer.end() }
  }
  try {
    return await new Promise<{ ok: boolean; status: number; body: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('PUT', url, true)
      xhr.withCredentials = false
      xhr.timeout = timeoutMs
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)
      let sent = 0
      xhr.upload.onprogress = (e) => {
        // e.loaded is cumulative; the meter wants deltas
        xfer.advance(e.loaded - sent)
        sent = e.loaded
        if (e.lengthComputable && e.total > 0) xfer.setTotal(e.total)
      }
      xhr.onload = () => {
        xfer.advance(blob.size - sent) // some agents skip the final progress event
        resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, body: xhr.responseText })
      }
      xhr.onerror = () => reject(new Error('upload network error'))
      xhr.ontimeout = () => reject(new Error('upload timed out'))
      xhr.onabort = () => reject(new Error('upload aborted'))
      xhr.send(blob)
    })
  } finally {
    xfer.end()
  }
}

export { generateSecretKey }
