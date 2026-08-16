import { DracoCompression } from '@babylonjs/core/Meshes/Compression/dracoCompression'
// Local Draco assets (spec 00 §6.5): never cdn.babylonjs.com.
// ?url -> separate same-origin files in the normal build; the standalone
// config inlines them as data: URIs (assetsInlineLimit).
import dracoWasmUrl from '@babylonjs/core/assets/Draco/draco_decoder_gltf.wasm?url'
import dracoJsUrl from '@babylonjs/core/assets/Draco/draco_wasm_wrapper_gltf.js?url'
import dracoFallbackUrl from '@babylonjs/core/assets/Draco/draco_decoder_gltf.js?url'

let configured = false
export function configureDraco(): void {
  if (configured) return
  configured = true
  DracoCompression.Configuration = {
    decoder: {
      wasmUrl: dracoJsUrl,
      wasmBinaryUrl: dracoWasmUrl,
      fallbackUrl: dracoFallbackUrl,
      // Main-thread decode: avoids blob-worker + importScripts + worker-src
      // CSP interaction entirely. FORM/0 models are small (<=276 meshes).
      numWorkers: 0,
    },
  }
}
