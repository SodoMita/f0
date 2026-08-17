/**
 * What this browser/GPU can actually do.
 *
 * The settings panel is honest: anything the platform cannot provide is shown
 * disabled with the reason, instead of a switch that does nothing. WebGL has
 * no vendor upscalers (DLSS/FSR/XeSS are driver/engine features), no hardware
 * ray tracing and no frame generation, so those appear as unavailable with an
 * explanation and the closest real equivalent is offered next to them.
 */
export interface Capabilities {
  webgl2: boolean
  maxTextureSize: number
  maxAnisotropy: number
  maxSamples: number
  maxRenderBufferSize: number
  hdrDisplay: boolean
  fullscreen: boolean
  audioOutputSelection: boolean
  audioInputSelection: boolean
  deviceMemoryGB: number | null
  hardwareConcurrency: number
  devicePixelRatio: number
  screen: { width: number; height: number }
  renderer: string
}

let cached: Capabilities | null = null

export function detectCapabilities(gl?: WebGL2RenderingContext | WebGLRenderingContext | null): Capabilities {
  if (cached) return cached
  const ctx = gl ?? null
  const anyCtx = ctx as (WebGL2RenderingContext & { getExtension(n: string): unknown }) | null
  let maxAniso = 0
  let renderer = 'unknown'
  try {
    const ext = anyCtx?.getExtension('EXT_texture_filter_anisotropic') as { MAX_TEXTURE_MAX_ANISOTROPY_EXT: number } | null
    if (ext && ctx) maxAniso = ctx.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number
    const dbg = anyCtx?.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null
    if (dbg && ctx) renderer = String(ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
  } catch { /* extension probing is best-effort */ }

  const nav = navigator as Navigator & { deviceMemory?: number; mediaDevices?: MediaDevices }
  const audioProto = typeof HTMLMediaElement !== 'undefined' ? HTMLMediaElement.prototype : null

  cached = {
    webgl2: !!ctx && typeof WebGL2RenderingContext !== 'undefined' && ctx instanceof WebGL2RenderingContext,
    maxTextureSize: ctx ? (ctx.getParameter(ctx.MAX_TEXTURE_SIZE) as number) : 4096,
    maxAnisotropy: Math.max(1, Math.floor(maxAniso)),
    maxSamples: ctx && 'MAX_SAMPLES' in ctx ? ((ctx as WebGL2RenderingContext).getParameter((ctx as WebGL2RenderingContext).MAX_SAMPLES) as number) : 1,
    maxRenderBufferSize: ctx ? (ctx.getParameter(ctx.MAX_RENDERBUFFER_SIZE) as number) : 4096,
    hdrDisplay: typeof matchMedia === 'function' && matchMedia('(dynamic-range: high)').matches,
    fullscreen: typeof document !== 'undefined' && (document.fullscreenEnabled ?? false),
    audioOutputSelection: !!(audioProto && 'setSinkId' in audioProto)
      || !!(typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype),
    audioInputSelection: !!nav.mediaDevices?.enumerateDevices,
    deviceMemoryGB: nav.deviceMemory ?? null,
    hardwareConcurrency: nav.hardwareConcurrency || 4,
    devicePixelRatio: window.devicePixelRatio || 1,
    screen: { width: window.screen?.width ?? 1920, height: window.screen?.height ?? 1080 },
    renderer,
  }
  return cached
}

/** Things the web platform simply does not expose, with the honest reason. */
export const UNAVAILABLE: Record<string, string> = {
  dlss: 'NVIDIA DLSS is a driver/native-SDK feature; browsers do not expose it to WebGL. Use render scale + sharpening below.',
  fsr: 'AMD FSR ships as engine source for native APIs. The spatial upscaler below (render scale + contrast-adaptive sharpen) is the same idea in WebGL.',
  xess: 'Intel XeSS requires native GPU access; not reachable from WebGL.',
  frameGen: 'Frame generation needs driver-level frame pacing and optical flow hardware. Not available to any browser API.',
  rayTracing: 'Hardware ray tracing needs WebGPU + vendor extensions that no browser exposes yet. Screen-space reflections below are the WebGL equivalent.',
  vsyncToggle: 'Browsers drive rendering through requestAnimationFrame, which is always display-synced. Use the frame cap instead.',
  hdrOutput: 'WebGL canvases cannot request an HDR swapchain in this browser. Exposure/tone mapping below still let you calibrate for an HDR panel.',
  vramLimit: 'WebGL cannot query or reserve VRAM. The budgets below cap what FORM/0 itself keeps resident, which is the part we control.',
}
