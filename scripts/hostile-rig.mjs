// HOSTILE test rig — a malicious local "remote" for the security audit.
//
// Same shape as scripts/offline-rig.mjs (wss relay + https model/Blossom
// server + proxy that injects the relay address), but everything it serves
// is an ATTACK: every payload here is signed/consistent (attacker controls
// the GLB AND the `x` hash, so hash verification cannot save us) and aims at
// crash / freeze / RCE / exhaustion.
//
//   node scripts/hostile-rig.mjs
//
//   * https://localhost:9443  — malicious relay (wss) + model server + Blossom
//   * http://localhost:9173   — proxy to vite with the hostile relay injected
//
// Control plane (from the audit harness):
//   POST http://localhost:9173/__attack?name=<id>   (proxied to :9443)
//   GET  http://localhost:9173/__attacks            (list + status)
//
// Attack catalog (each one fired individually, impact measured in the
// browser by scripts/hostile-audit.mjs):
//
//  RCE/XSS probes
//    xss-name        name (event content) with <img onerror> / script payloads
//    xss-filename    filename tag with HTML/JS payloads
//    xss-mixed       name+filename+color all hostile, drawer + board + search
//
//  Main-thread freeze (DoS)
//    huge-msg        one 12 MiB WS message (60k tags, valid signature)
//    deep-json       EVENT with 30k-deep nested field (JSON.parse recursion)
//    flood           3000 valid distinct root events in one burst
//    reply-storm     5000 replies on one root (thread view + index growth)
//    reconnect-flood relay drops the socket every 300 ms for 15 s
//
//  Crash / unhandled exception
//    malformed-burst garbage events (bad id/pubkey/tags/content types)
//    bin-frame       a BINARY websocket frame (nostr-tools onmessage)
//    glb-oob         bufferView OOB on indices (POSITION path is guarded)
//    glb-nan         node transforms of 1e308 (matrix -> Inf/NaN)
//    glb-chain       2000-node chain (depth 2000 > 128, also O(n^2) walk)
//    glb-draco       DRACO primitive with a corrupted compressed buffer
//    glb-audio-trunc WAV header claiming 4 GB data, buffer truncated
//
//  Resource exhaustion / OOM
//    glb-bomb        gzip bomb: 2 KB gzip -> ~1.5 GB inflate (hash of
//                    inflated bytes, so the rescue path takes the bite)
//    many-urls       valid model + 400 slow replica `url` tags (queue pin)
//    glb-texforge    two 1x1 PNGs with forged 4096x4096 headers
//    glb-tex19       19 real 2048x2048 textures (decoded-pixel budget)
//    glb-animmax     5000 channels x 200 keys (at the keyframe cap)
//    glb-audio-big   15 MB silent WAV on a looping emitter
//
//  Blossom server abuse (upload responses)
//    blossom-eviljson  20 MiB JSON upload response
//    blossom-evilurl   upload response URL with a 2 MiB query string
import { createServer as createHttps } from 'node:https'
import { createServer as createHttp } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'
import { WebSocketServer, WebSocket } from 'ws'
import { finalizeEvent, generateSecretKey } from 'nostr-tools'

const KEY = readFileSync('/tmp/rig-certs/key.pem')
const CERT = readFileSync('/tmp/rig-certs/cert.pem')
const RELAY_PORT = 9443
const PROXY_PORT = 9173
const VITE = process.env.VITE_UPSTREAM || 'http://localhost:5173'
const UPSTREAM = (() => {
  const u = new URL(VITE)
  return { host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) }
})()

const sha256 = (b) => createHash('sha256').update(b).digest('hex')

// ------------------------------------------------------------------ GLB
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

function cubeData() {
  const F = [
    [[1, 0, 0], [[0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5]]],
    [[-1, 0, 0], [[-0.5, -0.5, 0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5]]],
    [[0, 1, 0], [[-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5]]],
    [[0, -1, 0], [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, 0.5]]],
    [[0, 0, 1], [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]]],
    [[0, 0, -1], [[0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5], [0.5, -0.5, 0.5]]],
  ]
  const pos = [], nor = [], idx = []
  F.forEach(([n, verts], f) => {
    const base = f * 4
    for (const v of verts) { pos.push(...v); nor.push(...n) }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3)
  })
  return { pos: Float32Array.from(pos), nor: Float32Array.from(nor), idx: Uint16Array.from(idx) }
}

const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((c) => c / l) }
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
function quatLookNegZ(forward) {
  const f = norm(forward)
  let right = cross(f, [0, 1, 0])
  if (Math.hypot(...right) < 1e-6) right = cross(f, [1, 0, 0])
  right = norm(right)
  const up = cross(right, f)
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
    w = (m[6] - m[2]) / s; x = s / 4; y = (m[1] - m[3]) / s; z = (m[5] - m[7]) / s
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2
    w = (m[1] - m[3]) / s; x = (m[6] + m[2]) / s; y = (m[5] - m[7]) / s; z = (m[2] + m[4]) / s
  }
  return [x, y, z, w]
}

