import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import type { Scene } from '@babylonjs/core/scene'

/**
 * Upload a picture as a flat plane (studio).
 *
 * The chosen PNG/JPG/WebP is decoded, bounded to the app's texture limits
 * (long side ≤ IMAGE_MAX_SIDE, decoded pixels within the GLB safety scan
 * budget) and placed in the studio as one double-sided unlit plane whose
 * material carries the image. Publishing re-exports the studio scene, so
 * the texture lands in the GLB exactly like any library piece's texture
 * (the export review codec can still lossy-compress it to WebP).
 */

/** Long-side cap: keeps the embedded PNG well under the 8 MiB recommended
 *  post budget while staying far inside the 4096 px engine limit. */
export const IMAGE_MAX_SIDE = 2048

/** Resolve once the texture's pixels are available (data-URI decode). */
export function waitTextureReady(tex: Texture, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (tex.isReady()) { resolve(); return }
    const timer = setTimeout(() => reject(new Error('texture load timed out')), timeoutMs)
    tex.onLoadObservable.addOnce(() => { clearTimeout(timer); resolve() })
  })
}

export interface DecodedImage {
  canvas: HTMLCanvasElement
  width: number
  height: number
  /** True when the source was larger than IMAGE_MAX_SIDE and got resized. */
  downscaled: boolean
}

function objectUrlToImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('not a decodable image'))
    img.src = url
  })
}

/**
 * Decode an image file to a canvas bounded to the app's texture limits.
 * Throws a readable error for undecodable files. Alpha is preserved.
 */
export async function decodeImageFile(file: File): Promise<DecodedImage> {
  const limit = IMAGE_MAX_SIDE
  let bitmap: ImageBitmap | null = null
  let img: HTMLImageElement | null = null
  let url: string | null = null
  try {
    if (typeof createImageBitmap === 'function') {
      try { bitmap = await createImageBitmap(file) } catch { /* fall through */ }
    }
    if (!bitmap) {
      url = URL.createObjectURL(file)
      img = await objectUrlToImage(url)
    }
    const src = bitmap ?? img
    if (!src) throw new Error('not a decodable image')
    const srcW = src.width
    const srcH = src.height
    if (srcW < 1 || srcH < 1) throw new Error('image has no pixels')
    const scale = Math.min(1, limit / Math.max(srcW, srcH))
    const w = Math.max(1, Math.round(srcW * scale))
    const h = Math.max(1, Math.round(srcH * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas unavailable')
    ctx.drawImage(src, 0, 0, w, h)
    return { canvas, width: w, height: h, downscaled: scale < 1 }
  } finally {
    if (bitmap?.close) bitmap.close()
    if (url) URL.revokeObjectURL(url)
  }
}

export interface ImagePlane {
  mesh: Mesh
  texture: Texture
  /** world units */
  width: number
  height: number
  sourceName: string
  pixelW: number
  pixelH: number
}

/**
 * Build a double-sided unlit plane carrying the decoded image. `worldWidth`
 * sets the plane width in world units; the height follows the image aspect.
 * The plane faces +Z (the same convention as the library's flat 2D plates).
 */
export function buildImagePlane(
  scene: Scene,
  decoded: DecodedImage,
  worldWidth: number,
): ImagePlane {
  const aspect = decoded.height / decoded.width
  const w = Math.max(0.01, worldWidth)
  const h = w * aspect
  const name = `studio-image-${decoded.width}x${decoded.height}`
  // The Texture API loads a URL (data URIs are the repo's established path);
  // the canvas becomes the source, so no async fetch is involved.
  const tex = new Texture(decoded.canvas.toDataURL('image/png'), scene, false, false, Texture.BILINEAR_SAMPLINGMODE)
  tex.name = name
  tex.hasAlpha = true
  const mat = new PBRMaterial(`${name}-mat`, scene)
  mat.albedoTexture = tex
  mat.unlit = true // a picture is a picture: no studio lighting on it
  mat.alphaMode = PBRMaterial.PBRMATERIAL_ALPHABLEND
  mat.backFaceCulling = false // rule 7: display rendering is double-sided
  mat.metallic = 0
  mat.roughness = 1
  const mesh = MeshBuilder.CreatePlane(name, { width: w, height: h }, scene)
  mesh.material = mat
  mesh.isPickable = true
  return { mesh, texture: tex, width: w, height: h, sourceName: '', pixelW: decoded.width, pixelH: decoded.height }
}
