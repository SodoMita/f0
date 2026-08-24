import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import type { Scene } from '@babylonjs/core/scene'
import { LIMITS } from '../theme'

/**
 * Upload a picture as a flat plane (studio).
 *
 * The chosen PNG/JPG/WebP is decoded at its NATIVE resolution — no
 * downscaling: the post's own size limit (modelBytesHard) is what bounds
 * how large a picture can be. The only up-front refusal is the engine's
 * hard texture ceiling (LIMITS.textureSide): a larger side could not pass
 * validateGLB at publish, so it is surfaced as a clear error instead of a
 * silent resize. The plane is double-sided and unlit; publishing re-exports
 * the studio scene, so the texture lands in the GLB exactly like any
 * library piece's texture (the export review codec can still lossy-compress
 * it to WebP).
 */

/** Hard platform ceiling: validateGLB refuses any texture with a side
 *  above this, so a picture that big could never publish. Kept as the
 *  refusal threshold, not a downscale target. */
export const IMAGE_SIDE_HARD_LIMIT = LIMITS.textureSide

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
 * Decode an image file at its native resolution. Throws a readable error
 * for undecodable files and for images whose side exceeds the engine's
 * hard texture limit (they could not publish anyway). Alpha is preserved.
 */
export async function decodeImageFile(file: File): Promise<DecodedImage> {
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
    if (srcW > IMAGE_SIDE_HARD_LIMIT || srcH > IMAGE_SIDE_HARD_LIMIT) {
      throw new Error(`image is ${srcW}×${srcH} — a side exceeds the engine's ${IMAGE_SIDE_HARD_LIMIT} px texture limit and the post could not be published`)
    }
    const canvas = document.createElement('canvas')
    canvas.width = srcW
    canvas.height = srcH
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D canvas unavailable')
    ctx.drawImage(src, 0, 0, srcW, srcH)
    return { canvas, width: srcW, height: srcH }
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
