import { verifyEvent, verifiedSymbol, type Event, type VerifiedEvent } from 'nostr-tools'
import { LIMITS, MODEL_KIND, MODEL_MIMES } from '../theme'
import { parseThreadRefs, type ThreadMeta } from './thread-index'

export function verifyFresh(event: Event): event is VerifiedEvent {
  try { delete (event as Record<symbol, unknown>)[verifiedSymbol] } catch { /* non-extensible */ }
  return verifyEvent(event)
}

const HEX64 = /^[0-9a-f]{64}$/i
const HEX = /^#[0-9a-f]{6}$/i

function tag(tags: string[][], name: string): string | undefined {
  for (const t of tags) if (t[0] === name) return t[1]
  return undefined
}
function allTags(tags: string[][], name: string): string[] {
  const out: string[] = []
  for (const t of tags) if (t[0] === name && typeof t[1] === 'string') out.push(t[1])
  return out
}

export function parseModelEvent(event: Event): ThreadMeta | null {
  if (event.kind !== MODEL_KIND || event.content !== '' || !verifyFresh(event)) return null
  const tags = event.tags as string[][]

  const mime = tag(tags, 'm')
  if (!mime || !(MODEL_MIMES as readonly string[]).includes(mime)) return null

  const sha = (tag(tags, 'x') ?? tag(tags, 'ox'))?.toLowerCase()
  if (!sha || !HEX64.test(sha)) return null

  const size = Number(tag(tags, 'size'))
  if (!Number.isSafeInteger(size) || size < 1 || size > LIMITS.modelBytesHard) return null

  if (event.created_at > Math.floor(Date.now() / 1000) + 300) return null

  const urls = [
    ...tags.filter((t) => t[0] === 'url' && typeof t[1] === 'string').map((t) => t[1]),
    ...tags.filter((t) => t[0] === 'fallback' && typeof t[1] === 'string').map((t) => t[1]),
  ].filter((u) => /^https:\/\//i.test(u))

  const tintRaw = tag(tags, 'color')
  const tint = tintRaw && HEX.test(tintRaw) ? tintRaw : '#1b1a1a'

  const f = allTags(tags, 'f')
  const hasF = (name: string) => f.includes(name)

  const thumbUrl = tag(tags, 'thumb')
  const thumbSha = tag(tags, 'thumb-x')?.toLowerCase()
  const thumbSize = Number(tag(tags, 'thumb-size'))
  const { role, refs } = parseThreadRefs(tags)

  return {
    eventId: event.id,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    tint,
    sha256: sha,
    size,
    native: allTags(tags, 't').includes('form-zero'),
    mime,
    urls,
    thumbUrl: thumbUrl && /^https:\/\//i.test(thumbUrl) ? thumbUrl : undefined,
    thumbSha256: thumbSha && HEX64.test(thumbSha) ? thumbSha : undefined,
    thumbSize: Number.isSafeInteger(thumbSize) && thumbSize > 0 ? thumbSize : undefined,
    role,
    refs,
    animHint: tag(tags, 'anim') === '1' || hasF('anim'),
    cameraCount: Number(tag(tags, 'cameras')) || 0,
    hasAudio: tag(tags, 'audio') === '1' || hasF('audio'),
    filename: tag(tags, 'filename')?.slice(0, 120),
    sourceFormat: tag(tags, 'source-format')?.slice(0, 20),
    previewCamera: tag(tags, 'preview-camera') !== undefined ? Number(tag(tags, 'preview-camera')) : undefined,
    previewAnimation: tag(tags, 'preview-animation') !== undefined ? Number(tag(tags, 'preview-animation')) : undefined,
  }
}
