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
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = copyBytes(bytes)
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer as ArrayBuffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function isSha256Hex(value: string): boolean {
  return HEX64.test(value)
}

/** True when `blob` hashes to `expected` (lowercase hex64). */
export async function blobMatchesHash(blob: Blob, expected: string): Promise<boolean> {
  if (!expected || !HEX64.test(expected)) return false
  const bytes = copyBytes(new Uint8Array(await blob.arrayBuffer()))
  return (await sha256Hex(bytes)) === expected.toLowerCase()
}

/**
 * Detach a blob from any live scene / File backing store. The returned
 * `{ bytes, blob }` share one private buffer; later edits of the studio
 * cannot change them. Hash is of that snapshot.
 */
export async function freezeBlob(blob: Blob): Promise<{ bytes: Uint8Array; sha256: string; blob: Blob }> {
  const bytes = copyBytes(new Uint8Array(await blob.arrayBuffer()))
  const sha256 = await sha256Hex(bytes)
  return { bytes, sha256, blob: new Blob([bytes.buffer as ArrayBuffer], { type: blob.type || 'application/octet-stream' }) }
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

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('upload aborted')
    err.name = 'AbortError'
    throw err
  }
}
