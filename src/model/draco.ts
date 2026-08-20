import { DracoCompression } from '@babylonjs/core/Meshes/Compression/dracoCompression'
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

let configured = false
export function configureDraco(): void {
  if (configured) return
  configured = true
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