/** Minimal solid-color PNG (valid deflate stream, real IHDR). */
function makePng(width, height, rgb = [200, 40, 40]) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    out.write(type, 4)
    data.copy(out, 8)
    const crcTable = makePng.crcTable ?? (makePng.crcTable = (() => {
      const t = new Int32Array(256)
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c }
      return t
    })())
    let c = 0xffffffff
    for (let i = 8; i < out.length; i++) c = crcTable[(c ^ out[i]) & 0xff] ^ (c >>> 8)
    out.writeUInt32BE((c ^ 0xffffffff) >>> 0, out.length - 4)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type RGB
  // raw scanlines: filter byte 0 + RGB per pixel
  const rowLen = 1 + width * 3
  const raw = Buffer.alloc(rowLen * height)
  const px = Buffer.from([rgb[0], rgb[1], rgb[2]])
  for (let y = 0; y < height; y++) px.copy(raw, y * rowLen + 1, 0, 3)
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

/** PNG whose IHDR CLAIMS width x height but whose pixel data is 1x1. */
function makeForgedPng(claimW, claimH) {
  const real = makePng(1, 1)
  const out = Buffer.from(real)
  out.writeUInt32BE(claimW, 16)
  out.writeUInt32BE(claimH, 20)
  return out
}

/** PCM WAV: silence by default (the size IS the attack). */
function makeWav(bytes, rate = 8000) {
  const n = Math.max(0, Math.floor(bytes / 2))
  const data = Buffer.alloc(44 + n * 2)
  data.write('RIFF', 0)
  data.writeUInt32LE(36 + n * 2, 4)
  data.write('WAVE', 8)
  data.write('fmt ', 12)
  data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20)
  data.writeUInt16LE(1, 22)
  data.writeUInt32LE(rate, 24)
  data.writeUInt32LE(rate * 2, 28)
  data.writeUInt16LE(2, 32)
  data.writeUInt16LE(16, 34)
  data.write('data', 36)
  data.writeUInt32LE(n * 2, 40)
  return data
}

/** WAV header claims 4 GB of data; the buffer is ~1 KiB. */
function makeTruncWav() {
  const data = makeWav(1024)
  data.writeUInt32LE(0x10000000, 4)  // RIFF size
  data.writeUInt32LE(0x10000000, 40) // data chunk size
  return data
}

const align4 = (n) => (n + 3) & ~3

/** Baseline good model: red cube with a camera + 1 s animation. */
function makeModel(name) {
  const cube = cubeData()
  const binParts = []
  const views = []
  const accessors = []
  const addView = (buf) => {
    const offset = align4(binParts.reduce((s, b) => s + b.length, 0))
    binParts.push(Buffer.alloc(offset - binParts.reduce((s, b) => s + b.length, 0)), Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength))
    views.push({ buffer: 0, byteOffset: offset, byteLength: buf.byteLength })
    return views.length - 1
  }
  const posView = addView(cube.pos)
  const norView = addView(cube.nor)
  const idxView = addView(cube.idx)
  accessors.push(
    { bufferView: posView, componentType: 5126, count: cube.pos.length / 3, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
    { bufferView: norView, componentType: 5126, count: cube.nor.length / 3, type: 'VEC3' },
    { bufferView: idxView, componentType: 5123, count: cube.idx.length, type: 'SCALAR' },
  )
  const nodes = [{ mesh: 0, name: 'red' }]
  const meshes = [{ name: 'cube', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }]
  const materials = [{ name: 'red', pbrMetallicRoughness: { baseColorFactor: [0.85, 0.08, 0.08, 1], metallicFactor: 0, roughnessFactor: 1 } }]
  let anim
  if (name !== 'static') {
    const inBuf = Float32Array.from([0, 1])
    const outBuf = Float32Array.from([0, 0, 0, 0, 1.5, 0])
    const inView = addView(inBuf)
    const outView = addView(outBuf)
    accessors.push(
      { bufferView: inView, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: outView, componentType: 5126, count: 2, type: 'VEC3' },
    )
    anim = { name: 'bob', channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }], samplers: [{ input: 3, interpolation: 'LINEAR', output: 4 }] }
  }
  const json = {
    asset: { version: '2.0', generator: 'hostile-rig' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes, meshes, materials, accessors, bufferViews: views,
    buffers: [{ byteLength: align4(binParts.reduce((s, b) => s + b.length, 0)) }],
    animations: anim ? [anim] : undefined,
  }
  json.bin = Buffer.concat(binParts)
  return buildGLB(json)
}

/** OOB: the INDICES bufferView extends past the BIN chunk end. POSITION is
 *  fully valid (passes the guarded scanner), indices are not. */
function makeOobModel() {
  const base = makeModel('static')
  // Rebuild JSON with an indices bufferView whose byteLength overflows the
  // BIN by 64 bytes: Babylon's Uint16Array view will read OOB or throw.
  const jsonStart = 20
  const jsonLen = base.readUInt32LE(12)
  const gltf = JSON.parse(base.slice(jsonStart, jsonStart + jsonLen).toString('utf8').replace(/\0/g, ''))
  const binLen = gltf.buffers[0].byteLength
  gltf.bufferViews[2].byteLength = gltf.bufferViews[2].byteLength + 64 // overflow
  gltf.buffers[0].byteLength = binLen // keep claimed bin size honest
  const jsonBuf = Buffer.from(JSON.stringify(gltf) + '   ')
  const bin = base.slice(20 + jsonLen + 8) // unchanged BIN bytes
  const total = 20 + jsonBuf.length + 8 + bin.length
  const out = Buffer.alloc(total)
  out.write('glTF', 0)
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(total, 8)
  out.writeUInt32LE(jsonBuf.length, 12)
  out.write('JSON', 16)
  jsonBuf.copy(out, 20)
  out.writeUInt32LE(bin.length, 20 + jsonBuf.length)
  out.write('BIN\0', 20 + jsonBuf.length + 4)
  bin.copy(out, 20 + jsonBuf.length + 8)
  return out
}

