import { Scene } from '@babylonjs/core/scene'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
import type { AssetContainer } from '@babylonjs/core/assetContainer'
import { GLTF2Export } from '@babylonjs/serializers/glTF/2.0/glTFSerializer'
import { LIMITS } from '../theme'
import {
  dataUriImageHead, imageDimensions, limitDecodedPixels, limitTextureSide, validateGLB,
} from './limits'
// Keep the global glTF registration curated: importing the loader barrel would
// re-enable KHR_interactivity/FlowGraph for every remote post in the app.
import './gltf'
import '@babylonjs/loaders/OBJ/objFileLoader'

export interface ImportResult {
  container: AssetContainer
  /** Self-contained GLB produced by re-exporting the loaded scene. */
  glb: Blob
  filename: string
  sourceFormat: 'glb' | 'gltf' | 'obj'
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tga|ktx2)$/i
const PRIMARY_EXT = /\.(glb|gltf|obj)$/i
const MAX_IMPORT_FILES = 128
const MAX_URI_LENGTH = 2048

function basename(path: string): string {
  let clean = path.replace(/^file:/i, '').split(/[?#]/, 1)[0]
  try { clean = decodeURIComponent(clean) } catch { /* retain malformed spelling for a clean "missing" error */ }
  return clean.split(/[\\/]/).pop() || clean
}

function isDataUri(uri: string): boolean { return /^data:/i.test(uri) }

/** A document URI must be data: or a relative path selected by the player. */
function companionName(uri: string, allowLoaderFilePrefix = false): string | null {
  if (!uri || uri.length > MAX_URI_LENGTH || /[\u0000-\u001f\u007f]/.test(uri)) throw new Error('Invalid companion URI')
  if (isDataUri(uri)) return null
  let local = uri
  if (allowLoaderFilePrefix && /^file:/i.test(local)) local = local.slice(5)
  if (/^[a-z][a-z0-9+.-]*:/i.test(local) || /^[/\\]{1,2}/.test(local)) {
    throw new Error(`Remote or absolute companion URI is not allowed: ${uri.slice(0, 120)}`)
  }
  const name = basename(local)
  if (!name || name === '.' || name === '..') throw new Error('Invalid companion filename')
  return name
}

function asArray(value: unknown): any[] { return Array.isArray(value) ? value : [] }

/** Structural preflight for .gltf before Babylon allocates meshes/buffers. */
function validateGltfShape(gltf: any): void {
  if (!gltf || typeof gltf !== 'object' || Array.isArray(gltf)) throw new Error('glTF JSON must be an object')
  const nodes = asArray(gltf.nodes)
  const meshes = asArray(gltf.meshes)
  const accessors = asArray(gltf.accessors)
  const materials = asArray(gltf.materials)
  const textures = asArray(gltf.textures)
  const cameras = asArray(gltf.cameras)
  const skins = asArray(gltf.skins)
  const animations = asArray(gltf.animations)
  const lights = asArray(gltf.extensions?.KHR_lights_punctual?.lights)
  const buffers = asArray(gltf.buffers)
  const bufferViews = asArray(gltf.bufferViews)

  const capped = (label: string, count: number, limit: number) => {
    if (!Number.isSafeInteger(count) || count < 0 || count > limit) throw new Error(`${label} ${count} > ${limit}`)
  }
  const accessorCount = (accessor: any): number => {
    const count = accessor?.count
    capped('accessor count', count, LIMITS.indices)
    return count
  }
  capped('nodes', nodes.length, LIMITS.nodes)
  capped('meshes', meshes.length, LIMITS.meshes)
  capped('materials', materials.length, LIMITS.materials)
  capped('textures', textures.length, LIMITS.textures)
  capped('cameras', cameras.length, LIMITS.cameras)
  capped('skins', skins.length, LIMITS.skins)
  capped('lights', lights.length, LIMITS.lights)

  let bufferBytes = 0
  for (const buffer of buffers) {
    capped('buffer bytes', buffer?.byteLength, LIMITS.modelBytesHard)
    bufferBytes += buffer.byteLength
  }
  capped('total buffer bytes', bufferBytes, LIMITS.modelBytesHard)
  for (const view of bufferViews) {
    if (!Number.isSafeInteger(view?.buffer) || view.buffer < 0 || view.buffer >= buffers.length) throw new Error('Invalid bufferView buffer')
    const offset = view.byteOffset ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid bufferView offset')
    capped('bufferView bytes', view?.byteLength, LIMITS.modelBytesHard)
    if (offset + view.byteLength > buffers[view.buffer].byteLength) throw new Error('bufferView exceeds its buffer')
  }

  let accessorElements = 0
  for (const accessor of accessors) accessorElements += accessorCount(accessor)
  capped(
    'total accessor elements', accessorElements,
    LIMITS.indices + LIMITS.vertices * 8 + LIMITS.keyframes * 2,
  )

  let primitives = 0
  let vertices = 0
  let indices = 0
  for (const mesh of meshes) {
    for (const prim of asArray(mesh?.primitives)) {
      primitives++
      const pos = accessors[prim?.attributes?.POSITION]
      const idx = prim?.indices === undefined ? undefined : accessors[prim.indices]
      vertices += pos ? accessorCount(pos) : 0
      indices += idx ? accessorCount(idx) : 0
    }
  }
  capped('primitives', primitives, LIMITS.primitives)
  capped('vertices', vertices, LIMITS.vertices)
  capped('indices', indices, LIMITS.indices)

  let channels = 0
  let keyframes = 0
  for (const animation of animations) {
    channels += asArray(animation?.channels).length
    const samplers = asArray(animation?.samplers)
    for (const sampler of samplers) {
      const input = accessors[sampler?.input]
      keyframes += input ? accessorCount(input) : 0
    }
  }
  capped('animation channels', channels, LIMITS.animationChannels)
  capped('keyframes', keyframes, LIMITS.keyframes)
  for (const skin of skins) capped('joints per skin', asArray(skin?.joints).length, LIMITS.jointsPerSkin)

  const depthOf = (index: number, seen: Set<number>): number => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= nodes.length || seen.has(index)) return Number.POSITIVE_INFINITY
    seen.add(index)
    let depth = 1
    for (const child of asArray(nodes[index]?.children)) depth = Math.max(depth, 1 + depthOf(child, new Set(seen)))
    return depth
  }
  let depth = 0
  for (let i = 0; i < nodes.length; i++) depth = Math.max(depth, depthOf(i, new Set()))
  capped('scene graph depth', depth, LIMITS.sceneDepth)
}

