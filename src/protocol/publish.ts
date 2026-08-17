import { finalizeEvent, generateSecretKey, type EventTemplate } from 'nostr-tools'
import { BlossomClient } from './blossom'
import { RelayPool } from './nostr'
import { bytesToHex } from '../util/hex'
import { FORM_ZERO_TAG, MODEL_KIND, LIMITS } from '../theme'
import { saveOwnedPost } from './storage'

export type PublishRole = 'root' | 'reply'

export interface PublishInput {
  model: Blob
  poster: Blob
  tint: string
  filename?: string
  sourceFormat?: 'glb' | 'gltf' | 'obj' | 'generated'
  role?: PublishRole
  rootId?: string
  parentId?: string
  relayHint?: string
  previewCamera?: number
  previewAnimation?: number
  hasAudio?: boolean
  cameraCount?: number
  hasAnimation?: boolean
}

export interface PublishResult {
  eventId: string
  ok: string[]
  failed: string[]
}

export interface PublishProgress {
  stage: 'hash' | 'poster' | 'blossom' | 'relay' | 'done' | 'error'
  detail?: string
  ok?: number
  failed?: number
}

const ROOT_TAG = 'form-zero-root'
const REPLY_TAG = 'form-zero-reply'

function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return crypto.subtle.digest('SHA-256', buf).then((digest) =>
    Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join(''),
  )
}

/**
 * Full BUD-01 + kind-1063 publish path:
 *  1. hash model + poster
 *  2. upload both to every configured Blossom server (BUD-01, kind-24242 auth)
 *  3. build the signed kind-1063 event with v2 + v3 tags
 *  4. broadcast to relays, persist the per-post secret for later deletion
 *
 * Partial relay failure is reported (amber), not thrown. Blossom failure on
 * every replica is thrown — there is no point publishing an event with no
 * downloadable model.
 */
export async function publishModel(
  input: PublishInput,
  deps: {
    relays: string[]
    blossoms: string[]
    pool: RelayPool
    onProgress?: (p: PublishProgress) => void
  },
): Promise<PublishResult> {
  const { model, poster, tint } = input
  if (model.size > LIMITS.modelBytesHard) {
    throw new Error(`Model is ${(model.size / 1048576).toFixed(1)} MiB; limit is ${LIMITS.modelBytesHard / 1048576} MiB.`)
  }
  if (poster.size > LIMITS.posterBytesHard) {
    throw new Error(`Poster is ${(poster.size / 1024).toFixed(0)} KiB; limit is ${LIMITS.posterBytesHard / 1024} KiB.`)
  }

  deps.onProgress?.({ stage: 'hash' })
  const modelBytes = new Uint8Array(await model.arrayBuffer())
  const posterBytes = new Uint8Array(await poster.arrayBuffer())
  const [modelSha, posterSha] = await Promise.all([sha256Hex(modelBytes), sha256Hex(posterBytes)])

  const secret = generateSecretKey()
  const blossom = new BlossomClient(deps.blossoms)

  deps.onProgress?.({ stage: 'poster' })
  const posterUploads = await blossom.upload(poster, secret)
  if (!posterUploads.length) throw new Error('Poster upload failed on every Blossom server.')

  deps.onProgress?.({ stage: 'blossom' })
  const modelUploads = await blossom.upload(model, secret)
  if (!modelUploads.length) throw new Error('Model upload failed on every Blossom server.')

  const now = Math.floor(Date.now() / 1000)
  const role = input.role ?? 'root'
  const tags: string[][] = [
    ['t', FORM_ZERO_TAG],
    ['t', role === 'reply' ? REPLY_TAG : ROOT_TAG],
    ['m', 'model/gltf-binary'],
    ['x', modelSha],
    ['ox', modelSha],
    ['size', String(model.size)],
    ['color', tint],
    ['v', 'form-zero:3'],
  ]
  for (const u of modelUploads) tags.push(['url', u.url])
  for (const s of new Set(modelUploads.map((u) => new URL(u.url).origin))) tags.push(['server', s])
  tags.push(['thumb', posterUploads[0].url])
  tags.push(['thumb-x', posterSha])
  tags.push(['thumb-size', String(poster.size)])
  tags.push(['thumb-dim', '512x320'])
  if (input.filename) tags.push(['filename', input.filename.slice(0, 120)])
  if (input.sourceFormat) tags.push(['source-format', input.sourceFormat])
  if (typeof input.previewCamera === 'number') tags.push(['preview-camera', String(input.previewCamera)])
  if (typeof input.previewAnimation === 'number') tags.push(['preview-animation', String(input.previewAnimation)])
  if (input.cameraCount) tags.push(['cameras', String(input.cameraCount)])
  if (input.hasAnimation) tags.push(['anim', '1'])
  if (input.hasAudio) tags.push(['audio', '1'])
  if (role === 'reply' && input.rootId && input.parentId) {
    tags.push(['e', input.rootId, input.relayHint ?? '', 'root'])
    tags.push(['e', input.parentId, input.relayHint ?? '', 'reply'])
  }

  const template: EventTemplate = { kind: MODEL_KIND, created_at: now, tags, content: '' }

  // Compute the event id now (RelayPool.publish re-finalizes the same
  // template+secret, so it yields the identical id).
  const signed = finalizeEvent(template, secret)
  const eventId = signed.id

  deps.onProgress?.({ stage: 'relay' })
  const { ok, failed } = await deps.pool.publish(template, secret)
  await saveOwnedPost({
    eventId,
    secretKey: bytesToHex(secret),
    modelSha256: modelSha,
    modelUrls: modelUploads.map((u) => u.url),
    posterUrl: posterUploads[0].url,
    posterSha256: posterSha,
    relays: deps.relays,
    createdAt: now,
    rootId: role === 'reply' ? input.rootId : eventId,
    parentId: role === 'reply' ? input.parentId : undefined,
  })

  deps.onProgress?.({ stage: 'done', ok: ok.length, failed: failed.length })
  return { eventId, ok, failed }
}

