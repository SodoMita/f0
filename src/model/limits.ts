import { LIMITS } from '../theme'

export interface LimitReport {
  ok: boolean
  reason?: string
  stats: {
    nodes: number; meshes: number; primitives: number; vertices: number
    indices: number; materials: number; textures: number; cameras: number
    lights: number; skins: number; animations: number; channels: number
    keyframes: number; decodedPixels: number; depth: number
  }
}

/** Width/height from a supported image header (up to the first 64 KiB). */
export function imageDimensions(head: Uint8Array): { width: number; height: number } | null {
  if (head.length < 16) return null
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength)
  // PNG: 89 50 4E 47 ... IHDR at byte 16
  if (dv.getUint32(0, false) === 0x89504e47 && head.length >= 24) {
    return { width: dv.getUint32(16, false), height: dv.getUint32(20, false) }
  }
  // JPEG: scan SOFn markers. EXIF/ICC segments can put SOF many KiB in.
  if (head[0] === 0xff && head[1] === 0xd8) {
    let i = 2
    while (i + 9 < head.length) {
      if (head[i] !== 0xff) { i++; continue }
      const marker = head[i + 1]
      const len = dv.getUint16(i + 2, false)
      const isSOF = marker >= 0xc0 && marker <= 0xcf
        && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSOF) return { height: dv.getUint16(i + 5, false), width: dv.getUint16(i + 7, false) }
      if (len < 2) return null
      i += 2 + len
    }
    return null
  }
  // WebP: RIFF....WEBP
  if (dv.getUint32(0, false) === 0x52494646 && head.length >= 30 && dv.getUint32(8, false) === 0x57454250) {
    const fourcc = dv.getUint32(12, false)
    if (fourcc === 0x56503820 && head.length >= 30) { // 'VP8 ' lossy
      return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff }
    }
    if (fourcc === 0x56503858 && head.length >= 30) { // 'VP8X' extended
      const w = 1 + (head[24] | (head[25] << 8) | (head[26] << 16))
      const h = 1 + (head[27] | (head[28] << 8) | (head[29] << 16))
      return { width: w, height: h }
    }
    if (fourcc === 0x5650384c && head.length >= 25 && head[20] === 0x2f) { // 'VP8L' lossless
      return {
        width: 1 + head[21] + ((head[22] & 0x3f) << 8),
        height: 1 + (head[22] >> 6) + (head[23] << 2) + ((head[24] & 0x0f) << 10),
      }
    }
  }
  // GIF87a / GIF89a.
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) {
    return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) }
  }
  // BMP DIB width/height.
  if (head[0] === 0x42 && head[1] === 0x4d && head.length >= 26) {
    return { width: Math.abs(dv.getInt32(18, true)), height: Math.abs(dv.getInt32(22, true)) }
  }
  // TGA has no magic; restrict this to its defined image types + bit depths.
  if (head.length >= 18 && [1, 2, 3, 9, 10, 11].includes(head[2]) && [8, 16, 24, 32].includes(head[16])) {
    return { width: dv.getUint16(12, true), height: dv.getUint16(14, true) }
  }
  // KTX2 identifier, then vkFormat/typeSize/pixelWidth/pixelHeight.
  const ktx2 = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]
  if (head.length >= 28 && ktx2.every((b, i) => head[i] === b)) {
    return { width: dv.getUint32(20, true), height: dv.getUint32(24, true) }
  }
  return null
}

/** Decode only enough of an image data URI to inspect its dimensions. */
export function dataUriImageHead(uri: string, maxBytes = 64 * 1024): Uint8Array | null {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/is.exec(uri)
  // Deliberately exclude SVG: an image document can itself reference remote
  // resources, defeating the "self-contained model" network boundary.
  if (!match || !/^image\/(png|jpe?g|webp|gif|bmp|ktx2)$/i.test(match[1])) return null
  try {
    if (match[2]) {
      // 4 base64 chars encode 3 bytes. Keep a little padding for a partial quartet.
      const encoded = match[3].replace(/\s/g, '').slice(0, Math.ceil(maxBytes / 3) * 4 + 4)
      const raw = atob(encoded)
      const out = new Uint8Array(Math.min(raw.length, maxBytes))
      for (let i = 0; i < out.length; i++) out[i] = raw.charCodeAt(i)
      return out
    }
    return new TextEncoder().encode(decodeURIComponent(match[3])).subarray(0, maxBytes)
  } catch { return null }
}

