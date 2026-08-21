import { formatSize } from './modelInfo'
import { LIMITS } from '../theme'
import type { DracoAttributeName } from '../model/compressGlb'

/**
 * Export-review settings (SPEC AMENDMENT 86). Pure helpers — no Babylon, no
 * DOM — so scripts/export-card-unit.mjs can drive them directly.
 *
 * The review owns the things the author actually cares about at publish time:
 * the poster card size (aspect + resolution → the `dim` tag every client
 * renders at) and the model name (the nostr event `content`, NIP-50
 * searchable). Numeric dials follow one rule: a domain with MORE than four
 * possible values is a slider / number input, never a button row.
 */

/** Card aspect bounds = the `dim` format bounds (posterAspectMin/Max). */
export const CARD_ASPECT_MIN = LIMITS.posterAspectMin
export const CARD_ASPECT_MAX = LIMITS.posterAspectMax
/** Card resolution bounds = the `dim` format pixel bounds (posterDimMin/Max). */
export const CARD_RES_MIN = LIMITS.posterDimMin
export const CARD_RES_MAX = LIMITS.posterDimMax

/** Draco quantization-bits dial bounds (SPEC AMENDMENT 86/87). The encoder
 * (draco_encoder wasm via Babylon) accepts 1–30 bits per attribute kind;
 * 0 would disable quantization for that attribute (floats kept), which the
 * "raw" codec choice already covers, so the dials start at 1. */
export const DRACO_BITS_MIN = 1
export const DRACO_BITS_MAX = 30
/** Attribute kinds the draco path actually quantizes. TANGENT is NOT one of
 * them — Babylon maps it to GENERIC (GetDracoAttributeName), so a TANGENT
 * key in quantizationBits is dead; the GENERIC dial controls it. */
export const DRACO_ATTRIBS: readonly DracoAttributeName[] = ['POSITION', 'NORMAL', 'TEX_COORD', 'COLOR', 'GENERIC']
/** Defaults reproduce the old `balanced` preset (AMENDMENT 85) exactly, so an
 * untouched review encodes identical bytes to before. */
export const DRACO_BITS_DEFAULT: Record<DracoAttributeName, number> = { POSITION: 12, NORMAL: 9, TEX_COORD: 11, COLOR: 8, GENERIC: 11 }
/** Draco speed options (encode/decode): 0 = slowest, best compression;
 * 10 = fastest, worst. The encoder's own default is 5. */
export const DRACO_SPEED_MIN = 0
export const DRACO_SPEED_MAX = 10
export const DRACO_SPEED_DEFAULT = 5

/** Clamp + round a (possibly partial) bits record into the full per-attribute
 * record the encoder consumes; missing kinds take the balanced defaults. */
export function sanitizeDracoBits(bits: Partial<Record<DracoAttributeName, number>>): Record<DracoAttributeName, number> {
  const out = {} as Record<DracoAttributeName, number>
  for (const a of DRACO_ATTRIBS) out[a] = clamp(Math.round(bits[a] ?? DRACO_BITS_DEFAULT[a]), DRACO_BITS_MIN, DRACO_BITS_MAX)
  return out
}

