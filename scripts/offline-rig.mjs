// Offline test rig: a local wss:// relay + an https:// model server + an
// http proxy that injects the relay address into the app, so the whole
// verification suite runs WITHOUT real relays (this sandbox blocks every
// public relay/CDN; only localhost and the npm/github allowlist work).
//
//   node scripts/offline-rig.mjs
//
//   * https://localhost:8443   — fake NIP-01 relay (wss upgrade) AND the
//                               model files at /models/<name>.glb (CORS *)
//   * http://localhost:4173    — proxy to the vite dev server (5173) with a
//                               tiny same-origin rig hook injected
//
// The rig serves five GLB flavours (generated here, no assets on disk):
//   a  camera + animation, two cubes (red at origin, big green offset) —
//      the camera frames ONLY the red cube: poster must be red, not a
//      two-cube auto-fit.
//   b  static, no camera, two cubes — auto-fit poster must show both.
//   c  animated, no camera + embedded WAV — auto-fit poster, live
//      feed/tree preview, verified card badge and viewer sound control.
//   d  TWO cameras (cam0=red view, cam1=green view) + animation, event
//      carries preview-camera=1 — poster uses cam0 (red), live preview
//      must use cam1 (green).
//   e  camera, NOT animated — poster from camera; feed must STATIC-reject.
//   f  camera that frames NOTHING — poster must fall back to auto-fit
//      (blank authored camera), never to the publish placeholder.
//   x  animated text-ish wordmark (flat planes) for extra churn volume.
//
// The feed: 48 roots cycling those flavours + a reply tree on root #1
// (animated, static and camera'd replies) for thread/badge/childCount checks.
import { createServer as createHttps } from 'node:https'
import { createServer as createHttp } from 'node:http'
import { request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'
import { WebSocketServer } from 'ws'
import { finalizeEvent, generateSecretKey } from 'nostr-tools'

const __dir = dirname(fileURLToPath(import.meta.url))
const KEY = readFileSync('/tmp/rig-certs/key.pem')
const CERT = readFileSync('/tmp/rig-certs/cert.pem')
const RELAY_PORT = 8443
const PROXY_PORT = 4173
// Upstream dev/preview server (5173 = vite dev; 5174 = production preview).
// The env var is PARSED, not just printed: the proxy and the HMR upgrade
// below must follow it, or VITE_UPSTREAM=http://localhost:5174 silently
// talks to the dev server on 5173 (that mismatch invalidated a whole
// verification pass once).
const VITE = process.env.VITE_UPSTREAM || 'http://localhost:5173'
const UPSTREAM = (() => {
  try {
    const u = new URL(VITE)
    return { host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) }
  } catch { return { host: 'localhost', port: 5173 } }
})()

// ------------------------------------------------------------------ GLB

/** Minimal GLB writer: glTF JSON + one BIN chunk. */
function buildGLB(json) {
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8')
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)])
  const binPad = (4 - (json.bin.length % 4)) % 4
  const binChunk = Buffer.concat([json.bin, Buffer.alloc(binPad)])
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length
  const out = Buffer.alloc(total)
  out.write('glTF', 0)
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(total, 8)
  out.writeUInt32LE(jsonChunk.length, 12)
  out.write('JSON', 16)
  jsonChunk.copy(out, 20)
  const binOff = 20 + jsonChunk.length
  out.writeUInt32LE(binChunk.length, binOff)
  out.write('BIN\0', binOff + 4)
  binChunk.copy(out, binOff + 8)
  return out
}

/** One cube mesh's positions + normals + indices (1x1x1, centered). */
function cubeData() {
  const F = [
    [[1, 0, 0], [[0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5]]],
    [[-1, 0, 0], [[-0.5, -0.5, 0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5]]],
    [[0, 1, 0], [[-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5]]],
    [[0, -1, 0], [[-0.5, -0.5, 0.5], [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5]]],
    [[0, 0, 1], [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]]],
    [[0, 0, -1], [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]]],
  ]
  const pos = [], nor = [], idx = []
  F.forEach(([n, verts], f) => {
    const base = f * 4
    for (const v of verts) { pos.push(...v); nor.push(...n) }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  })
  return { pos: Float32Array.from(pos), nor: Float32Array.from(nor), idx: Uint16Array.from(idx) }
}

