import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import type { Scene } from '@babylonjs/core/scene'

/**
 * Shared 2D/backdrop helpers.
 *
 * `flatCamera` is the ONE place that decides how flat (card) scenes are
 * viewed. It parks the ortho camera at -Z looking toward +Z, which is the
 * only orientation where Babylon's left-handed axes put world +X on screen
 * right and show `CreatePlane`'s front face (normal 0,0,-1) to the viewer.
 * Everything else — no mirrored posters, no mirrored reply badges, columns
 * in reading order — follows from that. See `board/cardMaterial.ts`.
 *
 * Depth convention for flat scenes (camera at -Z):
 *   smaller z = closer to the camera.
 *   backdrop  z = +1 … +2   (furthest)
 *   cards     z =  0
 *   badges    z = -0.05     (in front of the card)
 */
export function flatCamera(scene: Scene, name: string, radius = 30): ArcRotateCamera {
  const cam = new ArcRotateCamera(name, -Math.PI / 2, Math.PI / 2, radius, Vector3.Zero(), scene)
  cam.mode = ArcRotateCamera.ORTHOGRAPHIC_CAMERA
  cam.inputs.clear()
  cam.detachControl()
  cam.minZ = -200
  cam.maxZ = 400
  scene.activeCamera = cam
  return cam
}

/** Device pixel ratio, clamped so huge-DPR phones don't melt the GPU. */
export function dpr(): number {
  const r = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  return Math.max(1, Math.min(2.5, r))
}

// ---------------------------------------------------------------- colours

export function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((n) => clampByte(n).toString(16).padStart(2, '0')).join('')
}

/** amount > 0 lightens toward white, < 0 darkens toward black. */
export function shade(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex)
  const t = amount > 0 ? 255 : 0
  const p = Math.abs(amount)
  return rgbToHex(r + (t - r) * p, g + (t - g) * p, b + (t - b) * p)
}

/** Perceived luminance 0..1 — decides whether a theme is light or dark. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

// -------------------------------------------------------------- backdrops

/**
 * Backdrop texture derived from the user's background colour: a soft vertical
 * gradient plus a wide radial lift in the upper third, so the scene reads as
 * a lit room instead of a void. Works for light themes too (it darkens the
 * edges instead of lightening them).
 */
export function paintBackdrop(tex: DynamicTexture, hex: string): void {
  const size = tex.getSize()
  const w = size.width
  const h = size.height
  const ctx = tex.getContext() as CanvasRenderingContext2D
  const dark = luminance(hex) < 0.5
  const top = shade(hex, dark ? 0.09 : -0.05)
  const bottom = shade(hex, dark ? -0.35 : -0.12)

  const g = ctx.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, top)
  g.addColorStop(0.55, hex)
  g.addColorStop(1, bottom)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)

  // radial lift, centred above the fold
  const rg = ctx.createRadialGradient(w / 2, h * 0.3, 0, w / 2, h * 0.3, Math.max(w, h) * 0.75)
  rg.addColorStop(0, dark ? 'rgba(255,255,255,0.055)' : 'rgba(255,255,255,0.35)')
  rg.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = rg
  ctx.fillRect(0, 0, w, h)

  // corner vignette
  const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.78)
  vg.addColorStop(0, 'rgba(0,0,0,0)')
  vg.addColorStop(1, dark ? 'rgba(0,0,0,0.42)' : 'rgba(0,0,0,0.16)')
  ctx.fillStyle = vg
  ctx.fillRect(0, 0, w, h)
  tex.update()
}

/**
 * Studio-style backdrop for the 3D viewer: a soft centred spotlight that
 * falls off to a darker floor, so a model reads as standing in a room
 * instead of floating in a black void.
 */