/** Node transforms of 1e308: world matrix -> Infinity/NaN downstream. */
function makeNanModel() {
  const base = makeModel('static')
  const jsonStart = 20
  const jsonLen = base.readUInt32LE(12)
  const gltf = JSON.parse(base.slice(jsonStart, jsonStart + jsonLen).toString('utf8'))
  gltf.nodes[0].translation = [1e308, 1e308, 1e308]
  gltf.nodes[0].scale = [1e308, 1e308, 1e308]
  gltf.nodes[0].rotation = [0, 0, 0, 0] // zero quaternion
  const jsonBuf = Buffer.from(JSON.stringify(gltf) + '   ')
  const bin = base.slice(20 + jsonLen + 8)
  const total = 20 + jsonBuf.length + 8 + bin.length
  const out = Buffer.alloc(total)
  out.write('glTF', 0)
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(total, 8)
  out.writeUInt32LE(jsonBuf.length, 12)
  out.write('JSON', 16)
  jsonBuf.copy(out, 20)
  out.writeUInt32LE(bin.length, 20 + jsonBuf.length)
  out.write('BIN\0', 20 + jsonBuf.length + 4)
  bin.copy(out, 20 + jsonBuf.length + 8)
  return out
}

/** 2000-node chain: depth 2000 (cap 128) and O(n^2) ancestor-set walk. */
function makeChainModel() {
  const base = makeModel('static')
  const jsonStart = 20
  const jsonLen = base.readUInt32LE(12)
  const gltf = JSON.parse(base.slice(jsonStart, jsonStart + jsonLen).toString('utf8'))
  const nodes = gltf.nodes
  for (let i = 0; i < 1999; i++) {
    nodes.push({ name: 'n' + (i + 1) })
    nodes[i].children = [i + 1]
  }
  gltf.scenes[0].nodes = nodes.map((_, i) => i)
  const jsonBuf = Buffer.from(JSON.stringify(gltf) + '   ')
  const bin = base.slice(20 + jsonLen + 8)
  const total = 20 + jsonBuf.length + 8 + bin.length
  const out = Buffer.alloc(total)
  out.write('glTF', 0)
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(total, 8)
  out.writeUInt32LE(jsonBuf.length, 12)
  out.write('JSON', 16)
  jsonBuf.copy(out, 20)
  out.writeUInt32LE(bin.length, 20 + jsonBuf.length)
  out.write('BIN\0', 20 + jsonBuf.length + 4)
  bin.copy(out, 20 + jsonBuf.length + 8)
  return out
}

function patchJson(base, fn) {
  const jsonStart = 20
  const jsonLen = base.readUInt32LE(12)
  const gltf = JSON.parse(base.slice(jsonStart, jsonStart + jsonLen).toString('utf8'))
  // appendExtra(buf) -> byte offset in the FINAL bin where buf now lives
  const extra = []
  const appendExtra = (buf) => {
    const off = gbinLen + extra.reduce((a, b) => a + b.length, 0)
    extra.push(buf)
    return off
  }
  const gbinLen = gltf.buffers[0].byteLength
  fn(gltf, appendExtra)
  const jsonBuf = Buffer.from(JSON.stringify(gltf) + '   ')
  const bin = Buffer.concat([base.slice(20 + jsonLen + 8), ...extra])
  const total = 20 + jsonBuf.length + 8 + bin.length
  const out = Buffer.alloc(total)
  out.write('glTF', 0)
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(total, 8)
  out.writeUInt32LE(jsonBuf.length, 12)
  out.write('JSON', 16)
  jsonBuf.copy(out, 20)
  out.writeUInt32LE(bin.length, 20 + jsonBuf.length)
  out.write('BIN\0', 20 + jsonBuf.length + 4)
  bin.copy(out, 20 + jsonBuf.length + 8)
  return out
}

/** Two 1x1 PNGs whose IHDR claims 4096x4096: header-only VRAM claim. */
function makeTexForgeModel() {
  const base = makeModel('static')
  return patchJson(base, (g, add) => {
    g.images = []; g.textures = []
    const forged = makeForgedPng(4096, 4096)
    const srcs = []
    for (let i = 0; i < 2; i++) {
      const off = add(forged)
      g.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: forged.length })
      g.images.push({ bufferView: g.bufferViews.length - 1, mimeType: 'image/png' })
      g.textures.push({ source: i })
      g.materials.push({ pbrMetallicRoughness: { baseColorTexture: { index: i } } })
      void srcs
    }
    g.buffers[0].byteLength = g.bufferViews[g.bufferViews.length - 1].byteOffset + forged.length
    g.meshes = [{ name: 'tex', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }]
    g.nodes = [{ mesh: 0, name: 'tex' }]
    g.scenes[0].nodes = [0]
  })
}

