import {
  decryptOwnedSecret, encryptOwnedSecret, isOwnedSecretHex, isSecretEnvelope,
  type SecretEnvelopeV1,
} from './ownedSecrets'

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

/** Legacy helpers; the full settings schema/store is used by the application. */
export interface Settings { background: string; inertia: number }
export async function loadSettings(): Promise<Settings> {
  const raw = await get<unknown>('settings', 'default')
  const fallback = { background: '#0B0B0C', inertia: 0.7 }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback
  const record = raw as Record<string, unknown>
  return {
    background: typeof record.background === 'string' && /^#[0-9a-f]{6}$/i.test(record.background) ? record.background : fallback.background,
    inertia: typeof record.inertia === 'number' && Number.isFinite(record.inertia) && record.inertia >= 0 && record.inertia <= 1
      ? record.inertia : fallback.inertia,
  }
}
export function saveSettings(s: Settings): Promise<void> {
  return put('settings', 'default', s)
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
  }
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
