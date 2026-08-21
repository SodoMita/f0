import {
  decryptOwnedSecret, encryptOwnedSecret, isOwnedSecretHex, isSecretEnvelope,
  type SecretEnvelopeV1,
} from './ownedSecrets'
import { LIMITS, MODEL_MIMES } from '../theme'
import type { ThreadMeta } from './thread-index'

const DB = 'form-zero'
const VERSION = 4
const STORES = ['modelCache', 'posterCache', 'networkConfig', 'settings', 'ownedPosts', 'keyring'] as const
type StoreName = (typeof STORES)[number]

const HEX64 = /^[0-9a-f]{64}$/i
const WRAPPING_KEY_ID = 'owned-posts-aes-gcm-v1'

// In-memory fallback when IndexedDB is unavailable (sandboxed iframe, private mode).
let mem: Map<StoreName, Map<string, unknown>> | null = null

function open(): Promise<IDBDatabase | null> {
  if (mem) return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, VERSION)
      req.onupgradeneeded = () => {
        for (const name of STORES) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => { mem = new Map(); resolve(null) }
    } catch { mem = new Map(); resolve(null) }
  })
}

function mstore(name: StoreName): Map<string, unknown> {
  let m = mem!.get(name)
  if (!m) { m = new Map(); mem!.set(name, m) }
  return m
}

export async function put(store: StoreName, key: string, value: unknown): Promise<void> {
  const db = await open()
  if (!db) { mstore(store).set(key, value); return }
  return new Promise((resolve) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value, key)
    tx.oncomplete = () => { db.close(); resolve() }
    // Caches/settings are best-effort; callers historically do not treat a
    // quota error as fatal. Security-sensitive writes use putChecked below.
    tx.onabort = tx.onerror = () => { db.close(); resolve() }
  })
}

async function putChecked(store: StoreName, key: string, value: unknown): Promise<void> {
  const db = await open()
  if (!db) { mstore(store).set(key, value); return }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    try { tx.objectStore(store).put(value, key) } catch (err) { db.close(); reject(err); return }
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onabort = tx.onerror = () => { const err = tx.error ?? new Error('IndexedDB write failed'); db.close(); reject(err) }
  })
}

export async function get<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await open()
  if (!db) return mstore(store).get(key) as T | undefined
  return new Promise((resolve) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).get(key)
    req.onsuccess = () => { db.close(); resolve(req.result as T) }
    req.onerror = () => { db.close(); resolve(undefined) }
  })
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  const db = await open()
  if (!db) return [...mstore(store).values()] as T[]
  return new Promise((resolve) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).getAll()
    req.onsuccess = () => { db.close(); resolve(req.result as T[]) }
    req.onerror = () => { db.close(); resolve([]) }
  })
}

export async function del(store: StoreName, key: string): Promise<void> {
  const db = await open()
  if (!db) { mstore(store).delete(key); return }
  return new Promise((resolve) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).delete(key)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onabort = tx.onerror = () => { db.close(); resolve() }
  })
}

export async function clearStore(store: StoreName): Promise<void> {
  const db = await open()
  if (!db) { mstore(store).clear(); return }
  return new Promise((resolve) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).clear()
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onabort = tx.onerror = () => { db.close(); resolve() }
  })
}

function boundedStrings(value: unknown, max = 64): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 2048)
    .slice(0, max)
}

export interface NetworkConfig { relays: string[]; blossoms: string[] }
export async function loadNetworkConfig(): Promise<NetworkConfig> {
  const raw = await get<unknown>('networkConfig', 'default')
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { relays: [], blossoms: [] }
  const record = raw as Record<string, unknown>
  return { relays: boundedStrings(record.relays), blossoms: boundedStrings(record.blossoms) }
}
export function saveNetworkConfig(config: NetworkConfig): Promise<void> {
  return put('networkConfig', 'default', {
    relays: boundedStrings(config.relays),
    blossoms: boundedStrings(config.blossoms),
  })
}


/**
 * Searchable snapshot of a post this browser published (AMENDMENT 70). Enough
 * to rebuild the post's ThreadMeta at boot, so own posts stay on the board
 * and findable by name/content even when the live feed's window (14 days /
 * limit) no longer carries them. Every field is validated on read.
 */
export interface OwnedPostMeta {
  pubkey: string
  mime: string
  size: number
  tint: string
  width: number
  height: number
  filename?: string
  name?: string
  sourceFormat?: string
  cameraCount?: number
  animHint?: boolean
  hasAudio?: boolean
}

