import { Effect } from '@babylonjs/core/Materials/effect'
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { Scene } from '@babylonjs/core/scene'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import type { Texture } from '@babylonjs/core/Materials/Textures/texture'

// A card is a plain unlit textured quad: gl_FragColor = tex * tint.
// Deterministic — no StandardMaterial emissive/diffuse/lighting interactions.
const VERT = `precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 worldViewProjection;
varying vec2 vUV;
void main() { gl_Position = worldViewProjection * vec4(position, 1.0); vUV = uv; }`

// 1.0 - vUV.y: Babylon uploads raw pixels bottom-up (GL convention) and our
// shader bypasses the engine's invertY handling, so without the flip both the
// poster and the live RTT would show upside down.
const FRAG = `precision highp float;
varying vec2 vUV;
uniform sampler2D tex;
uniform vec3 tint;
void main() { gl_FragColor = vec4(texture2D(tex, vec2(vUV.x, 1.0 - vUV.y)).rgb * tint, 1.0); }`

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
    uniforms: ['worldViewProjection', 'tint'],
    samplers: ['tex'],
  })
  mat.backFaceCulling = false
  mat.setTexture('tex', getWhite(scene))
  mat.setColor3('tint', Color3.White())
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
