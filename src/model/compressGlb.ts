/**
 * GLB codec pipeline for the export review: applies KHR_draco_mesh_compression
 * (geometry) and EXT_texture_webp (textures) to an ALREADY VALIDATED export,
 * producing a smaller self-contained GLB that never grew past the original.
 *
 * Design constraints (SPEC AMENDMENT 84):
 * - Encoders are INJECTED (`DracoCodec` / `TextureCodec`), so the rewrite is
 *   unit-testable under bun without browser codecs, and the app only offers a
 *   control when its encoder actually initialised ("never advertise a
 *   non-working codec control").
 * - The input bytes are immutable: a failed or gainless pass returns the
 *   original bytes untouched.
 * - Only mesh primitives are Draco-compressed — animations, skins, images and
 *   morph targets keep their exact original buffer views.
 * - Output is re-validated by the caller (`validateGLB`) before it can become
 *   the reviewed export; the published bytes stay exactly what was reviewed.
 */
import { align4, buildGLB, parseGLB } from './glbContainer'

export type DracoAttributeName = 'POSITION' | 'NORMAL' | 'COLOR' | 'TEX_COORD' | 'GENERIC'

export type DracoArray = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array

export interface DracoAttributeInput {
  semantic: string
  dracoName: DracoAttributeName
  size: number
  data: DracoArray
}

export interface DracoPrimitiveInput {
  attributes: DracoAttributeInput[]
  indices: Uint16Array | Uint32Array | null
}

/** Fine settings: quantization bits per Draco attribute kind (quality dial).
 * Unspecified entries fall back to the encoder's defaults. */
export interface DracoEncodeOptions {
  quantizationBits?: Partial<Record<DracoAttributeName, number>>
  encodeSpeed?: number
  decodeSpeed?: number
}

export interface DracoCodec {
  encodePrimitive(input: DracoPrimitiveInput, options?: DracoEncodeOptions): Promise<{ data: Uint8Array; attributeIds: Record<string, number> } | null>
}

export interface TextureCodec {
  /** Re-encode an embedded png/jpeg to webp; null = cannot (keep original). */
  encode(bytes: Uint8Array, mimeType: string, quality: number): Promise<Uint8Array | null>
}

export interface CompressOptions {
  draco?: DracoCodec
  dracoOptions?: DracoEncodeOptions
  webp?: TextureCodec
  /** 0..1 lossy quality for the texture codec (default 0.85). */
  webpQuality?: number
}

export interface CompressReport {
  keptOriginal: boolean
  draco: { prims: number; skipped: number; bytesBefore: number; bytesAfter: number; reasons: string[] }
  webp: { images: number; skipped: number; bytesBefore: number; bytesAfter: number; reasons: string[] }
}

interface DracoCtor {
  new (length: number): DracoArray
  BYTES_PER_ELEMENT: number
}
const COMPONENT_ARRAY: Record<number, DracoCtor> = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
}
const TYPE_SIZE: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }

/** Read an accessor into a fresh, packed (de-interleaved) typed array.
 * Returns null when the accessor is sparse, untyped or out of bounds —
 * callers treat that as "leave this primitive alone". */
export function readAccessor(bin: Uint8Array, bufferViews: any[], accessor: any): DracoArray | null {
  if (!accessor || accessor.sparse) return null
  const Ctor = COMPONENT_ARRAY[accessor.componentType]
  const size = TYPE_SIZE[accessor.type]
  if (!Ctor || !size) return null
  if (typeof accessor.bufferView !== 'number') return null
  const view = bufferViews[accessor.bufferView]
  if (!view || typeof view.byteLength !== 'number') return null
  const natural = Ctor.BYTES_PER_ELEMENT * size
  const stride = typeof view.byteStride === 'number' && view.byteStride > natural ? view.byteStride : natural
  const viewStart = view.byteOffset ?? 0
  const start = viewStart + (accessor.byteOffset ?? 0)
  const count = Number(accessor.count) || 0
  if (count < 0) return null
  const span = count > 0 ? (count - 1) * stride + natural : 0
  if (start + span > viewStart + view.byteLength) return null
  const out = new Ctor(count * size)
  const src = bin.subarray(start, start + span)
  if (stride === natural) {
    // `start` may be unaligned for a typed-array view; copy through bytes.
    new Uint8Array(out.buffer, out.byteOffset, out.byteLength).set(src)
  } else {
    for (let i = 0; i < count; i++) {
      new Uint8Array(out.buffer, out.byteOffset + i * natural, natural).set(src.subarray(i * stride, i * stride + natural))
    }
  }
  return out
}