/** Unit quaternion [x,y,z,w] rotating glTF -Z into `forward`. */
function quatLookNegZ(forward) {
  const f = norm(forward)
  let right = cross(f, [0, 1, 0])
  if (len(right) < 1e-6) right = cross(f, [1, 0, 0])
  right = norm(right)
  const up = cross(right, f)
  // rotation matrix rows: right, up, back(-f)
  const m = [right[0], right[1], right[2], up[0], up[1], up[2], -f[0], -f[1], -f[2]]
  const t = m[0] + m[4] + m[8]
  let x, y, z, w
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2
    w = s / 4; x = (m[5] - m[7]) / s; y = (m[6] - m[2]) / s; z = (m[1] - m[3]) / s
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2
    w = (m[5] - m[7]) / s; x = s / 4; y = (m[1] + m[3]) / s; z = (m[6] + m[2]) / s
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2
    w = (m[6] - m[2]) / s; x = (m[1] + m[3]) / s; y = s / 4; z = (m[5] + m[7]) / s
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2
    w = (m[1] - m[3]) / s; x = (m[6] + m[2]) / s; y = (m[5] + m[7]) / s; z = s / 4
  }
  return [x, y, z, w]
}
const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((c) => c / l) }
const len = (v) => Math.hypot(...v)
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

/** Short mono PCM fixture; enough duration for play/pause checks. */
function silentWav() {
  const sampleRate = 8000
  const samples = 2000
  const out = Buffer.alloc(44 + samples * 2)
  out.write('RIFF', 0)
  out.writeUInt32LE(out.length - 8, 4)
  out.write('WAVE', 8)
  out.write('fmt ', 12)
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(sampleRate * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36)
  out.writeUInt32LE(samples * 2, 40)
  return out
}

