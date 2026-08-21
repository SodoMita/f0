import type { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial'
import type { Texture as TextureT } from '@babylonjs/core/Materials/Textures/texture'
import {
  setCardTexture, setCardTexture2, setCardTint, setCardTint2,
  setCardOpacity, setCardBlend, setCardFlip, type CardTextureKind,
} from './cardMaterial'

/** SPEC CARD 120ms two-texture crossfade (hard swaps flickered black). */
export const CROSSFADE_MS = 120

export interface CardFade {
  opacity: number
  fadeFrom: number
  fadeTo: number
  fadeStart: number
  blend: number
  fadeFromBlend: number
  fadeToBlend: number
  fadeTex2: TextureT | null
  fadeTint2Hex: string
  fadeFlip: CardTextureKind
}

export function fadeInit(opacity = 0): CardFade {
  return {
    opacity, fadeFrom: opacity, fadeTo: opacity, fadeStart: 0,
    blend: 0, fadeFromBlend: 0, fadeToBlend: 1,
    fadeTex2: null, fadeTint2Hex: '#FFFFFF', fadeFlip: 'raw',
  }
}

/** Snap to the current crossfade target. Must reset blend or the white fallback shows. */
export function finishFade(s: CardFade, mat: ShaderMaterial): void {
  s.fadeStart = 0
  s.opacity = s.fadeTo
  setCardOpacity(mat, s.opacity)
  s.blend = 0
  setCardBlend(mat, 0)
  if (s.fadeTex2) {
    setCardTexture(mat, s.fadeTex2)
    setCardTint(mat, s.fadeTint2Hex)
    setCardTexture2(mat, null)
    setCardTint2(mat, '#FFFFFF')
    setCardFlip(mat, s.fadeFlip)
    s.fadeTex2 = null
  }
}

export function setOpacityNow(s: CardFade, mat: ShaderMaterial, v: number): void {
  s.opacity = v
  s.fadeStart = 0
  s.blend = 0
  setCardBlend(mat, 0)
  if (s.fadeTex2) {
    setCardTexture2(mat, null)
    setCardTint2(mat, '#FFFFFF')
    s.fadeTex2 = null
  }
  setCardOpacity(mat, v)
}

export function crossfadeTo(
  s: CardFade, mat: ShaderMaterial,
  tex2: TextureT | null, tint2Hex: string, flip: CardTextureKind, toOpacity = 1,
): void {
  if (s.fadeStart) finishFade(s, mat)
  setCardTexture2(mat, tex2)
  setCardTint2(mat, tint2Hex)
  s.fadeTex2 = tex2
  s.fadeTint2Hex = tint2Hex
  s.fadeFlip = flip
  s.fadeFrom = s.opacity
  s.fadeTo = toOpacity
  s.fadeFromBlend = 0
  s.fadeToBlend = 1
  s.fadeStart = performance.now()
}

export function fadeOpacityTo(s: CardFade, mat: ShaderMaterial, v: number): void {
  if (s.fadeStart === 0 && s.opacity === v) return
  s.fadeFrom = s.opacity
  s.fadeTo = v
  s.fadeFromBlend = 0
  s.fadeToBlend = 0
  s.fadeStart = performance.now()
}

/** Advance one fade. Returns true while still in flight. */
export function tickFade(s: CardFade, mat: ShaderMaterial, now: number): boolean {
  if (!s.fadeStart) return false
  const t = Math.min(1, (now - s.fadeStart) / CROSSFADE_MS)
  s.opacity = s.fadeFrom + (s.fadeTo - s.fadeFrom) * t
  setCardOpacity(mat, s.opacity)
  s.blend = s.fadeFromBlend + (s.fadeToBlend - s.fadeFromBlend) * t
  setCardBlend(mat, s.blend)
  if (t >= 1) finishFade(s, mat)
  return t < 1
}

/** Poster after a live slot is released; 3D mode keeps the plate invisible. */
export function showPoster(
  s: CardFade, mat: ShaderMaterial,
  poster: TextureT | null, plateTint: string, threeD: boolean,
): void {
  if (threeD) { setOpacityNow(s, mat, 0); return }
  if (poster) crossfadeTo(s, mat, poster, '#FFFFFF', 'rtt')
  else {
    setCardTexture(mat, null)
    setCardTint(mat, plateTint)
    setCardFlip(mat, 'raw')
    fadeOpacityTo(s, mat, 0.14)
  }
}
