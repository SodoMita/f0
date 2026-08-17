import { verifyEvent, verifiedSymbol, type Event, type VerifiedEvent } from 'nostr-tools'
import { FORM_ZERO_TAG, LIMITS, MODEL_KIND, ROOT_TAG, REPLY_TAG, SCHEMA_VERSION } from '../theme'
import { parseThreadRefs, type ThreadMeta } from './thread-index'

export function verifyFresh(event: Event): event is VerifiedEvent {
  try {
    delete (event as Record<symbol, unknown>)[verifiedSymbol]
  } catch { /* non-extensible */ }
  return verifyEvent(event)
}

function tag(tags: string[][], name: string): string | undefined {
  for (const t of tags) if (t[0] === name) return t[1]
  return undefined
}
function allTags(tags: string[][], name: string): string[] {
  const out: string[] = []
  for (const t of tags) if (t[0] === name && typeof t[1] === 'string') out.push(t[1])
  return out
}
const HEX64 = /^[0-9a-f]{64}$/i

export function parseModelEvent(event: Event): ThreadMeta | null {
  if (event.kind !== MODEL_KIND || event.content !== '' || !verifyFresh(event)) return null
  const tags = event.tags as string[][]
  if (!allTags(tags, 't').includes(FORM_ZERO_TAG)) return null
  const m = tag(tags, 'm')
  if (m && m !== 'model/gltf-binary') return null
  const sha = tag(tags, 'x')?.toLowerCase()
  const size = Number(tag(tags, 'size'))
  if (!sha || !HEX64.test(sha) || !Number.isSafeInteger(size) || size < 20 || size > LIMITS.modelBytesHard) return null
  if (event.created_at > Math.floor(Date.now() / 1000) + 300) return null
  const tintTag = tag(tags, 'color')
  const tint = tintTag && /^#[0-9a-f]{6}$/i.test(tintTag) ? tintTag : '#1b1a1a'
  const urls = tags
    .filter((t) => t[0] === 'url' && typeof t[1] === 'string')
    .map((t) => t[1])
    .filter((u) => /^https:\/\//i.test(u))
  const servers = allTags(tags, 'server')
  const thumbUrl = tag(tags, 'thumb')
  const thumbSha = tag(tags, 'thumb-x')?.toLowerCase()
  const thumbSize = Number(tag(tags, 'thumb-size'))
  const { role, refs, issues } = parseThreadRefs(tags)
  return {
    eventId: event.id,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    tint,
    sha256: sha,
    size,
    thumbUrl: thumbUrl && /^https:\/\//i.test(thumbUrl) ? thumbUrl : undefined,
    thumbSha256: thumbSha && HEX64.test(thumbSha) ? thumbSha : undefined,
    thumbSize: Number.isSafeInteger(thumbSize) ? thumbSize : undefined,
    urls,
    servers,
    role,
    refs,
    animHint: tag(tags, 'anim') === '1',
    cameraCount: Number(tag(tags, 'cameras')) || 0,
    hasAudio: tag(tags, 'audio') === '1',
    filename: tag(tags, 'filename')?.slice(0, 120),
    sourceFormat: (tag(tags, 'source-format') as ThreadMeta['sourceFormat']) || undefined,
    sourceFilename: tag(tags, 'source-filename')?.slice(0, 120),
    previewCamera: tag(tags, 'preview-camera') ? Number(tag(tags, 'preview-camera')) : undefined,
    previewAnimation: tag(tags, 'preview-animation') ? Number(tag(tags, 'preview-animation')) : undefined,
    issues,
  }
}

export { SCHEMA_VERSION, ROOT_TAG, REPLY_TAG }