/** 19 REAL 2048x2048 textures: 19 * 4Mpx * 4 = 304 MiB decoded (cap 128). */
function makeTex19Model() {
  const base = makeModel('static')
  const png = makePng(2048, 2048, [40, 200, 40])
  return patchJson(base, (g, add) => {
    g.images = []
    g.textures = []
    let end = g.buffers[0].byteLength
    for (let i = 0; i < 19; i++) {
      const off = add(png)
      g.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: png.length })
      g.images.push({ bufferView: g.bufferViews.length - 1, mimeType: 'image/png' })
      g.textures.push({ source: i })
      end = off + png.length
    }
    g.buffers[0].byteLength = end
    g.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }]
    g.meshes = [{ name: 'tex', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }]
    g.nodes = [{ mesh: 0, name: 'tex' }]
    g.scenes[0].nodes = [0]
  })
}

/** 5000 channels x 200 keyframes = 1,000,000 keys — exactly at the cap. */
function makeAnimMaxModel() {
  const base = makeModel('static')
  return patchJson(base, (g, add) => {
    const NCH = 5000, NKEY = 200
    const inBuf = Float32Array.from({ length: NKEY }, (_, i) => i / (NKEY - 1))
    const outBuf = Float32Array.from({ length: NKEY * 3 }, (_, i) => (i % 3 === 1 ? 0.5 : 0))
    const off1 = add(Buffer.from(inBuf.buffer))
    const off2 = add(Buffer.from(outBuf.buffer))
    g.bufferViews.push(
      { buffer: 0, byteOffset: off1, byteLength: inBuf.byteLength },
      { buffer: 0, byteOffset: off2, byteLength: outBuf.byteLength },
    )
    const inAcc = g.accessors.length
    g.accessors.push(
      { bufferView: g.bufferViews.length - 2, componentType: 5126, count: NKEY, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: g.bufferViews.length - 1, componentType: 5126, count: NKEY, type: 'VEC3' },
    )
    const channels = []
    const samplers = []
    for (let i = 0; i < NCH; i++) {
      samplers.push({ input: inAcc, interpolation: 'LINEAR', output: inAcc + 1 })
      channels.push({ sampler: i, target: { node: 0, path: 'translation' } })
    }
    g.animations = [{ name: 'max', channels, samplers }]
    g.buffers[0].byteLength = off2 + outBuf.byteLength
  })
}

/** MSFT_audio_emitter over a 15 MB silent WAV (loops). */
function makeAudioBigModel() {
  const base = makeModel('static')
  const wav = makeWav(15 * 1024 * 1024)
  return patchJson(base, (g, add) => {
    const off = add(wav)
    g.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: wav.length })
    g.buffers[0].byteLength = off + wav.length
    g.extensionsUsed = ['MSFT_audio_emitter']
    g.extensions = {
      MSFT_audio_emitter: {
        clips: [{ bufferView: g.bufferViews.length - 1, mimeType: 'audio/wav' }],
        emitters: [{ clips: [{ clip: 0, weight: 1 }], loop: true, volume: 1 }],
      },
    }
    g.nodes[0].extensions = { MSFT_audio_emitter: { emitters: [0] } }
    void base
  })
}

/** WAV header claims 4 GB of data; the clip buffer is ~1 KiB. */
function makeAudioTruncModel() {
  const base = makeModel('static')
  const wav = makeTruncWav()
  return patchJson(base, (g, add) => {
    const off = add(wav)
    g.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: wav.length })
    g.buffers[0].byteLength = off + wav.length
    g.extensionsUsed = ['MSFT_audio_emitter']
    g.extensions = {
      MSFT_audio_emitter: {
        clips: [{ bufferView: g.bufferViews.length - 1, mimeType: 'audio/wav' }],
        emitters: [{ clips: [{ clip: 0, weight: 1 }], loop: true, volume: 1 }],
      },
    }
    g.nodes[0].extensions = { MSFT_audio_emitter: { emitters: [0] } }
    void base
  })
}

/** DRACO-compressed primitive with a CORRUPTED compressed buffer. */
function makeDracoGarbageModel() {
  const lib = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'studio', 'library', 'glb', 'heart.glb')
  const base = readFileSync(lib)
  const binStart = 20
  const jsonLen = base.readUInt32LE(12)
  const binChunkOff = binStart + jsonLen
  const binLen = base.readUInt32LE(binChunkOff)
  // corrupt the middle of the BIN (draco data) — flip a page of bytes
  const out = Buffer.from(base)
  const at = binChunkOff + 8 + Math.floor(binLen / 2)
  for (let i = 0; i < 256; i++) out[at + i] ^= 0xff
  return out
}

// ------------------------------------------------------------------ feed
const sk = generateSecretKey()
const BOOT_NOW = Math.floor(Date.now() / 1000)

const models = new Map() // name -> { bytes, sha, gz }
function addModel(name, bytes, gz) {
  models.set(name, { bytes, sha: sha256(bytes), gz })
  return models.get(name)
}

// baseline good models so the app has a live feed to work on
addModel('ok', makeModel('anim'))
addModel('ok2', makeModel('static'))
// hostile models (served as-is; the matching event carries the REAL hash,
// so download + sha verification pass — the content is still an attack)
addModel('oob', makeOobModel())
addModel('nan', makeNanModel())
addModel('chain', makeChainModel())
addModel('texforge', makeTexForgeModel())
addModel('tex19', makeTex19Model())
addModel('animmax', makeAnimMaxModel())
addModel('audiobig', makeAudioBigModel())
addModel('audiotrunc', makeAudioTruncModel())
addModel('dracogarbage', makeDracoGarbageModel())