export interface OwnedPostRecord {
  eventId: string
  /** Decrypted only in memory; IndexedDB stores `secret: SecretEnvelopeV1`. */
  secretKey: string
  modelSha256: string
  modelUrls: string[]
  relays: string[]
  createdAt: number
  rootId?: string
  parentId?: string
  /** The owner deleted this post (AMENDMENT 70): boot restore must skip it. */
  tombstoned?: boolean
  /** Searchable snapshot for boot-time reindex (AMENDMENT 70). */
  meta?: OwnedPostMeta
}

type OwnedPostMetadata = Omit<OwnedPostRecord, 'secretKey'>
interface StoredOwnedPostRecord extends OwnedPostMetadata {
  secret: SecretEnvelopeV1
}
interface LegacyOwnedPostRecord extends OwnedPostMetadata {
  secretKey: string
}

function isWrappingKey(value: unknown): value is CryptoKey {
  if (!value || typeof value !== 'object') return false
  const key = value as CryptoKey
  return key.type === 'secret' && key.extractable === false
    && key.algorithm?.name === 'AES-GCM'
    && key.usages.includes('encrypt') && key.usages.includes('decrypt')
}

let wrappingKeyPromise: Promise<CryptoKey> | null = null

/**
 * Atomically get/create one non-extractable key. The read and conditional put
 * share a readwrite transaction, so two tabs cannot race and encrypt records
 * under different keys.
 */
async function createOrLoadWrappingKey(): Promise<CryptoKey> {
  const candidate = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as CryptoKey
  const db = await open()
  if (!db) {
    const current = mstore('keyring').get(WRAPPING_KEY_ID)
    if (isWrappingKey(current)) return current
    mstore('keyring').set(WRAPPING_KEY_ID, candidate)
    return candidate
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction('keyring', 'readwrite')
    const store = tx.objectStore('keyring')
    const req = store.get(WRAPPING_KEY_ID)
    let selected: CryptoKey | null = null
    req.onsuccess = () => {
      if (isWrappingKey(req.result)) {
        selected = req.result
        return
      }
      selected = candidate
      try { store.put(candidate, WRAPPING_KEY_ID) } catch (err) { tx.abort(); reject(err) }
    }
    req.onerror = () => { tx.abort() }
    tx.oncomplete = () => { db.close(); selected ? resolve(selected) : reject(new Error('Wrapping key unavailable')) }
    tx.onabort = tx.onerror = () => { const err = tx.error ?? new Error('Wrapping key storage failed'); db.close(); reject(err) }
  })
}

function wrappingKey(): Promise<CryptoKey> {
  if (!wrappingKeyPromise) {
    const pending = createOrLoadWrappingKey()
    let guarded: Promise<CryptoKey>
    guarded = pending.catch((err) => {
      if (wrappingKeyPromise === guarded) wrappingKeyPromise = null
      throw err
    })
    wrappingKeyPromise = guarded
  }
  return wrappingKeyPromise
}

function optionalHex(value: unknown): string | undefined {
  return typeof value === 'string' && HEX64.test(value) ? value.toLowerCase() : undefined
}

function ownedMeta(value: unknown): OwnedPostMeta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const m = value as Record<string, unknown>
  if (typeof m.pubkey !== 'string' || !HEX64.test(m.pubkey)) return null
  if (typeof m.mime !== 'string' || !(MODEL_MIMES as readonly string[]).includes(m.mime)) return null
  if (typeof m.size !== 'number' || !Number.isSafeInteger(m.size) || m.size < 1 || m.size > LIMITS.modelBytesHard) return null
  if (typeof m.tint !== 'string' || !/^#[0-9a-f]{6}$/i.test(m.tint)) return null
  const width = typeof m.width === 'number' ? m.width : NaN
  const height = typeof m.height === 'number' ? m.height : NaN
  if (!Number.isFinite(width) || !Number.isFinite(height)
    || width < LIMITS.posterDimMin || width > LIMITS.posterDimMax
    || height < LIMITS.posterDimMin || height > LIMITS.posterDimMax) return null
  const str = (v: unknown, max: number): string | undefined =>
    typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined
  return {
    pubkey: m.pubkey.toLowerCase(),
    mime: m.mime,
    size: m.size,
    tint: m.tint.toLowerCase(),
    width,
    height,
    filename: str(m.filename, 120),
    name: str(m.name, LIMITS.contentChars),
    sourceFormat: str(m.sourceFormat, 20),
    cameraCount: typeof m.cameraCount === 'number' && Number.isFinite(m.cameraCount) && m.cameraCount >= 0 ? m.cameraCount : undefined,
    animHint: m.animHint === true,
    hasAudio: m.hasAudio === true,
  }
}

