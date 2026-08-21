import { UNAVAILABLE, type Capabilities } from './capabilities'

/**
 * The settings schema. One declarative list drives persistence, the panel UI,
 * the quality presets and the "why is this greyed out" copy — so a new setting
 * is added in exactly one place.
 */
export type SettingKind = 'toggle' | 'select' | 'slider' | 'number' | 'color' | 'swatches' | 'action' | 'info'

export interface SettingDef {
  id: string
  label: string
  group: GroupId
  kind: SettingKind
  default?: unknown
  min?: number
  max?: number
  step?: number
  unit?: string
  options?: { value: string; label: string }[]
  /** Device-backed selects (audio input/output) may persist an option that is discovered at runtime. */
  allowCustomOption?: boolean
  hint?: string
  /** greyed out with this reason when the platform can't do it */
  unavailable?: (caps: Capabilities) => string | null
  /** hidden unless another setting is set to one of these values */
  showIf?: (v: SettingsValues) => boolean
  /** changing this needs a reload / new model load to take full effect */
  deferred?: boolean
}

export type GroupId =
  | 'presets' | 'display' | 'framerate' | 'aa' | 'textures'
  | 'lighting' | 'post' | 'camera' | 'memory' | 'audio' | 'interface'

export const GROUPS: { id: GroupId; label: string; icon: string }[] = [
  { id: 'presets', label: 'Quality preset', icon: 'M4 7h16M4 12h16M4 17h10' },
  { id: 'display', label: 'Display & resolution', icon: 'M3 5h18v11H3zM8 20h8' },
  { id: 'framerate', label: 'Framerate & sync', icon: 'M12 7v5l3 2M3 12a9 9 0 1018 0 9 9 0 10-18 0' },
  { id: 'aa', label: 'Anti-aliasing & upscaling', icon: 'M4 18L12 6l8 12M8 14h8' },
  { id: 'textures', label: 'Textures & materials', icon: 'M4 4h16v16H4zM4 10h16M10 4v16' },
  { id: 'lighting', label: 'Lighting & shadows', icon: 'M12 4v2M12 18v2M5 12H3M21 12h-2M6 6l1.5 1.5M16.5 16.5L18 18M18 6l-1.5 1.5M7.5 16.5L6 18M12 8a4 4 0 100 8 4 4 0 100-8' },
  { id: 'post', label: 'Post-processing', icon: 'M5 12a7 7 0 1114 0 7 7 0 01-14 0M12 3v2M12 19v2' },
  { id: 'camera', label: 'Camera', icon: 'M4 8h3l2-2h6l2 2h3v11H4zM12 16a3.5 3.5 0 100-7 3.5 3.5 0 000 7' },
  { id: 'memory', label: 'Memory & cache', icon: 'M4 6h16v12H4zM8 6v12M16 6v12' },
  { id: 'audio', label: 'Audio', icon: 'M5 10v4h3l4 4V6L8 10H5M16 9a4 4 0 010 6' },
  { id: 'interface', label: 'Interface', icon: 'M4 5h16v14H4zM4 9h16' },
]

export type SettingsValues = Record<string, string | number | boolean>

const pct = { min: 0, max: 100, step: 1, unit: '%' }

