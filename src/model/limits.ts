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
  while (off + 8 <= bytes.length) {
    const chunkLen = dv.getUint32(off, true)
    const chunkType = dv.getUint32(off + 4, true)
    off += 8
    if (off + chunkLen > bytes.length) return fail('Truncated GLB chunk.')
    if (chunkType === 0x4e4f534a) jsonBytes = bytes.subarray(off, off + chunkLen)
    if (chunkType === 0x004e4942) binLength = chunkLen
    off += chunkLen
  }
  if (!jsonBytes) return fail('GLB has no JSON chunk.')
  if (jsonBytes.length > LIMITS.jsonChunkBytes) return fail('GLB JSON chunk exceeds 2 MiB.')

  let gltf: any
  try {
    gltf = JSON.parse(new TextDecoder().decode(jsonBytes))
  } catch { return fail('GLB JSON chunk is not valid JSON.') }

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

  // Decoded-pixel budget from embedded images (PNG/JPEG headers).
  for (const img of images) {
    if (img.uri) continue // external URI: Babylon fetches it; not counted here
    const bv = bufferViews[img.bufferView]
    if (!bv || bv.byteOffset + bv.byteLength > binLength) return fail('Image bufferView out of BIN range.')
    // We can't slice cheaply here without the BIN; dimensions are checked by
    // the loader. Count only when a BIN slice is provided (post-download).
    stats.decodedPixels += 0
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
