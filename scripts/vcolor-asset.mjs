// Minimal hand-written GLB: colored cube, per-face byte-normalized VEC4 COLOR_0,
// KHR_mesh_quantization NOT required; use plain FLOAT pos/norm + UNSIGNED_BYTE norm color.
import fs from 'fs'

const S = 0.425
// 6 faces × 2 tris × 3 verts, flat shading; outward colors: R,G,B,Y,M,C
const faces = [
  { n: [1, 0, 0], c: [255, 40, 40, 255] },   // +X red
  { n: [-1, 0, 0], c: [40, 255, 40, 255] },  // -X green
  { n: [0, 1, 0], c: [40, 40, 255, 255] },   // +Y blue
  { n: [0, -1, 0], c: [255, 255, 40, 255] }, // -Y yellow
  { n: [0, 0, 1], c: [255, 40, 255, 255] },  // +Z magenta
  { n: [0, 0, -1], c: [40, 255, 255, 255] }, // -Z cyan
]
const pos = [], nrm = [], col = [], idx = []
let vi = 0
for (const f of faces) {
  const [nx, ny, nz] = f.n
  // two other axes for the face quad
  const ax = ny !== 0 ? [1, 0, 0] : [0, 1, 0]
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const ay = cross(f.n, ax)
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [
    nx * S + ax[0] * u * S + ay[0] * v * S,
    ny * S + ax[1] * u * S + ay[1] * v * S,
    nz * S + ax[2] * u * S + ay[2] * v * S,
  ])
  for (const t of [[0, 1, 2], [0, 2, 3]]) {
    for (const ci of t) {
      pos.push(...corners[ci])
      nrm.push(...f.n)
      col.push(...f.c)
      idx.push(vi++)
    }
  }
}
const packF32 = (arr) => {
  const b = Buffer.alloc(arr.length * 4)
  for (let i = 0; i < arr.length; i++) b.writeFloatLE(arr[i], i * 4)
  return b
}
const posB = packF32(pos)
const nrmB = packF32(nrm)
const colB = Buffer.from(col)
const idxB = Buffer.concat(idx.map(i => { const b = Buffer.alloc(2); b.writeUInt16LE(i, 0); return b }))

const pad4 = (b, ch = 0) => {
  const n = b.length % 4 ? 4 - (b.length % 4) : 0
  return n ? Buffer.concat([b, Buffer.alloc(n, ch)]) : b
}
const blobs = [posB, nrmB, colB, idxB]
const json = {
  asset: { version: '2.0', generator: 'vcolor test' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: 'vcolor-cube', mesh: 0 }],
  meshes: [{ name: 'vcolor-cube', primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3, material: 0, mode: 4 }] }],
  materials: [{ name: 'm', pbrMetallicRoughness: { baseColorFactor: [0.95, 0.95, 0.95, 1], metallicFactor: 0, roughnessFactor: 0.8 }, doubleSided: true }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: [-S, -S, -S], max: [S, S, S] },
    { bufferView: 1, componentType: 5126, count: nrm.length / 3, type: 'VEC3' },
    { bufferView: 2, componentType: 5121, count: col.length / 4, type: 'VEC4', normalized: true },
    { bufferView: 3, componentType: 5123, count: idx.length, type: 'SCALAR' },
  ],
  bufferViews: [],
  buffers: [],
}
let off = 0
let binBody = Buffer.alloc(0)
for (let i = 0; i < blobs.length; i++) {
  json.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: blobs[i].length, target: i === 3 ? 34963 : 34962 })
  binBody = Buffer.concat([binBody, pad4(blobs[i])])
  off += pad4(blobs[i]).length
}
json.buffers = [{ byteLength: binBody.length }]
let jb = pad4(Buffer.from(JSON.stringify(json)), 0x20)
binBody = pad4(binBody)
const total = 12 + 8 + jb.length + 8 + binBody.length
const header = Buffer.alloc(12)
header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8)
const jh = Buffer.alloc(8); jh.writeUInt32LE(jb.length, 0); jh.write('JSON', 4)
const bh = Buffer.alloc(8); bh.writeUInt32LE(binBody.length, 0); bh.write('BIN\0', 4)
fs.writeFileSync(process.argv[2], Buffer.concat([header, jh, jb, bh, binBody]))
console.log('wrote', process.argv[2], total, 'bytes')