/** Build one of the rig flavours. */
function makeModel(flavour) {
  const cube = cubeData()
  const binParts = []
  const views = []
  const accessors = []
  const addView = (buf, name) => {
    const offset = align4(binParts.reduce((s, b) => s + b.length, 0))
    binParts.push(Buffer.alloc(offset - binParts.reduce((s, b) => s + b.length, 0)), Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength))
    views.push({ buffer: 0, byteOffset: offset, byteLength: buf.byteLength })
    return views.length - 1
  }
  const posView = addView(cube.pos, 'pos')
  const norView = addView(cube.nor, 'nor')
  const idxView = addView(cube.idx, 'idx')
  accessors.push(
    { bufferView: posView, componentType: 5126, count: cube.pos.length / 3, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
    { bufferView: norView, componentType: 5126, count: cube.nor.length / 3, type: 'VEC3' },
    { bufferView: idxView, componentType: 5123, count: cube.idx.length, type: 'SCALAR' },
  )

  const nodes = []
  const meshes = []
  const materials = [
    { name: 'red', pbrMetallicRoughness: { baseColorFactor: [0.85, 0.08, 0.08, 1], metallicFactor: 0, roughnessFactor: 1 } },
    { name: 'green', pbrMetallicRoughness: { baseColorFactor: [0.08, 0.75, 0.2, 1], metallicFactor: 0, roughnessFactor: 1 } },
    { name: 'blue', pbrMetallicRoughness: { baseColorFactor: [0.1, 0.25, 0.9, 1], metallicFactor: 0, roughnessFactor: 1 } },
  ]
  const cubePrim = (mat) => ({ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: mat })
  meshes.push({ name: 'cube-red', primitives: [cubePrim(0)] })

  let anim = null
  const flat = flavour === 'x'
  if (flat) {
    // wordmark: flat quads (2D text stand-in) that must never render mirrored
    meshes.length = 0
    nodes.push({ mesh: 0, name: 'glyph' })
    const q = cubeData()
    // squash the cube into a flat plate
    for (let i = 0; i < q.pos.length; i += 3) q.pos[i + 2] *= 0.08
    const posViewF = addView(q.pos, 'pos')
    const norViewF = addView(q.nor, 'nor')
    const idxViewF = addView(q.idx, 'idx')
    accessors[0] = { bufferView: posViewF, componentType: 5126, count: q.pos.length / 3, type: 'VEC3', min: [-0.5, -0.5, -0.04], max: [0.5, 0.5, 0.04] }
    accessors[1] = { bufferView: norViewF, componentType: 5126, count: q.nor.length / 3, type: 'VEC3' }
    accessors[2] = { bufferView: idxViewF, componentType: 5123, count: q.idx.length, type: 'SCALAR' }
    meshes.push({ name: 'glyph-plate', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 2 }] })
    const inBuf = Float32Array.from([0, 1, 2])
    const outBuf = Float32Array.from([0, 0, 0, 0.6, 0, 0, 0, 0, 0])
    const inView = addView(inBuf, 'anim-in')
    const outView = addView(outBuf, 'anim-out')
    accessors.push(
      { bufferView: inView, componentType: 5126, count: 3, type: 'SCALAR', min: [0], max: [2] },
      { bufferView: outView, componentType: 5126, count: 3, type: 'VEC3' },
    )
    anim = { name: 'slide', channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }], samplers: [{ input: 3, interpolation: 'LINEAR', output: 4 }] }
  } else {
    nodes.push({ mesh: 0, name: 'red' })
    // big green cube off the red view's axis; for the camera tests (a, d) it
    // sits far enough out of the authored frustum that the camera poster
    // shows ONLY the red cube, while the auto-fit flavours (b, c, e, x) keep
    // it near enough for one-frame framing.
    const greenX = flavour === 'a' || flavour === 'd' ? 14 : 5
    nodes.push({ mesh: 1, name: 'green', translation: [greenX, 0, 0], scale: [4, 4, 4] })
    meshes.push({ name: 'cube-green', primitives: [cubePrim(1)] })
    const inBuf = Float32Array.from([0, 1])
    const outBuf = Float32Array.from([0, 0, 0, 0, 1.5, 0])
    const inView = addView(inBuf, 'anim-in')
    const outView = addView(outBuf, 'anim-out')
    accessors.push(
      { bufferView: inView, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: outView, componentType: 5126, count: 2, type: 'VEC3' },
    )
    if (flavour !== 'b' && flavour !== 'e') {
      anim = { name: 'bob', channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }], samplers: [{ input: 3, interpolation: 'LINEAR', output: 4 }] }
    }
  }

  const cameras = []
  const camRed = { name: 'cam-red', type: 'perspective', perspective: { yfov: 0.7, znear: 0.01, zfar: 100 } }
  const camGreen = { name: 'cam-green', type: 'perspective', perspective: { yfov: 0.7, znear: 0.01, zfar: 100 } }
  if (['a', 'd', 'e'].includes(flavour)) {
    cameras.push(camRed)
    const q0 = quatLookNegZ(sub([0, 0, 0], [-1.5, 0.5, 2.5]))
    nodes.push({ camera: 0, name: 'cam0', translation: [-1.5, 0.5, 2.5], rotation: q0 })
  }
  if (flavour === 'f') {
    // f = a camera that frames NOTHING: parked far away, tiny fov, looking
    // away from the model. The poster must fall back to auto-fit instead of
    // going blank -> publish placeholder.
    cameras.push({ name: 'cam-void', type: 'perspective', perspective: { yfov: 0.05, znear: 0.01, zfar: 100 } })
    const away = norm([1, 1, 1])
    const qf = quatLookNegZ(away)
    nodes.push({ camera: 0, name: 'cam0', translation: [40, 40, 40], rotation: qf })
  }
  if (flavour === 'd') {
    cameras.push(camGreen)
    const gx = 14
    const q1 = quatLookNegZ(sub([gx, 0, 0], [gx - 1.5, 0.6, 2.5]))
    nodes.push({ camera: 1, name: 'cam1', translation: [gx - 1.5, 0.6, 2.5], rotation: q1 })
  }

  let audioExtension
  if (flavour === 'c') {
    const audioView = addView(silentWav(), 'audio')
    audioExtension = {
      clips: [{ name: 'rig-silence', bufferView: audioView, mimeType: 'audio/wav' }],
      emitters: [{ name: 'rig-emitter', clips: [{ clip: 0, weight: 1 }], volume: 0.72, loop: true }],
    }
  }

  const json = {
    asset: { version: '2.0', generator: 'offline-rig' },
    scene: 0,
    scenes: [{
      nodes: nodes.map((_, i) => i),
      extensions: audioExtension ? { MSFT_audio_emitter: { emitters: [0] } } : undefined,
    }],
    nodes, meshes, materials, accessors,
    bufferViews: views,
    buffers: [{ byteLength: align4(binParts.reduce((s, b) => s + b.length, 0)) }],
    cameras: cameras.length ? cameras : undefined,
    animations: anim ? [anim] : undefined,
    extensionsUsed: audioExtension ? ['MSFT_audio_emitter'] : undefined,
    extensions: audioExtension ? { MSFT_audio_emitter: audioExtension } : undefined,
  }
  const bin = Buffer.concat(binParts)
  json.bin = bin
  return buildGLB(json)
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const align4 = (n) => (n + 3) & ~3