function collectUris(value: unknown, out: string[]): void {
  if (Array.isArray(value)) { for (const item of value) collectUris(item, out); return }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (key === 'uri' && typeof child === 'string' && child) out.push(child)
    else collectUris(child, out)
  }
}

function decodeDataBuffer(uri: string): Uint8Array {
  const match = /^data:[^,]*?(;base64)?,(.*)$/is.exec(uri)
  if (!match) throw new Error('Malformed buffer data URI')
  try {
    if (match[1]) {
      const raw = atob(match[2].replace(/\s/g, ''))
      const out = new Uint8Array(raw.length)
      for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
      return out
    }
    const bytes: number[] = []
    for (let i = 0; i < match[2].length;) {
      if (match[2][i] === '%' && /^[0-9a-f]{2}$/i.test(match[2].slice(i + 1, i + 3))) {
        bytes.push(parseInt(match[2].slice(i + 1, i + 3), 16)); i += 3
      } else {
        const code = match[2].charCodeAt(i++)
        if (code > 0x7f) throw new Error('Non-ASCII byte in buffer data URI')
        bytes.push(code)
      }
    }
    return new Uint8Array(bytes)
  } catch { throw new Error('Malformed buffer data URI') }
}

/** Scan uncompressed float POSITION bytes before Babylon computes bounds. */
async function validateGltfPositions(gltf: any, find: (uri: string) => File): Promise<void> {
  const buffers = asArray(gltf.buffers)
  const views = asArray(gltf.bufferViews)
  const accessors = asArray(gltf.accessors)
  const meshes = asArray(gltf.meshes)
  const cache = new Map<number, Uint8Array>()
  const bytesFor = async (index: number): Promise<Uint8Array> => {
    const hit = cache.get(index)
    if (hit) return hit
    const buffer = buffers[index]
    if (!buffer || typeof buffer.uri !== 'string') throw new Error('A .gltf buffer must have a local or data URI')
    const bytes = isDataUri(buffer.uri)
      ? decodeDataBuffer(buffer.uri)
      : new Uint8Array(await find(buffer.uri).arrayBuffer())
    if (bytes.byteLength < buffer.byteLength) throw new Error('Buffer is shorter than its declared byteLength')
    cache.set(index, bytes)
    return bytes
  }

  for (const mesh of meshes) {
    for (const prim of asArray(mesh?.primitives)) {
      if (prim?.extensions?.KHR_draco_mesh_compression || prim?.extensions?.EXT_meshopt_compression) continue
      const accessor = accessors[prim?.attributes?.POSITION]
      if (!accessor || accessor.componentType !== 5126 || accessor.type !== 'VEC3') continue
      if (accessor.sparse) throw new Error('Sparse POSITION accessors are not accepted by the safety scanner')
      const view = views[accessor.bufferView]
      if (!view) throw new Error('POSITION accessor has no bufferView')
      const bytes = await bytesFor(view.buffer)
      const viewStart = view.byteOffset ?? 0
      const accessorStart = accessor.byteOffset ?? 0
      const stride = view.byteStride ?? 12
      const count = accessor.count
      if (!Number.isSafeInteger(accessorStart) || accessorStart < 0 || !Number.isSafeInteger(stride) || stride < 12) {
        throw new Error('Invalid POSITION accessor layout')
      }
      if (count > 0 && accessorStart + (count - 1) * stride + 12 > view.byteLength) {
        throw new Error('POSITION accessor exceeds its bufferView')
      }
      const absolute = viewStart + accessorStart
      if (absolute + (count ? (count - 1) * stride + 12 : 0) > bytes.byteLength) throw new Error('POSITION accessor exceeds its buffer')
      const data = new DataView(bytes.buffer, bytes.byteOffset + absolute, bytes.byteLength - absolute)
      for (let i = 0; i < count; i++) {
        const offset = i * stride
        if (!Number.isFinite(data.getFloat32(offset, true))
          || !Number.isFinite(data.getFloat32(offset + 4, true))
          || !Number.isFinite(data.getFloat32(offset + 8, true))) {
          throw new Error('Non-finite vertex position in glTF')
        }
      }
    }
  }
}

