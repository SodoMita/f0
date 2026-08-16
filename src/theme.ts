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
  posterBytesHard: 200 * 1024,
  boardRoots: 48,
  maxEventsPage: 200,
} as const

export const DEFAULTS = {
  relays: ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nostr.band'],
  blossoms: ['https://nostr.download', 'https://blossom.primal.net'],
} as const
