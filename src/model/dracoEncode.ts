/**
 * LOCAL Draco ENCODER (decode side: `model/draco.ts`). Babylon core ships the
 * encoder wrapper + wasm; only its default config points at cdn.babylonjs.com,
 * which this app never touches (AMENDMENT 68 discipline). `?url` imports make
 * the normal build emit same-origin files and the standalone inline them.
 * Main-thread `numWorkers: 0` keeps it inside the page CSP. The control is
 * offered only when `dracoEncoderReady()` proves the encoder works.
 */
import { DracoEncoder } from '@babylonjs/core/Meshes/Compression/dracoEncoder'
import type { DracoCodec, DracoEncodeOptions } from './compressGlb'
import encoderWrapperUrl from '@babylonjs/core/assets/Draco/draco_encoder_wasm_wrapper.js?url'
import encoderWasmUrl from '@babylonjs/core/assets/Draco/draco_encoder.wasm?url'

let configured = false
export function configureDracoEncoder(): void {
  if (configured) return
  configured = true
  DracoEncoder.DefaultConfiguration = {
    wasmUrl: encoderWrapperUrl,
    wasmBinaryUrl: encoderWasmUrl,
    // No asm.js fallback (adds ~900 KB the standalone build would inline for
    // a path no supported browser takes); without wasm the probe fails and
    // the draco control stays hidden.
    numWorkers: 0,
  }
}

/** `DracoCodec` adapter. `kind` is the glTF semantic, so the returned
 * attributeIds map IS the KHR_draco_mesh_compression `attributes` dict. */
export const dracoCodec: DracoCodec = {
  async encodePrimitive(input, options?: DracoEncodeOptions) {
    const attributes = input.attributes.map((a) => ({ kind: a.semantic, dracoName: a.dracoName, size: a.size, data: a.data }))
    const encodeOptions: Record<string, unknown> = {}
    if (options?.quantizationBits) {
      // Babylon wants a complete record; fill partials over its defaults.
      encodeOptions.quantizationBits = { POSITION: 14, NORMAL: 10, COLOR: 8, TEX_COORD: 12, GENERIC: 12, ...options.quantizationBits }
    }
    if (options?.encodeSpeed !== undefined) encodeOptions.encodeSpeed = options.encodeSpeed
    if (options?.decodeSpeed !== undefined) encodeOptions.decodeSpeed = options.decodeSpeed
    const encoded = await DracoEncoder.Default._encodeAsync(
      attributes, input.indices,
      Object.keys(encodeOptions).length ? (encodeOptions as never) : undefined)
    if (!encoded) return null
    return {
      data: new Uint8Array(encoded.data.buffer, encoded.data.byteOffset, encoded.data.byteLength),
      attributeIds: encoded.attributeIds as Record<string, number>,
    }
  },
}

/** Resolves true once the encoder module is warm and a probe mesh encodes. */
let readyProbe: Promise<boolean> | null = null
export function dracoEncoderReady(): Promise<boolean> {
  readyProbe ??= (async () => {
    try {
      configureDracoEncoder()
      await DracoEncoder.Default.whenReadyAsync()
      const probe = await dracoCodec.encodePrimitive({
        attributes: [{ semantic: 'POSITION', dracoName: 'POSITION', size: 3, data: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) }],
        indices: new Uint16Array([0, 1, 2]),
      })
      return !!probe && probe.data.length > 0
    } catch { return false }
  })()
  return readyProbe
}
