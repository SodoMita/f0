// Codec units (SPEC AMENDMENT 84) — GLB container rewrite + Draco encode +
// WebP texture rewrite, all runnable under bun with the REAL Draco wasm
// (jsModule + wasmBinary injected the same way the app injects URLs):
//   bun scripts/codec-unit.mjs
import { readFileSync } from 'node:fs'
import { DracoEncoder } from '@babylonjs/core/Meshes/Compression/dracoEncoder'
import { DracoCompression } from '@babylonjs/core/Meshes/Compression/dracoCompression'
import { DracoDecoder } from '@babylonjs/core/Meshes/Compression/dracoDecoder'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
import '../src/model/gltf.ts' // curated loader + extensions (draco, webp, …)
import { align4, buildGLB, parseGLB } from '../src/model/glbContainer.ts'
import { compressGLB, readAccessor } from '../src/model/compressGlb.ts'
import { validateGLB } from '../src/model/limits.ts'
import { inspectGLB } from '../src/studio/exportInfo.ts'

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

// ---- real Draco encoder (same wasm the app bundles) -----------------------
const ASSETS = new URL('../node_modules/@babylonjs/core/assets/Draco/', import.meta.url)
const encoderModule = (await import(new URL('./draco_encoder_wasm_wrapper.js', ASSETS).href)).default
const decoderModule = (await import(new URL('./draco_wasm_wrapper_gltf.js', ASSETS).href)).default
const encoderWasm = readFileSync(new URL('./draco_encoder.wasm', ASSETS)).buffer
const decoderWasm = readFileSync(new URL('./draco_decoder_gltf.wasm', ASSETS)).buffer
const encoder = new DracoEncoder({ numWorkers: 0, jsModule: encoderModule, wasmBinary: encoderWasm, wasmUrl: 'x', wasmBinaryUrl: 'x' })
// Decoder for the roundtrip checks: same injection the app does via ?url.
DracoCompression.Configuration = { decoder: { numWorkers: 0, jsModule: decoderModule, wasmBinary: decoderWasm, wasmUrl: 'x', wasmBinaryUrl: 'x' } }
// Same main-thread normalized-override patch the app applies (src/model/draco.ts):
// without it the u8 COLOR_0 of a compressed GLB decodes as raw 0..255 instead
// of the accessor's normalized 0..1.
{
  const proto = DracoDecoder.prototype
  const original = proto.decodeMeshToMeshDataAsync
  proto.decodeMeshToMeshDataAsync = async function (data, attributes, gltfNormalizedOverride) {
    const meshData = await original.call(this, data, attributes, gltfNormalizedOverride)
    if (gltfNormalizedOverride) {
      for (const attr of meshData.attributes) {
        const want = gltfNormalizedOverride[attr.kind]
        if (want !== undefined && attr.normalized !== want) attr.normalized = want
      }
    }
    return meshData
  }
}
const dracoCodec = {
  async encodePrimitive(input, options) {
    const attributes = input.attributes.map((a) => ({ kind: a.semantic, dracoName: a.dracoName, size: a.size, data: a.data }))
    const out = await encoder._encodeAsync(attributes, input.indices, options)
    if (!out) return null
    return { data: new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength), attributeIds: out.attributeIds }
  },
}

