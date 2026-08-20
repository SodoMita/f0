import { LIMITS } from '../theme'

export const AUDIO_MIMES = ['audio/wav', 'audio/mpeg'] as const
export type EmbeddedAudioMime = typeof AUDIO_MIMES[number]
export type EmbeddedAudioExtension = 'KHR_audio' | 'MSFT_audio_emitter'

export interface EmbeddedAudioInspection {
  /** The GLB advertises one of the supported optional audio extensions. */
  present: boolean
  /** Set only after the bufferView, size, MIME and file signature pass. */
  audio?: Blob
  extension?: EmbeddedAudioExtension
  reason?: string
}

const JSON_CHUNK = 0x4e4f534a
const BIN_CHUNK = 0x004e4942

// A model's shared Uint8Array is inspected by poster, preview and viewer.
// Keying by object identity makes all three paths reuse the same tiny Blob.
const bytesCache = new WeakMap<Uint8Array, EmbeddedAudioInspection>()
// Public Blob API kept for callers that do not already hold decoded bytes.
// Cache the Promise itself so concurrent extraction also parses only once.
const blobCache = new WeakMap<Blob, Promise<Blob | undefined>>()

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function audioSignature(bytes: Uint8Array, mime: EmbeddedAudioMime): boolean {
  if (mime === 'audio/wav') {
    return bytes.length >= 12
      && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 // RIFF
      && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45 // WAVE
  }
  // MP3 starts either with an ID3v2 tag or directly with an MPEG frame sync.
  return bytes.length >= 3 && (
    (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)
    || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  )
}

function fail(present: boolean, reason: string, extension?: EmbeddedAudioExtension): EmbeddedAudioInspection {
  return { present, reason, extension }
}

/**
 * Inspect a binary GLB for its first embedded WAV/MP3 clip.
 *
 * Audio metadata is optional: malformed/unsupported/oversized audio is
 * ignored while the model remains renderable. No decoder is invoked here;
 * successful bytes become a Blob for HTMLAudioElement playback.
 */
export function inspectEmbeddedAudio(bytes: Uint8Array): EmbeddedAudioInspection {
  const cached = bytesCache.get(bytes)
  if (cached) return cached

  let result: EmbeddedAudioInspection = { present: false }
  try {
    if (bytes.byteLength < 20) return result
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) return result

    let offset = 12
    let jsonBytes: Uint8Array | null = null
    let binBytes: Uint8Array | null = null
    while (offset + 8 <= bytes.byteLength) {
      const length = view.getUint32(offset, true)
      const type = view.getUint32(offset + 4, true)
      offset += 8
      if (length > bytes.byteLength - offset) {
        result = fail(false, 'truncated GLB chunk')
        return result
      }
      if (type === JSON_CHUNK && !jsonBytes) jsonBytes = bytes.subarray(offset, offset + length)
      else if (type === BIN_CHUNK && !binBytes) binBytes = bytes.subarray(offset, offset + length)
      offset += length
    }
    if (!jsonBytes || !binBytes) return result

    const jsonText = new TextDecoder().decode(jsonBytes).replace(/[\u0000\x20\t\r\n]+$/g, '')
    const gltf = object(JSON.parse(jsonText))
    const extensions = object(gltf?.extensions)
    if (!extensions) return result

    const khr = object(extensions.KHR_audio)
    const msft = object(extensions.MSFT_audio_emitter)
    let extension: EmbeddedAudioExtension | undefined
    let clip: JsonObject | null = null
    if (khr) {
      extension = 'KHR_audio'
      clip = object(array(khr.audio)[0])
    } else if (msft) {
      extension = 'MSFT_audio_emitter'
      clip = object(array(msft.clips)[0])
    }
    if (!extension) return result
    if (!clip) {
      result = fail(true, 'audio extension has no clip', extension)
      return result
    }

    const mimeValue = clip.mimeType
    if (mimeValue !== 'audio/wav' && mimeValue !== 'audio/mpeg') {
      result = fail(true, 'unsupported embedded audio MIME type', extension)
      return result
    }
    const mime: EmbeddedAudioMime = mimeValue
    const bufferViewIndex = integer(clip.bufferView)
    const bufferViews = array(gltf?.bufferViews)
    const bufferView = bufferViewIndex === null ? null : object(bufferViews[bufferViewIndex])
    if (!bufferView) {
      result = fail(true, 'audio bufferView is missing', extension)
      return result
    }
    const bufferIndex = bufferView.buffer === undefined ? 0 : integer(bufferView.buffer)
    const byteOffset = bufferView.byteOffset === undefined ? 0 : integer(bufferView.byteOffset)
    const byteLength = integer(bufferView.byteLength)
    if (bufferIndex !== 0 || byteOffset === null || byteLength === null || byteLength === 0) {
      result = fail(true, 'audio bufferView is invalid', extension)
      return result
    }
    if (byteLength > LIMITS.audioBytes) {
      result = fail(true, `embedded audio exceeds ${LIMITS.audioBytes / 1024} KiB`, extension)
      return result
    }
    if (byteOffset > binBytes.byteLength || byteLength > binBytes.byteLength - byteOffset) {
      result = fail(true, 'audio bufferView is outside the GLB BIN chunk', extension)
      return result
    }

    const payload = binBytes.subarray(byteOffset, byteOffset + byteLength)
    if (!audioSignature(payload, mime)) {
      result = fail(true, 'embedded audio signature does not match its MIME type', extension)
      return result
    }
    // Copy into an owned ArrayBuffer: BlobPart deliberately excludes views
    // backed by SharedArrayBuffer in newer TypeScript DOM typings.
    const owned = new Uint8Array(payload.byteLength)
    owned.set(payload)
    result = { present: true, extension, audio: new Blob([owned.buffer], { type: mime }) }
    return result
  } catch {
    return result
  } finally {
    bytesCache.set(bytes, result)
  }
}

/** Synchronous extraction for the app's already-decoded model bytes. */
export function extractEmbeddedAudioBytes(bytes: Uint8Array): Blob | undefined {
  return inspectEmbeddedAudio(bytes).audio
}

/** Blob convenience API. A given Blob is converted and parsed at most once. */
export function extractEmbeddedAudio(blob: Blob): Promise<Blob | undefined> {
  const cached = blobCache.get(blob)
  if (cached) return cached
  const pending = blob.arrayBuffer()
    .then((buffer) => extractEmbeddedAudioBytes(new Uint8Array(buffer)))
    .catch(() => undefined)
  blobCache.set(blob, pending)
  return pending
}