async function imageHead(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer())
}

async function validateSelectedImages(files: File[], dataImageUris: string[] = []): Promise<void> {
  let decodedBytes = 0
  for (const file of files) {
    if (!IMAGE_EXT.test(file.name)) continue
    const dims = imageDimensions(await imageHead(file))
    if (!dims) throw new Error(`Texture dimensions could not be validated: ${file.name}`)
    const side = Math.max(dims.width, dims.height)
    if (dims.width < 1 || dims.height < 1 || side > limitTextureSide()) {
      throw new Error(`Texture ${file.name} is ${dims.width}x${dims.height}; limit is ${limitTextureSide()} px`)
    }
    decodedBytes += dims.width * dims.height * 4
  }
  for (const uri of dataImageUris) {
    const head = dataUriImageHead(uri)
    if (!head) throw new Error('Malformed image data URI')
    const dims = imageDimensions(head)
    if (!dims) throw new Error('Data texture dimensions could not be validated')
    const side = Math.max(dims.width, dims.height)
    if (dims.width < 1 || dims.height < 1 || side > limitTextureSide()) {
      throw new Error(`Data texture is ${dims.width}x${dims.height}; limit is ${limitTextureSide()} px`)
    }
    decodedBytes += dims.width * dims.height * 4
  }
  if (decodedBytes > limitDecodedPixels()) {
    throw new Error(`Decoded texture memory ${(decodedBytes / 1048576).toFixed(0)} MiB > ${(limitDecodedPixels() / 1048576).toFixed(0)} MiB`)
  }
}

function activeLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.replace(/#.*$/, '').trim()).filter(Boolean)
}

function validateObjShape(text: string): string[] {
  let vertices = 0
  let indices = 0
  let meshes = 0
  const materialFiles: string[] = []
  for (const line of activeLines(text)) {
    const split = line.search(/\s/)
    const keyword = (split < 0 ? line : line.slice(0, split)).toLowerCase()
    const rest = split < 0 ? '' : line.slice(split).trim()
    if (keyword === 'v' || keyword === 'vn' || keyword === 'vt') {
      if (keyword === 'v') vertices++
      const required = keyword === 'vt' ? 2 : 3
      const components = rest.split(/\s+/).slice(0, required).map(Number)
      if (components.length < required || components.some((v) => !Number.isFinite(v))) {
        throw new Error(`OBJ has non-finite ${keyword} data`)
      }
    } else if (keyword === 'f') {
      const corners = rest.split(/\s+/).filter(Boolean).length
      if (corners >= 3) indices += (corners - 2) * 3
    } else if (keyword === 'o' || keyword === 'g') {
      meshes++
    } else if (keyword === 'mtllib' && rest) {
      materialFiles.push(rest)
    }
  }
  if (vertices > LIMITS.vertices) throw new Error(`vertices ${vertices} > ${LIMITS.vertices}`)
  if (indices > LIMITS.indices) throw new Error(`indices ${indices} > ${LIMITS.indices}`)
  if (meshes > LIMITS.meshes) throw new Error(`meshes ${meshes} > ${LIMITS.meshes}`)
  return materialFiles
}