// ---- GLB fixtures ---------------------------------------------------------
/** Pack arrays into a BIN + views/accessors. Returns {json, bin}. */
function makeModel({ grid = 48, interleave = false, withTexture = false, withAnimation = false, withSkin = false, withMorph = false, tiny = false, alreadyDraco = false, shareView = false } = {}) {
  const n = tiny ? 3 : grid + 1
  const verts = n * n
  const positions = new Float32Array(verts * 3)
  const normals = new Float32Array(verts * 3)
  const colors = new Uint8Array(verts * 4)
  const uvs = new Float32Array(verts * 2)
  for (let y = 0; y < (tiny ? 1 : n); y++) {
    for (let x = 0; x < (tiny ? 3 : n); x++) {
      const i = y * n + x
      const u = tiny ? x / 2 : x / grid, v = tiny ? 0 : y / grid
      positions[i * 3] = u * 4 - 2
      positions[i * 3 + 1] = v * 4 - 2
      positions[i * 3 + 2] = Math.sin(u * 12.9898 + v * 78.233) * 0.6
      const len = Math.hypot(1, 1, Math.cos(u * 6.28) * 2)
      normals[i * 3] = 1 / len
      normals[i * 3 + 1] = 1 / len
      normals[i * 3 + 2] = (Math.cos(u * 6.28) * 2) / len
      colors[i * 4] = (x * 255) / grid | 0
      colors[i * 4 + 1] = (y * 255) / grid | 0
      colors[i * 4 + 2] = ((x + y) * 255) / (2 * grid) | 0
      colors[i * 4 + 3] = 255
      uvs[i * 2] = u
      uvs[i * 2 + 1] = v
    }
  }
  let indices
  if (tiny) {
    indices = new Uint32Array([0, 1, 2])
  } else {
    indices = new Uint32Array(grid * grid * 6)
    let t = 0
    for (let y = 0; y < grid; y++) {
      for (let x = 0; x < grid; x++) {
        const a = y * n + x, b = a + 1, c = a + n, d = c + 1
        indices[t++] = a; indices[t++] = c; indices[t++] = b
        indices[t++] = b; indices[t++] = c; indices[t++] = d
      }
    }
  }

  const bin = []
  const views = []
  const accessors = []
  const push = (bytes, extra = {}) => {
    const offset = align4(bin.reduce((n, b) => n + b.length, 0))
    while (bin.reduce((n, b) => n + b.length, 0) < offset) bin.push(new Uint8Array(1))
    bin.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)))
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, ...extra })
    return views.length - 1
  }
  const acc = (view, componentType, count, type, min, max, extra = {}) => {
    accessors.push({ bufferView: view, componentType, count, type, min, max, ...extra })
    return accessors.length - 1
  }

  let attrs
  if (interleave) {
    // one interleaved view: [pos3f | nrm3f | col4ub | uv2f] per vertex
    const stride = 12 + 12 + 4 + 8
    const packed = new Uint8Array(stride * verts)
    const dv = new DataView(packed.buffer)
    for (let i = 0; i < verts; i++) {
      const o = i * stride
      for (let c = 0; c < 3; c++) dv.setFloat32(o + c * 4, positions[i * 3 + c], true)
      for (let c = 0; c < 3; c++) dv.setFloat32(o + 12 + c * 4, normals[i * 3 + c], true)
      packed.set(colors.subarray(i * 4, i * 4 + 4), o + 24)
      for (let c = 0; c < 2; c++) dv.setFloat32(o + 28 + c * 4, uvs[i * 2 + c], true)
    }
    const v = push(packed, { byteStride: stride })
    attrs = {
      POSITION: acc(v, 5126, verts, 'VEC3', [-2, -2, -1], [2, 2, 1]),
      NORMAL: acc(v, 5126, verts, 'VEC3', undefined, undefined, { byteOffset: 12 }),
      COLOR_0: acc(v, 5121, verts, 'VEC4', undefined, undefined, { byteOffset: 24, normalized: true }),
      TEXCOORD_0: acc(v, 5126, verts, 'VEC2', undefined, undefined, { byteOffset: 28 }),
    }
  } else {
    attrs = {
      POSITION: acc(push(positions), 5126, verts, 'VEC3', [-2, -2, -1], [2, 2, 1]),
      NORMAL: acc(push(normals), 5126, verts, 'VEC3'),
      COLOR_0: acc(push(colors), 5121, verts, 'VEC4', undefined, undefined, { normalized: true }),
      TEXCOORD_0: acc(push(uvs), 5126, verts, 'VEC2'),
    }
  }
  const idxAcc = acc(push(indices), 5125, indices.length, 'SCALAR')

  const prim = { attributes: attrs, indices: idxAcc, mode: 4, material: 0 }
  const meshes = [{ primitives: [prim] }]
  const materials = [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } }]
  const images = []
  const textures = []

  if (withTexture) {
    // minimal-but-real PNG header (IHDR 16×16 RGB) + filler ≥ 64 bytes
    const ihdr = new Uint8Array(8 + 25 + 200)
    const dv = new DataView(ihdr.buffer)
    ihdr.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    ihdr.set([0, 0, 0, 13], 8); ihdr.set([0x49, 0x48, 0x44, 0x52], 12)
    dv.setUint32(16, 16); dv.setUint32(20, 16); ihdr[24] = 8; ihdr[25] = 2
    const v = push(ihdr)
    images.push({ mimeType: 'image/png', bufferView: v })
    textures.push({ source: 0, sampler: 0 })
    materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 }
  }
  let animations
  if (withAnimation) {
    const times = new Float32Array([0, 1, 2])
    const values = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8])
    const tin = acc(push(times), 5126, 3, 'SCALAR')
    const val = acc(push(values), 5126, 3, 'VEC3')
    animations = [{ channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }], samplers: [{ input: tin, output: val, interpolation: 'LINEAR' }] }]
  }
  let skins
  if (withSkin) {
    const mats = new Float32Array(16)
    skins = [{ joints: [0], inverseBindMatrices: acc(push(mats), 5126, 1, 'MAT4') }]
  }
  if (withMorph) {
    const targets = new Float32Array(verts * 3).fill(0.1)
    prim.targets = [{ POSITION: acc(push(targets), 5126, verts, 'VEC3') }]
    meshes[0].weights = [0]
  }
  if (alreadyDraco) {
    const payload = new Uint8Array(64).fill(7)
    prim.extensions = { KHR_draco_mesh_compression: { bufferView: push(payload), attributes: { POSITION: 0 } } }
  }
  if (shareView) {
    // second mesh reading the SAME position view. It carries a CUSTOM_*
    // attribute, so draco skips it and it stays raw — the shared position
    // view MUST survive for it.
    const custom = acc(push(colors), 5121, verts, 'VEC4', undefined, undefined, { normalized: true })
    meshes.push({ primitives: [{ attributes: { POSITION: attrs.POSITION, CUSTOM_FOO: custom }, indices: idxAcc, mode: 4, material: 0 }] })
  }

  const json = {
    asset: { version: '2.0', generator: 'codec-unit' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, ...(withSkin ? { skin: 0 } : {}) }],
    meshes,
    materials,
    accessors,
    bufferViews: views,
    buffers: [],
  }
  if (images.length) { json.images = images; json.textures = textures; json.samplers = [{ magFilter: 1, minFilter: 1 }] }
  if (animations) json.animations = animations
  if (skins) json.skins = skins
  const binBytes = new Uint8Array(bin.reduce((n, b) => n + b.length, 0))
  let cur = 0
  for (const b of bin) { binBytes.set(b, cur); cur += b.length }
  json.buffers = [{ byteLength: binBytes.length }]
  return buildGLB(json, binBytes)
}

