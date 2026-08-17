export const theme = {
  background: '#0B0B0C',
  panel: '#121213',
  paper: '#EEE9E1',
  ink: '#F2EEE8',
  muted: '#827E79',
  accent: '#FF5C35',
  success: '#98CA72',
  warning: '#F4C95D',
  danger: '#FF674B',
  focus: '#FFB094',
  line: 0xffffff1a,
} as const

export const FORM_ZERO_TAG = 'form-zero'
export const ROOT_TAG = 'form-zero-root'
export const REPLY_TAG = 'form-zero-reply'
export const SCHEMA_VERSION = 'form-zero:3'
export const MODEL_KIND = 1063
export const DELETE_KIND = 5
export const BLOSSOM_AUTH_KIND = 24242

export const LIMITS = {
  modelBytesHard: 20 * 1024 * 1024,
  modelBytesRecommended: 8 * 1024 * 1024,
  posterBytesHard: 200 * 1024,
  jsonChunkBytes: 2 * 1024 * 1024,
  nodes: 2000,
  meshes: 500,
  primitives: 1000,
  vertices: 2_000_000,
  indices: 6_000_000,
  materials: 256,
  textures: 64,
  textureSide: 4096,
  cameras: 16,
  lights: 32,
  boardRoots: 48,
  maxEventsPage: 200,
} as const

export const DEFAULTS = {
  relays: ['wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nostr.band'],
  blossoms: ['https://nostr.download', 'https://blossom.primal.net'],
} as const
