/** GLB container read/write (chunk framing only — never loads a model). */
export interface GlbDoc {
  json: any
  /** BIN chunk payload (empty when the GLB has no BIN chunk). */
  bin: Uint8Array
}

const MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

/** Parse a GLB into its JSON chunk (object) and BIN chunk; null if invalid. */
export function parseGLB(bytes: Uint8Array): GlbDoc | null {
  if (bytes.length < 20) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== 2) return null
  let off = 12
  let json: any = null
  let bin: Uint8Array = new Uint8Array(0)
  while (off + 8 <= bytes.length) {
    const size = dv.getUint32(off, true)
    const type = dv.getUint32(off + 4, true)
    off += 8
    if (off + size > bytes.length) return null
    if (type === CHUNK_JSON) {
      try { json = JSON.parse(new TextDecoder().decode(bytes.subarray(off, off + size))) } catch { return null }
    } else if (type === CHUNK_BIN) bin = bytes.slice(off, off + size)
    off += size
  }
  return json ? { json, bin } : null
}

/** Serialize a GLB: header, JSON chunk (space-padded), BIN (zero-padded);
 * both chunks 4-byte aligned per the spec. */
export function buildGLB(json: any, bin: Uint8Array): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4
  const binPad = (4 - (bin.length % 4)) % 4
  const binLen = bin.length + binPad
  const total = 12 + 8 + jsonBytes.length + jsonPad + (binLen > 0 ? 8 + binLen : 0)
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, MAGIC, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  dv.setUint32(12, jsonBytes.length + jsonPad, true)
  dv.setUint32(16, CHUNK_JSON, true)
  out.set(jsonBytes, 20)
  for (let i = 0; i < jsonPad; i++) out[20 + jsonBytes.length + i] = 0x20
  if (binLen > 0) {
    const binStart = 20 + jsonBytes.length + jsonPad
    dv.setUint32(binStart, binLen, true)
    dv.setUint32(binStart + 4, CHUNK_BIN, true)
    out.set(bin, binStart + 8)
  }
  return out
}

export const align4 = (n: number): number => n + ((4 - (n % 4)) % 4)
