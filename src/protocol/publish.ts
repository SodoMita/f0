import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from 'nostr-tools'
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay'
import { BlossomClient } from './blossom'
import {
  FORM_ZERO_TAG,
  MODEL_KIND,
  ROOT_TAG,
  REPLY_TAG,
  SCHEMA_VERSION,
  LIMITS,
} from '../theme'
import { bytesToHex } from '../util/hex'
import { put } from './storage'

// Browser WebSocket for nostr-tools.
if (typeof WebSocket !== 'undefined') useWebSocketImplementation(WebSocket as any)

export interface PublishOptions {
  blob: Blob
  relays: string[]
  blossoms: string[]
  tint: string
  replyTo?: { rootId: string; parentId: string; relayHint?: string }
  filename?: string
  sourceFormat?: 'glb' | 'gltf' | 'obj' | 'generated'
  cameraCount?: number
  hasAudio?: boolean
  hasAnimation?: boolean
  onProgress?: (stage: PublishStage, detail?: string) => void
}

export type PublishStage = 'hash' | 'blossom' | 'nostr' | 'done' | 'error'

export interface PublishedModel {
  eventId: string
  sha256: string
  urls: string[]
  secretKey: Uint8Array
  size: number
}

export async function publishModel(opts: PublishOptions): Promise<PublishedModel> {
  const { blob, relays, blossoms, tint, replyTo, onProgress } = opts
  if (blob.size > LIMITS.modelBytesHard) {
    throw new Error(`Final GLB exceeds 20 MiB (${(blob.size / 1048576).toFixed(1)} MiB).`)
  }

  onProgress?.('hash')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  )
  const sha256 = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')

  const secret = generateSecretKey()
  const blossom = new BlossomClient(blossoms)
  onProgress?.('blossom')
  const uploaded = await blossom.upload(blob, secret)
  if (!uploaded.length) throw new Error('No Blossom replica completed.')

  const urls = uploaded.map((u) => u.url)
  const servers = Array.from(new Set(uploaded.map((u) => new URL(u.url).origin)))
  const now = Math.floor(Date.now() / 1000)

  const tags: string[][] = [
    ['t', FORM_ZERO_TAG],
    ['t', replyTo ? REPLY_TAG : ROOT_TAG],
    ['m', 'model/gltf-binary'],
    ['x', sha256],
    ['size', String(blob.size)],
    ['v', SCHEMA_VERSION],
    ['color', tint],
  ]
  for (const url of urls) tags.push(['url', url])
  for (const server of servers) tags.push(['server', server])
  if (replyTo) {
    tags.push(['e', replyTo.rootId, replyTo.relayHint ?? '', 'root'])
    tags.push(['e', replyTo.parentId, replyTo.relayHint ?? '', 'reply'])
  }
  if (opts.filename) tags.push(['filename', opts.filename.slice(0, 120)])
  if (opts.sourceFormat) tags.push(['source-format', opts.sourceFormat])
  if (opts.cameraCount) tags.push(['cameras', String(opts.cameraCount)])
  if (opts.hasAudio) tags.push(['audio', '1'])
  if (opts.hasAnimation) tags.push(['anim', '1'])

  const event = finalizeEvent({ kind: MODEL_KIND, created_at: now, tags, content: '' }, secret)

  onProgress?.('nostr')
  await Promise.allSettled(
    relays.map(async (url) => {
      const relay = await Relay.connect(url)
      try {
        await relay.publish(event)
      } finally {
        relay.close()
      }
    }),
  )

  await put('ownedPosts', event.id, {
    eventId: event.id,
    pubkey: event.pubkey,
    secretKey: bytesToHex(secret),
    modelSha256: sha256,
    modelUrls: urls,
    servers,
    relays,
    createdAt: now,
    filename: opts.filename,
  })

  onProgress?.('done')
  return { eventId: event.id, sha256, urls, secretKey: secret, size: blob.size }
}