/** glTF attribute semantic → Draco attribute kind. null = unsupported here. */
export function dracoNameFor(semantic: string): DracoAttributeName | null {
  if (semantic === 'POSITION' || semantic === 'NORMAL') return semantic
  if (semantic === 'TANGENT') return 'GENERIC'
  if (/^COLOR_\d+$/.test(semantic)) return 'COLOR'
  if (/^TEXCOORD_\d+$/.test(semantic)) return 'TEX_COORD'
  return null
}

function usedList(json: any, key: 'extensionsUsed' | 'extensionsRequired', name: string): void {
  const list: string[] = json[key] ?? (json[key] = [])
  if (!list.includes(name)) list.push(name)
}

/** Rewrite the GLB with the requested codecs applied. Never throws for
 * codec-level failures — those degrade to "primitive/image skipped". */
export async function compressGLB(bytes: Uint8Array, opts: CompressOptions): Promise<{ bytes: Uint8Array; report: CompressReport }> {
  const report: CompressReport = {
    keptOriginal: true,
    draco: { prims: 0, skipped: 0, bytesBefore: 0, bytesAfter: 0, reasons: [] },
    webp: { images: 0, skipped: 0, bytesBefore: 0, bytesAfter: 0, reasons: [] },
  }
  const doc = parseGLB(bytes)
  if (!doc) return { bytes, report }
  const json = structuredClone(doc.json)
  const bin = doc.bin
  const bufferViews: any[] = json.bufferViews ?? []
  const accessors: any[] = json.accessors ?? []
  const meshes: any[] = json.meshes ?? []
  const images: any[] = json.images ?? []
  const textures: any[] = json.textures ?? []

  // ---- Draco pass ---------------------------------------------------------
  type DracoEdit = { mesh: number; prim: number; payload: Uint8Array; ids: Record<string, number> }
  const dracoEdits: DracoEdit[] = []
  const dracoReason = (why: string) => { if (!report.draco.reasons.includes(why)) report.draco.reasons.push(why) }

  if (opts.draco && meshes.length) {
    if ((json.skins ?? []).length) {
      report.draco.skipped = meshes.reduce((n, m) => n + (m?.primitives?.length ?? 0), 0)
      dracoReason('skinned models keep raw buffers')
    } else {
      for (let mi = 0; mi < meshes.length; mi++) {
        const prims = meshes[mi]?.primitives
        if (!Array.isArray(prims)) continue
        for (let pi = 0; pi < prims.length; pi++) {
          const prim = prims[pi]
          if (!prim || typeof prim !== 'object') continue
          const skipPrim = (why: string) => { report.draco.skipped++; dracoReason(why) }
          if (prim.extensions?.KHR_draco_mesh_compression || prim.extensions?.EXT_meshopt_compression) { skipPrim('already compressed'); continue }
          if (prim.mode !== undefined && prim.mode !== 4) { skipPrim('non-triangle primitive'); continue }
          if (prim.targets) { skipPrim('morph targets stay raw'); continue }
          const attrsIn = prim.attributes ?? {}
          const semanticNames = Object.keys(attrsIn)
          if (!('POSITION' in attrsIn)) { skipPrim('no POSITION'); continue }
          const attributes: DracoAttributeInput[] = []
          let readable = true
          for (const semantic of semanticNames) {
            const accessor = accessors[attrsIn[semantic]]
            const data = readAccessor(bin, bufferViews, accessor)
            const dracoName = dracoNameFor(semantic)
            if (!data || !dracoName || !accessor) { readable = false; break }
            attributes.push({ semantic, dracoName, size: TYPE_SIZE[accessor.type] ?? 0, data })
          }
          if (!readable) { skipPrim('unsupported attribute layout'); continue }
          const pos = attributes.find((a) => a.semantic === 'POSITION')
          if (!pos || !(pos.data instanceof Float32Array) || pos.data.length < 9) { skipPrim('POSITION must be float32 with real vertices'); continue }
          let badVertex = false
          for (let i = 0; i < pos.data.length; i++) { if (!Number.isFinite(pos.data[i])) { badVertex = true; break } }
          if (badVertex) { skipPrim('non-finite positions'); continue }
          let indices: Uint16Array | Uint32Array | null = null
          if (prim.indices !== undefined) {
            const idxData = readAccessor(bin, bufferViews, accessors[prim.indices])
            if (!(idxData instanceof Uint16Array) && !(idxData instanceof Uint32Array)) { skipPrim('unsupported index layout'); continue }
            indices = idxData
          }
          // Only compress when the payload beats the raw bytes it replaces.
          let rawSize = 0
          const seenViews = new Set<number>()
          const primAccessors = [...Object.values(attrsIn), ...(prim.indices !== undefined ? [prim.indices] : [])]
          for (const accessorIndex of primAccessors) {
            const viewIndex = accessors[accessorIndex as number]?.bufferView
            if (typeof viewIndex === 'number' && !seenViews.has(viewIndex)) {
              seenViews.add(viewIndex)
              rawSize += Number(bufferViews[viewIndex]?.byteLength) || 0
            }
          }
          try {
            const result = await opts.draco.encodePrimitive({ attributes, indices }, opts.dracoOptions)
            if (result && result.data.length > 0 && result.data.length < rawSize) {
              dracoEdits.push({ mesh: mi, prim: pi, payload: result.data, ids: result.attributeIds })
            } else if (result) { report.draco.skipped++; dracoReason('a primitive did not shrink') }
            else { report.draco.skipped++; dracoReason('encoder refused a primitive') }
          } catch {
            report.draco.skipped++
            dracoReason('encoder failed on a primitive')
          }
        }
      }
    }
  }

  // ---- WebP pass ----------------------------------------------------------
  const webpEdits = new Map<number, Uint8Array>()
  if (opts.webp && images.length && textures.length) {
    const referenced = new Set<number>()
    for (const tex of textures) if (typeof tex?.source === 'number') referenced.add(tex.source)
    for (let ii = 0; ii < images.length; ii++) {
      const image = images[ii]
      const mime = String(image?.mimeType ?? '')
      if (typeof image?.bufferView !== 'number' || !referenced.has(ii)) continue
      if (!/^image\/(png|jpeg)$/.test(mime)) { report.webp.skipped++; report.webp.reasons.push('not a png/jpeg image'); continue }
      const view = bufferViews[image.bufferView]
      if (!view || typeof view.byteLength !== 'number' || view.byteLength < 64) { report.webp.skipped++; report.webp.reasons.push('image too small to bother'); continue }
      const start = view.byteOffset ?? 0
      const raw = bin.subarray(start, start + view.byteLength)
      try {
        const out = await opts.webp.encode(raw, mime, opts.webpQuality ?? 0.85)
        if (out && out.length > 0 && out.length < view.byteLength) webpEdits.set(ii, out)
        else { report.webp.skipped++; report.webp.reasons.push(out ? 'an image did not shrink' : 'image encode unavailable') }
      } catch {
        report.webp.skipped++
        report.webp.reasons.push('image encode failed')
      }
    }
  }

  if (!dracoEdits.length && !webpEdits.size) return { bytes, report }

  // ---- Which accessors must keep their bufferView? ------------------------
  // A compressed primitive's attribute/indices accessors are stripped (the
  // Draco payload replaces the data) — but ONLY when no surviving raw
  // primitive, morph target, instancing extension, skin or animation still
  // reads them.
  const compressed = new Set(dracoEdits.map((e) => `${e.mesh}:${e.prim}`))
  const plainRefs = new Set<number>()
  const stripCandidates = new Set<number>()
  const addRefs = (prim: any, raw: boolean) => {
    for (const acc of Object.values(prim?.attributes ?? {})) if (typeof acc === 'number') (raw ? plainRefs : stripCandidates).add(acc)
    if (typeof prim?.indices === 'number') (raw ? plainRefs : stripCandidates).add(prim.indices)
    for (const target of prim?.targets ?? []) for (const acc of Object.values(target ?? {})) if (typeof acc === 'number') plainRefs.add(acc)
    const inst = prim?.extensions?.EXT_mesh_gpu_instancing?.attributes
    for (const acc of Object.values(inst ?? {})) if (typeof acc === 'number') plainRefs.add(acc)
  }
  for (let mi = 0; mi < meshes.length; mi++) {
    const prims = meshes[mi]?.primitives ?? []
    for (let pi = 0; pi < prims.length; pi++) addRefs(prims[pi], !compressed.has(`${mi}:${pi}`))
  }
  for (const skin of json.skins ?? []) if (typeof skin?.inverseBindMatrices === 'number') plainRefs.add(skin.inverseBindMatrices)
  for (const anim of json.animations ?? []) for (const sampler of anim?.samplers ?? []) {
    for (const acc of [sampler?.input, sampler?.output]) if (typeof acc === 'number') plainRefs.add(acc)
  }
  for (const acc of stripCandidates) if (plainRefs.has(acc)) stripCandidates.delete(acc)

  const strippedViews = new Set<number>()
  for (const accIndex of stripCandidates) {
    const accessor = accessors[accIndex]
    if (!accessor || typeof accessor.bufferView !== 'number') continue
    strippedViews.add(accessor.bufferView)
    delete accessor.bufferView
    delete accessor.byteOffset
  }

  // ---- WebP image + texture rewrite ---------------------------------------
  const replacedViews = new Set<number>()
  for (const [ii, payload] of webpEdits) {
    const image = images[ii]
    replacedViews.add(image.bufferView)
    image.mimeType = 'image/webp'
    report.webp.images++
    report.webp.bytesBefore += Number(bufferViews[image.bufferView]?.byteLength) || 0
    report.webp.bytesAfter += align4(payload.length)
  }
  for (const tex of textures) {
    if (typeof tex?.source !== 'number' || !webpEdits.has(tex.source)) continue
    // No-fallback WebP form (EXT_texture_webp spec): the texture points at
    // the webp image through the extension and drops its plain source.
    tex.extensions = { ...tex.extensions, EXT_texture_webp: { source: tex.source } }
    delete tex.source
    usedList(json, 'extensionsUsed', 'EXT_texture_webp')
    usedList(json, 'extensionsRequired', 'EXT_texture_webp')
  }

  // ---- Draco primitive rewrite --------------------------------------------
  for (const edit of dracoEdits) {
    const prim = meshes[edit.mesh].primitives[edit.prim]
    prim.extensions = { ...prim.extensions, KHR_draco_mesh_compression: { bufferView: -1, attributes: edit.ids } }
    usedList(json, 'extensionsUsed', 'KHR_draco_mesh_compression')
    usedList(json, 'extensionsRequired', 'KHR_draco_mesh_compression')
    report.draco.prims++
    report.draco.bytesAfter += align4(edit.payload.length)
  }

  // ---- Rebuild the BIN: surviving views (index order) + appended payloads -
  const surviveView = (vi: number): boolean => {
    if (strippedViews.has(vi) || replacedViews.has(vi)) return false
    for (const accessor of accessors) if (accessor?.bufferView === vi) return true
    for (const image of images) if (image?.bufferView === vi) return true
    return false
  }
  let capacity = 0
  for (let vi = 0; vi < bufferViews.length; vi++) {
    const view = bufferViews[vi]
    if (typeof view?.byteLength !== 'number') continue
    if (surviveView(vi)) capacity += align4(view.byteLength)
  }
  for (const e of dracoEdits) capacity += align4(e.payload.length)
  for (const p of webpEdits.values()) capacity += align4(p.length)
  const outBin = new Uint8Array(capacity)
  let cursor = 0
  const writeView = (payload: Uint8Array): { byteOffset: number; byteLength: number } => {
    const at = align4(cursor)
    outBin.set(payload, at)
    cursor = at + payload.length
    return { byteOffset: at, byteLength: payload.length }
  }
  const viewRemap = new Map<number, number>()
  const newViews: any[] = []
  for (let vi = 0; vi < bufferViews.length; vi++) {
    if (!surviveView(vi)) continue
    const view = bufferViews[vi]
    const placed = writeView(bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + (view.byteLength ?? 0)))
    viewRemap.set(vi, newViews.length)
    newViews.push({ ...view, buffer: 0, byteOffset: placed.byteOffset, byteLength: placed.byteLength })
  }
  const appendPayload = (payload: Uint8Array): number => {
    const placed = writeView(payload)
    newViews.push({ buffer: 0, byteOffset: placed.byteOffset, byteLength: placed.byteLength })
    return newViews.length - 1
  }
  for (const edit of dracoEdits) {
    meshes[edit.mesh].primitives[edit.prim].extensions.KHR_draco_mesh_compression.bufferView = appendPayload(edit.payload)
  }
  for (const [ii, payload] of webpEdits) images[ii].bufferView = appendPayload(payload)

  for (const accessor of accessors) {
    if (typeof accessor?.bufferView === 'number' && viewRemap.has(accessor.bufferView)) accessor.bufferView = viewRemap.get(accessor.bufferView)!
  }
  for (const image of images) {
    if (typeof image?.bufferView === 'number' && viewRemap.has(image.bufferView)) image.bufferView = viewRemap.get(image.bufferView)!
  }
  for (const vi of strippedViews) if (!surviveView(vi)) report.draco.bytesBefore += Number(bufferViews[vi]?.byteLength) || 0
  json.bufferViews = newViews
  json.buffers = [{ byteLength: cursor }]

  const out = buildGLB(json, outBin.subarray(0, cursor))
  if (out.length >= bytes.length) {
    // Never publish a "compressed" file that did not shrink.
    report.draco = { prims: 0, skipped: report.draco.skipped + report.draco.prims, bytesBefore: 0, bytesAfter: 0, reasons: [...report.draco.reasons, 'no net gain'] }
    report.webp = { images: 0, skipped: report.webp.skipped + report.webp.images, bytesBefore: 0, bytesAfter: 0, reasons: [...report.webp.reasons, 'no net gain'] }
    return { bytes, report }
  }
  report.keptOriginal = false
  return { bytes: out, report }
}