/**
 * GLB complexity validation BEFORE Babylon ever sees the bytes (07 §4).
 * This is what prevents a huge/hostile model from exhausting GPU memory and
 * crashing the renderer ("Aw, Snap!").
 */
/**
 * Memo of validation results by content hash. The poster renderer, the live
 * preview pool and the viewer all validate the SAME model; parsing the JSON
 * chunk three times per post is pure waste.
 */
const reportBySha = new Map<string, LimitReport>()

export function validateGLBCached(bytes: Uint8Array, sha256: string): LimitReport {
  const hit = reportBySha.get(sha256)
  if (hit) return hit
  const report = validateGLB(bytes)
  if (reportBySha.size > 256) reportBySha.clear()
  reportBySha.set(sha256, report)
  return report
}

/**
 * Runtime overrides for the device-protection caps (settings → Textures).
 * A phone can refuse 4K-textured posts outright instead of thrashing VRAM.
 */
const overrides: { textureSide?: number; decodedPixels?: number } = {}

export function setLimitOverrides(next: { textureSide?: number; decodedPixels?: number }): void {
  Object.assign(overrides, next)
  reportBySha.clear()   // previous verdicts were made under different caps
}

export function limitTextureSide(): number { return overrides.textureSide ?? LIMITS.textureSide }
export function limitDecodedPixels(): number { return overrides.decodedPixels ?? LIMITS.decodedPixels }

