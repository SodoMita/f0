#!/usr/bin/env node
/**
 * Verify the local Draco decoder assets that src/model/draco.ts wires up.
 *
 * Simulates exactly what Babylon's DracoCodec does with the app's
 * configuration (wasmUrl=wasm wrapper JS, wasmBinaryUrl=decoder wasm,
 * numWorkers=0): load the wasm binary, evaluate the wrapper (which defines
 * DracoDecoderModule), then instantiate the module with the binary.
 *
 * Round-trip: encode a small triangle mesh with the encoder wrapper, decode
 * it back, and assert the decoded vertex count / triangle count match.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const DRACO = join(here, '..', 'node_modules', '@babylonjs', 'core', 'assets', 'Draco')
// The Emscripten wrapper detects the Node environment and calls require('fs')
// / require('path'); give it a working require scoped to this module.
const require = createRequire(import.meta.url)

// --- 1. The three files src/model/draco.ts imports (same paths) ---
const wasmBinary = readFileSync(join(DRACO, 'draco_decoder_gltf.wasm'))
const wrapperJs = readFileSync(join(DRACO, 'draco_wasm_wrapper_gltf.js'), 'utf8')
const fallbackJs = readFileSync(join(DRACO, 'draco_decoder_gltf.js'), 'utf8')

console.log(`draco_decoder_gltf.wasm      ${wasmBinary.length} bytes`)
console.log(`draco_wasm_wrapper_gltf.js   ${wrapperJs.length} bytes (defines DracoDecoderModule)`)
console.log(`draco_decoder_gltf.js        ${fallbackJs.length} bytes (fallback)`)

// --- 2. Evaluate the wrapper exactly as Tools.LoadBabylonScriptAsync does ---
// (script tag in a browser; vm.runInContext in Node — same effect)
// The wrapper declares `var DracoDecoderModule=function(){...}` in its own
// scope; evaluate it in a fresh context and read the global back.
const context = vm.createContext({
  require,
  __filename: join(DRACO, 'draco_wasm_wrapper_gltf.js'),
  __dirname: DRACO,
  WebAssembly,
  TextDecoder,
  TextEncoder,
  console,
  process,
})
const moduleFactory = vm.runInContext(wrapperJs + '\n;globalThis.__dracoDecoderModuleFactory = DracoDecoderModule;', context)
if (typeof moduleFactory !== 'function') {
  console.error('FAIL: wrapper did not define DracoDecoderModule')
  process.exit(1)
}
console.log('wrapper evaluated OK — DracoDecoderModule is a', typeof moduleFactory)

// --- 3. Instantiate the module with the wasm binary (what _createModuleAsync does) ---
const moduleOverrides = { wasmBinary: wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength) }
const decoderModule = await moduleFactory(moduleOverrides)
await decoderModule.ready
if (!decoderModule) {
  console.error('FAIL: DracoDecoderModule() returned nothing')
  process.exit(1)
}
console.log('decoder module created OK — exports:', Object.keys(decoderModule).filter((k) => !k.startsWith('_')).slice(0, 8).join(', '), '…')

// --- 4. Round-trip: encode a quad, decode it back ---
// Use the encoder wrapper the same way (draco_encoder_wasm_wrapper.js).
const encJs = readFileSync(join(DRACO, 'draco_encoder_wasm_wrapper.js'), 'utf8')
const encWasm = readFileSync(join(DRACO, 'draco_encoder.wasm'))
const encContext = vm.createContext({
  require,
  __filename: join(DRACO, 'draco_encoder_wasm_wrapper.js'),
  __dirname: DRACO,
  WebAssembly,
  TextDecoder,
  TextEncoder,
  console,
  process,
})
vm.runInContext(encJs + '\n;globalThis.__dracoEncoderModuleFactory = DracoEncoderModule;', encContext)
const encModule = await encContext.__dracoEncoderModuleFactory({ wasmBinary: encWasm.buffer.slice(encWasm.byteOffset, encWasm.byteOffset + encWasm.byteLength) })
await encModule.ready

// A 2-triangle quad:
//   0---1
//   | / |
//   2---3
const positions = new Float32Array([
  0, 0, 0,   1, 0, 0,   0, 1, 0,   1, 1, 0,
])
const indices = new Uint32Array([0, 1, 2, 2, 1, 3])

const encoder = new encModule.Encoder()
const builder = new encModule.MeshBuilder()
const mesh = new encModule.Mesh()
builder.AddFloatAttributeToMesh(mesh, encModule.POSITION, positions.length / 3, 3, positions)
builder.AddFacesToMesh(mesh, indices.length / 3, indices)
encoder.SetSpeedOptions(5, 5)
encoder.SetEncodingMethod(encModule.MESH_SEQUENTIAL_ENCODING)
const encData = new encModule.DracoInt8Array()
const encodedSize = encoder.EncodeMeshToDracoBuffer(mesh, encData)
if (encodedSize <= 0) {
  console.error('FAIL: encoder produced no data')
  process.exit(1)
}
const encoded = new Uint8Array(encodedSize)
for (let i = 0; i < encodedSize; i++) encoded[i] = encData.GetValue(i)
console.log(`encoded quad -> ${encodedSize} bytes of Draco data`)

encModule.destroy(encData)
encModule.destroy(mesh)
encModule.destroy(builder)
encModule.destroy(encoder)

// --- 5. Decode with the decoder module (what KHR_draco_mesh_compression does) ---
const decoder = new decoderModule.Decoder()
const dMesh = new decoderModule.Mesh()
const dBuffer = new decoderModule.DecoderBuffer()
dBuffer.Init(new Uint8Array(encoded), encoded.length)
const status = decoder.DecodeBufferToMesh(dBuffer, dMesh)
if (!status.ok()) {
  console.error('FAIL: decode status', status.error_msg())
  process.exit(1)
}
const numPoints = dMesh.num_points()
const numFaces = dMesh.num_faces()
console.log(`decoded mesh: ${numPoints} points, ${numFaces} faces`)

// Read positions back and sanity-check — same call path as Babylon's
// DecodeMesh (GetAttributeDataArrayForAllPoints + HEAPF32 view).
const pAttr = decoder.GetAttributeByUniqueId(dMesh, 0)
const posData = new Float32Array(numPoints * 3)
const posPtr = decoderModule._malloc(posData.length * 4)
try {
  decoder.GetAttributeDataArrayForAllPoints(dMesh, pAttr, decoderModule.DT_FLOAT32, posData.length * 4, posPtr)
  posData.set(new Float32Array(decoderModule.HEAPF32.buffer, posPtr, posData.length))
} finally {
  decoderModule._free(posPtr)
}
let minX = Infinity, maxX = -Infinity
for (let i = 0; i < numPoints * 3; i += 3) {
  minX = Math.min(minX, posData[i]); maxX = Math.max(maxX, posData[i])
}
console.log(`decoded positions: x in [${minX}, ${maxX}]`)

decoderModule.destroy(decoder)
decoderModule.destroy(dMesh)
decoderModule.destroy(dBuffer)

const pass = numPoints === 4 && numFaces === 2 && Math.abs(minX) < 1e-5 && Math.abs(maxX - 1) < 1e-5
if (!pass) {
  console.error(`FAIL: expected 4 points / 2 faces / x∈[0,1], got ${numPoints} / ${numFaces} / [${minX}, ${maxX}]`)
  process.exit(1)
}

console.log('\nDRACO DECODER ROUND-TRIP OK — the app\'s local decoder assets decode real Draco data.')
