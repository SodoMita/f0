const DB = 'form-zero'
const VERSION = 2
const STORES = ['modelCache', 'posterCache', 'networkConfig', 'settings'] as const
type StoreName = (typeof STORES)[number]

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
    tx.onerror = () => { db.close(); resolve() }
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

export interface NetworkConfig { relays: string[]; blossoms: string[] }
export async function loadNetworkConfig(): Promise<NetworkConfig> {
  return (await get<NetworkConfig>('networkConfig', 'default')) ?? { relays: [], blossoms: [] }
}
export function saveNetworkConfig(config: NetworkConfig): Promise<void> {
  return put('networkConfig', 'default', config)
}

export interface Settings { background: string; inertia: number }
export async function loadSettings(): Promise<Settings> {
  return (await get<Settings>('settings', 'default')) ?? { background: '#0B0B0C', inertia: 0.7 }
}
export function saveSettings(s: Settings): Promise<void> {
  return put('settings', 'default', s)
}