// gzip bomb: small gzip of (valid tiny GLB + N MiB of zero padding).
// The event `x` hash is of the INFLATED bytes, so the client's gzip rescue
// path inflates it all in memory BEFORE the size cap is consulted.
// Built on demand: POST /__attack?name=glb-bomb&mib=512 (default 512).
const TINY_GLB = makeModel('static')
let bomb = null // { gz, sha, size }
function buildBomb(mib) {
  const pad = mib * 1024 * 1024
  const buf = Buffer.alloc(TINY_GLB.length + pad)
  TINY_GLB.copy(buf, 0)
  const gz = zlib.gzipSync(buf, { level: 9 })
  const sha = sha256(buf)
  bomb = { gz, sha, size: buf.length }
  console.log(`[hostile] gzip bomb built: ${gz.length} B gzip -> ${(buf.length / 1048576).toFixed(0)} MiB inflated`)
  return bomb
}
buildBomb(Number(process.env.BOMB_MIB || 512))

function modelEvent(name, extraTagPairs = [], age = 0) {
  const m = models.get(name)
  const tags = [
    ['t', 'form-zero'], ['t', 'root'],
    ['m', 'model/gltf-binary'],
    ['x', m.sha], ['ox', m.sha], ['size', String(m.bytes.length)],
    ['url', `https://localhost:${RELAY_PORT}/models/${name}.glb`],
    ['dim', '448x280'],
    ['v', 'form-zero:4'],
    ['filename', `${name}.glb`],
  ]
  for (const p of extraTagPairs) tags.push([p[0], p[1]])
  return finalizeEvent({ kind: 1063, created_at: BOOT_NOW - 60 - age, tags, content: '' }, sk)
}

// Seed feed: 3 good roots + 1 reply (the app boots with content).
const seedEvents = [
  modelEvent('ok', [['anim', '1']], 10),
  modelEvent('ok2', [], 20),
  modelEvent('ok', [['anim', '1']], 30),
  {
    ...modelEvent('ok2', [
      ['t', 'form-zero'],
      ['e', modelEvent('ok', [['anim', '1']], 10).id, '', 'root'],
      ['e', modelEvent('ok', [['anim', '1']], 10).id, '', 'reply'],
    ], 5),
    tags: undefined,
  },
]
// rebuild the reply with a stable root id
const root0 = seedEvents[0]
seedEvents[3] = finalizeEvent({
  kind: 1063, created_at: BOOT_NOW - 5,
  tags: [
    ['t', 'form-zero'], ['m', 'model/gltf-binary'],
    ['x', models.get('ok2').sha], ['ox', models.get('ok2').sha], ['size', String(models.get('ok2').bytes.length)],
    ['url', `https://localhost:${RELAY_PORT}/models/ok2.glb`],
    ['dim', '448x280'], ['v', 'form-zero:4'], ['filename', 'ok2.glb'],
    ['e', root0.id, '', 'root'], ['e', root0.id, '', 'reply'],
  ],
  content: '',
}, sk)

const events = [...seedEvents]

// ------------------------------------------------------------------ relay
function matchFilter(ev, f) {
  if (f.ids && !f.ids.includes(ev.id)) return false
  if (f.authors && !f.authors.includes(ev.pubkey)) return false
  if (f.kinds && !f.kinds.includes(ev.kind)) return false
  if (f.since && ev.created_at < f.since) return false
  if (f.until && ev.created_at > f.until) return false
  if (f['#t'] && !ev.tags.some((t) => t[0] === 't' && f['#t'].includes(t[1]))) return false
  if (f['#m'] && !ev.tags.some((t) => t[0] === 'm' && f['#m'].includes(t[1]))) return false
  return true
}

const RIG_HOOK = `(() => {
  const relay = 'wss://localhost:${RELAY_PORT}';
  const t = setInterval(() => {
    const f = window.__form0;
    if (!f) return;
    clearInterval(t);
    try { f.pool.applyRelays([relay]); } catch (e) { console.error('[hostile-rig]', e); }
  }, 120);
})();`

const clients = new Set() // ws
let slowHits = 0
const subs = new Map() // subId -> { ws, filters }
const state = { mode: 'normal', floodTimer: null }
const attackLog = []

function pushToAll(eventsToPush) {
  for (const ws of clients) {
    if (ws.readyState !== WebSocket.OPEN) continue
    for (const sub of subs.values()) {
      if (sub.ws !== ws) continue
      for (const ev of eventsToPush) {
        for (const f of sub.filters) if (f.kinds?.includes(ev.kind)) ws.send(JSON.stringify(['EVENT', sub.id, ev]))
      }
    }
  }
}