// ------------------------------------------------------------------ feed

const FLAVOURS = ['a', 'a', 'a', 'a', 'c', 'c', 'b', 'b', 'd', 'd', 'e', 'x', 'f']
const N_ROOTS = 48
const models = new Map() // name -> { bytes, sha }
const events = [] // wire events
const sk = generateSecretKey()

function modelFor(flavour) {
  let name = `m-${flavour}`
  if (!models.has(name)) {
    const bytes = makeModel(flavour)
    const sha = createHash('sha256').update(bytes).digest('hex')
    models.set(name, { bytes, sha })
  }
  return models.get(name)
}

// Captured ONCE at boot: makeEvent must derive created_at from a FIXED base,
// not per-call Date.now(). GLB generation is slow enough that the wall clock
// can advance by exactly the ageSec delta between two same-flavour roots —
// identical created_at + identical tags = identical event id, and the app
// dedupes by id, silently shrinking the 52-event feed (verify suites stall
// on their `>= 52` gates). A frozen base makes ageSec strictly monotonic.
const BOOT_NOW = Math.floor(Date.now() / 1000)

function makeEvent(kind, tags, ageSec = 0) {
  // every event gets its own created_at: identical tag sets must still
  // produce distinct ids (the app dedupes by id)
  const t = { kind, created_at: BOOT_NOW - 60 - ageSec, tags, content: '' }
  return finalizeEvent(t, sk)
}

// 48 roots cycling the flavours
for (let i = 0; i < N_ROOTS; i++) {
  const flavour = FLAVOURS[i % FLAVOURS.length]
  const { bytes, sha } = modelFor(flavour)
  const tags = [
    ['t', 'form-zero'], ['t', 'root'],
    ['m', 'model/gltf-binary'],
    ['x', sha], ['ox', sha], ['size', String(bytes.length)],
    ['url', `https://localhost:${RELAY_PORT}/models/${flavour}.glb`],
    ['dim', '448x280'],
    ['v', 'form-zero:4'],
    ['filename', `${flavour}.glb`],
  ]
  if (['a', 'e'].includes(flavour)) tags.push(['cameras', '1'])
  if (flavour === 'd') tags.push(['cameras', '2'], ['preview-camera', '1'])
  if (['a', 'c', 'd', 'x'].includes(flavour)) tags.push(['anim', '1'])
  if (flavour === 'c') tags.push(['audio', '1'])
  if (flavour === 'f') tags.push(['cameras', '1'])
  events.push(makeEvent(1063, tags, i))
}

// reply tree on root #1: animated, static, camera'd, and a nested reply
const root1 = events[1]
const replies = []
for (const [i, flavour] of ['c', 'b', 'a', 'x'].entries()) {
  const { bytes, sha } = modelFor(flavour)
  const tags = [
    ['t', 'form-zero'],
    ['m', 'model/gltf-binary'],
    ['x', sha], ['ox', sha], ['size', String(bytes.length)],
    ['url', `https://localhost:${RELAY_PORT}/models/${flavour}.glb`],
    ['dim', '448x280'],
    ['v', 'form-zero:4'],
    ['filename', `${flavour}.glb`],
    ['e', root1.id, '', 'root'],
    ['e', i === 0 ? root1.id : replies[0].id, '', 'reply'],
  ]
  if (['a', 'c', 'x'].includes(flavour)) tags.push(['anim', '1'])
  if (flavour === 'c') tags.push(['audio', '1'])
  if (flavour === 'a') tags.push(['cameras', '1'])
  const ev = makeEvent(1063, tags)
  events.push(ev)
  replies.push(ev)
}

// ------------------------------------------------------------------ relay

function matchFilter(ev, f) {
  if (f.ids && !f.ids.includes(ev.id)) return false
  if (f.authors && !f.authors.includes(ev.pubkey)) return false
  if (f.kinds && !f.kinds.includes(ev.kind)) return false
  if (f.since && ev.created_at < f.since) return false
  if (f.until && ev.created_at > f.until) return false
  if (f['#t'] && !ev.tags.some((t) => t[0] === 't' && f['#t'].includes(t[1]))) return false
  if (f['#m'] && !ev.tags.some((t) => t[0] === 'm' && f['#m'].includes(t[1]))) return false
  if (f['#e'] && !ev.tags.some((t) => t[0] === 'e' && f['#e'].includes(t[1]))) return false
  return true
}

