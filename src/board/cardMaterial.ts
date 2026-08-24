import { Effect } from '@babylonjs/core/Materials/effect'
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Vector2 } from '@babylonjs/core/Maths/math.vector'
import { Scene } from '@babylonjs/core/scene'
import type { Texture as TextureT } from '@babylonjs/core/Materials/Textures/texture'

// A card is a plain unlit textured quad: rgba = (tex.rgb * tint, tex.a * opacity).
// Deterministic — no StandardMaterial emissive/diffuse/lighting interactions
// (StandardMaterial renders black on strict GL drivers).
//
// ============================ ORIENTATION ============================
// There is NO per-driver calibration any more (the old boot probe guessed
// wrong on X for `dyn`/`rtt`, which is why reply badges rendered mirrored).
// The mirroring was never a driver quirk — it was the *camera*:
//
//   * `CreatePlane` builds its quad in the XY plane with normal (0,0,-1),
//     uv (0,0) at (-w/2,-h/2) — i.e. u grows toward +X, v grows toward +Y.
//   * Babylon is LEFT-handed. A camera parked at +Z looking back at the
//     origin has its screen-right axis at world -X, so every quad is seen
//     from BEHIND: the texture is mirrored horizontally and, worse, the
//     board's own column order is mirrored too (column 0 drew on the right).
//
// The fix is to park every 2D ortho camera at -Z looking toward +Z
// (ArcRotateCamera alpha = -PI/2, see `flatCamera()` below). Then
// world +X == screen right, u=0 is on the left, v=0 is at the bottom, and
// all three texture kinds land the right way up with zero shader flips:
//
//   RawTexture (cached posters) CreateRGBATexture(..., invertY=false) keeps
//                               GL bottom-up rows (same as an RTT). Correct.
//   RenderTargetTexture (posters + live)  GL renders bottom-up -> v=0 is
//                               the bottom of the rendered frame. Correct.
//   DynamicTexture (badges/HUD) invertY defaults to true -> canvas row 0
//                               lands at v=1 (top). Correct.
//
// The `flip` uniform is kept (cheap, and gives us an escape hatch for a
// future texture kind) but every production path passes (0,0).
// Verified in `test/orient2.ts` — an F-shaped probe through all three kinds
// with the production camera; all four corners must match.
// =====================================================================

const VERT = `precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 worldViewProjection;
varying vec2 vUV;
void main() { gl_Position = worldViewProjection * vec4(position, 1.0); vUV = uv; }`

const FRAG = `precision highp float;
varying vec2 vUV;
uniform sampler2D tex;
uniform sampler2D tex2;
uniform vec3 tint;
uniform vec3 tint2;
uniform vec2 flip;
uniform float opacity;
uniform float blend;
void main() {
  vec2 uv = vec2(flip.x > 0.5 ? 1.0 - vUV.x : vUV.x, flip.y > 0.5 ? 1.0 - vUV.y : vUV.y);
  // Two-texture crossfade (SPEC CARD "Crossfade 120ms"): blend ramps 0..1
  // between the old and the new texture in the SAME quad, so plate ->
  // poster -> live preview genuinely crossfade instead of hard-swapping
  // (hard swaps were the black-flicker regression).
  vec4 a = texture2D(tex, uv);
  vec4 b = texture2D(tex2, uv);
  vec4 t = mix(a, b, blend);
  // Some opaque glTF materials write RGB but leave alpha at 0 (the
  // framebuffer clear). Treat any non-black RGB as coverage so those
  // models still show on a transparent card.
  float cover = t.a;
  if (cover < 0.016) {
    float m = max(t.r, max(t.g, t.b));
    if (m > 0.016) cover = 1.0;
  }
  gl_FragColor = vec4(t.rgb * mix(tint, tint2, blend), cover * opacity);
}`

export type CardTextureKind = 'raw' | 'dyn' | 'rtt'

