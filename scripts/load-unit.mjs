// Model load verification units (AMENDMENT 71) — no browser needed:
//   bun scripts/load-unit.mjs
// Covers the Blossom download/verify path against an in-process HTTP stub
// (exact bytes, truncation, gzip-without-Content-Encoding rescue, replica
// fallback, oversize, per-replica diagnostics) and the publish-time cache
// seeding that lets the author's own post load with NO network at all.
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { BlossomClient } from '../src/protocol/blossom.ts'
import { sha256Hex, isHashMismatch, isOversize } from '../src/protocol/hash.ts'
import { AssetCache } from '../src/core/assets.ts'

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

/** Minimal valid GLB (one triangle), same builder as studio-unit. */
function makeGlb() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const indices = new Uint16Array([0, 1, 2])
  const bin = new Uint8Array(44)
  bin.set(new Uint8Array(positions.buffer), 0)
  bin.set(new Uint8Array(indices.buffer), 36)
  const json = JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'tri' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    buffers: [{ byteLength: 44 }],
  })
  const enc = new TextEncoder()
  const jsonBytes = enc.encode(json)
  const padded = jsonBytes.length + (4 - (jsonBytes.length % 4)) % 4
  const total = 12 + 8 + padded + 8 + bin.length
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true) // 'glTF'
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  dv.setUint32(12, padded, true)
  dv.setUint32(16, 0x4e4f534a, true) // 'JSON'
  out.set(jsonBytes, 20)
  const binStart = 20 + padded
  dv.setUint32(binStart, bin.length, true)
  dv.setUint32(binStart + 4, 0x004e4942, true) // 'BIN'
  out.set(bin, binStart + 8)
  return out
}

const glb = makeGlb()
const sha = await sha256Hex(glb)
const gzipped = gzipSync(glb)

let hits = 0
const server = createServer((req, res) => {
  hits++
  if (req.url === '/exact') { res.writeHead(200, { 'content-length': String(glb.length) }); res.end(glb); return }
  if (req.url === '/trunc') { res.writeHead(200, { 'content-length': String(glb.length - 8) }); res.end(glb.subarray(0, glb.length - 8)); return }
  if (req.url === '/gz') {
    // pre-compressed storage served WITHOUT Content-Encoding: the client
    // receives gzip bytes for a model that exists intact on the server.
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(gzipped.length) })
    res.end(gzipped)
    return
  }
  if (req.url === '/big') {
    const big = new Uint8Array(21 * 1024 * 1024)
    res.writeHead(200, { 'content-length': String(big.length) })
    res.end(big)
    return
  }
  res.writeHead(404); res.end('nope')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const blossoms = new BlossomClient()
try {
  // ------------------------------------------------------------ download
  const ok = await blossoms.download([`${base}/exact`], sha, glb.length)
  check('exact replica verifies', (await sha256Hex(new Uint8Array(await ok.arrayBuffer()))) === sha)

  const bad = await blossoms.download([`${base}/trunc`], sha, glb.length).then(() => null, (e) => e)
  check('truncated replica -> hash mismatch with diagnostics', isHashMismatch(bad) && /hash mismatch/.test(bad.message) && /got sha256/.test(bad.message), bad?.message)

  const gz = await blossoms.download([`${base}/gz`], sha, glb.length)
  check('gzip body without Content-Encoding is rescued and verifies', (await sha256Hex(new Uint8Array(await gz.arrayBuffer()))) === sha)

  const fallback = await blossoms.download([`${base}/404`, `${base}/exact`], sha, glb.length)
  check('dead first replica falls through to the next', (await sha256Hex(new Uint8Array(await fallback.arrayBuffer()))) === sha)

  const bigErr = await blossoms.download([`${base}/big`], sha, glb.length).then(() => null, (e) => e)
  check('oversize replica -> OversizeError, not corruption', isOversize(bigErr), bigErr?.message)

  const gone = await blossoms.download([`${base}/404`], sha, glb.length).then(() => null, (e) => e)
  check('all replicas dead -> error carries the HTTP status', gone instanceof Error && /HTTP 404/.test(gone.message), gone?.message)

  // ------------------------------------------- publish-time cache seeding
  const engine = new NullEngine()
  const scene = new Scene(engine)
  const assets = new AssetCache(blossoms, scene)
  const meta = {
    eventId: 'ab'.repeat(32), pubkey: 'cd'.repeat(32), createdAt: 1700000000,
    tint: '#1b1a1a', sha256: sha, size: glb.length, native: true,
    mime: 'model/gltf-binary', urls: [`${base}/404`],
    width: 448, height: 280, role: 'root', refs: {},
    animHint: false, cameraCount: 0, hasAudio: false,
    filename: 'bush.glb', name: 'bush',
  }
  check('seed accepts bytes that hash to the claim', await assets.seedModelBytes(sha, glb))
  const wrong = await assets.seedModelBytes(sha, new Uint8Array([1, 2, 3]))
  check('seed rejects bytes that do not hash to the claim', wrong === false)
  const before = hits
  const bytes = await assets.getModelBytes(meta)
  check('seeded own post loads with ZERO network requests (bad replicas cannot break it)', !!bytes && hits === before && (await sha256Hex(bytes)) === sha, `${hits - before} requests`)

  // a post whose replicas are all dead still reports per-replica detail
  // (distinct sha256 so the seeded cache cannot answer it)
  const other = { ...meta, eventId: '11'.repeat(32), sha256: 'ff'.repeat(32), urls: [`${base}/404`] }
  await assets.getModelBytes(other)
  check('failed load stores per-replica detail for the E101 sheet', /HTTP 404/.test(assets.failureDetail(other.eventId)), assets.failureDetail(other.eventId))

  // AMENDMENT 72: the mark a failed fetch leaves must be RETRYABLE. This is
  // the reported bug shape: one bad first fetch of a fresh post used to make
  // E101 permanent for the session. Simulate the mark (as failHash would
  // leave it), then the retry path: clear the marks and read again — the
  // seeded verified cache serves with no network.
  const marked = { ...meta, eventId: '33'.repeat(32) }
  assets.hashFailed.add(marked.eventId)
  check('marked post refuses to load while the flag stands', (await assets.getModelBytes(marked)) === undefined)
  assets.unfail(marked.eventId)
  const recovered = await assets.getModelBytes(marked)
  check('retry clears the mark and the verified cache serves again (no E101 forever)', !!recovered && (await sha256Hex(recovered)) === sha)

  // "caches cleared" scenario: the seed survives in the RAM map keyed by sha
  const again = await assets.getModelBytes(meta)
  check('seeded bytes stay readable (hash re-checked on every read)', !!again && (await sha256Hex(again)) === sha)
} finally {
  server.close()
}

console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL LOAD UNIT CHECKS PASSED')
process.exit(fails.length ? 1 : 0)
