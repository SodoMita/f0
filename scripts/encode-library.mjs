// Optional Draco pass: keep the file only when it is smaller AND still a
// self-contained GLB. Tiny low-poly clips often grow under Draco, so this
// is best-effort — quantization in scripts/libglb.py is the baseline.
//   node scripts/encode-library.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const roots = [
  join(here, '../src/studio/library/2d'),
  join(here, '../src/studio/library/glb'),
]

function listGlbs(dir) {
  try { return readdirSync(dir).filter((f) => f.endsWith('.glb')).map((f) => join(dir, f)) }
  catch { return [] }
}

function inspect(bytes) {
  if (bytes.length < 20) return { ok: false }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (dv.getUint32(0, true) !== 0x46546c67) return { ok: false }
  let off = 12
  let jsonBytes = null
  while (off + 8 <= bytes.length) {
    const chunkLen = dv.getUint32(off, true)
    const chunkType = dv.getUint32(off + 4, true)
    off += 8
    if (off + chunkLen > bytes.length) return { ok: false }
    if (chunkType === 0x4e4f534a) jsonBytes = bytes.subarray(off, off + chunkLen)
    off += chunkLen
  }
  if (!jsonBytes) return { ok: false }
  let gltf
  try { gltf = JSON.parse(new TextDecoder().decode(jsonBytes)) }
  catch { return { ok: false } }
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
  return {
    ok: bad.length === 0,
    animations: (gltf.animations ?? []).length,
    draco: JSON.stringify(gltf).includes('KHR_draco_mesh_compression'),
  }
}

const files = roots.flatMap(listGlbs)
if (!files.length) {
  console.log('no library glbs')
  process.exit(0)
}

const help = spawnSync('npx', ['--yes', '@gltf-transform/cli@4.1.2', '--help'], {
  encoding: 'utf8',
  timeout: 180000,
})
if (help.status !== 0) {
  console.log('gltf-transform unavailable; keeping quantized originals')
  if (help.stderr) console.log(String(help.stderr).slice(0, 400))
  process.exit(0)
}

const tmp = mkdtempSync(join(tmpdir(), 'f0-enc-'))
let kept = 0
let skipped = 0
try {
  for (const src of files) {
    const dest = join(tmp, 'out.glb')
    const run = spawnSync('npx', [
      '--yes', '@gltf-transform/cli@4.1.2', 'optimize', src, dest,
      '--compress', 'draco',
      '--texture-compress', 'false',
      // Colour is a UV into the palette texture (2026-08-21): a simplifier
      // would interpolate those UVs and land vertices BETWEEN swatches, so
      // decimation is off for the library. Same reason textures stay PNG.
      '--simplify', 'false',
    ], { encoding: 'utf8', timeout: 120000 })
    if (run.status !== 0 || !existsSync(dest)) {
      skipped++
      continue
    }
    const next = new Uint8Array(readFileSync(dest))
    const prev = statSync(src).size
    const report = inspect(next)
    if (!report.ok || next.byteLength >= prev) {
      skipped++
      continue
    }
    writeFileSync(src, next)
    console.log(`  draco ${src.slice(src.lastIndexOf('/') - 6)}  ${prev} → ${next.byteLength}`)
    kept++
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
console.log(`draco kept ${kept}, left quantized ${skipped + (files.length - kept - skipped)}`)
