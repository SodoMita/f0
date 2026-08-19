const HEX64 = /^[0-9a-f]{64}$/i

/** Independent copy — never alias the caller's ArrayBuffer. */
export function copyBytes(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.byteLength)
  out.set(src)
  return out
}

/**
 * SHA-256 of `bytes` as lowercase hex. WebCrypto may detach the ArrayBuffer
 * it is given, so we always hash a private copy and leave the caller's
 * snapshot intact (editing / a second digest must not see zeros).
 *
 * NEVER pass `bytes.buffer` to digest when `byteOffset !== 0` — that hashes
 * the whole backing store, including bytes outside the view.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = copyBytes(bytes)
  // `copy` is a fresh allocation, so copy.buffer is exact-length (offset 0).
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer as ArrayBuffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function isSha256Hex(value: string): boolean {
  return HEX64.test(value)
}

/**
 * Blob from an exact copy of `bytes`. `new Blob([view])` of a slice can
 * include bytes outside the view (the whole ArrayBuffer) on some backends.
 */
export function bytesToBlob(bytes: Uint8Array, type = 'application/octet-stream'): Blob {
  const exact = copyBytes(bytes)
  return new Blob([exact.buffer as ArrayBuffer], { type })
}

/** Exact-length copy of a blob's bytes (never a view into a larger buffer). */
export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return copyBytes(new Uint8Array(await blob.arrayBuffer()))
}

/** True when `blob` hashes to `expected` (lowercase hex64). */
export async function blobMatchesHash(blob: Blob, expected: string): Promise<boolean> {
  if (!expected || !HEX64.test(expected)) return false
  const bytes = await blobToBytes(blob)
  return (await sha256Hex(bytes)) === expected.toLowerCase()
}

/**
 * Detach a blob from any live scene / File backing store. The returned
 * `{ bytes, blob }` share one private buffer; later edits of the studio
 * cannot change them. Hash is of that snapshot.
 */
export async function freezeBlob(blob: Blob): Promise<{ bytes: Uint8Array; sha256: string; blob: Blob }> {
  const bytes = await blobToBytes(blob)
  const sha256 = await sha256Hex(bytes)
  return { bytes, sha256, blob: bytesToBlob(bytes, blob.type || 'application/octet-stream') }
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = (err as { name?: string }).name
  const msg = (err as { message?: string }).message ?? ''
  return name === 'AbortError' || /abort/i.test(msg)
}

export class HashMismatchError extends Error {
  name = 'HashMismatchError'
  constructor(message = 'blob hash mismatch') {
    super(message)
    this.name = 'HashMismatchError'
  }
}

export function isHashMismatch(err: unknown): boolean {
  return err instanceof HashMismatchError || (!!err && typeof err === 'object' && (err as Error).name === 'HashMismatchError')
}

/** Body exceeded the stream cap. Not corruption — do not hide the post. */
export class OversizeError extends Error {
  name = 'OversizeError'
  constructor(message = 'stream exceeded size cap') {
    super(message)
    this.name = 'OversizeError'
  }
}

export function isOversize(err: unknown): boolean {
  return err instanceof OversizeError || (!!err && typeof err === 'object' && (err as Error).name === 'OversizeError')
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('upload aborted')
    err.name = 'AbortError'
    throw err
  }
}
