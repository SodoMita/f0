import { Effect } from '@babylonjs/core/Materials/effect'
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { Scene } from '@babylonjs/core/scene'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Vector2 } from '@babylonjs/core/Maths/math.vector'
import type { Texture } from '@babylonjs/core/Materials/Textures/texture'

// A card is a plain unlit textured quad: rgba = tex.rgb * tint, tex.a.
// Deterministic — no StandardMaterial emissive/diffuse/lighting interactions
// (StandardMaterial renders black on strict GL drivers).
//
// FLIPS (empirically verified against raw WebGL, see test/orient.ts):
//  * Babylon 8 inverts uv.x for ShaderMaterial quads relative to raw GL, so
//    every texture must be sampled with 1.0 - uv.x or content is mirrored
//    (this was the "flipped posts" bug).
//  * Vertical orientation differs per texture source:
//      RawTexture (posters)          -> storage is top-down  -> flip Y
//      RenderTargetTexture (live)    -> storage is bottom-up -> no flip
//      DynamicTexture (badges, HUD)  -> upload flips rows     -> no flip
const VERT = `precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 worldViewProjection;
varying vec2 vUV;
void main() { gl_Position = worldViewProjection * vec4(position, 1.0); vUV = uv; }`

const FRAG = `precision highp float;
varying vec2 vUV;
uniform sampler2D tex;
uniform vec3 tint;
uniform vec2 flip;
uniform float roundCorner;
uniform float borderWidth;
void main() {
  vec2 uv = vec2(flip.x > 0.5 ? 1.0 - vUV.x : vUV.x, flip.y > 0.5 ? 1.0 - vUV.y : vUV.y);
  vec4 t = texture2D(tex, uv);
  vec3 c = t.rgb * tint;
  float a = t.a;
  // rounded corners (soft, anti-aliased)
  if (roundCorner > 0.0) {
    vec2 q = abs(vUV - 0.5) - (0.5 - roundCorner);
    float d = length(max(q, 0.0)) - roundCorner;
    a *= 1.0 - smoothstep(-1.5, 1.5, d * 400.0);
  }
  // hairline border
  if (borderWidth > 0.0) {
    vec2 q2 = abs(vUV - 0.5) - (0.5 - borderWidth);
    float d2 = abs(length(max(q2, 0.0)) - borderWidth) - borderWidth;
    float edge = 1.0 - smoothstep(-1.5, 1.5, d2 * 600.0);
    c += vec3(1.0, 1.0, 1.0) * edge * 0.10;
  }
  gl_FragColor = vec4(c, a);
}`

let registered = false
let sharedWhite: DynamicTexture | null = null

export function makeCardMaterial(scene: Scene): ShaderMaterial {
  if (!registered) {
    Effect.ShadersStore['cardVertexShader'] = VERT
    Effect.ShadersStore['cardFragmentShader'] = FRAG
    registered = true
  }
  const mat = new ShaderMaterial('card-shader', scene, 'card', {
    attributes: ['position', 'uv'],
    uniforms: ['worldViewProjection', 'tint', 'flip', 'roundCorner', 'borderWidth'],
    samplers: ['tex'],
  })
  mat.backFaceCulling = false
  mat.needAlphaBlending()
  mat.setTexture('tex', getWhite(scene))
  mat.setColor3('tint', Color3.White())
  mat.setVector2('flip', new Vector2(0, 1))
  mat.setFloat('roundCorner', 0)
  mat.setFloat('borderWidth', 0)
  return mat
}

function getWhite(scene: Scene): DynamicTexture {
  if (sharedWhite) return sharedWhite
  sharedWhite = new DynamicTexture('white1x1', { width: 1, height: 1 }, scene, false)
  const ctx = sharedWhite.getContext() as CanvasRenderingContext2D
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 1, 1)
  sharedWhite.update()
  return sharedWhite
}

export function setCardTexture(mat: ShaderMaterial, tex: Texture | null): void {
  mat.setTexture('tex', tex ?? getWhite(mat.getScene()))
}

export function setCardTint(mat: ShaderMaterial, hex: string): void {
  mat.setColor3('tint', Color3.FromHexString(hex))
}

export function setCardWhite(mat: ShaderMaterial): void {
  mat.setColor3('tint', Color3.White())
}

/**
 * Per-path sampling orientation (empirically verified, test/orient2.ts):
 *   poster (RawTexture)          -> flip(0,1)
 *   live preview (RTT)           -> flip(0,0)
 *   badge (DynamicTexture)       -> flip(0,0)
 * RawTextures are stored top-down so they need the Y flip; RTTs and
 * DynamicTextures are stored bottom-up and must NOT be Y-flipped (the old
 * hardcoded 1-v.y flipped badges and live previews upside down).
 */
export function setCardFlip(mat: ShaderMaterial, flipX: boolean, flipY: boolean): void {
  mat.setVector2('flip', new Vector2(flipX ? 1 : 0, flipY ? 1 : 0))
}

export function setCardRounded(mat: ShaderMaterial, corner: number): void {
  mat.setFloat('roundCorner', corner)
}

export function setCardBorder(mat: ShaderMaterial, width: number): void {
  mat.setFloat('borderWidth', width)
}