const RIG_HOOK = `(() => {
  const relay = 'wss://localhost:${RELAY_PORT}';
  const t = setInterval(() => {
    const f = window.__form0;
    if (!f) return;
    clearInterval(t);
    try { f.pool.applyRelays([relay]); } catch (e) { console.error('[rig]', e); }
  }, 120);
})();`

// Blossom-style upload store: sha256 -> bytes (PUT /upload, GET /<sha>)
const uploads = new Map()

// The seed feed, captured once: POST /__reset restores it so the verify
// suites can run repeatedly without earlier publishes polluting the feed.
const SEED_EVENTS = [...events]

// Seed sanity: the feed must be 52 DISTINCT ids (the app dedupes by id, so a
// collision silently shrinks the feed and stalls every `>= 52` gate).
{
  const seen = new Map()
  for (const ev of events) {
    if (seen.has(ev.id)) console.error('[rig] SEED DUPLICATE id', ev.id.slice(0, 8), 'created_at', ev.created_at, 'tags', JSON.stringify(ev.tags.filter(t => ['t','x','e'].includes(t[0]))))
    seen.set(ev.id, true)
  }
}

const httpsServer = createHttps({ key: KEY, cert: CERT }, (req, res) => {
  req.on('error', () => {})
  res.on('error', () => {})
  const url = new URL(req.url, `https://localhost:${RELAY_PORT}`)
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type',
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return
  }
  if (req.method === 'POST' && url.pathname === '/__reset') {
    events.length = 0
    events.push(...SEED_EVENTS)
    res.writeHead(200, { 'content-type': 'application/json', ...cors })
    res.end(JSON.stringify({ events: events.length }))
    return
  }
  if (req.method === 'PUT' && url.pathname === '/upload') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const sha = createHash('sha256').update(body).digest('hex')
      // BUD-01 requires a kind-24242 authorization; the rig only checks it
      // is present and parses (the app's real signature check is off-rig).
      const auth = String(req.headers.authorization ?? '')
      if (!auth.startsWith('Nostr ')) { res.writeHead(401, cors).end('missing Nostr authorization'); return }
      try {
        const ev = JSON.parse(Buffer.from(auth.slice(6), 'base64').toString('utf8'))
        if (ev.kind !== 24242 || !Array.isArray(ev.tags)) { res.writeHead(401, cors).end('bad auth event'); return }
        if (!ev.tags.some((t) => t[0] === 't' && t[1] === 'upload')) { res.writeHead(401, cors).end('bad auth method'); return }
      } catch { res.writeHead(401, cors).end('bad auth encoding'); return }
      uploads.set(sha, body)
      res.writeHead(200, { 'content-type': 'application/json', ...cors })
      res.end(JSON.stringify({ url: `https://localhost:${RELAY_PORT}/${sha}`, sha256: sha }))
    })
    return
  }
  if (req.method === 'GET' && /^\/[0-9a-f]{64}$/.test(url.pathname)) {
    const bytes = uploads.get(url.pathname.slice(1))
    if (!bytes) { res.writeHead(404, cors).end(); return }
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50
    res.writeHead(200, {
      'content-type': isPng ? 'image/png' : 'model/gltf-binary',
      'content-length': bytes.length,
      'access-control-allow-origin': '*',
    })
    res.end(bytes)
    return
  }
  if (url.pathname.startsWith('/models/')) {
    const name = url.pathname.slice('/models/'.length).replace(/\.glb$/, '')
    const m = modelFor(name)
    if (!m) { res.writeHead(404).end(); return }
    res.writeHead(200, {
      'content-type': 'model/gltf-binary',
      'content-length': m.bytes.length,
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, HEAD',
    })
    res.end(Buffer.from(m.bytes))
    return
  }
  res.writeHead(404).end()
})