export const SETTINGS: SettingDef[] = [
  // ------------------------------------------------------------ presets
  {
    id: 'preset', label: 'Preset', group: 'presets', kind: 'select', default: 'high',
    options: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'ultra', label: 'Ultra' },
      { value: 'custom', label: 'Custom' },
    ],
    hint: 'Changing any setting below switches this to Custom.',
  },

  // ------------------------------------------------------------ display
  {
    id: 'resolutionMode', label: 'Resolution', group: 'display', kind: 'select', default: 'auto',
    options: [
      { value: 'auto', label: 'Auto (display ratio, adaptive)' },
      { value: 'scale', label: 'Scale factor' },
      { value: 'manual', label: 'Manual (exact pixels)' },
    ],
  },
  {
    id: 'renderScale', label: 'Render scale', group: 'display', kind: 'slider', default: 100,
    min: 25, max: 200, step: 5, unit: '%',
    hint: 'Below 100% the frame is rendered smaller and upscaled — the WebGL equivalent of a spatial upscaler.',
    showIf: (v) => v.resolutionMode === 'scale',
  },
  {
    id: 'renderScalePow2', label: 'Snap to powers of two', group: 'display', kind: 'toggle', default: false,
    hint: 'Restrict the scale to ×4, ×2, ÷2, ÷4 … (exact texel mapping, cheapest filtering).',
    showIf: (v) => v.resolutionMode === 'scale',
  },
  {
    id: 'resolutionWidth', label: 'Width', group: 'display', kind: 'number', default: 1920,
    min: 2, max: 16384, step: 1, unit: 'px', showIf: (v) => v.resolutionMode === 'manual',
  },
  {
    id: 'resolutionHeight', label: 'Height', group: 'display', kind: 'number', default: 1080,
    min: 2, max: 16384, step: 1, unit: 'px',
    showIf: (v) => v.resolutionMode === 'manual' && !v.aspectLock,
  },
  {
    id: 'aspectLock', label: 'Tie height to window aspect', group: 'display', kind: 'toggle', default: true,
    // AMENDMENT 79: with this OFF the buffer aspect no longer has to match the
    // window, and the canvas used to be stretched to fill it — a 16:9 buffer
    // in a 4:3 window drew circles as ellipses. The canvas is now LETTERBOXED
    // to the chosen aspect instead. Say so, because "black bars appear" is a
    // visible consequence of the toggle, not a bug.
    hint: 'On: height follows the window, the canvas always fills it. Off: the exact width × height below is rendered and letterboxed (bars) so the picture is never stretched.',
    showIf: (v) => v.resolutionMode === 'manual',
  },
  {
    id: 'displayMode', label: 'Display mode', group: 'display', kind: 'select', default: 'windowed',
    options: [{ value: 'windowed', label: 'Windowed' }, { value: 'fullscreen', label: 'Fullscreen' }],
    unavailable: (c) => (c.fullscreen ? null : 'This browser blocks the Fullscreen API here.'),
  },
  {
    id: 'powerPreference', label: 'GPU power preference', group: 'display', kind: 'select', default: 'high-performance',
    options: [
      { value: 'default', label: 'Default (browser decides)' },
      { value: 'high-performance', label: 'High performance' },
      { value: 'low-power', label: 'Low power' },
    ],
    hint: 'A context-creation hint: on dual-GPU laptops it picks integrated vs. discrete. Takes effect on the next launch.',
    deferred: true,
  },
  {
    id: 'hdr', label: 'HDR output', group: 'display', kind: 'info',
    unavailable: () => UNAVAILABLE.hdrOutput,
    hint: 'Detected display range is reported below.',
  },
  { id: 'brightness', label: 'Brightness', group: 'display', kind: 'slider', default: 100, min: 25, max: 250, step: 1, unit: '%' },
  { id: 'contrast', label: 'Contrast', group: 'display', kind: 'slider', default: 100, min: 50, max: 200, step: 1, unit: '%' },
  {
    id: 'toneMapping', label: 'Tone mapping', group: 'display', kind: 'select', default: 'none',
    options: [
      { value: 'none', label: 'Off' },
      { value: 'standard', label: 'Standard' },
      { value: 'aces', label: 'ACES filmic' },
      { value: 'pbrNeutral', label: 'Khronos PBR Neutral' },
    ],
    hint: 'Khronos PBR Neutral is the glTF reference curve: mid-tones stay colour-accurate while highlights roll off gently.',
  },
  {
    id: 'dithering', label: 'Dithering', group: 'display', kind: 'toggle', default: false,
    hint: 'Adds a fine noise grain to the final colour, hiding banding in smooth gradients.',
  },
  { id: 'calibration', label: 'Show calibration pattern', group: 'display', kind: 'action', hint: 'Greyscale ramp + clipping bars. Raise brightness until the darkest bar is just visible.' },

  // ---------------------------------------------------------- framerate
  { id: 'fpsUncapped', label: 'Uncapped framerate', group: 'framerate', kind: 'toggle', default: true },
  {
    id: 'fpsLimit', label: 'Frame limit', group: 'framerate', kind: 'number', default: 60,
    min: 5, max: 1000, step: 1, unit: 'fps', showIf: (v) => !v.fpsUncapped,
  },
  {
    id: 'vsync', label: 'V-Sync', group: 'framerate', kind: 'info',
    unavailable: () => UNAVAILABLE.vsyncToggle,
  },
  {
    id: 'adaptiveResolution', label: 'Adaptive resolution', group: 'framerate', kind: 'toggle', default: true,
    hint: 'Drops the render scale automatically when frames get slow, restores it when they recover.',
  },
  {
    id: 'idleThrottle', label: 'Stop drawing when idle', group: 'framerate', kind: 'toggle', default: true,
    hint: 'A still board renders zero frames. Turn off only when debugging the render loop.',
  },

  // ----------------------------------------------------------------- AA
  {
    id: 'msaa', label: 'MSAA', group: 'aa', kind: 'select', default: '4',
    options: [
      { value: '1', label: 'Off' }, { value: '2', label: '2×' },
      { value: '4', label: '4×' }, { value: '8', label: '8×' },
    ],
    unavailable: (c) => (c.maxSamples > 1 ? null : 'This GPU/driver reports no multisample support.'),
  },
  { id: 'fxaa', label: 'FXAA', group: 'aa', kind: 'toggle', default: false, hint: 'Cheap post-process edge smoothing; softens the whole image.' },
  {
    id: 'taa', label: 'Temporal AA (TXAA-style)', group: 'aa', kind: 'toggle', default: false,
    hint: 'Accumulates jittered frames while the camera is still. Costs extra frames after each movement.',
    unavailable: (c) => (c.webgl2 ? null : 'Temporal AA needs WebGL2.'),
  },
  { id: 'taaSamples', label: 'TAA samples', group: 'aa', kind: 'slider', default: 8, min: 2, max: 32, step: 1, showIf: (v) => !!v.taa },
  {
    id: 'upscaler', label: 'Upscaler', group: 'aa', kind: 'select', default: 'off',
    options: [
      { value: 'off', label: 'Off (native)' },
      { value: 'spatial', label: 'Spatial (render scale + sharpen)' },
    ],
    hint: 'DLSS / FSR / XeSS are native-only; this is the WebGL equivalent.',
  },
  {
    id: 'upscalerMode', label: 'Upscaler mode', group: 'aa', kind: 'select', default: 'quality',
    options: [
      { value: 'ultraQuality', label: 'Ultra quality (77%)' },
      { value: 'quality', label: 'Quality (67%)' },
      { value: 'balanced', label: 'Balanced (59%)' },
      { value: 'performance', label: 'Performance (50%)' },
      { value: 'ultraPerformance', label: 'Ultra performance (33%)' },
    ],
    showIf: (v) => v.upscaler === 'spatial',
  },
  { id: 'sharpness', label: 'Sharpness', group: 'aa', kind: 'slider', default: 30, ...pct, showIf: (v) => v.upscaler === 'spatial' || !!v.sharpen },
  { id: 'sharpen', label: 'Sharpening', group: 'aa', kind: 'toggle', default: false },
  { id: 'dlss', label: 'DLSS', group: 'aa', kind: 'info', unavailable: () => UNAVAILABLE.dlss },
  { id: 'fsr', label: 'FSR', group: 'aa', kind: 'info', unavailable: () => UNAVAILABLE.fsr },
  { id: 'xess', label: 'XeSS', group: 'aa', kind: 'info', unavailable: () => UNAVAILABLE.xess },
  { id: 'frameGen', label: 'Frame generation', group: 'aa', kind: 'info', unavailable: () => UNAVAILABLE.frameGen },

  // ----------------------------------------------------------- textures
  {
    id: 'pbr', label: 'Physically based rendering', group: 'textures', kind: 'toggle', default: true,
    hint: 'Off = unlit flat shading: every material renders as its base colour. Fastest possible path.',
  },
  { id: 'pbrSpecular', label: 'Specular highlights', group: 'textures', kind: 'toggle', default: true, showIf: (v) => !!v.pbr },
  { id: 'pbrReflections', label: 'Reflections', group: 'textures', kind: 'toggle', default: true, showIf: (v) => !!v.pbr },
  {
    id: 'textureQuality', label: 'Skip models with textures over', group: 'textures', kind: 'select', default: '0',
    options: [
      { value: '512', label: '512 px' }, { value: '1024', label: '1024 px' },
      { value: '2048', label: '2048 px' }, { value: '4096', label: '4096 px' },
      { value: '0', label: 'No extra limit' },
    ],
    hint: 'WebGL cannot downscale a model\'s textures after decode, so this is a load-time guard: posts above the cap are skipped instead of thrashing VRAM. The spec cap (4096 px / 128 MiB decoded) always applies.',
    deferred: true,
  },
  {
    id: 'anisotropy', label: 'Anisotropic filtering', group: 'textures', kind: 'select', default: '4',
    options: [
      { value: '1', label: 'Off' }, { value: '2', label: '2×' }, { value: '4', label: '4×' },
      { value: '8', label: '8×' }, { value: '16', label: '16×' },
    ],
    unavailable: (c) => (c.maxAnisotropy > 1 ? null : 'No EXT_texture_filter_anisotropic on this GPU.'),
  },
  { id: 'mipmaps', label: 'Mipmapping', group: 'textures', kind: 'toggle', default: true, deferred: true },
  {
    id: 'previewWidth', label: 'Card / preview width', group: 'textures', kind: 'slider', default: 448,
    min: 32, max: 4096, step: 1, unit: 'px',
    hint: 'Width of each card live-preview render target (height is fixed at width × 5/8 to match the poster aspect). Bigger = sharper but more GPU per active slot.',
    deferred: true,
  },

  // ----------------------------------------------------------- lighting
  {
    id: 'shadows', label: 'Shadows', group: 'lighting', kind: 'select', default: 'contact',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'contact', label: 'Contact shadows only' },
      { value: 'dynamic', label: 'Dynamic (self-shadowing)' },
      { value: 'cascaded', label: 'Cascaded (large scenes)' },
    ],
  },
  {
    id: 'shadowQuality', label: 'Shadow map resolution', group: 'lighting', kind: 'select', default: '1024',
    options: [
      { value: '512', label: '512' }, { value: '1024', label: '1024' },
      { value: '2048', label: '2048' }, { value: '4096', label: '4096' },
    ],
    showIf: (v) => v.shadows === 'dynamic' || v.shadows === 'cascaded',
  },
  { id: 'shadowSoftness', label: 'Shadow softness', group: 'lighting', kind: 'slider', default: 40, ...pct, showIf: (v) => v.shadows === 'dynamic' },
  {
    id: 'shadowFilter', label: 'Shadow filtering', group: 'lighting', kind: 'select', default: 'blurESM',
    options: [
      { value: 'blurESM', label: 'Blur exponential (smooth)' },
      { value: 'esm', label: 'Exponential (sharpest)' },
      { value: 'pcf', label: 'PCF (percentage closer)' },
      { value: 'pcss', label: 'PCSS (contact hardening)' },
    ],
    showIf: (v) => v.shadows === 'dynamic',
    hint: 'PCSS softens shadows the further they land from the caster. Cascaded mode filters itself (PCF + cascade blend).',
  },
  {
    id: 'shadowBias', label: 'Shadow bias', group: 'lighting', kind: 'slider', default: 5, min: 0, max: 100, step: 1,
    showIf: (v) => v.shadows === 'dynamic' || v.shadows === 'cascaded',
    hint: 'Depth offset against shadow acne stripes. Raise only until the artefacts vanish — too much detaches shadows.',
  },
  {
    id: 'shadowNormalBias', label: 'Shadow normal bias', group: 'lighting', kind: 'slider', default: 10, min: 0, max: 100, step: 1,
    showIf: (v) => v.shadows === 'dynamic' || v.shadows === 'cascaded',
    hint: 'Offset along the surface normal; helps on curved or thin geometry.',
  },
  { id: 'contactShadowStrength', label: 'Contact shadow strength', group: 'lighting', kind: 'slider', default: 55, ...pct, showIf: (v) => v.shadows !== 'off' },
  {
    id: 'ao', label: 'Ambient occlusion', group: 'lighting', kind: 'select', default: 'off',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'ssao', label: 'SSAO (cheap)' },
      { value: 'ssao2', label: 'SSAO2 / HBAO-class' },
    ],
    unavailable: (c) => (c.webgl2 ? null : 'SSAO2 needs WebGL2 (depth textures + MRT).'),
  },
  { id: 'aoStrength', label: 'AO strength', group: 'lighting', kind: 'slider', default: 100, min: 0, max: 200, step: 1, unit: '%', showIf: (v) => v.ao !== 'off' },
  { id: 'aoSamples', label: 'AO samples', group: 'lighting', kind: 'slider', default: 8, min: 4, max: 32, step: 1, showIf: (v) => v.ao === 'ssao2' },
  {
    id: 'ssr', label: 'Screen-space reflections', group: 'lighting', kind: 'toggle', default: false,
    hint: 'The WebGL stand-in for ray-traced reflections. Expensive.',
    unavailable: (c) => (c.webgl2 ? null : 'SSR needs WebGL2.'),
  },
  { id: 'rayTracing', label: 'Hardware ray tracing', group: 'lighting', kind: 'info', unavailable: () => UNAVAILABLE.rayTracing },
  { id: 'lightIntensity', label: 'Light rig intensity', group: 'lighting', kind: 'slider', default: 100, min: 20, max: 200, step: 1, unit: '%' },
  {
    id: 'fog', label: 'Fog', group: 'lighting', kind: 'select', default: 'off',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'linear', label: 'Linear' },
      { value: 'exp', label: 'Exponential' },
      { value: 'exp2', label: 'Exponential squared' },
    ],
    hint: 'Camera-distance atmosphere in the viewer and studio.',
  },
  { id: 'fogDensity', label: 'Fog density', group: 'lighting', kind: 'slider', default: 40, min: 1, max: 200, step: 1, showIf: (v) => v.fog === 'exp' || v.fog === 'exp2' },
  { id: 'fogStart', label: 'Fog start', group: 'lighting', kind: 'slider', default: 2, min: 0, max: 200, step: 0.5, showIf: (v) => v.fog === 'linear' },
  { id: 'fogEnd', label: 'Fog end', group: 'lighting', kind: 'slider', default: 40, min: 1, max: 2000, step: 1, showIf: (v) => v.fog === 'linear' },
  { id: 'fogColor', label: 'Fog colour', group: 'lighting', kind: 'color', default: '#0B0B0C', showIf: (v) => v.fog !== 'off' },

  // --------------------------------------------------------------- post
  { id: 'bloom', label: 'Bloom', group: 'post', kind: 'toggle', default: false },
  { id: 'bloomStrength', label: 'Bloom strength', group: 'post', kind: 'slider', default: 40, ...pct, showIf: (v) => !!v.bloom },
  {
    id: 'bloomQuality', label: 'Bloom quality', group: 'post', kind: 'select', default: 'medium',
    options: [
      { value: 'low', label: 'Low (kernel 16)' }, { value: 'medium', label: 'Medium (kernel 32)' },
      { value: 'high', label: 'High (kernel 64)' }, { value: 'ultra', label: 'Ultra (kernel 128)' },
    ],
    showIf: (v) => !!v.bloom,
  },
  { id: 'bloomThreshold', label: 'Bloom threshold', group: 'post', kind: 'slider', default: 80, ...pct, showIf: (v) => !!v.bloom },
  { id: 'vignette', label: 'Vignette', group: 'post', kind: 'toggle', default: false },
  { id: 'grain', label: 'Film grain', group: 'post', kind: 'toggle', default: false },
  { id: 'grainIntensity', label: 'Grain intensity', group: 'post', kind: 'slider', default: 15, ...pct, showIf: (v) => !!v.grain },
  {
    id: 'dof', label: 'Depth of field', group: 'post', kind: 'toggle', default: false,
    hint: 'Lens-style blur by distance from the focus plane. Viewer & studio only.',
    unavailable: (c) => (c.webgl2 ? null : 'Depth of field needs WebGL2 (depth textures).'),
  },
  {
    id: 'dofFStop', label: 'Aperture (f-stop)', group: 'post', kind: 'slider', default: 1.4, min: 0.8, max: 22, step: 0.1, unit: 'ƒ/',
    hint: 'Lower f-stop = shallower depth of field = stronger background blur.',
    showIf: (v) => !!v.dof,
  },
  { id: 'dofFocus', label: 'Focus distance', group: 'post', kind: 'slider', default: 2000, min: 100, max: 20000, step: 50, unit: 'mm', showIf: (v) => !!v.dof },
  {
    id: 'dofQuality', label: 'Blur quality', group: 'post', kind: 'select', default: 'medium',
    options: [
      { value: 'low', label: 'Low (subtle)' },
      { value: 'medium', label: 'Medium (standard)' },
      { value: 'high', label: 'High (fine)' },
    ],
    showIf: (v) => !!v.dof,
  },
  {
    id: 'chromaticAberration', label: 'Chromatic aberration', group: 'post', kind: 'toggle', default: false,
    hint: 'Colour fringing toward the frame edges, like a cheap lens.',
  },
  { id: 'caAmount', label: 'Aberration amount', group: 'post', kind: 'slider', default: 30, min: 0, max: 100, step: 1, showIf: (v) => !!v.chromaticAberration },
  {
    id: 'glow', label: 'Glow (emissive)', group: 'post', kind: 'toggle', default: false,
    hint: 'Emissive surfaces bleed light. Unlike bloom this is per-material, not a whole-screen threshold.',
  },
  { id: 'glowIntensity', label: 'Glow intensity', group: 'post', kind: 'slider', default: 60, min: 0, max: 200, step: 1, unit: '%', showIf: (v) => !!v.glow },
  {
    id: 'motionBlur', label: 'Motion blur', group: 'post', kind: 'toggle', default: false,
    hint: 'Velocity-based blur while geometry or the camera moves. Render-on-demand stills come out clean.',
    unavailable: (c) => (c.webgl2 ? null : 'Motion blur needs WebGL2 (velocity render targets).'),
  },
  { id: 'motionBlurStrength', label: 'Motion blur strength', group: 'post', kind: 'slider', default: 100, min: 0, max: 200, step: 1, unit: '%', showIf: (v) => !!v.motionBlur },
  {
    id: 'curvature', label: 'Surface curvature', group: 'post', kind: 'toggle', default: false,
    hint: 'Tints ridges white and valleys black — the CAD inspection view for a model\'s surface.',
    unavailable: (c) => (c.webgl2 ? null : 'Surface curvature needs WebGL2 (normal buffer render targets).'),
  },
  { id: 'curvatureStrength', label: 'Curvature strength', group: 'post', kind: 'slider', default: 100, min: 0, max: 200, step: 1, unit: '%', showIf: (v) => !!v.curvature },
  {
    id: 'highlight', label: 'Model outline', group: 'post', kind: 'toggle', default: false,
    hint: 'Draws a rim outline around the open model in the viewer.',
  },
  { id: 'highlightColor', label: 'Outline colour', group: 'post', kind: 'color', default: '#FF5C35', showIf: (v) => !!v.highlight },

  // ------------------------------------------------------------- camera
  { id: 'fov', label: 'Field of view', group: 'camera', kind: 'slider', default: 46, min: 20, max: 120, step: 1, unit: '°' },
  { id: 'nearClip', label: 'Near clip plane', group: 'camera', kind: 'number', default: 0.01, min: 0.0001, max: 10, step: 0.001 },
  { id: 'farClip', label: 'Far clip plane', group: 'camera', kind: 'number', default: 2000, min: 10, max: 1000000, step: 10 },
  { id: 'cameraInertia', label: 'Camera inertia', group: 'camera', kind: 'slider', default: 70, ...pct },
  { id: 'invertY', label: 'Invert vertical orbit', group: 'camera', kind: 'toggle', default: false },

  // ------------------------------------------------------------- memory
  { id: 'vramInfo', label: 'VRAM limit', group: 'memory', kind: 'info', unavailable: () => UNAVAILABLE.vramLimit },
  { id: 'modelRamBudget', label: 'Model cache in RAM', group: 'memory', kind: 'slider', default: 48, min: 8, max: 512, step: 8, unit: 'MiB' },
  { id: 'textureBudget', label: 'Resident card textures', group: 'memory', kind: 'slider', default: 32, min: 8, max: 128, step: 4 },
  { id: 'livePreviews', label: 'Live preview slots', group: 'memory', kind: 'slider', default: 5, min: 0, max: 12, step: 1 },
  { id: 'prefetch', label: 'Preload distance', group: 'memory', kind: 'slider', default: 100, min: 0, max: 300, step: 10, unit: '% screen' },
  { id: 'keepOffscreen', label: 'Keep offscreen models loaded', group: 'memory', kind: 'toggle', default: false },
  { id: 'clearCache', label: 'Clear cached models & posters', group: 'memory', kind: 'action' },

  // -------------------------------------------------------------- audio
  {
    id: 'audioOutput', label: 'Output device', group: 'audio', kind: 'select', default: 'default',
    options: [{ value: 'default', label: 'System default' }], allowCustomOption: true,
    unavailable: (c) => (c.audioOutputSelection ? null : 'This browser does not support choosing an audio output device (setSinkId).'),
  },
  {
    id: 'audioInput', label: 'Input device', group: 'audio', kind: 'select', default: 'default',
    options: [{ value: 'default', label: 'System default' }], allowCustomOption: true,
    unavailable: (c) => (c.audioInputSelection ? null : 'No media device enumeration in this browser.'),
    hint: 'Used by in-app recording (spec 05b) once it lands.',
  },
  { id: 'volMaster', label: 'Master', group: 'audio', kind: 'slider', default: 100, ...pct },
  { id: 'volMusic', label: 'Music', group: 'audio', kind: 'slider', default: 80, ...pct },
  { id: 'volSfx', label: 'Effects', group: 'audio', kind: 'slider', default: 100, ...pct },
  { id: 'volVoice', label: 'Voice / dialogue', group: 'audio', kind: 'slider', default: 100, ...pct },
  { id: 'volUi', label: 'Interface', group: 'audio', kind: 'slider', default: 60, ...pct },
  {
    id: 'spatialAudio', label: 'Spatial audio', group: 'audio', kind: 'select', default: 'stereo',
    options: [
      { value: 'mono', label: 'Mono' },
      { value: 'stereo', label: 'Stereo' },
      { value: 'hrtf', label: '3D spatial (HRTF)' },
      { value: 'surround', label: 'Surround passthrough (5.1 / 7.1)' },
    ],
    hint: 'Dolby Atmos / Windows Sonic are applied by the OS on the selected output device.',
  },
  { id: 'audioBackground', label: 'Play audio when unfocused', group: 'audio', kind: 'toggle', default: false },

  // ---------------------------------------------------------- interface
  { id: 'background', label: 'Background', group: 'interface', kind: 'swatches', default: '#0B0B0C' },
  { id: 'inertia', label: 'Scroll inertia', group: 'interface', kind: 'slider', default: 70, ...pct },
  {
    id: 'autoplayAnimations', label: 'Autoplay animations', group: 'interface', kind: 'toggle', default: true,
    hint: 'Cards and thread nodes start animating when they come into view. Off = everything opens paused; the ▶ button on a card is the only way to start. Sound always needs that button tap (browsers block audio without a gesture).',
  },
  {
    id: 'direct3D', label: 'Show posts as 3D models', group: 'interface', kind: 'toggle', default: false,
    hint: 'Board cards and thread nodes render each post as its real 3D model, animated in place — no poster snapshot, no render-to-texture. Heavier on the GPU: models load near the viewport only, so turn this off on weak devices.',
  },
  { id: 'reduceMotion', label: 'Reduce motion', group: 'interface', kind: 'toggle', default: false },
{ id: 'showFps', label: 'Show performance overlay', group: 'interface', kind: 'toggle', default: false },

  // --- Selection highlight in the studio (Babylon HighlightLayer under the
  // hood; color + thickness both configurable, persisted via the normal
  // settings pipeline so a quality preset can pick its own look).
  { id: 'selectionHighlight', label: 'Selection outline', group: 'interface', kind: 'toggle', default: true },
  { id: 'selectionHighlightColor', label: 'Outline colour', group: 'interface', kind: 'color', default: '#FFFFFF', showIf: (v) => !!v.selectionHighlight },
  { id: 'selectionHighlightThickness', label: 'Outline thickness', group: 'interface', kind: 'slider', default: 2, min: 1, max: 8, step: 1, showIf: (v) => !!v.selectionHighlight,
    hint: '1 = hairline glow, 8 = thick rim. Higher values blur further past the mesh silhouette.' },
] 

