import { finalizeEvent, generateSecretKey, type EventTemplate } from 'nostr-tools'
import { BlossomClient } from './blossom'
import { RelayPool } from './nostr'
import { bytesToHex } from '../util/hex'
import { FORM_ZERO_TAG, MODEL_KIND, LIMITS } from '../theme'
import { saveOwnedPost } from './storage'
import { freezeBlob, throwIfAborted } from './hash'

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

/**
 * Full BUD-01 + kind-1063 publish path:
 *  1. hash model + poster
 *  2. upload both to every configured Blossom server (BUD-01, kind-24242 auth)
 *  3. build the signed kind-1063 event with v2 + v3 tags
 *  4. persist the encrypted deletion capability, then broadcast to relays
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
    signal?: AbortSignal
  },
): Promise<PublishResult> {
  const { model, poster, tint } = input
  if (model.size > LIMITS.modelBytesHard) {
    throw new Error(`Model is ${(model.size / 1048576).toFixed(1)} MiB; limit is ${LIMITS.modelBytesHard / 1048576} MiB.`)
  }
  if (poster.size > LIMITS.posterBytesHard) {
    throw new Error(`Poster is ${(poster.size / 1024).toFixed(0)} KiB; limit is ${LIMITS.posterBytesHard / 1024} KiB.`)
  }

  throwIfAborted(deps.signal)
  deps.onProgress?.({ stage: 'hash' })
  // Freeze first so later studio edits cannot change the bytes we hash
  // and then PUT. The event `x` tag is this snapshot.
  const [modelSnap, posterSnap] = await Promise.all([freezeBlob(model), freezeBlob(poster)])
  const modelSha = modelSnap.sha256
  const posterSha = posterSnap.sha256
  throwIfAborted(deps.signal)

  const secret = generateSecretKey()
  try {
    const blossom = new BlossomClient(deps.blossoms)

    deps.onProgress?.({ stage: 'poster' })
    const posterUploads = await blossom.upload(posterSnap.blob, secret, deps.signal)
    if (!posterUploads.length) throw new Error('Poster upload failed on every Blossom server.')
    throwIfAborted(deps.signal)

    deps.onProgress?.({ stage: 'blossom' })
    const modelUploads = await blossom.upload(modelSnap.blob, secret, deps.signal)
    if (!modelUploads.length) throw new Error('Model upload failed on every Blossom server.')
    throwIfAborted(deps.signal)

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
    tags.push(['thumb-size', String(posterSnap.bytes.byteLength)])
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

    throwIfAborted(deps.signal)
    const template: EventTemplate = { kind: MODEL_KIND, created_at: now, tags, content: '' }

    // Compute the event id now (RelayPool.publish re-finalizes the same
    // template+secret, so it yields the identical id).
    const signed = finalizeEvent(template, secret)
    const eventId = signed.id

    // Persist the deletion capability before broadcasting. If the encrypted
    // record cannot be stored (quota/CryptoKey clone failure), fail closed: do
    // not publish a post this browser can no longer sign a deletion for.
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

    deps.onProgress?.({ stage: 'relay' })
    const { ok, failed } = await deps.pool.publish(template, secret)
    deps.onProgress?.({ stage: 'done', ok: ok.length, failed: failed.length })
    return { eventId, ok, failed }
  } finally {
    secret.fill(0)
  }
}