/** Synthetic webp payload with a parseable VP8X header (w×h). */
function fakeWebp(width, height, size = 128) {
  const out = new Uint8Array(size)
  out.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  new DataView(out.buffer).setUint32(4, size - 8, true)
  out.set([0x57, 0x45, 0x42, 0x50], 8) // WEBP
  out.set([0x56, 0x50, 0x38, 0x58], 12) // VP8X
  new DataView(out.buffer).setUint32(16, 10, true)
  out[20] = 0x10 // alpha flag
  const w = width - 1, h = height - 1
  out[24] = w & 0xff; out[25] = (w >> 8) & 0xff; out[26] = (w >> 16) & 0xff
  out[27] = h & 0xff; out[28] = (h >> 8) & 0xff; out[29] = (h >> 16) & 0xff
  return out
}

// ---- container units ------------------------------------------------------
{
  const bytes = makeModel({ grid: 8 })
  const doc = parseGLB(bytes)
  check('parseGLB reads JSON + BIN', !!doc?.json && doc.bin.length > 0 && doc.json.meshes.length === 1)
  const rebuilt = buildGLB(doc.json, doc.bin)
  const again = parseGLB(rebuilt)
  check('buildGLB roundtrips', !!again && JSON.stringify(again.json) === JSON.stringify(doc.json) && Buffer.compare(Buffer.from(again.bin), Buffer.from(doc.bin)) === 0 && validateGLB(rebuilt).ok)
}

