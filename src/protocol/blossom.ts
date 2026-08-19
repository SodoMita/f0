import { finalizeEvent, generateSecretKey, type EventTemplate } from 'nostr-tools'
import { BLOSSOM_AUTH_KIND, LIMITS } from '../theme'
import { transfers, originOf } from '../core/transfer'
import {
  bytesToBlob, freezeBlob, HashMismatchError, isAbortError, isOversize, isSha256Hex,
  OversizeError, sha256Hex, throwIfAborted,
} from './hash'

export { sha256Hex, freezeBlob, HashMismatchError, OversizeError } from './hash'

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

function magicOk(bytes: Uint8Array): boolean {
  return bytes[0] === GLB_MAGIC[0] && bytes[1] === GLB_MAGIC[1] && bytes[2] === GLB_MAGIC[2] && bytes[3] === GLB_MAGIC[3]
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
   *
   * Returns the round-trip time too: the panel shows it as the server's
   * ping. `cache: 'no-store'` matters — a cached response would report a
   * sub-millisecond "ping" that never touched the network.
   */
  static async probe(url: string, timeoutMs = 5000): Promise<{ ok: boolean; ms: number }> {
    const normalized = normalizeBlossom(url)
    if (!normalized) return { ok: false, ms: 0 }
    const t0 = performance.now()
    try {
      await fetch(normalized + '/', {
        method: 'HEAD', mode: 'no-cors', credentials: 'omit', cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      })
      return { ok: true, ms: Math.round(performance.now() - t0) }
    } catch { return { ok: false, ms: Math.round(performance.now() - t0) } }
  }

  /**
   * Download + verify: replicas in order, stream cap, SHA-256, GLB magic
   * bytes (06 §3.2). Models only — posters are rendered locally, never
   * fetched (format v4).
   *
   * redirect: 'error' enforces the spec's "no cross-origin redirects" (06
   * §3.2): a replica URL that redirects (e.g. to a tracking endpoint) is
   * skipped and the next replica is tried. Content is SHA-256-verified
   * either way, but a redirect would still hand the viewer's IP to the
   * redirect target, and the event author controls the URL already.
   */
  async download(urls: string[], hash: string, expectedSize: number, maxBytes = LIMITS.modelBytesHard): Promise<Blob> {
    let hashMismatch = false
    let oversize = false
    // Size is a meter + a cap, never a refuse. A stale `size` tag with a
    // hash-valid body used to skip every replica before SHA ran ("false
    // refuse"). Cap at max(claimed size, hard limit) so a too-small tag
    // cannot truncate a good body, and a missing tag cannot run unbounded.
    const cap = Math.max(expectedSize > 0 ? expectedSize : 0, maxBytes)
    for (const url of urls) {
      // One meter entry per replica attempt: a replica that stalls stops
      // contributing bytes and the reported speed drops, which is exactly
      // what the HUD should show.
      const xfer = transfers.track('down', expectedSize, originOf(url))
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
          if (total > cap) throw new OversizeError()
          chunks.push(value)
        }
        const bytes = new Uint8Array(total)
        let off = 0
        for (const c of chunks) { bytes.set(c, off); off += c.length }
        // ALWAYS hash. Hash matches `x` → accept even if the size tag is
        // wrong. Hash mismatch → this replica is garbage; try the next.
        // Models MUST match the event `x` tag. An empty hash used to skip
        // the check, which let a wrong-hash replica render on the board.
        const expect = hash.toLowerCase()
        if (!isSha256Hex(expect)) continue
        if (isSha256Hex(expect) && (await sha256Hex(bytes)) !== expect) {
          hashMismatch = true
          continue
        }
        if (!magicOk(bytes)) continue
        return bytesToBlob(bytes, 'model/gltf-binary')
      } catch (err) {
        if (isOversize(err)) oversize = true
        /* next replica */
      } finally {
        xfer.end()
      }
    }
    if (hashMismatch) throw new HashMismatchError()
    if (oversize) throw new OversizeError()
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

  /** BUD-01 upload. Returns replica URLs. `signal` aborts every in-flight PUT. */
  async upload(blob: Blob, secret: Uint8Array, signal?: AbortSignal): Promise<{ url: string; sha256: string }[]> {
    throwIfAborted(signal)
    if (blob.size > LIMITS.modelBytesHard) throw new Error(`Final GLB exceeds ${LIMITS.modelBytesHard / 1048576} MiB.`)
    // Freeze first: the studio scene (and some File/Blob backends) can still
    // mutate the bytes we were handed. The event `x` tag and the PUT body
    // must be the same snapshot.
    const frozen = await freezeBlob(blob)
    throwIfAborted(signal)
    const hash = frozen.sha256
    const results = await Promise.allSettled(
      this.servers.map(async (server) => {
        // XHR, not fetch: `fetch` reports nothing about request-body
        // progress, so an upload would sit at "0 bytes sent" until it
        // completed. XHR's upload.onprogress is the only portable way to
        // show a real upload speed. Semantics kept identical to the old
        // fetch call (no credentials, 60 s cap, JSON body).
        const res = await putWithProgress(`${server}/upload`, frozen.blob, {
          Authorization: `Nostr ${this.auth('upload', hash, secret)}`,
        }, 60000, originOf(server), signal)
        if (!res.ok) throw new Error(`${server} upload failed (${res.status})`)
        let json: { url?: string; sha256?: string }
        try { json = JSON.parse(res.body) as { url?: string; sha256?: string } } catch { throw new Error(`${server} returned invalid JSON`) }
        // A regex check alone lets through parseable-garbage like "https://"
        // (no host), which would later crash publish.ts's `new URL(u.url)`
        // while building the server tags. Parse and require a real host.
        if (!json.url) throw new Error(`${server} returned invalid URL`)
        let parsedUrl: URL
        try { parsedUrl = new URL(json.url) } catch { throw new Error(`${server} returned invalid URL`) }
        if (parsedUrl.protocol !== 'https:' || !parsedUrl.hostname) throw new Error(`${server} returned invalid URL`)
        if (json.sha256 && json.sha256.toLowerCase() !== hash) throw new Error(`${server} hash mismatch`)
        return { url: json.url, sha256: hash }
      }),
    )
    const out = results.filter((r): r is PromiseFulfilledResult<{ url: string; sha256: string }> => r.status === 'fulfilled').map((r) => r.value)
    if (!out.length) {
      const aborted = signal?.aborted || results.some((r) => r.status === 'rejected' && isAbortError(r.reason))
      if (aborted) {
        const err = new Error('upload aborted')
        err.name = 'AbortError'
        throw err
      }
      throw new Error('No Blossom replica completed.')
    }
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
  host?: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; body: string }> {
  const xfer = transfers.track('up', blob.size, host)
  const abortErr = (): Error => {
    const err = new Error('upload aborted')
    err.name = 'AbortError'
    return err
  }
  if (signal?.aborted) { xfer.end(); throw abortErr() }
  if (typeof XMLHttpRequest === 'undefined') {
    try {
      const res = await fetch(url, {
        method: 'PUT', headers, body: blob, credentials: 'omit',
        signal: mergeSignals(signal, timeoutMs),
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
        xfer.advance(e.loaded - sent)
        sent = e.loaded
        if (e.lengthComputable && e.total > 0) xfer.setTotal(e.total)
      }
      xhr.onload = () => {
        xfer.advance(blob.size - sent)
        resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, body: xhr.responseText })
      }
      xhr.onerror = () => reject(new Error('upload network error'))
      xhr.ontimeout = () => reject(new Error('upload timed out'))
      xhr.onabort = () => reject(abortErr())
      const onAbort = () => xhr.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      xhr.addEventListener('loadend', () => signal?.removeEventListener('abort', onAbort))
      xhr.send(blob)
    })
  } finally {
    xfer.end()
  }
}

/** Combine a caller abort with a timeout. `AbortSignal.any` is still patchy. */
function mergeSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!signal) return timeout
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout])
  const ctrl = new AbortController()
  const abort = () => ctrl.abort()
  if (signal.aborted || timeout.aborted) { ctrl.abort(); return ctrl.signal }
  signal.addEventListener('abort', abort, { once: true })
  timeout.addEventListener('abort', abort, { once: true })
  return ctrl.signal
}

export { generateSecretKey }
