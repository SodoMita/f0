#!/usr/bin/env node
/**
 * Live-preview → viewer hand-off units (no browser):
 *   bun scripts/handoff-unit.mjs
 *
 * Guards the duplicate authored-camera regression. Babylon 8.10's
 * `instantiateModelsToScene` already clones glTF cameras; the old hand-off
 * code cloned them AGAIN, so a one-camera model opened to two camera dots.
 */
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
import '@babylonjs/core/Cameras/universalCamera'
import '@babylonjs/loaders/glTF'
import { handoffContainer } from '../src/core/sceneTransfer.ts'

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

/** Tiny triangle GLB with ONE authored perspective camera. */
function makeCameraGlb() {
  const positions = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0])
  const indices = new Uint16Array([0, 1, 2])
  const bin = new Uint8Array(44)
  bin.set(new Uint8Array(positions.buffer), 0)
  bin.set(new Uint8Array(indices.buffer), 36)
  const json = JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [
      { mesh: 0, name: 'tri' },
      { camera: 0, name: 'cam0', translation: [0, 0, 3] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    cameras: [{ name: 'cam-red', type: 'perspective', perspective: { yfov: 0.7, znear: 0.01, zfar: 100 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-1, -1, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    buffers: [{ byteLength: 44 }],
  })
  const jsonBytes = new TextEncoder().encode(json)
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4
  const jsonChunk = jsonBytes.length + jsonPad
  const binPad = (4 - (bin.length % 4)) % 4
  const binChunk = bin.length + binPad
  const total = 12 + 8 + jsonChunk + 8 + binChunk
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true) // glTF
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonChunk, true)
  view.setUint32(16, 0x4e4f534a, true) // JSON
  out.set(jsonBytes, 20)
  for (let i = 0; i < jsonPad; i++) out[20 + jsonBytes.length + i] = 0x20
  const binAt = 20 + jsonChunk
  view.setUint32(binAt, binChunk, true)
  view.setUint32(binAt + 4, 0x004e4942, true) // BIN
  out.set(bin, binAt + 8)
  return out
}

const engine = new NullEngine()
const sourceScene = new Scene(engine)
const targetScene = new Scene(engine)
const source = await LoadAssetContainerAsync(makeCameraGlb(), sourceScene, { pluginExtension: '.glb' })
source.addAllToScene()
check('source model has exactly one authored camera', source.cameras.length === 1,
  source.cameras.map((c) => c.name).join(','))

const { container } = handoffContainer(source, sourceScene, targetScene, new Vector3(0, 0, 0), 'viewer')
check('hand-off keeps exactly one authored camera', container.cameras.length === 1,
  container.cameras.map((c) => c.name).join(','))
check('handed-off camera belongs to the target scene',
  container.cameras.every((c) => c.getScene() === targetScene))
check('no cloned camera is left behind in the source scene',
  sourceScene.cameras.filter((c) => c.name.startsWith('viewer-')).length === 0,
  sourceScene.cameras.map((c) => c.name).join(','))

if (fails.length) {
  console.error(`\n${fails.length} HANDOFF UNIT CHECK(S) FAILED`)
  process.exit(1)
}
console.log('\nALL HANDOFF UNIT CHECKS PASSED')