function validateMtl(text: string, find: (uri: string) => File): void {
  let materials = 0
  for (const line of activeLines(text)) {
    const split = line.search(/\s/)
    const keyword = (split < 0 ? line : line.slice(0, split)).toLowerCase()
    const rest = split < 0 ? '' : line.slice(split).trim()
    if (keyword === 'newmtl') materials++
    if (!rest || !(keyword.startsWith('map_') || ['bump', 'disp', 'decal', 'refl'].includes(keyword))) continue
    // Babylon accepts a few map options. Prefer the whole remainder (filenames
    // may contain spaces), then the final token after options.
    try { find(rest) } catch { find(rest.split(/\s+/).pop() || rest) }
  }
  if (materials > LIMITS.materials) throw new Error(`materials ${materials} > ${LIMITS.materials}`)
}

/**
 * Load a bounded, fully local multi-file selection and repack it to one GLB.
 * No selected model is allowed to turn an import into an app-origin or remote
 * network request.
 */
export async function importModelFiles(scene: Scene, files: File[]): Promise<ImportResult> {
  if (!files.length) throw new Error('No file selected')
  if (files.length > MAX_IMPORT_FILES) throw new Error(`Choose at most ${MAX_IMPORT_FILES} files`)
  if (files.some((file) => /\.basis$/i.test(file.name))) {
    throw new Error('Raw .basis textures cannot be dimension-validated; use a .ktx2 container')
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  if (!Number.isSafeInteger(totalBytes) || totalBytes > LIMITS.modelBytesHard) {
    throw new Error(`Selected files total ${(totalBytes / 1048576).toFixed(1)} MiB; limit is ${LIMITS.modelBytesHard / 1048576} MiB`)
  }

  const primaries = files.filter((file) => PRIMARY_EXT.test(file.name))
  if (primaries.length !== 1) throw new Error('Choose exactly one .glb, .gltf, or .obj file')
  const primary = primaries[0]
  const extension = primary.name.toLowerCase().split('.').pop()

  // A GLB is validated before Babylon sees one byte. This restores the hard
  // rule that the sidecar branch accidentally bypassed.
  if (extension === 'glb') {
    const bytes = new Uint8Array(await primary.arrayBuffer())
    const report = validateGLB(bytes)
    if (!report.ok) throw new Error(report.reason)
    const container = await LoadAssetContainerAsync(primary, scene)
    container.addAllToScene()
    return { container, glb: primary, filename: primary.name, sourceFormat: 'glb' }
  }

  // Index companions case-insensitively by basename. Ambiguity is rejected;
  // silently choosing one of two texture.png files is unsafe and surprising.
  const byName = new Map<string, File>()
  for (const file of files) {
    if (file === primary) continue
    const key = basename(file.name).toLowerCase()
    const previous = byName.get(key)
    if (previous && previous !== file) throw new Error(`Ambiguous companion filename: ${basename(file.name)}`)
    byName.set(key, file)
  }
  const findCompanion = (uri: string, loaderUrl = false): File => {
    const name = companionName(uri, loaderUrl)
    if (!name) throw new Error('Expected a selected companion, not a data URI')
    const file = byName.get(name.toLowerCase())
    if (!file) throw new Error(`Missing companion file: ${name}`)
    return file
  }

  let gltfJson: any = null
  if (extension === 'gltf') {
    if (primary.size > LIMITS.jsonChunkBytes) throw new Error('glTF JSON exceeds 2 MiB')
    try { gltfJson = JSON.parse(await primary.text()) } catch { throw new Error('glTF JSON is not valid JSON') }
    validateGltfShape(gltfJson)
    const uris: string[] = []
    collectUris(gltfJson, uris)
    const dataImages: string[] = []
    for (const uri of uris) {
      if (isDataUri(uri)) {
        if (/^data:image\//i.test(uri)) dataImages.push(uri)
        continue
      }
      findCompanion(uri)
    }
    for (const buffer of asArray(gltfJson.buffers)) {
      if (typeof buffer?.uri !== 'string' || isDataUri(buffer.uri)) continue
      const file = findCompanion(buffer.uri)
      if (!Number.isSafeInteger(buffer.byteLength) || buffer.byteLength < 0 || buffer.byteLength > file.size) {
        throw new Error(`Buffer length does not match companion: ${file.name}`)
      }
    }
    await validateGltfPositions(gltfJson, (uri) => findCompanion(uri))
    await validateSelectedImages(files, dataImages)
  } else {
    const objText = await primary.text()
    const materialUris = validateObjShape(objText)
    const materialFiles = materialUris.map((uri) => findCompanion(uri))
    for (const mtl of materialFiles) validateMtl(await mtl.text(), (uri) => findCompanion(uri))
    await validateSelectedImages(files)
  }

  const urls = new Map<File, string>()
  const generatedUrls = new Set<string>()
  const urlFor = (file: File): string => {
    let url = urls.get(file)
    if (!url) {
      url = URL.createObjectURL(file)
      urls.set(file, url)
      generatedUrls.add(url)
    }
    return url
  }
  const resolveCompanion = (uri: string): string => {
    if (isDataUri(uri) || generatedUrls.has(uri)) return uri
    return urlFor(findCompanion(uri, true))
  }

  // OBJ's MTL/texture loads bypass glTF's per-loader hook. Intercept only its
  // file: dependency URLs; unrelated app HTTPS requests keep the previous
  // processor if they happen concurrently.
  const FileTools = await import('@babylonjs/core/Misc/fileTools')
  const previousUrlProcessor = FileTools.FileTools.PreprocessUrl
  FileTools.FileTools.PreprocessUrl = (url: string) => {
    if (/^file:/i.test(url)) return resolveCompanion(url)
    return previousUrlProcessor(url)
  }

  let container: AssetContainer
  try {
    container = await LoadAssetContainerAsync(primary, scene, {
      pluginOptions: {
        gltf: {
          preprocessUrlAsync: async (url: string) => resolveCompanion(url),
        },
      },
    })
    container.addAllToScene()
  } finally {
    FileTools.FileTools.PreprocessUrl = previousUrlProcessor
    // Revoke after a delay so in-flight image uploads can finish.
    setTimeout(() => {
      for (const url of urls.values()) URL.revokeObjectURL(url)
      urls.clear()
      generatedUrls.clear()
    }, 8000)
  }

  // OBJ line geometry has no glTF equivalent. Keep it in the local preview,
  // but disable it while creating the publishable GLB.
  const isLine = (mesh: any) => {
    if (typeof mesh.getClassName === 'function' && mesh.getClassName() === 'LinesMesh') return true
    if ((mesh.subMeshes || []).some((sub: any) => sub.fillMode === 1)) return true
    return !!mesh.material && (mesh.material.wireframe === true || mesh.material.fillMode === 1)
  }
  const triangleMeshes = container.meshes.filter((mesh) => !isLine(mesh))
  const enabled = new Map(container.meshes.map((mesh) => [mesh, mesh.isEnabled()]))
  for (const mesh of container.meshes) if (!triangleMeshes.includes(mesh)) mesh.setEnabled(false)

  try {
    const exported = await GLTF2Export.GLBAsync(scene, primary.name.replace(/\.[^.]+$/, '') || 'model', {
      shouldExportNode: (node) => triangleMeshes.includes(node as any) || container.transformNodes.includes(node as any),
    })
    const outFile = Object.values(exported.glTFFiles)[0]
    const glbBlob = outFile instanceof Blob ? outFile : new Blob([outFile], { type: 'model/gltf-binary' })
    return {
      container,
      glb: glbBlob,
      filename: primary.name.replace(/\.[^.]+$/, '') + '.glb',
      sourceFormat: extension as 'gltf' | 'obj',
    }
  } catch (err) {
    container.removeAllFromScene()
    container.dispose()
    throw err
  } finally {
    for (const [mesh, wasEnabled] of enabled) mesh.setEnabled(wasEnabled)
  }
}
