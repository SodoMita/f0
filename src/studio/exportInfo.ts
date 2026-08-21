import { formatSize } from './modelInfo'

export interface GLBExportInfo {
  bytes: number
  jsonBytes: number
  binBytes: number
  geometryBytes: number
  imageBytes: number
  animationBytes: number
  otherBytes: number
  extensions: string[]
  meshes: number
  triangles: number
  textures: number
  animations: number
}

/** Lightweight, no-loader inspection of the exact GLB blob to be published.
 * It deliberately reads only the GLB JSON chunk: previewing/export review must
 * not parse the model into a second Babylon scene. */
export function inspectGLB(bytes: Uint8Array): GLBExportInfo {
  const empty: GLBExportInfo = { bytes: bytes.length, jsonBytes: 0, binBytes: 0, geometryBytes: 0, imageBytes: 0, animationBytes: 0, otherBytes: bytes.length, extensions: [], meshes: 0, triangles: 0, textures: 0, animations: 0 }
  if (bytes.length < 20) return empty
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== 0x46546c67) return empty
  let offset = 12
  let json: any = null
  let binBytes = 0
  let jsonBytes = 0
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset, true)
    const type = view.getUint32(offset + 4, true)
    offset += 8
    if (offset + size > bytes.length) return empty
    if (type === 0x4e4f534a) {
      jsonBytes = size
      try { json = JSON.parse(new TextDecoder().decode(bytes.subarray(offset, offset + size))) } catch { return empty }
    } else if (type === 0x004e4942) binBytes += size
    offset += size
  }
  if (!json) return empty
  const views: any[] = Array.isArray(json.bufferViews) ? json.bufferViews : []
  const viewSize = (i: unknown): number => typeof i === 'number' && views[i] ? Number(views[i].byteLength) || 0 : 0
  const imageViews = new Set<number>((json.images ?? []).map((image: any) => image.bufferView).filter((n: unknown) => typeof n === 'number'))
  const animationViews = new Set<number>()
  for (const animation of json.animations ?? []) for (const sampler of animation.samplers ?? []) {
    for (const accessorIndex of [sampler.input, sampler.output]) {
      const accessor = json.accessors?.[accessorIndex]
      if (typeof accessor?.bufferView === 'number') animationViews.add(accessor.bufferView)
    }
  }
  let imageBytes = 0
  let animationBytes = 0
  for (const n of imageViews) imageBytes += viewSize(n)
  for (const n of animationViews) if (!imageViews.has(n)) animationBytes += viewSize(n)
  const geometryBytes = Math.max(0, binBytes - imageBytes - animationBytes)
  let triangles = 0
  for (const mesh of json.meshes ?? []) for (const primitive of mesh.primitives ?? []) {
    const accessor = json.accessors?.[primitive.indices ?? primitive.attributes?.POSITION]
    const count = Number(accessor?.count) || 0
    triangles += Math.floor(count / 3)
  }
  const accounted = 12 + jsonBytes + binBytes
  return {
    bytes: bytes.length, jsonBytes, binBytes, imageBytes, animationBytes, geometryBytes,
    otherBytes: Math.max(0, bytes.length - accounted),
    extensions: [...(json.extensionsUsed ?? [])].map(String),
    meshes: (json.meshes ?? []).length, triangles, textures: (json.textures ?? []).length,
    animations: (json.animations ?? []).length,
  }
}

export function exportBreakdown(info: GLBExportInfo): string {
  return `textures ${formatSize(info.imageBytes)} · geometry ${formatSize(info.geometryBytes)} · animation ${formatSize(info.animationBytes)}`
}
