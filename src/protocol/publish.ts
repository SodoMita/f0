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
  /** Poster render size (px) — goes into the `dim` tag. Posters are only
   *  ever rendered locally from the model; no PNG is uploaded. */
  width: number
  height: number
  tint: string
  filename?: string
  sourceFormat?: 'glb' | 'gltf' | 'obj' | 'generated'
  role?: PublishRole
  rootId?: string
  parentId?: string
  relayHint?: string
  /** Model name → event `content` (AMENDMENT 66: was always ''). Lets relay
   *  full-text search (NIP-50) find a post by name. Bounded, single line. */
  name?: string
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
  stage: 'hash' | 'blossom' | 'relay' | 'done' | 'error'
  detail?: string
  ok?: number
  failed?: number
}

const ROOT_TAG = 'form-zero-root'
const REPLY_TAG = 'form-zero-reply'

/**
 * Full BUD-01 + kind-1063 publish path (format v4):
 *  1. hash the model
 *  2. upload it to every configured Blossom server (BUD-01, kind-24242 auth)
 *  3. build the signed kind-1063 event with v2 + v3 tags + `dim`
 *  4. persist the encrypted deletion capability, then broadcast to relays
 *
 * No poster PNG is published: every client renders posters locally from the
 * model, sized by the `dim` tag.
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
  const { model, tint } = input
  if (model.size > LIMITS.modelBytesHard) {
    throw new Error(`Model is ${(model.size / 1048576).toFixed(1)} MiB; limit is ${LIMITS.modelBytesHard / 1048576} MiB.`)
  }

  throwIfAborted(deps.signal)
  deps.onProgress?.({ stage: 'hash' })
  // Freeze first so later studio edits cannot change the bytes we hash
  // and then PUT. The event `x` tag is this snapshot.
  const modelSnap = await freezeBlob(model)
  const modelSha = modelSnap.sha256
  throwIfAborted(deps.signal)

  const secret = generateSecretKey()
  try {
    const blossom = new BlossomClient(deps.blossoms)

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
      ['dim', `${input.width}x${input.height}`],
      ['v', 'form-zero:4'],
    ]
    for (const u of modelUploads) tags.push(['url', u.url])
    for (const s of new Set(modelUploads.map((u) => new URL(u.url).origin))) tags.push(['server', s])
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
    const template: EventTemplate = {
      kind: MODEL_KIND,
      created_at: now,
      tags,
      content: (input.name ?? '').slice(0, LIMITS.contentChars),
    }

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

