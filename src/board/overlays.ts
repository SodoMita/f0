import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { Constants } from '@babylonjs/core/Engines/constants'
import type { Scene } from '@babylonjs/core/scene'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import type { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial'
import {
  makeCardMaterial, setCardTexture, setCardTint, setCardWhite, setCardOpacity, setCardFlip,
} from './cardMaterial'
import { roundRect, paintPlayButtons } from '../core/gfx'
import { theme } from '../theme'

/** Overlay pass (badge / play / spinner) — after group 0 so posts cannot cover buttons. */
export const OVERLAY_GROUP = 1

export function disableOverlayAutoClear(scene: Scene): void {
  scene.setRenderingAutoClearDepthStencil(OVERLAY_GROUP, false)
}

export interface QuadOpts {
  z?: number
  group?: number
  pickable?: boolean
  enabled?: boolean
  blend?: boolean
}

/**
 * Overlay (badge / ▶ / spinner): group 1 only fixes SORT order. Depth is not
 * cleared between groups, so a 3D model sticking out of the card won the
 * depth test against the button on top of it. Overlays never write depth;
 * ignoring the test is what "always on top" means.
 */
export function makeOverlayMaterial(scene: Scene): ShaderMaterial {
  const mat = makeCardMaterial(scene)
  mat.depthFunction = Constants.ALWAYS
  return mat
}

export function makeQuad(scene: Scene, name: string, opts: QuadOpts = {}): { mesh: Mesh; mat: ShaderMaterial } {
  const mesh = MeshBuilder.CreatePlane(name, { width: 4, height: 4 }, scene)
  mesh.setEnabled(opts.enabled ?? false)
  mesh.isPickable = opts.pickable ?? false
  mesh.position.z = opts.z ?? 0
  const overlay = opts.group !== undefined
  if (overlay) mesh.renderingGroupId = opts.group as number
  const mat = overlay ? makeOverlayMaterial(scene) : makeCardMaterial(scene, opts.blend ?? true)
  mesh.material = mat
  return { mesh, mat }
}

export function bindDyn(mat: ShaderMaterial, tex: DynamicTexture, tint?: string, opacity?: number): void {
  setCardTexture(mat, tex)
  if (tint) setCardTint(mat, tint)
  else setCardWhite(mat)
  if (opacity !== undefined) setCardOpacity(mat, opacity)
  setCardFlip(mat, 'dyn')
}

export function makePlayTextures(scene: Scene, prefix: string, dark: boolean): { off: DynamicTexture; on: DynamicTexture } {
  const mk = (name: string) => {
    const tex = new DynamicTexture(name, { width: 128, height: 128 }, scene, false, Texture.BILINEAR_SAMPLINGMODE)
    tex.hasAlpha = true
    return tex
  }
  const off = mk(`${prefix}-off`)
  const on = mk(`${prefix}-on`)
  paintPlayButtons(off, on, dark, theme.ink)
  return { off, on }
}

export function paintGlassPill(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, dark: boolean,
): void {
  ctx.fillStyle = dark ? 'rgba(12,12,14,0.62)' : 'rgba(250,250,252,0.72)'
  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.30)' : 'rgba(0,0,0,0.28)'
  ctx.lineWidth = Math.max(2, h * 0.028)
  roundRect(ctx, x, y, w, h, h / 2)
  ctx.fill()
  ctx.stroke()
}

/** Vector ↩ — never a font glyph (missing from most UI fonts). */
export function strokeReplyArrow(ctx: CanvasRenderingContext2D, ax: number, cy: number, s: number): void {
  ctx.beginPath()
  ctx.moveTo(ax + s, cy - s * 0.85)
  ctx.lineTo(ax + s * 0.15, cy - s * 0.85)
  ctx.quadraticCurveTo(ax - s * 0.75, cy - s * 0.85, ax - s * 0.75, cy + s * 0.05)
  ctx.lineTo(ax - s * 0.75, cy + s * 0.5)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(ax - s * 0.75 - s * 0.5, cy + s * 0.05)
  ctx.lineTo(ax - s * 0.75, cy + s * 0.6)
  ctx.lineTo(ax - s * 0.75 + s * 0.5, cy + s * 0.05)
  ctx.stroke()
}

export function inkFor(dark: boolean): string {
  return dark ? theme.ink : '#101014'
}
