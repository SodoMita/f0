/**
 * Browser texture codec: re-encode embedded png/jpeg textures as WebP
 * (EXT_texture_webp) through canvas — no wasm, no network. Offered only
 * where the browser can really produce webp bytes (Safari's canvas encoder
 * came late), so the control never advertises a dead option.
 */
import type { TextureCodec } from './compressGlb'

// 1×1 transparent PNG used only to probe encoder availability.
const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function tinyPng(): Uint8Array {
  const raw = atob(TINY_PNG_B64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function encodeWebp(bytes: Uint8Array, mimeType: string, quality: number): Promise<Uint8Array | null> {
  try {
    if (typeof createImageBitmap !== 'function') return null
    const bitmap = await createImageBitmap(new Blob([bytes as unknown as BlobPart], { type: mimeType }))
    const convert = async (): Promise<Blob> => {
      if (typeof OffscreenCanvas === 'function') {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('no 2d')
        ctx.drawImage(bitmap, 0, 0)
        const blob = await canvas.convertToBlob({ type: 'image/webp', quality })
        if (!blob || blob.type !== 'image/webp') throw new Error('no webp encode')
        return blob
      }
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no 2d')
      ctx.drawImage(bitmap, 0, 0)
      return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => (blob && blob.type === 'image/webp' ? resolve(blob) : reject(new Error('no webp encode'))), 'image/webp', quality)
      })
    }
    const blob = await convert()
    bitmap.close()
    const out = new Uint8Array(await blob.arrayBuffer())
    // Trust bytes, not the blob type: verify the RIFF….WEBP magic.
    if (out.length < 12 || out[0] !== 0x52 || out[1] !== 0x49 || out[2] !== 0x46 || out[3] !== 0x46 || out[8] !== 0x57 || out[9] !== 0x45 || out[10] !== 0x42 || out[11] !== 0x50) return null
    return out
  } catch {
    return null
  }
}

export const webpCodec: TextureCodec = { encode: encodeWebp }

let supported: Promise<boolean> | null = null
/** Resolves true when this browser's canvas can encode webp. */
export function webpEncoderSupported(): Promise<boolean> {
  supported ??= (async () => {
    try {
      const out = await encodeWebp(tinyPng(), 'image/png', 0.8)
      return !!out && out.length > 0
    } catch {
      return false
    }
  })()
  return supported
}
