/**
 * GLB codec pipeline for the export review (SPEC AMENDMENT 84): applies
 * KHR_draco_mesh_compression + EXT_texture_webp to an already-validated
 * export. Encoders are injected (unit-testable under bun, and the app only
 * offers controls whose encoder actually initialised). The input bytes are
 * immutable — any failed or gainless pass returns them untouched. Only mesh
 * primitives are compressed: animations, skins, images and morph targets
 * keep their exact buffer views; the caller re-validates the result.
 */
import { align4, buildGLB, parseGLB } from './glbContainer'

export type DracoAttributeName = 'POSITION' | 'NORMAL' | 'COLOR' | 'TEX_COORD' | 'GENERIC'
export type DracoArray = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array

export interface DracoAttributeInput { semantic: string; dracoName: DracoAttributeName; size: number; data: DracoArray }
export interface DracoPrimitiveInput { attributes: DracoAttributeInput[]; indices: Uint16Array | Uint32Array | null }

/** Fine settings: quantization bits per Draco attribute kind. */
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
  webpQuality?: number
}

export interface CompressReport {
  keptOriginal: boolean
  draco: { prims: number; skipped: number; bytesBefore: number; bytesAfter: number; reasons: string[] }
  webp: { images: number; skipped: number; bytesBefore: number; bytesAfter: number; reasons: string[] }
}

interface DracoCtor { new (length: number): DracoArray; BYTES_PER_ELEMENT: number }
const COMPONENT_ARRAY: Record<number, DracoCtor> = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
}
const TYPE_SIZE: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }

/** Read an accessor into a fresh, packed (de-interleaved) typed array.
 * null = sparse/untyped/out of bounds → caller leaves the primitive alone. */