function burstEvents(n, baseTagsFor) {
    const out = []
    for (let i = 0; i < n; i++) {
      const m = models.get(i % 2 ? 'ok' : 'ok2')
      out.push(finalizeEvent({
        kind: 1063,
        // strictly in the PAST (future > +300s is refused by the client)
        created_at: BOOT_NOW - 1000 - i,
      tags: [
        ['t', 'form-zero'], ['t', 'root'], ['m', 'model/gltf-binary'],
        ['x', m.sha], ['ox', m.sha], ['size', String(m.bytes.length)],
        ['url', `https://localhost:${RELAY_PORT}/models/${i % 2 ? 'ok' : 'ok2'}.glb`],
        ['dim', '448x280'], ['v', 'form-zero:4'], ['filename', `flood-${i}.glb`],
      ],
      content: '',
    }, sk))
  }
  return out
}

const XSS_NAME = '<img src=x onerror="window.__xss=(window.__xss||0)+1"><script>window.__xss2=1</script>'
const XSS_FILE = '../../</title><svg/onload=window.__xss3=1>.glb'

const attacks = {
  // ---------------- RCE / XSS probes ----------------
  'xss-name': () => pushToAll([finalizeEvent({
    kind: 1063, created_at: BOOT_NOW - 5000,
    tags: [
      ['t', 'form-zero'], ['t', 'root'], ['m', 'model/gltf-binary'],
      ['x', models.get('ok').sha], ['ox', models.get('ok').sha], ['size', String(models.get('ok').bytes.length)],
      ['url', `https://localhost:${RELAY_PORT}/models/ok.glb`],
      ['dim', '448x280'], ['v', 'form-zero:4'], ['filename', 'xss.glb'],
    ],
    content: XSS_NAME,
  }, sk)]),
  'xss-filename': () => pushToAll([finalizeEvent({
    kind: 1063, created_at: BOOT_NOW - 5001,
    tags: [
      ['t', 'form-zero'], ['t', 'root'], ['m', 'model/gltf-binary'],
      ['x', models.get('ok').sha], ['ox', models.get('ok').sha], ['size', String(models.get('ok').bytes.length)],
      ['url', `https://localhost:${RELAY_PORT}/models/ok.glb`],
      ['dim', '448x280'], ['v', 'form-zero:4'], ['filename', XSS_FILE],
    ],
    content: '',
  }, sk)]),
  'xss-mixed': () => pushToAll([
    finalizeEvent({
      kind: 1063, created_at: BOOT_NOW - 5002,
      tags: [
        ['t', 'form-zero'], ['t', 'root'], ['m', 'model/gltf-binary'],
        ['x', models.get('ok').sha], ['ox', models.get('ok').sha], ['size', String(models.get('ok').bytes.length)],
        ['url', `https://localhost:${RELAY_PORT}/models/ok.glb`],
        ['dim', '448x280'], ['v', 'form-zero:4'],
        ['filename', '<script>document.title="PWNED"</script>.glb'],
        ['color', '#1b1a1a"><img src=x onerror=window.__xss4=1>'],
      ],
      content: `"><svg/onload=window.__xss5=1>`,
    }, sk),
  ]),

  // ---------------- main-thread freeze ----------------
  'huge-msg': () => {
    const junk = 'x'.repeat(180)
    const tags = []
    for (let i = 0; i < 200000; i++) tags.push(['j' + (i % 97), junk])
    const ev = finalizeEvent({ kind: 1063, created_at: BOOT_NOW - 2000, tags, content: '' }, sk)
    // one fat message per client (valid signature; app drops it: no `m` tag)
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue
      for (const sub of subs.values()) if (sub.ws === ws) ws.send(JSON.stringify(['EVENT', sub.id, ev]))
    }
  },
  'deep-json': () => {
    let deep = 1
    for (let i = 0; i < 30000; i++) deep = { a: deep }
    const ev = {
      id: 'a'.repeat(64), pubkey: 'b'.repeat(64), kind: 1063,
      created_at: BOOT_NOW - 6001, tags: [['t', 'form-zero']], sig: 'c'.repeat(128),
      content: '', _junk: deep,
    }
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue
      for (const sub of subs.values()) if (sub.ws === ws) ws.send(JSON.stringify(['EVENT', sub.id, ev]))
    }
  },
  'flood': () => { pushToAll(burstEvents(3000)) },
  'reply-storm': () => {
    const root = root0
    const out = []
    for (let i = 0; i < 5000; i++) {
      const m = models.get('ok2')
      out.push(finalizeEvent({
        kind: 1063, created_at: BOOT_NOW - 7000 - i,
        tags: [
          ['t', 'form-zero'], ['m', 'model/gltf-binary'],
          ['x', m.sha], ['ox', m.sha], ['size', String(m.bytes.length)],
          ['url', `https://localhost:${RELAY_PORT}/models/ok2.glb`],
          ['dim', '448x280'], ['v', 'form-zero:4'], ['filename', `reply-${i}.glb`],
          ['e', root.id, '', 'root'], ['e', root.id, '', 'reply'],
        ],
        content: '',
      }, sk))
    }
    pushToAll(out)
  },
  'reconnect-flood': () => {
    const until = Date.now() + 15000
    const tick = () => {
      if (Date.now() > until) { state.floodTimer = null; return }
      for (const ws of clients) { try { ws.terminate() } catch { /* gone */ } }
      state.floodTimer = setTimeout(tick, 300)
    }
    tick()
  },

  // ---------------- crash / unhandled ----------------
  'malformed-burst': () => {
    const bad = [
      { id: 123, pubkey: 'zz', kind: '1063', created_at: 'now', tags: 'notarray', content: 42, sig: 'aa' },
      { id: 'd'.repeat(64), pubkey: 'e'.repeat(64), kind: 1063, created_at: BOOT_NOW, tags: [1, 2, 3], content: {}, sig: 'f'.repeat(128) },
      { id: 'g'.repeat(64), pubkey: 'h'.repeat(64), kind: 1063, created_at: 99999999999, tags: null, content: 'x', sig: 'i'.repeat(128) },
      { id: 'j'.repeat(64), pubkey: 'k'.repeat(64), kind: 1063, created_at: BOOT_NOW, tags: [[], [[]], [[[], []]]], content: 'a'.repeat(100000), sig: 'l'.repeat(128) },
      { id: 'm'.repeat(63), pubkey: 'n'.repeat(64), kind: 1063, created_at: BOOT_NOW, tags: [['t']], sig: 'o'.repeat(128) },
    ]
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue
      for (const sub of subs.values()) if (sub.ws === ws) for (const ev of bad) ws.send(JSON.stringify(['EVENT', sub.id, ev]))
    }
  },
  'bin-frame': () => {
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue
      ws.send(Buffer.from('binary-attack-payload'.repeat(1000)), { binary: true })
    }
  },

  // ---------------- model-content attacks ----------------
  'glb-oob': () => pushToAll([modelEvent('oob', [], 100)]),
  'glb-nan': () => pushToAll([modelEvent('nan', [], 101)]),
  'glb-chain': () => pushToAll([modelEvent('chain', [], 102)]),
  'glb-texforge': () => pushToAll([modelEvent('texforge', [], 103)]),
  'glb-tex19': () => pushToAll([modelEvent('tex19', [], 104)]),
  'glb-animmax': () => pushToAll([modelEvent('animmax', [['anim', '1']], 105)]),
  'glb-audio-big': () => pushToAll([modelEvent('audiobig', [['audio', '1']], 106)]),
  'glb-audio-trunc': () => pushToAll([modelEvent('audiotrunc', [['audio', '1']], 107)]),
  'glb-draco': () => pushToAll([modelEvent('dracogarbage', [], 108)]),
  'glb-bomb': (params) => {
    if (params.mib) buildBomb(Number(params.mib))
    // LIE about size: a real `size` tag > 20 MiB is refused at parse time.
    // The download cap is max(claimed, 20 MiB hard), so the small gzip body
    // streams through and the gzip-rescue path inflates without a cap.
    pushToAll([finalizeEvent({
      kind: 1063, created_at: BOOT_NOW - 8000 - (params.nonce ?? 0),
      tags: [
        ['t', 'form-zero'], ['t', 'root'], ['m', 'model/gltf-binary'],
        ['x', bomb.sha], ['ox', bomb.sha], ['size', '512'],
        ['url', `https://localhost:${RELAY_PORT}/models/bomb.glb`],
        ['dim', '448x280'], ['v', 'form-zero:4'], ['filename', 'bomb.glb'],
      ],
      content: '',
    }, sk)])
  },
  'many-urls': () => {
    const m = models.get('ok')
    const urls = []
    for (let i = 0; i < 400; i++) urls.push(['url', `https://localhost:${RELAY_PORT}/slow?d=8&i=${i}`])
    pushToAll([finalizeEvent({
      kind: 1063, created_at: BOOT_NOW - 9000,
      tags: [
        ['t', 'form-zero'], ['t', 'root'], ['m', 'model/gltf-binary'],
        ['x', m.sha], ['ox', m.sha], ['size', String(m.bytes.length)],
        ...urls,
        ['dim', '448x280'], ['v', 'form-zero:4'], ['filename', 'manyurls.glb'],
      ],
      content: '',
    }, sk)])
  },

  // ---------------- blossom abuse ----------------
  'blossom-eviljson': () => { state.blossomMode = 'eviljson' },
  'blossom-evilurl': () => { state.blossomMode = 'evilurl' },
}