/** Compact label for the codec note: `pos 12/nrm 9/uv 11/col 8/gen 11`. */
export function dracoBitsNote(bits: Record<DracoAttributeName, number>): string {
  return `pos ${bits.POSITION}/nrm ${bits.NORMAL}/uv ${bits.TEX_COORD}/col ${bits.COLOR}/gen ${bits.GENERIC} bits`
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

export interface CardDim { width: number; height: number }

/**
 * A card size from the review's two dials. `longEdge` is the pixel count of
 * the LONG side (the number people think of as "resolution"); the short side
 * follows the aspect. The long edge is floored so the short edge never drops
 * under the format's minimum (a 2:1 card needs 128px of long edge to have a
 * 64px short side).
 */
export function cardDimFromSettings(aspect: number, longEdge: number): CardDim {
  const a = clamp(aspect, CARD_ASPECT_MIN, CARD_ASPECT_MAX)
  const minLong = Math.max(CARD_RES_MIN, Math.ceil(a >= 1 ? CARD_RES_MIN * a : CARD_RES_MIN / a))
  const l = clamp(Math.round(longEdge), minLong, CARD_RES_MAX)
  const width = a >= 1 ? l : Math.round(l * a)
  const height = a >= 1 ? Math.round(l / a) : l
  return { width, height }
}

/** Inverse of cardDimFromSettings — used to seed the dials from previewDim. */
export function cardSettingsFromDim(width: number, height: number): { aspect: number; longEdge: number } {
  const aspect = width / Math.max(1, height)
  return {
    aspect: clamp(aspect, CARD_ASPECT_MIN, CARD_ASPECT_MAX),
    longEdge: clamp(Math.max(width, height), CARD_RES_MIN, CARD_RES_MAX),
  }
}

/** Named aspect presets shown on the aspect dial. */
export const ASPECT_PRESETS: ReadonlyArray<readonly [string, number]> = [
  ['1:2', 0.5],
  ['3:4', 0.75],
  ['4:5', 0.8],
  ['1:1', 1],
  ['5:4', 1.25],
  ['4:3', 4 / 3],
  ['3:2', 1.5],
  ['16:10', 1.6],
  ['16:9', 16 / 9],
  ['2:1', 2],
]

/** Label for the aspect dial: the named preset when near one, else the ratio. */
export function aspectLabel(aspect: number): string {
  const a = clamp(aspect, CARD_ASPECT_MIN, CARD_ASPECT_MAX)
  let best: string | null = null
  let bestDiff = Infinity
  for (const [name, value] of ASPECT_PRESETS) {
    const d = Math.abs(a - value)
    if (d < bestDiff) { bestDiff = d; best = name }
  }
  if (best && bestDiff <= 0.025) return best
  return a.toFixed(2)
}

export interface GLBExportInfo {
  bytes: number
  jsonBytes: number
  binBytes: number
  geometryBytes: number
  imageBytes: number
  animationBytes: number
  otherBytes: number
  extensions: string[]
  meshes: number
  triangles: number
  textures: number
  animations: number
}

/** Lightweight, no-loader inspection of the exact GLB blob to be published.
 * It deliberately reads only the GLB JSON chunk: previewing/export review must
 * not parse the model into a second Babylon scene. */
export function inspectGLB(bytes: Uint8Array): GLBExportInfo {
  const empty: GLBExportInfo = { bytes: bytes.length, jsonBytes: 0, binBytes: 0, geometryBytes: 0, imageBytes: 0, animationBytes: 0, otherBytes: bytes.length, extensions: [], meshes: 0, triangles: 0, textures: 0, animations: 0 }
  if (bytes.length < 20) return empty
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== 0x46546c67) return empty
  let offset = 12
  let json: any = null
  let binBytes = 0
  let jsonBytes = 0
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset, true)
    const type = view.getUint32(offset + 4, true)
    offset += 8
    if (offset + size > bytes.length) return empty
    if (type === 0x4e4f534a) {
      jsonBytes = size
      try { json = JSON.parse(new TextDecoder().decode(bytes.subarray(offset, offset + size))) } catch { return empty }
    } else if (type === 0x004e4942) binBytes += size
    offset += size
  }
  if (!json) return empty
  const views: any[] = Array.isArray(json.bufferViews) ? json.bufferViews : []
  const viewSize = (i: unknown): number => typeof i === 'number' && views[i] ? Number(views[i].byteLength) || 0 : 0
  const imageViews = new Set<number>((json.images ?? []).map((image: any) => image.bufferView).filter((n: unknown) => typeof n === 'number'))
  const animationViews = new Set<number>()
  for (const animation of json.animations ?? []) for (const sampler of animation.samplers ?? []) {
    for (const accessorIndex of [sampler.input, sampler.output]) {
      const accessor = json.accessors?.[accessorIndex]
      if (typeof accessor?.bufferView === 'number') animationViews.add(accessor.bufferView)
    }
  }
  let imageBytes = 0
  let animationBytes = 0
  for (const n of imageViews) imageBytes += viewSize(n)
  for (const n of animationViews) if (!imageViews.has(n)) animationBytes += viewSize(n)
  const geometryBytes = Math.max(0, binBytes - imageBytes - animationBytes)
  let triangles = 0
  for (const mesh of json.meshes ?? []) for (const primitive of mesh.primitives ?? []) {
    const accessor = json.accessors?.[primitive.indices ?? primitive.attributes?.POSITION]
    const count = Number(accessor?.count) || 0
    triangles += Math.floor(count / 3)
  }
  const accounted = 12 + jsonBytes + binBytes
  return {
    bytes: bytes.length, jsonBytes, binBytes, imageBytes, animationBytes, geometryBytes,
    otherBytes: Math.max(0, bytes.length - accounted),
    extensions: [...(json.extensionsUsed ?? [])].map(String),
    meshes: (json.meshes ?? []).length, triangles, textures: (json.textures ?? []).length,
    animations: (json.animations ?? []).length,
  }
}

export function exportBreakdown(info: GLBExportInfo): string {
  return `textures ${formatSize(info.imageBytes)} · geometry ${formatSize(info.geometryBytes)} · animation ${formatSize(info.animationBytes)}`
}