export const BY_ID: Record<string, SettingDef> = Object.fromEntries(SETTINGS.map((s) => [s.id, s]))

const HEX_COLOR = /^#[0-9a-f]{6}$/i
const SAFE_OPTION = /^[^\u0000-\u001f\u007f]{1,512}$/

/**
 * Accept a persisted/UI value only when it matches its schema entry. Keeping
 * this next to SETTINGS makes the schema the source of truth for both the UI
 * and the trust boundary at IndexedDB.
 */
export function normalizeSettingValue(def: SettingDef, value: unknown): string | number | boolean | undefined {
  switch (def.kind) {
    case 'toggle':
      return typeof value === 'boolean' ? value : undefined
    case 'slider':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
      if (def.min !== undefined && value < def.min) return undefined
      if (def.max !== undefined && value > def.max) return undefined
      return value
    }
    case 'select': {
      if (typeof value !== 'string') return undefined
      if (def.options?.some((o) => o.value === value)) return value
      return def.allowCustomOption && SAFE_OPTION.test(value) ? value : undefined
    }
    case 'color':
    case 'swatches':
      return typeof value === 'string' && HEX_COLOR.test(value) ? value : undefined
    // Actions and capability readouts are not state and must never be loaded
    // from persistence, even if a tampered record contains matching keys.
    case 'action':
    case 'info':
      return undefined
  }
}