// ------------------------------------------------------------------ server
const httpsServer = createHttps({ key: KEY, cert: CERT }, (req, res) => {
  req.on('error', () => {})
  res.on('error', () => {})
  const url = new URL(req.url, `https://localhost:${RELAY_PORT}`)
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, PUT, POST, OPTIONS',
    'access-control-allow-headers': 'Authorization, Content-Type',
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return }

  if (url.pathname === '/__attack') {
    const name = url.searchParams.get('name') || ''
    const fn = attacks[name]
    if (!fn) { res.writeHead(404, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify({ error: 'unknown attack', available: Object.keys(attacks) })); return }
    try {
      fn({ ...url.searchParams })
      attackLog.push({ name, at: Date.now(), clients: clients.size, params: Object.fromEntries(url.searchParams) })
      res.writeHead(200, { 'content-type': 'application/json', ...cors })
      res.end(JSON.stringify({ ok: true, name, clients: clients.size }))
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json', ...cors })
      res.end(JSON.stringify({ ok: false, error: String(e) }))
    }
    return
  }
  if (url.pathname === '/__attacks') {
    res.writeHead(200, { 'content-type': 'application/json', ...cors })
    res.end(JSON.stringify({ available: Object.keys(attacks), log: attackLog, clients: clients.size, slowHits }))
    return
  }
  if (url.pathname === '/slow') {
    slowHits++
    const d = Math.min(Number(url.searchParams.get('d') ?? 5), 30)
    setTimeout(() => {
      try { res.writeHead(404, cors); res.end('slow') } catch { /* client gone */ }
    }, d * 1000)
    return
  }
  if (req.method === 'PUT' && (url.pathname === '/upload' || url.pathname.endsWith('/upload'))) {
    const chunks = []
    let got = 0
    req.on('data', (c) => { got += c.length; if (got < 32 * 1024 * 1024) chunks.push(c) })
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const sha = sha256(body)
      if (state.blossomMode === 'eviljson') {
        // 20 MiB of JSON, all "valid"
        const junk = 'x'.repeat(512)
        let s = '{"url":"https://localhost:' + RELAY_PORT + '/models/ok.glb","sha256":"' + sha + '","pad":['
        while (s.length < 20 * 1024 * 1024) s += '"' + junk + '",'
        s += '"]}'
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
        res.end(s)
        return
      }
      if (state.blossomMode === 'evilurl') {
        const s = '{"url":"https://localhost:' + RELAY_PORT + '/models/ok.glb?' + 'a'.repeat(2 * 1024 * 1024) + '","sha256":"' + sha + '"}'
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
        res.end(s)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', ...cors })
      res.end(JSON.stringify({ url: `https://localhost:${RELAY_PORT}/models/ok.glb`, sha256: sha }))
    })
    return
  }
  if (req.method === 'GET' && url.pathname.startsWith('/models/')) {
    const name = url.pathname.slice('/models/'.length).replace(/\.glb$/, '')
    if (name === 'bomb') {
      res.writeHead(200, {
        'content-type': 'model/gltf-binary',
        'content-length': bomb.gz.length,
        'access-control-allow-origin': '*',
      })
      res.end(bomb.gz)
      return
    }
    const m = models.get(name)
    if (!m) { res.writeHead(404, cors).end(); return }
    res.writeHead(200, {
      'content-type': 'model/gltf-binary',
      'content-length': m.bytes.length,
      'access-control-allow-origin': '*',
    })
    res.end(Buffer.from(m.bytes))
    return
  }
  res.writeHead(404, cors).end()
})