export function validateGLB(bytes: Uint8Array): LimitReport {
  const stats = { nodes: 0, meshes: 0, primitives: 0, vertices: 0, indices: 0, materials: 0, textures: 0, cameras: 0, lights: 0, skins: 0, animations: 0, channels: 0, keyframes: 0, decodedPixels: 0, depth: 0 }
  const fail = (reason: string): LimitReport => ({ ok: false, reason, stats })

  if (bytes.length > LIMITS.modelBytesHard) return fail(`Model is ${(bytes.length / 1048576).toFixed(1)} MiB; limit is 20 MiB.`)
  if (bytes.length < 20) return fail('File too small to be a GLB.')

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (dv.getUint32(0, true) !== 0x46546c67) return fail('Not a GLB file (bad magic).')
  if (dv.getUint32(4, true) !== 2) return fail('Unsupported GLB version.')

  // Walk chunks; find JSON and BIN.
  let off = 12
  let jsonBytes: Uint8Array | null = null
  let binLength = 0
  let binOffset = 0
  while (off + 8 <= bytes.length) {
    const chunkLen = dv.getUint32(off, true)
    const chunkType = dv.getUint32(off + 4, true)
    off += 8
    if (off + chunkLen > bytes.length) return fail('Truncated GLB chunk.')
    if (chunkType === 0x4e4f534a) jsonBytes = bytes.subarray(off, off + chunkLen)
    if (chunkType === 0x004e4942) { binLength = chunkLen; binOffset = off }
    off += chunkLen
  }
  if (!jsonBytes) return fail('GLB has no JSON chunk.')
  if (jsonBytes.length > LIMITS.jsonChunkBytes) return fail('GLB JSON chunk exceeds 2 MiB.')

  let gltf: any
  try {
    gltf = JSON.parse(new TextDecoder().decode(jsonBytes))
  } catch { return fail('GLB JSON chunk is not valid JSON.') }

  // External resources are FORBIDDEN (spec PIPELINE "external URIs
  // forbidden", 06 §3.2). A hostile post can put a tiny, valid GLB here and
  // point `buffers[].uri` / `images[].uri` (or any extension uri) at an
  // arbitrary host: Babylon fetches it verbatim with rootUrl '' — no size
  // cap (the 20 MiB cap covers only the container), no hash check — turning
  // a signed post into an unbounded download (tab crash) or a tracking
  // request that leaks the viewer's IP to a third party. Only empty or
  // data: URIs pass (data: URIs are bounded by the 2 MiB JSON chunk cap).
  {
    const bad: string[] = []
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) { for (const x of v) walk(x); return }
      if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (k === 'uri' && typeof x === 'string' && x !== '' && !/^data:/i.test(x)) bad.push(x.slice(0, 120))
          else walk(x)
        }
      }
    }
    walk(gltf)
    if (bad.length) return fail(`External resource URI is not allowed (self-contained GLBs only): ${bad[0]}`)
  }

  const nodes = (gltf.nodes ?? []) as any[]
  const meshes = (gltf.meshes ?? []) as any[]
  const materials = (gltf.materials ?? []) as any[]
  const textures = (gltf.textures ?? []) as any[]
  const images = (gltf.images ?? []) as any[]
  const accessors = (gltf.accessors ?? []) as any[]
  const bufferViews = (gltf.bufferViews ?? []) as any[]
  const animations = (gltf.animations ?? []) as any[]
  const skins = (gltf.skins ?? []) as any[]
  const cameras = (gltf.cameras ?? []) as any[]

  stats.nodes = nodes.length
  stats.meshes = meshes.length
  stats.materials = materials.length
  stats.textures = textures.length
  stats.cameras = cameras.length
  stats.skins = skins.length
  stats.animations = animations.length
  stats.lights = (gltf.extensions?.KHR_lights_punctual?.lights ?? gltf.extensions?.KHR_lights_punctual?.lights ?? []).length

  if (stats.nodes > LIMITS.nodes) return fail(`nodes ${stats.nodes} > ${LIMITS.nodes}`)
  if (stats.meshes > LIMITS.meshes) return fail(`meshes ${stats.meshes} > ${LIMITS.meshes}`)
  if (stats.materials > LIMITS.materials) return fail(`materials ${stats.materials} > ${LIMITS.materials}`)
  if (stats.textures > LIMITS.textures) return fail(`textures ${stats.textures} > ${LIMITS.textures}`)
  if (stats.cameras > LIMITS.cameras) return fail(`cameras ${stats.cameras} > ${LIMITS.cameras}`)
  if (stats.lights > LIMITS.lights) return fail(`lights ${stats.lights} > ${LIMITS.lights}`)
  if (stats.skins > LIMITS.skins) return fail(`skins ${stats.skins} > ${LIMITS.skins}`)

  for (const mesh of meshes) {
    const prims = mesh.primitives ?? []
    stats.primitives += prims.length
    for (const prim of prims) {
      const pos = accessors[prim.attributes?.POSITION]
      if (pos) stats.vertices += pos.count ?? 0
      const idx = prim.indices !== undefined ? accessors[prim.indices] : undefined
      if (idx) stats.indices += idx.count ?? 0
    }
  }
  if (stats.primitives > LIMITS.primitives) return fail(`primitives ${stats.primitives} > ${LIMITS.primitives}`)
  if (stats.vertices > LIMITS.vertices) return fail(`vertices ${stats.vertices} > ${LIMITS.vertices}`)
  if (stats.indices > LIMITS.indices) return fail(`indices ${stats.indices} > ${LIMITS.indices}`)

  for (const anim of animations) {
    const samplers = anim.samplers ?? []
    const channels = anim.channels ?? []
    stats.channels += channels.length
    for (const s of samplers) {
      const input = accessors[s.input]
      if (input) stats.keyframes += input.count ?? 0
    }
  }
  if (stats.channels > LIMITS.animationChannels) return fail(`animation channels ${stats.channels} > ${LIMITS.animationChannels}`)
  if (stats.keyframes > LIMITS.keyframes) return fail(`keyframes ${stats.keyframes} > ${LIMITS.keyframes}`)

  for (const skin of skins) {
    if ((skin.joints ?? []).length > LIMITS.jointsPerSkin) return fail(`joints per skin > ${LIMITS.jointsPerSkin}`)
  }

  // Non-finite vertex positions poison the auto-fit cameras (NaN propagates
  // out of worldBox/frameDistance → blank poster / invisible model) and can
  // produce garbage bounding boxes. Reject them up front. Draco/meshopt
  // primitives are opaque here (their buffers are compressed); they stay
  // covered by the container-level caps.
  const FLOAT = 5126
  for (const mesh of meshes) {
    for (const prim of (mesh.primitives ?? []) as any[]) {
      const acc = accessors[prim.attributes?.POSITION]
      if (!acc || acc.componentType !== FLOAT || acc.type !== 'VEC3') continue
      if (prim.extensions?.KHR_draco_mesh_compression || prim.extensions?.EXT_meshopt_compression) continue
      if (acc.sparse) return fail('Sparse POSITION accessors are not accepted by the safety scanner.')
      const bv = bufferViews[acc.bufferView]
      if (!bv || typeof bv.byteLength !== 'number' || bv.byteLength < 12) continue
      const bStart = bv.byteOffset ?? 0
      const aStart = acc.byteOffset ?? 0
      if (!Number.isSafeInteger(aStart) || aStart < 0 || aStart + 12 > bv.byteLength) return fail('Position accessor offset out of range.')
      if (bStart + bv.byteLength > binLength) return fail('Position bufferView out of BIN range.')
      const stride = bv.byteStride ?? 12
      if (!Number.isSafeInteger(stride) || stride < 12) return fail('Position accessor stride too small.')
      const count = acc.count ?? 0
      if (!Number.isSafeInteger(count) || count < 0 || (count > 0 && aStart + (count - 1) * stride + 12 > bv.byteLength)) {
        return fail('Position accessor exceeds its bufferView.')
      }
      const dv = new DataView(bytes.buffer, bytes.byteOffset + binOffset + bStart + aStart, bv.byteLength - aStart)
      for (let i = 0; i < count; i++) {
        const o = i * stride
        if (!Number.isFinite(dv.getFloat32(o, true)) ||
            !Number.isFinite(dv.getFloat32(o + 4, true)) ||
            !Number.isFinite(dv.getFloat32(o + 8, true))) {
          return fail('Non-finite vertex position in mesh.')
        }
      }
    }
  }

  // Decoded-image budget from embedded bufferViews AND data: URIs. A tiny
  // compressed image (or just a forged header) can declare enormous output
  // dimensions, so the container/JSON byte caps alone do not protect VRAM.
  for (const img of images) {
    let head: Uint8Array | null = null
    if (img.bufferView !== undefined && !/^image\/(png|jpe?g|webp|gif|bmp|ktx2)$/i.test(String(img.mimeType ?? ''))) {
      return fail('Embedded image has an unsupported or unsafe MIME type.')
    }
    if (typeof img.uri === 'string' && /^data:/i.test(img.uri)) {
      head = dataUriImageHead(img.uri)
      if (!head) return fail('Image data URI is malformed or has a non-image MIME type.')
    } else {
      const bv = bufferViews[img.bufferView]
      if (!bv) continue
      const start = (bv.byteOffset ?? 0)
      const end = start + (bv.byteLength ?? 0)
      if (end > binLength) return fail('Image bufferView out of BIN range.')
      head = bytes.subarray(binOffset + start, binOffset + Math.min(end, start + 64 * 1024))
    }
    const dims = imageDimensions(head)
    if (!dims) return fail('Embedded image dimensions could not be validated.')
    const side = Math.max(dims.width, dims.height)
    if (dims.width < 1 || dims.height < 1 || side > limitTextureSide()) {
      return fail(`texture ${dims.width}x${dims.height} exceeds the ${limitTextureSide()} px limit`)
    }
    stats.decodedPixels += dims.width * dims.height * 4
  }
  if (stats.decodedPixels > limitDecodedPixels()) {
    return fail(`decoded texture memory ${(stats.decodedPixels / 1048576).toFixed(0)} MiB > ${(limitDecodedPixels() / 1048576).toFixed(0)} MiB`)
  }

  // Scene-graph depth (cycles → reject).
  const depthOf = (i: number, seen: Set<number>): number => {
    if (seen.has(i)) return Number.POSITIVE_INFINITY
    seen.add(i)
    let d = 1
    for (const c of (nodes[i]?.children ?? [])) d = Math.max(d, 1 + depthOf(c, new Set(seen)))
    return d
  }
  for (let i = 0; i < nodes.length; i++) stats.depth = Math.max(stats.depth, depthOf(i, new Set()))
  if (stats.depth > LIMITS.sceneDepth) return fail(`scene graph depth ${stats.depth} > ${LIMITS.sceneDepth}`)

  return { ok: true, stats }
}
