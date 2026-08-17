import { Scene } from '@babylonjs/core/scene'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
import type { AssetContainer } from '@babylonjs/core/assetContainer'
import { GLTF2Export } from '@babylonjs/serializers/glTF'
import '@babylonjs/loaders/glTF'
import '@babylonjs/loaders/OBJ'

export interface ImportResult {
  container: AssetContainer
  /** Self-contained GLB produced by re-exporting the loaded scene. */
  glb: Blob
  filename: string
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tga|ktx2|basis)$/i
const BIN_EXT = /\.bin$/i

function basename(path: string): string {
  return decodeURIComponent(path.split(/[\\/]/).pop() || path)
}

function isExternalUri(uri: unknown): uri is string {
  return typeof uri === 'string' && !!uri && !/^(data:|blob:|https?:)/i.test(uri)
}

/**
 * Load a multi-file selection:
 *  - a self-contained .glb is loaded directly
 *  - a .gltf plus its .bin and image/texture companions are resolved by
 *    basename (regardless of the folder they were picked from) and exported
 *    to a self-contained GLB
 *  - an .obj (with optional .mtl + textures) is loaded and exported to GLB
 *
 * The companion lookup mirrors the old Three VFS: external URIs are matched
 * to selected files by basename, so a gltf referencing "textures/foo.png"
 * resolves to a selected file named "foo.png".
 */
export async function importModelFiles(scene: Scene, files: File[]): Promise<ImportResult> {
  if (!files.length) throw new Error('No file selected')

  const glb = files.find((f) => f.name.toLowerCase().endsWith('.glb'))
  if (glb) {
    const container = await LoadAssetContainerAsync(glb, scene)
    container.addAllToScene()
    return { container, glb: glb, filename: glb.name }
  }

  const gltf = files.find((f) => f.name.toLowerCase().endsWith('.gltf'))
  const obj = files.find((f) => f.name.toLowerCase().endsWith('.obj'))
  const primary = gltf ?? obj
  if (!primary) throw new Error('Choose a .glb, .gltf, or .obj file')

  // Index every companion by its basename (and lowercase basename).
  const byName = new Map<string, File>()
  for (const f of files) {
    if (f === primary) continue
    byName.set(f.name, f)
    byName.set(f.name.toLowerCase(), f)
    const base = basename(f.name)
    byName.set(base, f)
    byName.set(base.toLowerCase(), f)
  }

  if (gltf) {
    const json = JSON.parse(await gltf.text())
    const referenced = new Set<string>()
    const collect = (uri: unknown) => { if (isExternalUri(uri)) referenced.add(basename(uri)) }
    for (const b of json.buffers ?? []) collect(b.uri)
    for (const img of json.images ?? []) collect(img.uri)

    const missing: string[] = []
    for (const name of referenced) if (!byName.has(name)) missing.push(name)
    if (missing.length) throw new Error(`Missing companion file(s): ${[...new Set(missing)].join(', ')}`)
  }

  // Object URLs for companions; preprocessUrlAsync rewrites the glTF URIs.
  const urls = new Map<File, string>()
  const urlFor = (f: File) => {
    let u = urls.get(f)
    if (!u) { u = URL.createObjectURL(f); urls.set(f, u) }
    return u
  }
  const resolveCompanion = (uri: string): string => {
    const base = basename(uri)
    const f = byName.get(base) ?? byName.get(base.toLowerCase())
    return f ? urlFor(f) : uri
  }

  // OBJ's MTL/texture loads bypass the glTF hook, so install a global
  // PreprocessUrl for the duration of the import that maps companion URIs.
  const FileTools = await import('@babylonjs/core/Misc/fileTools')
  const previous = FileTools.FileTools.PreprocessUrl
  FileTools.FileTools.PreprocessUrl = (url: string) => {
    try { return isExternalUri(url) ? resolveCompanion(url) : url } catch { return url }
  }

  let container: AssetContainer
  try {
    container = await LoadAssetContainerAsync(primary, scene, {
      pluginOptions: {
        gltf: {
          // Map every external .bin/.png/etc URI to the selected companion.
          preprocessUrlAsync: async (url: string) => isExternalUri(url) ? resolveCompanion(url) : url,
        },
      },
    })
    container.addAllToScene()
  } finally {
    FileTools.FileTools.PreprocessUrl = previous
    // Revoke after a delay so in-flight GPU uploads finish.
    setTimeout(() => {
      for (const u of urls.values()) URL.revokeObjectURL(u)
      urls.clear()
    }, 8000)
  }

  // The OBJ loader can emit line-segment geometry (LinesMesh); glTF has no
  // line mode and the exporter throws "Unknown fill mode". Exclude line
  // meshes from the export (they remain in the container for preview but
  // are disabled, so they are neither drawn nor serialized).
  const isLine = (m: any) => {
    if (typeof m.getClassName === 'function' && m.getClassName() === 'LinesMesh') return true
    if ((m.subMeshes || []).some((sm: any) => sm.fillMode === 1)) return true
    // The OBJ loader emits line elements as a regular Mesh with a
    // wireframe material (no fill) — glTF cannot represent those.
    if (m.material && (m.material.wireframe === true || m.material.fillMode === 1)) return true
    return false
  }
  const triangleMeshes = container.meshes.filter((m) => !isLine(m))
  for (const m of container.meshes) {
    if (!triangleMeshes.includes(m)) m.setEnabled(false)
  }

  const exported = await GLTF2Export.GLBAsync(scene, primary.name.replace(/\.[^.]+$/, '') || 'model', {
    shouldExportNode: (n) => triangleMeshes.includes(n as any) || container.transformNodes.includes(n as any),
  })
  for (const m of container.meshes) m.setEnabled(true)
  const outFile = Object.values(exported.glTFFiles)[0]
  const glbBlob = outFile instanceof Blob ? outFile : new Blob([outFile], { type: 'model/gltf-binary' })


/** A mesh is exportable to glTF if every submesh draws triangles (fill mode 4). */

  return { container, glb: glbBlob, filename: primary.name.replace(/\.[^.]+$/, '') + '.glb' }
}
