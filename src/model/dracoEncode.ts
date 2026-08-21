/**
 * LOCAL Draco ENCODER (the decode side lives in `model/draco.ts`).
 *
 * Babylon core ships the encoder wrapper + wasm (`@babylonjs/core/assets/
 * Draco/draco_encoder*`); only the default configuration points at
 * cdn.babylonjs.com, which this app must never touch (spec 00 §6.5, and the
 * standalone build must stay network-free). Exactly like the decoder config,
 * the assets are imported with `?url` so the normal build emits same-origin
 * files and the standalone build inlines them as data: URIs
 * (assetsInlineLimit). Main-thread `numWorkers: 0` keeps it inside the page
 * CSP (no blob worker importScripts).
 *
 * The encoder is only offered in the export review when it actually
 * initialises and encodes a probe mesh — "never advertise a non-working codec
 * control".
 */
import { DracoEncoder } from '@babylonjs/core/Meshes/Compression/dracoEncoder'
import type { DracoCodec } from './compressGlb'
// Local Draco assets (spec 00 §6.5): never cdn.babylonjs.com.
import encoderWrapperUrl from '@babylonjs/core/assets/Draco/draco_encoder_wasm_wrapper.js?url'
import encoderWasmUrl from '@babylonjs/core/assets/Draco/draco_encoder.wasm?url'

let configured = false
export function configureDracoEncoder(): void {
  if (configured) return
  configured = true
  DracoEncoder.DefaultConfiguration = {
    wasmUrl: encoderWrapperUrl,
    wasmBinaryUrl: encoderWasmUrl,
    // No asm.js fallback: the wasm pair is ~430 KB and the fallback another
    // ~900 KB, which the standalone build would inline for a path no
    // supported browser takes. Without WebAssembly the probe fails and the
    // draco control simply stays hidden (optional feature, never advertised
    // when it cannot work).
    // Main-thread encode (same rationale as the decoder): no worker/CSP
    // interaction. Studio exports are small (LIMITS.vertices etc).
    numWorkers: 0,
  }
}

/** `DracoCodec` adapter over Babylon's main-thread DracoEncoder. */
export const dracoCodec: DracoCodec = {
  async encodePrimitive(input) {
    // `kind` is the glTF semantic, so the returned attributeIds map is
    // exactly the KHR_draco_mesh_compression `attributes` dictionary.
    const attributes = input.attributes.map((a) => ({ kind: a.semantic, dracoName: a.dracoName, size: a.size, data: a.data }))
    const encoded = await DracoEncoder.Default._encodeAsync(attributes, input.indices)
    if (!encoded) return null
    return {
      data: new Uint8Array(encoded.data.buffer, encoded.data.byteOffset, encoded.data.byteLength),
      attributeIds: encoded.attributeIds as Record<string, number>,
    }
  },
}

let ready: Promise<boolean> | null = null
/** Resolves once the encoder module is warm and a probe mesh encodes. */
export function dracoEncoderReady(): Promise<boolean> {
  ready ??= (async () => {
    try {
      configureDracoEncoder()
      await DracoEncoder.Default.whenReadyAsync()
      const probe = await dracoCodec.encodePrimitive({
        attributes: [{ semantic: 'POSITION', dracoName: 'POSITION', size: 3, data: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) }],
        indices: new Uint16Array([0, 1, 2]),
      })
      return !!probe && probe.data.length > 0
    } catch {
      return false
    }
  })()
  return ready
}
