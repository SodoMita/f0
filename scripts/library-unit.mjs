// Guard the studio library GLBs without booting Babylon.
//   node scripts/library-unit.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = join(here, '../src/studio/library')
const manifest = JSON.parse(readFileSync(join(lib, 'manifest.json'), 'utf8'))

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

function resolve(item) {
  const prefer = join(lib, item.dim, item.id + '.glb')
  if (existsSync(prefer)) return prefer
  return join(lib, 'glb', item.id + '.glb')
}

function listGlbs(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.glb'))
}

const files2d = listGlbs(join(lib, '2d'))
const files3d = listGlbs(join(lib, '3d'))
const filesLegacy = listGlbs(join(lib, 'glb'))
check('catalog is non-empty', manifest.length >= 40, `n=${manifest.length}`)
check('every catalog id resolves to a glb', manifest.every((item) => existsSync(resolve(item))))
check('traced 2d plates exist', ['heart', 'star', 'house', 'check', 'lock'].every((id) => files2d.includes(id + '.glb')), files2d.join(','))
// Faces are low-poly BALLS since 2026-08-21 — never flat plates again.
check('faces are 3d balls', manifest.filter((i) => i.group === 'face').every((i) => i.dim === '3d'),
  manifest.filter((i) => i.group === 'face').map((i) => `${i.id}:${i.dim}`).join(','))
check('the flat smiley plate is gone', !files2d.includes('smile.glb'), files2d.join(','))
check('voxel group exists', manifest.filter((i) => i.group === 'voxel').length >= 5,
  manifest.filter((i) => i.group === 'voxel').map((i) => i.id).join(','))
check('front-facing pieces are flagged', manifest.filter((i) => i.front).length >= 20,
  String(manifest.filter((i) => i.front).length))

function inspect(bytes) {
  if (bytes.length < 20) return { ok: false, reason: 'too small' }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (dv.getUint32(0, true) !== 0x46546c67) return { ok: false, reason: 'bad magic' }
  if (dv.getUint32(4, true) !== 2) return { ok: false, reason: 'bad version' }
  let off = 12
  let jsonBytes = null
  while (off + 8 <= bytes.length) {
    const chunkLen = dv.getUint32(off, true)
    const chunkType = dv.getUint32(off + 4, true)
    off += 8
    if (off + chunkLen > bytes.length) return { ok: false, reason: 'truncated' }
    if (chunkType === 0x4e4f534a) jsonBytes = bytes.subarray(off, off + chunkLen)
    off += chunkLen
  }
  if (!jsonBytes) return { ok: false, reason: 'no json' }
  let gltf
  try { gltf = JSON.parse(new TextDecoder().decode(jsonBytes)) }
  catch { return { ok: false, reason: 'json' } }
  const bad = []
  const walk = (v) => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'uri' && typeof x === 'string' && x !== '' && !/^data:/i.test(x)) bad.push(x)
        else walk(x)
      }
    }
  }
  walk(gltf)
  if (bad.length) return { ok: false, reason: 'external uri ' + bad[0] }
  let vertices = 0
  let uvd = 0
  for (const mesh of gltf.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const acc = gltf.accessors?.[prim.attributes?.POSITION]
      if (acc) vertices += acc.count ?? 0
      if (prim.attributes?.TEXCOORD_0 !== undefined) uvd++
    }
  }
  // Palette-texture colour (2026-08-21): one embedded PNG, sampled NEAREST,
  // referenced by the material's baseColorTexture. Never an external URI.
  const images = gltf.images ?? []
  const palette = {
    images: images.length,
    embedded: images.every((img) => img.bufferView !== undefined && !img.uri),
    nearest: (gltf.samplers ?? []).every((s) => s.magFilter === 9728 && s.minFilter === 9728),
    bound: (gltf.materials ?? []).every((m) => m.pbrMetallicRoughness?.baseColorTexture?.index !== undefined),
    bytes: images.reduce((n, img) => n + (gltf.bufferViews?.[img.bufferView]?.byteLength ?? 0), 0),
    uvd,
  }
  let zmin = Infinity, zmax = -Infinity
  // POSITION may be Draco-compressed — then we cannot read z. Only check raw float accessors.
  const acc0 = gltf.accessors?.[0]
  const views = gltf.bufferViews ?? []
  if (acc0 && acc0.componentType === 5126 && acc0.type === 'VEC3' && acc0.min && acc0.max) {
    zmin = acc0.min[2]; zmax = acc0.max[2]
  }
  return {
    ok: true,
    meshes: (gltf.meshes ?? []).length,
    vertices,
    textures: (gltf.textures ?? []).length,
    skins: (gltf.skins ?? []).length,
    animations: (gltf.animations ?? []).length,
    zspan: Number.isFinite(zmin) ? zmax - zmin : 0,
    draco: JSON.stringify(gltf).includes('KHR_draco_mesh_compression'),
    palette,
  }
}

let bytesTotal = 0
const paletteBytes = new Set()
const seen = new Set()
for (const item of manifest) {
  const path = resolve(item)
  if (seen.has(path)) continue
  seen.add(path)
  const bytes = new Uint8Array(readFileSync(path))
  bytesTotal += bytes.byteLength
  const label = path.slice(lib.length + 1)
  const report = inspect(bytes)
  check(`${label} is a self-contained GLB`, report.ok, report.ok ? `v=${report.vertices}` : report.reason)
  if (report.ok) {
    check(`${label} has mesh + positions`, report.meshes >= 1 && report.vertices >= 3)
    check(`${label} has no skins / anim`, report.skins === 0 && report.animations === 0)
    // At most ONE texture and it must be the embedded palette: self-contained,
    // NEAREST-sampled, bound as baseColorTexture, and tiny.
    check(`${label} ships at most the palette texture`, report.textures <= 1, `n=${report.textures}`)
    if (report.textures === 1) {
      check(`${label} palette is embedded + NEAREST + bound`,
        report.palette.images === 1 && report.palette.embedded && report.palette.nearest &&
        report.palette.bound && report.palette.uvd >= 1,
        JSON.stringify(report.palette))
      check(`${label} palette image stays tiny`, report.palette.bytes > 0 && report.palette.bytes < 4096,
        `${report.palette.bytes} B`)
      paletteBytes.add(report.palette.bytes)
    }
    if (label.startsWith('2d/') && !report.draco) {
      check(`${label} is a single plane (no stacked z)`, report.zspan < 1e-5)
    }
  }
}
void files3d
void filesLegacy
check('every piece shares ONE palette image', paletteBytes.size <= 1, [...paletteBytes].join(','))
check('library stays small', bytesTotal < 1_200_000, `${(bytesTotal / 1024).toFixed(0)} KiB`)

console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL LIBRARY UNIT CHECKS PASSED')
process.exit(fails.length ? 1 : 0)
