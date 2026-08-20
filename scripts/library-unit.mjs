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
check('traced 2d plates exist', ['smile', 'heart', 'star', 'house', 'check', 'lock'].every((id) => files2d.includes(id + '.glb')), files2d.join(','))

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
  for (const mesh of gltf.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const acc = gltf.accessors?.[prim.attributes?.POSITION]
      if (acc) vertices += acc.count ?? 0
    }
  }
  return {
    ok: true,
    meshes: (gltf.meshes ?? []).length,
    vertices,
    textures: (gltf.textures ?? []).length,
    skins: (gltf.skins ?? []).length,
    animations: (gltf.animations ?? []).length,
  }
}

let bytesTotal = 0
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
    check(`${label} has no textures / skins`, report.textures === 0 && report.skins === 0)
    check(`${label} has a looping clip`, report.animations >= 1)
  }
}
void files3d
void filesLegacy
check('library stays small', bytesTotal < 1_200_000, `${(bytesTotal / 1024).toFixed(0)} KiB`)

console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL LIBRARY UNIT CHECKS PASSED')
process.exit(fails.length ? 1 : 0)
