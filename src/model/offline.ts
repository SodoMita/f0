import { KhronosTextureContainer2 } from '@babylonjs/core/Misc/khronosTextureContainer2'

/**
 * Zero-CDN guarantee (00 §6.5): Babylon defaults the KTX2/Basis transcoder
 * URLs to cdn.babylonjs.com. FORM/0 ships no network except user content, so
 * neutralize them — a KTX2 texture then fails cleanly instead of leaking a
 * request. Draco (the common case) is fully local, see draco.ts.
 */
export function enforceOffline(): void {
  const cfg = KhronosTextureContainer2.URLConfig
  cfg.jsDecoderModule = ''
  cfg.wasmUASTCToASTC = ''
  cfg.wasmUASTCToBC7 = ''
  cfg.wasmUASTCToRGBA_UNORM = ''
  cfg.wasmUASTCToRGBA_SRGB = ''
  cfg.wasmUASTCToR8_UNORM = ''
  cfg.wasmUASTCToRG8_UNORM = ''
  cfg.jsMSCTranscoder = ''
  cfg.wasmMSCTranscoder = ''
  cfg.wasmZSTDDecoder = ''
}
