import { LIBRARY, type LibraryItem } from './catalog'

const urls = import.meta.glob(['./2d/*.glb', './3d/*.glb', './glb/*.glb'], {
  query: '?url',
  eager: true,
  import: 'default',
}) as Record<string, string>

const cache = new Map<string, Uint8Array>()

export function libraryUrl(item: LibraryItem): string {
  const keyed = urls[`./${item.dim}/${item.id}.glb`]
  if (keyed) return keyed
  const legacy = urls[`./glb/${item.id}.glb`]
  if (legacy) return legacy
  throw new Error(`unknown library item: ${item.dim}/${item.id}`)
}

export async function libraryBytes(item: LibraryItem): Promise<Uint8Array> {
  const key = `${item.dim}/${item.id}`
  const hit = cache.get(key)
  if (hit) return hit
  const res = await fetch(libraryUrl(item))
  if (!res.ok) throw new Error(`library fetch failed: ${key}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  cache.set(key, bytes)
  return bytes
}

export function libraryIds(): string[] {
  return LIBRARY.map((item) => item.id)
}