function ownedMetadata(value: unknown): OwnedPostMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const rec = value as Record<string, unknown>
  if (typeof rec.eventId !== 'string' || !HEX64.test(rec.eventId)) return null
  if (typeof rec.modelSha256 !== 'string' || !HEX64.test(rec.modelSha256)) return null
  if (typeof rec.createdAt !== 'number' || !Number.isSafeInteger(rec.createdAt) || rec.createdAt < 0) return null
  const rootId = optionalHex(rec.rootId)
  const parentId = optionalHex(rec.parentId)
  return {
    eventId: rec.eventId.toLowerCase(),
    modelSha256: rec.modelSha256.toLowerCase(),
    modelUrls: boundedStrings(rec.modelUrls),
    relays: boundedStrings(rec.relays),
    createdAt: rec.createdAt,
    rootId,
    parentId,
    tombstoned: rec.tombstoned === true,
    meta: ownedMeta(rec.meta) ?? undefined,
  }
}

/**
 * Rebuild a post's ThreadMeta from a persisted owned-post record
 * (AMENDMENT 70). Records from before the snapshot existed (no `meta`) yield
 * null — they rely on the live feed like any foreign post.
 */
export function ownedToMeta(rec: OwnedPostRecord): ThreadMeta | null {
  const m = rec.meta
  if (!m) return null
  const isReply = typeof rec.parentId === 'string'
  return {
    eventId: rec.eventId,
    pubkey: m.pubkey,
    createdAt: rec.createdAt,
    tint: m.tint,
    sha256: rec.modelSha256,
    size: m.size,
    native: true,
    mime: m.mime,
    urls: rec.modelUrls,
    width: m.width,
    height: m.height,
    role: isReply ? 'reply' : 'root',
    refs: isReply ? { rootId: rec.rootId, parentId: rec.parentId } : {},
    animHint: m.animHint === true,
    cameraCount: m.cameraCount ?? 0,
    hasAudio: m.hasAudio === true,
    filename: m.filename,
    name: m.name,
    sourceFormat: m.sourceFormat,
  }
}

/**
 * Persist the owner's tombstone on the owned-post record so a boot-time
 * restore cannot resurrect a post the user deleted (AMENDMENT 70).
 * Best-effort: if the write fails the worst case is today's behaviour —
 * hidden again as soon as the relayed kind-5 arrives.
 */
export async function markOwnedPostTombstoned(eventId: string): Promise<void> {
  const db = await open()
  if (!db) {
    const rec = mstore('ownedPosts').get(eventId) as Record<string, unknown> | undefined
    if (rec) mstore('ownedPosts').set(eventId, { ...rec, tombstoned: true })
    return
  }
  return new Promise((resolve) => {
    const tx = db.transaction('ownedPosts', 'readwrite')
    const store = tx.objectStore('ownedPosts')
    const req = store.get(eventId)
    req.onsuccess = () => {
      if (req.result && typeof req.result === 'object') {
        try { store.put({ ...(req.result as object), tombstoned: true }, eventId) } catch { /* best effort */ }
      }
    }
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onabort = tx.onerror = () => { db.close(); resolve() }
  })
}

export async function saveOwnedPost(rec: OwnedPostRecord): Promise<void> {
  const metadata = ownedMetadata(rec)
  if (!metadata || !isOwnedSecretHex(rec.secretKey)) throw new Error('Invalid owned-post record')
  const secret = await encryptOwnedSecret(rec.secretKey, metadata.eventId, await wrappingKey())
  const stored: StoredOwnedPostRecord = { ...metadata, secret }
  // This write is not a cache: silently losing it removes the only ability to
  // sign a deletion, so propagate quota/clone failures to the publish flow.
  await putChecked('ownedPosts', metadata.eventId, stored)
}

export async function listOwnedPosts(): Promise<OwnedPostRecord[]> {
  const records = await getAll<unknown>('ownedPosts')
  if (!records.length) return []
  const key = await wrappingKey()
  const out: OwnedPostRecord[] = []

  for (const value of records) {
    const metadata = ownedMetadata(value)
    if (!metadata) continue
    const stored = value as Partial<StoredOwnedPostRecord & LegacyOwnedPostRecord>
    try {
      if (isSecretEnvelope(stored.secret)) {
        const secretKey = await decryptOwnedSecret(stored.secret, metadata.eventId, key)
        out.push({ ...metadata, secretKey })
      } else if (isOwnedSecretHex(stored.secretKey)) {
        // One-way migration from v3 plaintext records. saveOwnedPost overwrites
        // the same key with an authenticated AES-GCM envelope before exposing
        // the record to the deletion service.
        const migrated = { ...metadata, secretKey: stored.secretKey }
        await saveOwnedPost(migrated)
        out.push(migrated)
      }
    } catch {
      // Missing/replaced key, malformed ciphertext, or failed migration:
      // never expose unauthenticated key material to the signing path.
    }
  }
  return out
}
