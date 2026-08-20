import { verifyEvent, verifiedSymbol, type Event, type VerifiedEvent } from 'nostr-tools'
// Inlined worker: keeps the single-file standalone build working (blob: URL,
// already allowed by the CSP's worker-src).
import VerifyWorker from './verify.worker?worker&inline'
import { LIMITS, MODEL_KIND, MODEL_MIMES, POSTER_W, POSTER_H, parsePosterDim } from '../theme'
import { parseThreadRefs, type ThreadMeta } from './thread-index'

/**
 * Events WE verified ourselves. A relay can pre-set nostr-tools' own
 * `verifiedSymbol` on the wire object, so that flag is still stripped on first
 * sight — but a second verification of the same object is pure waste, and
 * secp256k1 verification costs tens of milliseconds of main thread each.
 * (It used to run twice per event: once at ingress, once in parseModelEvent.)
 */
const selfVerified = new WeakSet<object>()

// ---------------------------------------------------------------- worker

let worker: Worker | null = null
let workerBroken = false
let nextJob = 1
const jobs = new Map<number, (ok: boolean) => void>()

function getWorker(): Worker | null {
  if (workerBroken) return null
  if (worker) return worker
  try {
    worker = new VerifyWorker()
    worker.onmessage = (m: MessageEvent<{ id: number; ok: boolean }>) => {
      const done = jobs.get(m.data.id)
      if (!done) return
      jobs.delete(m.data.id)
      done(m.data.ok)
    }
    worker.onerror = () => {
      workerBroken = true
      for (const done of jobs.values()) done(false)
      jobs.clear()
      worker = null
    }
  } catch {
    workerBroken = true
    worker = null
  }
  return worker
}

/**
 * Verify off the main thread. Falls back to synchronous verification when
 * workers are unavailable. The result is remembered per event object exactly
 * like `verifyFresh`, so `parseModelEvent` never pays for it again.
 */
export async function verifyFreshAsync(event: Event): Promise<boolean> {
  if (selfVerified.has(event)) return true
  try { delete (event as Record<symbol, unknown>)[verifiedSymbol] } catch { /* non-extensible */ }
  const w = getWorker()
  if (!w) return verifyFresh(event)
  const id = nextJob++
  const ok = await new Promise<boolean>((resolve) => {
    jobs.set(id, resolve)
    try {
      w.postMessage({ id, event })
    } catch {
      jobs.delete(id)
      resolve(verifyEvent(event))
    }
  })
  if (ok) selfVerified.add(event)
  return ok
}

export function verifyFresh(event: Event): event is VerifiedEvent {
  if (selfVerified.has(event)) return true
  try { delete (event as Record<symbol, unknown>)[verifiedSymbol] } catch { /* non-extensible */ }
  if (!verifyEvent(event)) return false
  selfVerified.add(event)
  return true
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
  // AMENDMENT 66: `content` MAY carry the model name (bounded, single line);
  // older format posts have it empty. Longer content is off-format — skip.
  if (event.kind !== MODEL_KIND || event.content.length > LIMITS.contentChars || !verifyFresh(event)) return null
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

  // v4: no thumb PNG in the format at all — posters are rendered from the
  // model by every client. `dim` (WxH) declares that render's pixel size;
  // posts without a usable `dim` (older format) fall back to the default.
  const dim = parsePosterDim(tag(tags, 'dim')) ?? { width: POSTER_W, height: POSTER_H }

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
    width: dim.width,
    height: dim.height,
    role,
    refs,
    animHint: tag(tags, 'anim') === '1' || hasF('anim'),
    cameraCount: Number(tag(tags, 'cameras')) || 0,
    hasAudio: tag(tags, 'audio') === '1' || hasF('audio'),
    filename: tag(tags, 'filename')?.slice(0, 120),
    /** Model name from event `content` (AMENDMENT 66); empty for older posts. */
    name: event.content.trim() || undefined,
    sourceFormat: tag(tags, 'source-format')?.slice(0, 20),
    previewCamera: tag(tags, 'preview-camera') !== undefined ? Number(tag(tags, 'preview-camera')) : undefined,
    previewAnimation: tag(tags, 'preview-animation') !== undefined ? Number(tag(tags, 'preview-animation')) : undefined,
  }
}
