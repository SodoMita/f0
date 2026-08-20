import { LIBRARY } from './catalog'

const urls = import.meta.glob('./glb/*.glb', {
  query: '?url',
  eager: true,
  import: 'default',
}) as Record<string, string>

const cache = new Map<string, Uint8Array>()

export function libraryUrl(id: string): string {
  const url = urls[`./glb/${id}.glb`]
  if (!url) throw new Error(`unknown library item: ${id}`)
  return url
}

export async function libraryBytes(id: string): Promise<Uint8Array> {
  const hit = cache.get(id)
  if (hit) return hit
  if (!LIBRARY.some((item) => item.id === id)) throw new Error(`unknown library item: ${id}`)
  const res = await fetch(libraryUrl(id))
  if (!res.ok) throw new Error(`library fetch failed: ${id}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  cache.set(id, bytes)
  return bytes
}

export function libraryIds(): string[] {
  return LIBRARY.map((item) => item.id)
}