export function readAccessor(bin: Uint8Array, bufferViews: any[], accessor: any): DracoArray | null {
  if (!accessor || accessor.sparse) return null
  const Ctor = COMPONENT_ARRAY[accessor.componentType]
  const size = TYPE_SIZE[accessor.type]
  const view = Ctor && size && typeof accessor.bufferView === 'number' ? bufferViews[accessor.bufferView] : null
  if (!view || typeof view.byteLength !== 'number') return null
  const natural = Ctor.BYTES_PER_ELEMENT * size
  const stride = typeof view.byteStride === 'number' && view.byteStride > natural ? view.byteStride : natural
  const count = Number(accessor.count) || 0
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
  const span = count > 0 ? (count - 1) * stride + natural : 0
  if (count < 0 || start + span > (view.byteOffset ?? 0) + view.byteLength) return null
  const out = new Ctor(count * size)
  const outBytes = new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
  const src = bin.subarray(start, start + span)
  if (stride === natural) outBytes.set(src) // start may be unaligned; copy bytes
  else for (let i = 0; i < count; i++) outBytes.set(src.subarray(i * stride, i * stride + natural), i * natural)
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

function usedList(json: any, name: string): void {
  for (const key of ['extensionsUsed', 'extensionsRequired'] as const) {
    const list: string[] = json[key] ?? (json[key] = [])
    if (!list.includes(name)) list.push(name)
  }
}

/** Rewrite the GLB with the requested codecs. Codec failures degrade to
 * "primitive/image skipped"; the function itself never throws. */
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

  // ---- Draco pass: encode primitives that can only shrink ----------------
  type DracoEdit = { mesh: number; prim: number; payload: Uint8Array; ids: Record<string, number> }
  const dracoEdits: DracoEdit[] = []
  const dracoReason = (why: string) => { if (!report.draco.reasons.includes(why)) report.draco.reasons.push(why) }

  if (opts.draco && meshes.length) {
    if ((json.skins ?? []).length) {
      report.draco.skipped = meshes.reduce((n, m) => n + (m?.primitives?.length ?? 0), 0)
      dracoReason('skinned models keep raw buffers')
    } else {
      const skipPrim = (why: string) => { report.draco.skipped++; dracoReason(why) }
      for (let mi = 0; mi < meshes.length; mi++) {
        const prims = meshes[mi]?.primitives
        if (!Array.isArray(prims)) continue
        for (let pi = 0; pi < prims.length; pi++) {
          const prim = prims[pi]
          if (!prim || typeof prim !== 'object') continue
          if (prim.extensions?.KHR_draco_mesh_compression || prim.extensions?.EXT_meshopt_compression) { skipPrim('already compressed'); continue }
          if (prim.mode !== undefined && prim.mode !== 4) { skipPrim('non-triangle primitive'); continue }
          if (prim.targets) { skipPrim('morph targets stay raw'); continue }
          const attrsIn = prim.attributes ?? {}
          if (!('POSITION' in attrsIn)) { skipPrim('no POSITION'); continue }
          // Read every attribute; any unreadable one aborts the primitive.
          const attributes: DracoAttributeInput[] = []
          let readable = true
          for (const semantic of Object.keys(attrsIn)) {
            const accessor = accessors[attrsIn[semantic]]
            const data = readAccessor(bin, bufferViews, accessor)
            const dracoName = dracoNameFor(semantic)
            if (!accessor || !data || !dracoName) { readable = false; break }
            attributes.push({ semantic, dracoName, size: TYPE_SIZE[accessor.type] ?? 0, data })
          }
          const pos = attributes.find((a) => a.semantic === 'POSITION')
          if (!readable) { skipPrim('unsupported attribute layout'); continue }
          if (!(pos?.data instanceof Float32Array) || pos.data.length < 9) { skipPrim('POSITION must be float32 with real vertices'); continue }
          if (!pos.data.every(Number.isFinite)) { skipPrim('non-finite positions'); continue }
          let indices: Uint16Array | Uint32Array | null = null
          if (prim.indices !== undefined) {
            const idxData = readAccessor(bin, bufferViews, accessors[prim.indices])
            if (!(idxData instanceof Uint16Array) && !(idxData instanceof Uint32Array)) { skipPrim('unsupported index layout'); continue }
            indices = idxData
          }
          // Raw bytes this primitive's (exclusive) views occupy.
          let rawSize = 0
          for (const viewIndex of new Set([...Object.values(attrsIn), prim.indices].map((a: any) => accessors[a]?.bufferView))) {
            if (typeof viewIndex === 'number') rawSize += Number(bufferViews[viewIndex]?.byteLength) || 0
          }
          try {
            const result = await opts.draco.encodePrimitive({ attributes, indices }, opts.dracoOptions)
            if (result && result.data.length > 0 && result.data.length < rawSize) {
              dracoEdits.push({ mesh: mi, prim: pi, payload: result.data, ids: result.attributeIds })
            } else {
              skipPrim(result ? 'a primitive did not shrink' : 'encoder refused a primitive')
            }
          } catch { skipPrim('encoder failed on a primitive') }
        }
      }
    }
  }

  // ---- WebP pass: re-encode referenced embedded png/jpeg textures --------
  const webpEdits = new Map<number, Uint8Array>()
  if (opts.webp && images.length && textures.length) {
    const referenced = new Set(textures.map((t) => t?.source).filter((s) => typeof s === 'number'))
    for (let ii = 0; ii < images.length; ii++) {
      const image = images[ii]
      const mime = String(image?.mimeType ?? '')
      if (typeof image?.bufferView !== 'number' || !referenced.has(ii)) continue
      const view = bufferViews[image.bufferView]
      if (!/^image\/(png|jpeg)$/.test(mime)) { report.webp.skipped++; report.webp.reasons.push('not a png/jpeg image'); continue }
      if (!view || typeof view.byteLength !== 'number' || view.byteLength < 64) { report.webp.skipped++; report.webp.reasons.push('image too small to bother'); continue }
      const start = view.byteOffset ?? 0
      try {
        const out = await opts.webp.encode(bin.subarray(start, start + view.byteLength), mime, opts.webpQuality ?? 0.85)
        if (out && out.length > 0 && out.length < view.byteLength) webpEdits.set(ii, out)
        else { report.webp.skipped++; report.webp.reasons.push(out ? 'an image did not shrink' : 'image encode unavailable') }
      } catch { report.webp.skipped++; report.webp.reasons.push('image encode failed') }
    }
  }

  if (!dracoEdits.length && !webpEdits.size) return { bytes, report }

  // ---- Strip accessors of compressed prims (only if nothing raw reads them)
  const compressed = new Set(dracoEdits.map((e) => `${e.mesh}:${e.prim}`))
  const stripCandidates = new Set<number>()
  const plainRefs = new Set<number>()
  const collect = (refs: Set<number>, prim: any): void => {
    for (const acc of Object.values(prim?.attributes ?? {})) if (typeof acc === 'number') refs.add(acc)
    if (typeof prim?.indices === 'number') refs.add(prim.indices)
    for (const target of prim?.targets ?? []) for (const acc of Object.values(target ?? {})) if (typeof acc === 'number') plainRefs.add(acc)
    for (const acc of Object.values(prim?.extensions?.EXT_mesh_gpu_instancing?.attributes ?? {})) if (typeof acc === 'number') plainRefs.add(acc)
  }
  for (let mi = 0; mi < meshes.length; mi++) {
    const prims = meshes[mi]?.primitives ?? []
    for (let pi = 0; pi < prims.length; pi++) collect(compressed.has(`${mi}:${pi}`) ? stripCandidates : plainRefs, prims[pi])
  }
  for (const skin of json.skins ?? []) if (typeof skin?.inverseBindMatrices === 'number') plainRefs.add(skin.inverseBindMatrices)
  for (const anim of json.animations ?? []) for (const s of anim?.samplers ?? []) {
    for (const acc of [s?.input, s?.output]) if (typeof acc === 'number') plainRefs.add(acc)
  }
  const strippedViews = new Set<number>()
  for (const accIndex of stripCandidates) {
    if (plainRefs.has(accIndex)) continue
    const accessor = accessors[accIndex]
    if (accessor && typeof accessor.bufferView === 'number') {
      strippedViews.add(accessor.bufferView)
      delete accessor.bufferView
      delete accessor.byteOffset
    }
  }

  // ---- Rewrite webp images + textures (spec: no-fallback form) -----------
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
    tex.extensions = { ...tex.extensions, EXT_texture_webp: { source: tex.source } }
    delete tex.source
    usedList(json, 'EXT_texture_webp')
  }

  // ---- Rewrite draco primitives ------------------------------------------
  for (const edit of dracoEdits) {
    const prim = meshes[edit.mesh].primitives[edit.prim]
    prim.extensions = { ...prim.extensions, KHR_draco_mesh_compression: { bufferView: -1, attributes: edit.ids } }
    usedList(json, 'KHR_draco_mesh_compression')
    report.draco.prims++
    report.draco.bytesAfter += align4(edit.payload.length)
  }

  // ---- Rebuild the BIN: surviving views in index order + appended payloads
  const dead = new Set([...strippedViews, ...replacedViews])
  const alive = new Set<number>()
  for (const [i, accessor] of accessors.entries()) if (typeof accessor?.bufferView === 'number' && !dead.has(accessor.bufferView)) alive.add(accessor.bufferView)
  for (const image of images) if (typeof image?.bufferView === 'number' && !dead.has(image.bufferView)) alive.add(image.bufferView)
  const survivors = bufferViews.map((_, i) => i).filter((i) => alive.has(i) && typeof bufferViews[i]?.byteLength === 'number')
  let capacity = survivors.reduce((n, i) => n + align4(bufferViews[i].byteLength), 0)
  for (const p of [...dracoEdits.map((e) => e.payload), ...webpEdits.values()]) capacity += align4(p.length)
  const outBin = new Uint8Array(capacity)
  let cursor = 0
  const newViews: any[] = []
  const writeView = (payload: Uint8Array, base?: any): number => {
    const at = align4(cursor)
    outBin.set(payload, at)
    cursor = at + payload.length
    newViews.push(base ? { ...base, buffer: 0, byteOffset: at, byteLength: payload.length } : { buffer: 0, byteOffset: at, byteLength: payload.length })
    return newViews.length - 1
  }
  const viewRemap = new Map<number, number>()
  for (const vi of survivors) {
    const view = bufferViews[vi]
    const payload = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + (view.byteLength ?? 0))
    viewRemap.set(vi, writeView(payload, view))
  }
  for (const edit of dracoEdits) meshes[edit.mesh].primitives[edit.prim].extensions.KHR_draco_mesh_compression.bufferView = writeView(edit.payload)
  for (const [ii, payload] of webpEdits) images[ii].bufferView = writeView(payload)
  for (const accessor of accessors) if (viewRemap.has(accessor?.bufferView)) accessor.bufferView = viewRemap.get(accessor.bufferView)
  for (const image of images) if (viewRemap.has(image?.bufferView)) image.bufferView = viewRemap.get(image.bufferView)
  for (const vi of strippedViews) if (!alive.has(vi)) report.draco.bytesBefore += Number(bufferViews[vi]?.byteLength) || 0
  json.bufferViews = newViews
  json.buffers = [{ byteLength: cursor }]

  const out = buildGLB(json, outBin.subarray(0, cursor))
  if (out.length >= bytes.length) {
    // Never publish a "compressed" file that did not shrink.
    const zero = (t: CompressReport['draco'] | CompressReport['webp'], n: number) => ({ prims: 0, images: 0, skipped: t.skipped + n, bytesBefore: 0, bytesAfter: 0, reasons: [...t.reasons, 'no net gain'] })
    report.draco = zero(report.draco, report.draco.prims)
    report.webp = zero(report.webp, report.webp.images)
    return { bytes, report }
  }
  report.keptOriginal = false
  return { bytes: out, report }
}
