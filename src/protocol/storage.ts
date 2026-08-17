const DB = 'form-zero'
const VERSION = 3
const STORES = ['ownedPosts', 'modelCache', 'posterCache', 'cacheMeta', 'networkConfig'] as const
type StoreName = (typeof STORES)[number]

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const name of STORES) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function put(store: StoreName, key: string, value: unknown): Promise<void> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value, key)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}

export async function get<T>(store: StoreName, key: string): Promise<T | undefined> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).get(key)
    req.onsuccess = () => { db.close(); resolve(req.result as T) }
    req.onerror = () => { db.close(); reject(req.error) }
  })
}

export async function del(store: StoreName, key: string): Promise<void> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).delete(key)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => { db.close(); reject(tx.error) }
  })
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).getAll()
    req.onsuccess = () => { db.close(); resolve(req.result as T[]) }
    req.onerror = () => { db.close(); reject(req.error) }
  })
}

export interface NetworkConfig { relays: string[]; blossoms: string[] }

export async function loadNetworkConfig(): Promise<NetworkConfig> {
  const value = await get<NetworkConfig>('networkConfig', 'default')
  return value ?? { relays: [], blossoms: [] }
}
export function saveNetworkConfig(config: NetworkConfig): Promise<void> {
  return put('networkConfig', 'default', config)
}

const MODEL_QUOTA = 96 * 1024 * 1024
const meta = new Map<string, { size: number; at: number }>()
let metaLoaded = false
async function ensureMeta(): Promise<void> {
  if (metaLoaded) return
  metaLoaded = true
  const all = await getAll<{ sha256: string; size: number; at: number }>('cacheMeta')
  for (const m of all) meta.set(m.sha256, { size: m.size, at: m.at })
}

export async function cacheBlob(store: 'modelCache' | 'posterCache', sha256: string, blob: Blob): Promise<void> {
  await ensureMeta()
  await put(store, sha256, blob)
  meta.set(sha256, { size: blob.size, at: Date.now() })
  await put('cacheMeta', sha256, { sha256, size: blob.size, at: Date.now() })
  let total = 0
  for (const m of meta.values()) total += m.size
  if (total > MODEL_QUOTA) {
    const victims = [...meta.entries()].sort((a, b) => a[1].at - b[1].at)
    for (const [id] of victims) {
      if (total <= MODEL_QUOTA) break
      const m = meta.get(id)
      if (!m) continue
      await del(store, id)
      await del('cacheMeta', id)
      meta.delete(id)
      total -= m.size
    }
  }
}