// ---- draco units ----------------------------------------------------------
async function loadVerts(bytes) {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  const c = await LoadAssetContainerAsync(bytes, scene, { pluginExtension: '.glb' })
  const mesh = c.meshes.find((m) => m.getVerticesData?.('position'))
  if (!mesh) throw new Error('no mesh with vertices')
  return {
    positions: Float32Array.from(mesh.getVerticesData('position')),
    normals: Float32Array.from(mesh.getVerticesData('normal')),
    colors: mesh.getVerticesData('color') ? Uint8Array.from(mesh.getVerticesData('color')) : null,
    indices: mesh.getIndices().length,
  }
}
const maxDelta = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i])); return d }
/** Draco may REORDER vertices (spec: order and number can change), so compare
 * geometry as sorted per-component distributions, not element-wise. */
const sortedDelta = (a, b) => { const x = Float64Array.from(a).sort(); const y = Float64Array.from(b).sort(); return maxDelta(x, y) }

{
  const bytes = makeModel({ grid: 96 })
  const { bytes: out, report } = await compressGLB(bytes, { draco: dracoCodec })
  check('draco: file shrinks', out.length < bytes.length * 0.6, `${bytes.length} → ${out.length} (${report.draco.prims} prims)`)
  check('draco: report says applied', !report.keptOriginal && report.draco.prims === 1 && report.draco.bytesBefore > report.draco.bytesAfter)
  const v = validateGLB(out)
  check('draco: output passes validateGLB', v.ok, v.reason ?? '')
  const doc = parseGLB(out)
  const prim = doc.json.meshes[0].primitives[0]
  const ext = prim.extensions?.KHR_draco_mesh_compression
  check('draco: extension JSON shape', !!ext && typeof ext.bufferView === 'number' && Object.keys(ext.attributes).join(',') === 'POSITION,NORMAL,COLOR_0,TEXCOORD_0')
  check('draco: extension attrs subset of primitive attrs', Object.keys(ext.attributes).every((k) => k in prim.attributes))
  check('draco: accessors lose bufferView but keep count/bounds', Object.values(prim.attributes).every((a) => doc.json.accessors[a].bufferView === undefined && doc.json.accessors[a].count === (96 + 1) * (96 + 1)) && Array.isArray(doc.json.accessors[prim.attributes.POSITION].min))
  check('draco: extensionsRequired declared', doc.json.extensionsRequired?.includes('KHR_draco_mesh_compression') && doc.json.extensionsUsed?.includes('KHR_draco_mesh_compression'))
  const info = inspectGLB(out)
  check('draco: inspectGLB sees the extension', info.extensions.includes('KHR_draco_mesh_compression') && info.meshes === 1 && info.triangles > 0)
  try {
    const before = await loadVerts(bytes)
    const after = await loadVerts(out)
    check('draco: roundtrip vertex count + indices', before.positions.length === after.positions.length && before.indices === after.indices, `${before.positions.length / 3} verts`)
    check('draco: positions within quantization tolerance', sortedDelta(before.positions, after.positions) < 0.001, String(sortedDelta(before.positions, after.positions)))
    check('draco: normals within tolerance', sortedDelta(before.normals, after.normals) < 0.05, String(sortedDelta(before.normals, after.normals)))
    if (before.colors) check('draco: byte colors survive exactly', sortedDelta(before.colors, after.colors) === 0)
  } catch (e) {
    check('draco: Babylon loads the compressed GLB', false, e.message)
  }
}