const wss = new WebSocketServer({ server: httpsServer })
wss.on('connection', (ws) => {
  clients.add(ws)
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (!Array.isArray(msg) || typeof msg[0] !== 'string') return
    if (msg[0] === 'REQ') {
      const sub = msg[1]
      const filters = msg.slice(2).filter((f) => f && typeof f === 'object')
      subs.set(sub, { ws, id: sub, filters })
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
      ws.send(JSON.stringify(['OK', ev.id, true, '']))
      if (!events.some((e) => e.id === ev.id)) events.push(ev)
      for (const [subId, { ws: other, filters }] of subs) {
        if (filters.some((f) => matchFilter(ev, f))) other.send(JSON.stringify(['EVENT', subId, ev]))
      }
    } else if (msg[0] === 'CLOSE') {
      for (const [id, s] of subs) if (s.ws === ws) subs.delete(id)
    }
  })
  ws.on('close', () => {
    clients.delete(ws)
    for (const [id, s] of subs) if (s.ws === ws) subs.delete(id)
  })
})

httpsServer.listen(RELAY_PORT, () => {
  console.log(`[hostile] relay+models+blossom on https://localhost:${RELAY_PORT}  (${events.length} seed events, ${models.size} models)`)
})

// ------------------------------------------------------------------ proxy
const proxy = createHttp((req, res) => {
  req.on('error', () => {})
  res.on('error', () => {})
  if (req.url?.startsWith('/__attack') || req.url === '/__attacks') {
    // the hostile server is HTTPS — forward over TLS (self-signed is fine locally)
    const fwd = httpsRequest(
      { host: 'localhost', port: RELAY_PORT, path: req.url, method: req.method, rejectUnauthorized: false },
      (up) => {
        res.writeHead(up.statusCode, { 'content-type': 'application/json' })
        up.pipe(res)
      },
    )
    fwd.on('error', () => { try { res.writeHead(502); res.end() } catch { /* gone */ } })
    fwd.end()
    return
  }
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
        const headers = { ...up.headers }
        let bytes = Buffer.concat(chunks)
        const enc = String(headers['content-encoding'] || '').toLowerCase()
        if (enc === 'gzip') bytes = zlib.gunzipSync(bytes)
        else if (enc === 'deflate') bytes = zlib.inflateSync(bytes)
        else if (enc === 'br') bytes = zlib.brotliDecompressSync(bytes)
        if (enc) delete headers['content-encoding']
        let body = bytes.toString('utf8')
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
  socket.on('error', () => {})
  const up = httpRequest({ host: UPSTREAM.host, port: UPSTREAM.port, path: req.url, headers: req.headers })
  up.on('upgrade', (r, upSocket, upHead) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n')
    if (upHead.length) socket.write(upHead)
    socket.pipe(upSocket).pipe(socket)
  })
  up.on('error', () => socket.destroy())
  up.end()
})
proxy.listen(PROXY_PORT, () => {
  console.log(`[hostile] proxy on http://localhost:${PROXY_PORT} -> ${UPSTREAM.host}:${UPSTREAM.port}`)
})