const wss = new WebSocketServer({ server: httpsServer })
const subs = new Map() // subId -> { ws, filters }
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (!Array.isArray(msg) || typeof msg[0] !== 'string') return
    if (msg[0] === 'REQ') {
      const sub = msg[1]
      const filters = msg.slice(2).filter((f) => f && typeof f === 'object')
      subs.set(sub, { ws, filters })
      const sent = new Set()
      for (const f of filters) {
        const list = events.filter((ev) => matchFilter(ev, f)).slice(0, f.limit ?? 500)
        for (const ev of list) {
          if (sent.has(ev.id)) continue
          sent.add(ev.id)
          ws.send(JSON.stringify(['EVENT', sub, ev]))
        }
      }
      ws.send(JSON.stringify(['EOSE', sub]))
    } else if (msg[0] === 'EVENT') {
      const ev = msg[1]
      if (!ev || typeof ev.id !== 'string' || typeof ev.kind !== 'number') return
      // NIP-20 acknowledgement — nostr-tools' publish() waits for it
      ws.send(JSON.stringify(['OK', ev.id, true, '']))
      if (!events.some((e) => e.id === ev.id)) {
        events.push(ev)
        // live push to every matching subscription INCLUDING the publisher's
        // own (NIP-01 relays deliver to all subscribers; the app dedupes by
        // id) — otherwise the app would never see its own published posts.
        for (const [sub, { ws: other, filters }] of subs) {
          if (filters.some((f) => matchFilter(ev, f))) other.send(JSON.stringify(['EVENT', sub, ev]))
        }
      }
    } else if (msg[0] === 'CLOSE') {
      subs.delete(msg[1])
    }
  })
  ws.on('close', () => {
    for (const [sub, subInfo] of subs) if (subInfo.ws === ws) subs.delete(sub)
  })
})

httpsServer.listen(RELAY_PORT, () => {
  console.log(`[rig] relay+models on https://localhost:${RELAY_PORT}  (${events.length} events, ${models.size} models)`)
})

// ------------------------------------------------------------------ proxy
const proxy = createHttp((req, res) => {
  // the browser aborts requests all the time (navigations, viewport
  // changes) — without error handlers those aborts crash the whole rig
  req.on('error', () => {})
  res.on('error', () => {})
  if (req.url === '/__rig.js') {
    res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' })
    res.end(RIG_HOOK)
    return
  }
  const upstream = httpRequest({ host: UPSTREAM.host, port: UPSTREAM.port, path: req.url, method: req.method, headers: req.headers }, (up) => {
    const ct = String(up.headers['content-type'] || '')
    if (ct.includes('text/html')) {
      const chunks = []
      up.on('data', (c) => chunks.push(c))
      up.on('end', () => {
        // vite preview gzips the HTML; the dev server does not. Decompress
        // before injecting — stringifying gzip bytes produced
        // ERR_CONTENT_DECODING_FAILED in the browser (prod-verify was dead).
        const headers = { ...up.headers }
        let bytes = Buffer.concat(chunks)
        const enc = String(headers['content-encoding'] || '').toLowerCase()
        if (enc === 'gzip') bytes = zlib.gunzipSync(bytes)
        else if (enc === 'deflate') bytes = zlib.inflateSync(bytes)
        else if (enc === 'br') bytes = zlib.brotliDecompressSync(bytes)
        if (enc) delete headers['content-encoding']
        let body = bytes.toString('utf8')
        // Injection must obey the page's OWN CSP: the web build allows only
        // 'self' scripts (use the external /__rig.js), the standalone build
        // allows only inline scripts (inline the hook itself). Injecting the
        // wrong kind makes the browser silently refuse to fetch it and the
        // relay is never configured.
        const csp = /<meta[^>]*Content-Security-Policy[^>]*content="([^"]*)"/.exec(body)?.[1] ?? ''
        if (/script-src[^;]*'unsafe-inline'/.test(csp)) {
          body = body.replace('</head>', `<script>${RIG_HOOK}</script></head>`)
        } else {
          body = body.replace('</head>', '<script src="/__rig.js"></script></head>')
        }
        res.writeHead(up.statusCode, { ...headers, 'content-length': Buffer.byteLength(body) })
        res.end(body)
      })
    } else {
      res.writeHead(up.statusCode, up.headers)
      up.pipe(res)
    }
  })
  upstream.on('error', () => { try { res.writeHead(502); res.end() } catch { /* client gone */ } })
  req.pipe(upstream)
})
proxy.on('upgrade', (req, socket, head) => {
  // vite HMR websocket — forward so the dev client stays quiet
  socket.on('error', () => {})
  const up = httpRequest({ host: UPSTREAM.host, port: UPSTREAM.port, path: req.url, headers: req.headers })
  up.on('upgrade', (res, upSocket, upHead) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n')
    if (upHead.length) socket.write(upHead)
    socket.pipe(upSocket).pipe(socket)
  })
  up.on('error', () => socket.destroy())
  up.end()
})
proxy.listen(PROXY_PORT, () => {
  console.log(`[rig] proxy on http://localhost:${PROXY_PORT} -> ${UPSTREAM.host}:${UPSTREAM.port}  (rig hook: /__rig.js)`)
})