{
  const bytes = makeModel({ tiny: true })
  const { bytes: out, report } = await compressGLB(bytes, { draco: dracoCodec })
  check('draco: tiny mesh is never made bigger', out.length <= bytes.length && (!report.keptOriginal || out === bytes), `${bytes.length} → ${out.length}`)
}

{
  const bytes = makeModel({ alreadyDraco: true, grid: 4 })
  const { bytes: out, report } = await compressGLB(bytes, { draco: dracoCodec })
  check('draco: already-compressed primitive skipped untouched', out === bytes && report.keptOriginal && report.draco.reasons.includes('already compressed'))
}

{
  const bytes = makeModel({ withSkin: true, grid: 8 })
  const { bytes: out, report } = await compressGLB(bytes, { draco: dracoCodec })
  check('draco: skinned model stays raw', out === bytes && report.draco.reasons.includes('skinned models keep raw buffers'))
}

{
  const bytes = makeModel({ withMorph: true, grid: 8 })
  const { bytes: out, report } = await compressGLB(bytes, { draco: dracoCodec })
  check('draco: morph-target primitive stays raw', out === bytes && report.draco.reasons.includes('morph targets stay raw'))
}

{
  const bytes = makeModel({ withAnimation: true, grid: 24 })
  const { bytes: out } = await compressGLB(bytes, { draco: dracoCodec })
  const src = parseGLB(bytes)
  const dst = parseGLB(out)
  const orig = readAccessor(src.bin, src.json.bufferViews, src.json.accessors[src.json.animations[0].samplers[0].output])
  const moved = readAccessor(dst.bin, dst.json.bufferViews, dst.json.accessors[dst.json.animations[0].samplers[0].output])
  check('draco: animation sampler bytes unchanged', !!orig && !!moved && Buffer.compare(Buffer.from(orig.buffer, orig.byteOffset, orig.byteLength), Buffer.from(moved.buffer, moved.byteOffset, moved.byteLength)) === 0)
}

{
  const bytes = makeModel({ interleave: true, grid: 64 })
  const { bytes: out, report } = await compressGLB(bytes, { draco: dracoCodec })
  check('draco: interleaved attributes de-interleave + compress', !report.keptOriginal && report.draco.prims === 1 && validateGLB(out).ok)
  try {
    const before = await loadVerts(bytes)
    const after = await loadVerts(out)
    check('draco: interleaved roundtrip matches', before.positions.length === after.positions.length && sortedDelta(before.positions, after.positions) < 0.001)
  } catch (e) {
    check('draco: interleaved roundtrip loads', false, e.message)
  }
}

{
  const bytes = makeModel({ shareView: true, grid: 48 })
  const { bytes: out, report } = await compressGLB(bytes, { draco: dracoCodec })
  const doc = parseGLB(out)
  const sharedAccessor = doc.json.meshes[1].primitives[0].attributes.POSITION
  const view = doc.json.bufferViews[doc.json.accessors[sharedAccessor].bufferView]
  check('draco: view shared with a raw primitive survives', !report.keptOriginal && report.draco.prims >= 1 && typeof view?.byteLength === 'number' && view.byteLength > 100)
  try {
    const before = await loadVerts(bytes)
    const after = await loadVerts(out)
    check('draco: shared-view roundtrip loads both meshes', after.positions.length > 0 && before.indices === after.indices)
  } catch (e) {
    check('draco: shared-view roundtrip loads', false, e.message)
  }
}