/** Deterministic per-kind sampling flips. All zero — see the note above. */
const FLIPS: Record<CardTextureKind, readonly [0 | 1, 0 | 1]> = {
  raw: [0, 0],
  dyn: [0, 0],
  rtt: [0, 0],
}

let registered = false
const whiteByScene = new WeakMap<Scene, DynamicTexture>()

/**
 * @param blend  true (default) = alpha-blended card/badge quad.
 *               false = opaque quad, used for backdrops so they render in
 *               the opaque pass and stay behind everything else.
 */
export function makeCardMaterial(scene: Scene, blend = true): ShaderMaterial {
  if (!registered) {
    Effect.ShadersStore['cardVertexShader'] = VERT
    Effect.ShadersStore['cardFragmentShader'] = FRAG
    registered = true
  }
  const mat = new ShaderMaterial(blend ? 'card-shader' : 'card-shader-opaque', scene, 'card', {
    attributes: ['position', 'uv'],
    uniforms: ['worldViewProjection', 'tint', 'tint2', 'flip', 'opacity', 'blend'],
    samplers: ['tex', 'tex2'],
    // NOTE: `needAlphaBlending` must be passed as an OPTION. Calling
    // `mat.needAlphaBlending()` (as the old code did) is a *getter*, not a
    // setter — the cards were therefore rendered opaque and every model sat
    // in a black rectangle even though the render targets were transparent.
    needAlphaBlending: blend,
  })
  mat.backFaceCulling = false
  // Transparent quads must not write depth: a fully-transparent card plane
  // (3D mode's invisible tap target) sitting at z=0 would otherwise occlude
  // the real model behind it, and a poster card would hide its own badge
  // whenever transparent-sort put the card later than the overlay.
  if (blend) mat.disableDepthWrite = true
  mat.setTexture('tex', getWhite(scene))
  mat.setTexture('tex2', getWhite(scene))
  mat.setColor3('tint', Color3.White())
  mat.setColor3('tint2', Color3.White())
  mat.setVector2('flip', new Vector2(0, 0))
  mat.setFloat('opacity', 1)
  mat.setFloat('blend', 0)
  return mat
}

function getWhite(scene: Scene): DynamicTexture {
  const hit = whiteByScene.get(scene)
  if (hit) return hit
  const tex = new DynamicTexture('white1x1', { width: 1, height: 1 }, scene, false)
  const ctx = tex.getContext() as CanvasRenderingContext2D
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 1, 1)
  tex.update()
  whiteByScene.set(scene, tex)
  return tex
}

export function setCardTexture(mat: ShaderMaterial, tex: TextureT | null): void {
  mat.setTexture('tex', tex ?? getWhite(mat.getScene()))
}

export function setCardTint(mat: ShaderMaterial, hex: string): void {
  mat.setColor3('tint', Color3.FromHexString(hex))
}

export function setCardWhite(mat: ShaderMaterial): void {
  mat.setColor3('tint', Color3.White())
}

export function setCardOpacity(mat: ShaderMaterial, v: number): void {
  mat.setFloat('opacity', Math.max(0, Math.min(1, v)))
}

/** Second texture + its tint for the two-texture crossfade. */
export function setCardTexture2(mat: ShaderMaterial, tex: TextureT | null): void {
  mat.setTexture('tex2', tex ?? getWhite(mat.getScene()))
}

export function setCardTint2(mat: ShaderMaterial, hex: string): void {
  mat.setColor3('tint2', Color3.FromHexString(hex))
}

/** Crossfade position 0..1 between tex/tint and tex2/tint2. */
export function setCardBlend(mat: ShaderMaterial, v: number): void {
  mat.setFloat('blend', Math.max(0, Math.min(1, v)))
}

/** Sampling orientation for a texture kind (deterministic; see header). */
export function setCardFlip(mat: ShaderMaterial, kind: CardTextureKind): void {
  const [x, y] = FLIPS[kind]
  mat.setVector2('flip', new Vector2(x, y))
}