export function defaults(): SettingsValues {
  const out: SettingsValues = {}
  for (const s of SETTINGS) if (s.default !== undefined) out[s.id] = s.default as string | number | boolean
  return out
}

/** Drop unknown, mistyped, non-finite and out-of-range persisted values. */
export function sanitizeSettingsRecord(saved: unknown): SettingsValues {
  const out = defaults()
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return out
  const record = saved as Record<string, unknown>
  for (const def of SETTINGS) {
    if (!Object.prototype.hasOwnProperty.call(record, def.id)) continue
    const normalized = normalizeSettingValue(def, record[def.id])
    if (normalized !== undefined) out[def.id] = normalized
  }

  // These values are individually legal at the schema edges (10), but an
  // equal/inverted clip range makes Babylon's projection matrix unusable.
  if (Number(out.nearClip) >= Number(out.farClip)) {
    out.nearClip = BY_ID.nearClip.default as number
    out.farClip = BY_ID.farClip.default as number
  }
  // Same story for the linear fog range: start < end or the fog ramp inverts.
  if (Number(out.fogStart) >= Number(out.fogEnd)) {
    out.fogStart = BY_ID.fogStart.default as number
    out.fogEnd = BY_ID.fogEnd.default as number
  }
  return out
}

/** Quality presets — only the graphics keys; interface/audio are never touched. */
export const PRESETS: Record<string, SettingsValues> = {
  // Low = NO post-processing pipeline at all: no AA of any kind, no upscaler,
  // no sharpen, no bloom/grain/vignette, nothing. The work goes into a low
  // render scale instead — the cheapest thing a weak GPU can be given. All
  // pipeline-owning keys are listed explicitly so switching DOWN to Low also
  // turns off post effects the user may have switched on before.
  low: {
    resolutionMode: 'scale', renderScale: 65, renderScalePow2: false, adaptiveResolution: true,
    msaa: '1', fxaa: false, taa: false, upscaler: 'off', sharpen: false, sharpness: 30,
    pbr: false, pbrSpecular: false, pbrReflections: false, textureQuality: '1024', anisotropy: '1', mipmaps: true,
    previewWidth: 224, shadows: 'off', ao: 'off', ssr: false,
    bloom: false, vignette: false, grain: false,
    dof: false, chromaticAberration: false, glow: false, motionBlur: false, curvature: false, highlight: false,
    modelRamBudget: 16, textureBudget: 12, livePreviews: 1, prefetch: 50,
  },
  medium: {
    resolutionMode: 'auto', renderScale: 100, adaptiveResolution: true,
    msaa: '2', fxaa: true, taa: false, upscaler: 'off', sharpen: false, sharpness: 30,
    pbr: true, pbrSpecular: true, pbrReflections: false, textureQuality: '0', anisotropy: '4', mipmaps: true,
    previewWidth: 320, shadows: 'contact', contactShadowStrength: 45, ao: 'off', ssr: false,
    bloom: false, vignette: false, grain: false,
    dof: false, chromaticAberration: false, glow: false, motionBlur: false, curvature: false, highlight: false,
    modelRamBudget: 32, textureBudget: 24, livePreviews: 3, prefetch: 100,
  },
  high: {
    resolutionMode: 'auto', renderScale: 100, adaptiveResolution: true,
    msaa: '4', fxaa: false, taa: false, upscaler: 'off', sharpen: false, sharpness: 30,
    pbr: true, pbrSpecular: true, pbrReflections: true, textureQuality: '0', anisotropy: '8', mipmaps: true,
    previewWidth: 448, shadows: 'contact', contactShadowStrength: 55, ao: 'ssao2', aoStrength: 90, aoSamples: 8, ssr: false,
    bloom: true, bloomStrength: 30, bloomQuality: 'medium', bloomThreshold: 85, vignette: false, grain: false,
    dof: false, chromaticAberration: false, glow: false, motionBlur: false, curvature: false, highlight: false,
    modelRamBudget: 48, textureBudget: 32, livePreviews: 5, prefetch: 100,
  },
  ultra: {
    resolutionMode: 'scale', renderScale: 150, renderScalePow2: false, adaptiveResolution: false,
    msaa: '8', fxaa: false, taa: true, taaSamples: 16, upscaler: 'off', sharpen: true, sharpness: 20,
    pbr: true, pbrSpecular: true, pbrReflections: true, textureQuality: '0', anisotropy: '16', mipmaps: true,
    previewWidth: 640, shadows: 'dynamic', shadowQuality: '2048', shadowSoftness: 45,
    contactShadowStrength: 60, ao: 'ssao2', aoStrength: 110, aoSamples: 16, ssr: true,
    bloom: true, bloomStrength: 45, bloomQuality: 'ultra', bloomThreshold: 78, vignette: true, grain: false,
    dof: false, chromaticAberration: false, glow: false, motionBlur: false, curvature: false, highlight: false,
    modelRamBudget: 128, textureBudget: 64, livePreviews: 8, prefetch: 200,
  },
}

/** Keys a preset owns — used to decide whether the current state is "custom". */
export const PRESET_KEYS = Object.keys(PRESETS.high)