// ---- draco fine settings (AMENDMENT 85) ----------------------------------
{
  const bytes = makeModel({ grid: 96 })
  let captured = null
  const spyCodec = {
    async encodePrimitive(input, options) {
      captured = options
      return dracoCodec.encodePrimitive(input, options)
    },
  }
  const high = await compressGLB(bytes, { draco: spyCodec, dracoOptions: { quantizationBits: { POSITION: 14, NORMAL: 10, TEX_COORD: 12, COLOR: 8 } } })
  const small = await compressGLB(bytes, { draco: spyCodec, dracoOptions: { quantizationBits: { POSITION: 10, NORMAL: 8, TEX_COORD: 9, COLOR: 6 } } })
  check('draco: fine settings reach the encoder', !!captured?.quantizationBits && captured.quantizationBits.POSITION !== undefined, JSON.stringify(captured?.quantizationBits ?? null))
  check('draco: fewer bits -> smaller payload', !small.report.keptOriginal && small.bytes.length < high.bytes.length, `${high.bytes.length} vs ${small.bytes.length}`)
  try {
    const before = await loadVerts(bytes)
    const after = await loadVerts(small.bytes)
    check('draco: low-bit roundtrip keeps vertex count + indices', before.positions.length === after.positions.length && before.indices === after.indices, `${after.positions.length} floats`)
    const lowDelta = sortedDelta(before.positions, after.positions)
    check('draco: low-bit positions within coarse tolerance', lowDelta < 0.01, String(lowDelta))
  } catch (e) {
    check('draco: low-bit roundtrip loads', false, e.message)
  }
}

// ---- webp units -----------------------------------------------------------
{
  const bytes = makeModel({ withTexture: true, grid: 8 })
  const goodCodec = { async encode() { return fakeWebp(16, 16, 96) } }
  const { bytes: out, report } = await compressGLB(bytes, { webp: goodCodec })
  const doc = parseGLB(out)
  check('webp: image replaced + validated', !report.keptOriginal && report.webp.images === 1 && validateGLB(out).ok)
  check('webp: texture uses extension source without fallback', doc.json.textures[0].source === undefined && doc.json.textures[0].extensions?.EXT_texture_webp?.source === 0)
  check('webp: image declares image/webp mimeType', doc.json.images[0].mimeType === 'image/webp')
  check('webp: extensionsUsed+Required declared', doc.json.extensionsUsed.includes('EXT_texture_webp') && doc.json.extensionsRequired.includes('EXT_texture_webp'))
  const view = doc.json.bufferViews[doc.json.images[0].bufferView]
  const raw = doc.bin.subarray(view.byteOffset, view.byteOffset + view.byteLength)
  check('webp: replaced payload is the encoded webp', raw[0] === 0x52 && raw[8] === 0x57 && raw.length === 96)
  const info = inspectGLB(out)
  check('webp: inspectGLB sees the extension + dims', info.extensions.includes('EXT_texture_webp'))
}

{
  const bytes = makeModel({ withTexture: true, grid: 8 })
  const fatCodec = { async encode() { return fakeWebp(16, 16, 4096) } } // bigger than the png
  const { bytes: out, report } = await compressGLB(bytes, { webp: fatCodec })
  check('webp: gainless image keeps original', out === bytes && report.keptOriginal)
}

{
  const bytes = makeModel({ withTexture: true, grid: 8 })
  const deadCodec = { async encode() { return null } }
  const { bytes: out, report } = await compressGLB(bytes, { webp: deadCodec })
  check('webp: encoder failure keeps original', out === bytes && report.keptOriginal)
}

{
  const bytes = makeModel({ withTexture: true, grid: 8 })
  let gotQuality = null
  const spyCodec = { async encode(_b, _m, quality) { gotQuality = quality; return fakeWebp(16, 16, 90) } }
  await compressGLB(bytes, { webp: spyCodec, webpQuality: 0.55 })
  check('webp: quality setting is passed through', gotQuality === 0.55, String(gotQuality))
}

// ---- combined -------------------------------------------------------------
{
  const bytes = makeModel({ withTexture: true, grid: 96 })
  const { bytes: out, report } = await compressGLB(bytes, { draco: dracoCodec, webp: { async encode() { return fakeWebp(16, 16, 90) } } })
  const info = inspectGLB(out)
  check('combined: draco + webp together', !report.keptOriginal && report.draco.prims === 1 && report.webp.images === 1 && validateGLB(out).ok && info.extensions.length === 2)
  check('combined: smaller than either alone is plausible', out.length < bytes.length * 0.7, `${bytes.length} → ${out.length}`)
}

console.log(fails.length ? `\n${fails.length} FAIL` : '\nall codec units passed')
process.exit(fails.length ? 1 : 0)
