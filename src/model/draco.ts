import { DracoCompression } from '@babylonjs/core/Meshes/Compression/dracoCompression'
import { DracoDecoder } from '@babylonjs/core/Meshes/Compression/dracoDecoder'
// Local Draco assets (spec 00 §6.5): never cdn.babylonjs.com.
// ?url -> separate same-origin files in the normal build; the standalone
// config inlines them as data: URIs (assetsInlineLimit).
//
// Babylon's IDracoCodecConfiguration maps:
//   wasmUrl       -> the Emscripten JS wrapper that instantiates the WASM
//   wasmBinaryUrl -> the actual WebAssembly binary (.wasm)
//   fallbackUrl   -> the pure-JS decoder used when WASM is unavailable
// These are the three files below, in that order.
import dracoWasmWrapperJsUrl from '@babylonjs/core/assets/Draco/draco_wasm_wrapper_gltf.js?url'
import dracoWasmBinaryUrl from '@babylonjs/core/assets/Draco/draco_decoder_gltf.wasm?url'
import dracoJsFallbackUrl from '@babylonjs/core/assets/Draco/draco_decoder_gltf.js?url'

type DracoAttribute = { kind: string; normalized: boolean; [k: string]: unknown }
type DracoMeshData = { attributes: DracoAttribute[]; [k: string]: unknown }
type DecodeFn = (
  this: unknown,
  data: ArrayBuffer | ArrayBufferView,
  attributes: Record<string, number>,
  gltfNormalizedOverride?: Record<string, boolean>,
) => Promise<DracoMeshData>

/**
 * MAIN-THREAD DRACO DECODE DROPS THE glTF NORMALIZED FLAG (Babylon ≤8.10).
 *
 * A glTF COLOR_0 like { componentType: 5121 u8, normalized: true, VEC4 } —
 * exactly what the studio library ships, draco-compressed —
 * only keeps its `normalized` flag through the WORKER decode path:
 * `decodeMeshToMeshDataAsync` applies `applyGltfNormalizedOverride` there.
 * The `_modulePromise` (main-thread) branch, which is the ONLY branch we run
 * (`numWorkers: 0`, see below), ignores the override, so the color vertex
 * buffer lands as *unnormalized bytes*. The PBR vertex shader then reads raw
 * 0..255 channel values as colors (~255x overdrive), every channel clips, and
 * vertex-colored models render as flat white/grey slabs in the VIEWER, on
 * board posters/live previews, in thread 3D — i.e. "works in studio" (where
 * the tint UI masks the white-out) but nowhere else (2026-08-20 field report).
 *
 * Idempotent polyfill below: apply the same override the worker path applies.
 * When a future Babylon fixes the module branch, this rewrites normalized to
 * the exact same value the fixed path would set — a no-op. Float COLOR_0
 * (paint bakes, plain GLBs) is unaffected: their accessors carry
 * `normalized: false`, which the patch writes back unchanged.
 */
let patchedDecode = false
function patchDracoNormalizedOverride(): void {
  if (patchedDecode) return
  patchedDecode = true
  const proto = DracoDecoder.prototype as unknown as { decodeMeshToMeshDataAsync: DecodeFn }
  const original: DecodeFn = proto.decodeMeshToMeshDataAsync
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

let configured = false
export function configureDraco(): void {
  if (configured) return
  configured = true
  patchDracoNormalizedOverride()
  DracoCompression.Configuration = {
    decoder: {
      wasmUrl: dracoWasmWrapperJsUrl,
      wasmBinaryUrl: dracoWasmBinaryUrl,
      fallbackUrl: dracoJsFallbackUrl,
      // Main-thread decode: avoids blob-worker + importScripts + worker-src
      // CSP interaction entirely. FORM/0 models are small (<=276 meshes).
      // Note: the wasm binary is fetched via XHR, so the page CSP must allow
      // same-origin connections (connect-src 'self' — see csp.ts) when the
      // app is served over HTTP (dev server, plain-HTTP deployment). The
      // standalone build inlines everything as data: URIs and its CSP already
      // lists data: in connect-src.
      numWorkers: 0,
    },
  }
}