export function paintSpotlight(tex: DynamicTexture, hex: string, aspect = 1.6): void {
  const { width: w, height: h } = tex.getSize()
  const ctx = tex.getContext() as CanvasRenderingContext2D
  const dark = luminance(hex) < 0.5
  ctx.save()
  ctx.fillStyle = shade(hex, dark ? -0.25 : -0.08)
  ctx.fillRect(0, 0, w, h)
  // The backdrop plane is camera-aspect (wide on landscape, narrow on
  // portrait). A circular gradient drawn here gets stretched by the plane,
  // so on phones the lit oval turned into a flat grey slab (regression:
  // "viewer shows a flat grey slab on phone"). Counter-stretch by 1/aspect
  // so the spotlight is CIRCULAR on screen at every aspect.
  ctx.translate(w / 2, h * 0.42)
  ctx.scale(1 / Math.max(0.25, aspect), 1)
  const rg = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(w, h) * 0.55)
  rg.addColorStop(0, shade(hex, dark ? 0.16 : 0.1))
  rg.addColorStop(0.45, shade(hex, dark ? 0.05 : 0.02))
  rg.addColorStop(1, shade(hex, dark ? -0.35 : -0.14))
  ctx.fillStyle = rg
  ctx.fillRect(-w, -h, w * 2, h * 2)
  ctx.restore()
  // bottom falloff so the model's "floor" reads darker than the top
  const fg = ctx.createLinearGradient(0, h * 0.5, 0, h)
  fg.addColorStop(0, 'rgba(0,0,0,0)')
  fg.addColorStop(1, dark ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.10)')
  ctx.fillStyle = fg
  ctx.fillRect(0, 0, w, h)
  tex.update()
}

export function makeSpotlightTexture(scene: Scene, name: string, hex: string, aspect = 1.6): DynamicTexture {
  const tex = new DynamicTexture(name, { width: 512, height: 512 }, scene, false)
  paintSpotlight(tex, hex, aspect)
  return tex
}

export function makeBackdropTexture(scene: Scene, name: string, hex: string): DynamicTexture {
  const tex = new DynamicTexture(name, { width: 256, height: 256 }, scene, false)
  paintBackdrop(tex, hex)
  return tex
}

/**
 * Soft elliptical contact shadow, drawn light-on-transparent so it can be
 * tinted per theme. Gives every floating model a place to stand.
 */
export function makeContactShadow(scene: Scene, name: string): DynamicTexture {
  const S = 256
  const tex = new DynamicTexture(name, { width: S, height: S / 2 }, scene, false)
  const ctx = tex.getContext() as CanvasRenderingContext2D
  ctx.clearRect(0, 0, S, S / 2)
  ctx.save()
  ctx.translate(S / 2, S / 4)
  ctx.scale(1, 0.5)
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, S / 2)
  g.addColorStop(0, 'rgba(255,255,255,0.85)')
  g.addColorStop(0.45, 'rgba(255,255,255,0.28)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(0, 0, S / 2, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
  tex.update()
  tex.hasAlpha = true
  return tex
}

/**
 * Spinning-ring loading indicator: 12 dots on a circle with a fading trail.
 * The texture is static — the mesh spins (see Board.tick / ThreadView), which
 * keeps it perfectly crisp at any zoom and costs nothing per frame.
 */
export function makeSpinnerTexture(scene: Scene, name: string): DynamicTexture {
  const S = 256
  const DOTS = 12
  const tex = new DynamicTexture(name, { width: S, height: S }, scene, false)
  tex.hasAlpha = true
  const ctx = tex.getContext() as CanvasRenderingContext2D
  ctx.clearRect(0, 0, S, S)
  const ringR = S * 0.34
  for (let i = 0; i < DOTS; i++) {
    // dot 0 is the head of the trail
    const a = (i / DOTS) * Math.PI * 2 - Math.PI / 2
    const t = 1 - i / DOTS
    const r = S * (0.036 + 0.030 * t)
    ctx.globalAlpha = 0.12 + 0.88 * t * t
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(S / 2 + Math.cos(a) * ringR, S / 2 + Math.sin(a) * ringR, r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
  tex.update()
  return tex
}

/** Rounded-rect path helper for canvas 2D (badges, node frames). */
export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.arcTo(x + w, y, x + w, y + rr, rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr)
  ctx.lineTo(x + rr, y + h)
  ctx.arcTo(x, y + h, x, y + h - rr, rr)
  ctx.lineTo(x, y + rr)
  ctx.arcTo(x, y, x + rr, y, rr)
  ctx.closePath()
}
