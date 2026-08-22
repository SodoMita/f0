export const theme = {
  background: '#0B0B0C',
  panel: '#141418',
  ink: '#F2EEE8',
  muted: '#827E79',
  accent: '#FF5C35',
  success: '#98CA72',
  warning: '#F4C95D',
  danger: '#FF674B',
} as const

export const FORM_ZERO_TAG = 'form-zero'
export const MODEL_KIND = 1063
export const DELETE_KIND = 5
export const BLOSSOM_AUTH_KIND = 24242
export const MODEL_MIMES = ['model/gltf-binary', 'model/gltf+json'] as const

// v4 post format: posters are NEVER fetched — every client renders them from
// the model. A post declares its rendered image size via the `dim` tag
// (`WxH`, e.g. `448x280`); these are the defaults a publisher renders at and
// the fallback for posts (older format) that carry no `dim`.
export const POSTER_W = 448
export const POSTER_H = 280
// Spec 08 §1 / 07 §4. Enforced BEFORE bytes reach Babylon (crash prevention).
export const LIMITS = {
  modelBytesHard: 20 * 1024 * 1024,
  modelBytesRecommended: 8 * 1024 * 1024,
  jsonChunkBytes: 2 * 1024 * 1024,
  nodes: 2000,
  meshes: 500,
  primitives: 1000,
  vertices: 2_000_000,
  indices: 6_000_000,
  materials: 256,
  textures: 64,
  textureSide: 4096,
  decodedPixels: 128 * 1024 * 1024,
  skins: 32,
  jointsPerSkin: 256,
  animationChannels: 5000,
  keyframes: 1_000_000,
  cameras: 16,
  lights: 32,
  sceneDepth: 128,
  // `dim` bounds: a poster is a card image, not a wallpaper. Ratio is
  // validated separately (postAspect) so a card can never be a sliver.
  posterDimMin: 64,
  posterDimMax: 4096,
  posterAspectMin: 0.5,
  posterAspectMax: 2.0,
  boardRoots: 48,
  maxEventsPage: 200,
  // Security caps (2026-08-22 hostile-rig audit). Each one stopped a
  // concrete remote attack — see docs/SPEC.md AMENDMENT 89.
  // Replicas per post: a hostile `url`-tag storm (hundreds of slow URLs)
  // pinned a download lane for hours; the real format ships 1–3.
  replicasPerPost: 3,
  // Max tags a kind-1063 event may carry. A 200k-tag message cost tens of
  // ms per tag-array pass; no legitimate post comes close.
  maxEventTags: 1000,
  // Max relay websocket frame (bytes). NIP-01 frames are small JSON; a
  // 45 MiB frame froze the main thread in JSON.parse. Bigger frames are
  // treated as hostile and the socket is dropped.
  wsFrameBytes: 512 * 1024,
  // Token bucket for relay events: 100/sec sustained, 500 burst. The
  // burst covers the initial 200-event feed; a sustained flood is dropped
  // (fail closed — unverified events are never rendered).
  relayEventsPerSec: 100,
  relayEventBurst: 500,
  // Max events held in the ThreadIndex. A relay can push a million
  // distinct valid events; the index is a bounded game state, not a DB.
  maxIndexedEvents: 20000,
  // Total embedded-audio bytes per model (MSFT_audio_emitter clips). A
  // hostile 15 MiB "silent" WAV is a decode bomb; real clips are small.
  audioBytes: 8 * 1024 * 1024,
  // Max nodes rendered in one thread map. Each node is 5 textured planes,
  // so a hostile reply storm (thousands of replies on one root) would
  // freeze the tab on open; the view shows root + newest + a "+N more"
  // notice instead.
  threadNodes: 120,
  // Max chars of nostr event `content` we publish / accept as the model name
  // (AMENDMENT 66). Older posts have empty content; anything longer is
  // off-format and the event is skipped.
  contentChars: 140,
} as const

/** Validated `dim` tag -> poster pixel size, or null when unusable. */
export function parsePosterDim(
  value: string | undefined,
): { width: number; height: number } | null {
  const m = /^(\d{1,5})x(\d{1,5})$/.exec(value ?? '')
  if (!m) return null
  const width = Number(m[1])
  const height = Number(m[2])
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return null
  if (width < LIMITS.posterDimMin || width > LIMITS.posterDimMax) return null
  if (height < LIMITS.posterDimMin || height > LIMITS.posterDimMax) return null
  const aspect = width / height
  if (aspect < LIMITS.posterAspectMin || aspect > LIMITS.posterAspectMax) return null
  return { width, height }
}

export const DEFAULTS = {
  relays: ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nostr.band'],
  blossoms: ['https://nostr.download', 'https://blossom.primal.net'],
} as const
