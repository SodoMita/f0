import { Effect } from '@babylonjs/core/Materials/effect'
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture'
import { RenderTargetTexture } from '@babylonjs/core/Materials/Textures/renderTargetTexture'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { Vector2 } from '@babylonjs/core/Maths/math.vector'
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine'
import type { Texture as TextureT } from '@babylonjs/core/Materials/Textures/texture'

// A card is a plain unlit textured quad: rgba = tex.rgb * tint, tex.a.
// Deterministic — no StandardMaterial emissive/diffuse/lighting interactions
// (StandardMaterial renders black on strict GL drivers).
//
// ORIENTATION (empirically verified, test/orient2.ts + runtime probe):
//  * Vertical orientation differs per texture source:
//      RawTexture (posters)          -> storage is top-down  -> flip Y
//      RenderTargetTexture (live)    -> storage is bottom-up -> no flip
//      DynamicTexture (badges, HUD)  -> upload flips rows     -> no flip
//  * Horizontal orientation varies per GL driver AND per texture kind, so
//    detectCardFlips() calibrates each kind once at boot with
//    production-identical textures (left=red / right=blue probe).
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
void main() {
  vec2 uv = vec2(flip.x > 0.5 ? 1.0 - vUV.x : vUV.x, flip.y > 0.5 ? 1.0 - vUV.y : vUV.y);
  vec4 t = texture2D(tex, uv);
  gl_FragColor = vec4(t.rgb * tint, t.a);
}`

export type CardTextureKind = 'raw' | 'dyn' | 'rtt'

let registered = false
let sharedWhite: DynamicTexture | null = null

/** Global flips per texture kind, calibrated once per session. */
const globalFlipX: Record<CardTextureKind, 0 | 1> = { raw: 0, dyn: 0, rtt: 0 }
const globalFlipY: Record<CardTextureKind, 0 | 1> = { raw: 0, dyn: 0, rtt: 0 }

export function setGlobalFlips(flips: { flipX: Record<CardTextureKind, 0 | 1>; flipY: Record<CardTextureKind, 0 | 1> }): void {
  globalFlipX.raw = flips.flipX.raw
  globalFlipX.dyn = flips.flipX.dyn
  globalFlipX.rtt = flips.flipX.rtt
  globalFlipY.raw = flips.flipY.raw
  globalFlipY.dyn = flips.flipY.dyn
  globalFlipY.rtt = flips.flipY.rtt
}

export function getGlobalFlips(): { flipX: Record<CardTextureKind, 0 | 1>; flipY: Record<CardTextureKind, 0 | 1> } {
  return { flipX: { ...globalFlipX }, flipY: { ...globalFlipY } }
}

/**
 * Calibrates the card pipeline orientation per texture kind on THIS GL
 * driver, anchored to the real board (empty at boot): a probe quad is placed
 * at world (0,0), rendered by the real board camera, and read back from the
 * default framebuffer synchronously (flushRenderer=false). Two probes per
 * kind: an X probe (left-red/right-blue columns, sampled at x=-3.5) and a Y
 * probe (top-red/bottom-green rows, sampled at x=0 so the driver's X-mirror
 * cannot leak into the reading). Both axes are calibrated; nothing is
 * hardcoded. Runs once at boot before any posts arrive.
 */
export async function detectCardFlipsOnBoard(
  engine: AbstractEngine,
  boardScene: Scene,
): Promise<{ flipX: Record<CardTextureKind, 0 | 1>; flipY: Record<CardTextureKind, 0 | 1> }> {
  const flipX: Record<CardTextureKind, 0 | 1> = { raw: 0, dyn: 0, rtt: 0 }
  const flipY: Record<CardTextureKind, 0 | 1> = { raw: 0, dyn: 0, rtt: 0 }
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  const W = 64
  const dataX = new Uint8Array(W * W * 4) // red left half / blue right half
  const dataY = new Uint8Array(W * W * 4) // red top half / green bottom half
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      if (x < W / 2) dataX[i] = 255
      else dataX[i + 2] = 255
      dataX[i + 3] = 255
      if (y < W / 2) dataY[i] = 255
      else dataY[i + 1] = 255
      dataY[i + 3] = 255
    }
  }

  const cam = boardScene.activeCamera as ArcRotateCamera | null
  if (!cam || cam.mode !== ArcRotateCamera.ORTHOGRAPHIC_CAMERA) return { flipX, flipY }
  const w = engine.getRenderWidth()
  const h = engine.getRenderHeight()
  const orthoR = cam.orthoRight ?? 1
  const orthoL = cam.orthoLeft ?? -1
  const orthoT = cam.orthoTop ?? 1
  const orthoB = cam.orthoBottom ?? -1
  const toPx = (wx: number, wy: number) => [
    Math.round(((wx - orthoL) / (orthoR - orthoL)) * w),
    Math.round(h * (1 - (orthoT - wy) / (orthoT - orthoB))),
  ]
  const [pxLeft] = toPx(-3.5, 0)
  const [pxMid] = toPx(0, 0)
  const [, pyTop] = toPx(0, 3)
  const [, pyBot] = toPx(0, -3)

  const mesh = MeshBuilder.CreatePlane('flipx-probe', { width: 8, height: 8 }, boardScene)
  mesh.position.set(0, 0, 0)
  mesh.isPickable = false
  const mat = makeCardMaterial(boardScene)
  mesh.material = mat

  const readPix = async (px: number, py: number): Promise<[number, number, number]> => {
    const v = await engine.readPixels(px, py, 1, 1, true, false)
    if (!v) return [0, 0, 0]
    const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
    return [b[0], b[1], b[2]]
  }
  const warmUp = async () => {
    for (let i = 0; i < 10; i++) {
      boardScene.render()
      await sleep(40)
    }
  }
  const measure = async (tex: TextureT, kind: CardTextureKind, pattern: 'X' | 'Y'): Promise<void> => {
    mat.setTexture('tex', tex)
    mat.setVector2('flip', new Vector2(0, 0))
    await warmUp()
    // atomic render + read of the default framebuffer
    boardScene.render()
    if (pattern === 'X') {
      const [r, g, b] = await readPix(pxLeft, toPx(0, 0)[1])
      // eslint-disable-next-line no-console
      console.log('[flipx] kind=' + kind + ' X L=', r + ',' + g + ',' + b)
      flipX[kind] = b > 128 && r < 128 ? 1 : 0
    } else {
      const top = await readPix(pxMid, pyTop)
      const bot = await readPix(pxMid, pyBot)
      // eslint-disable-next-line no-console
      console.log('[flipx] kind=' + kind + ' Y top=', top.join(','), ' bot=', bot.join(','))
      flipY[kind] = top[1] > 128 && bot[0] > 128 ? 1 : 0 // green on top = flipped
    }
  }

  try {
    // raw: exactly like AssetCache poster uploads (CreateRGBATexture, invertY=true)
    await measure(new RawTexture(dataX, W, W, 5, boardScene, false, true, Texture.BILINEAR_SAMPLINGMODE), 'raw', 'X')
    await measure(new RawTexture(dataY, W, W, 5, boardScene, false, true, Texture.BILINEAR_SAMPLINGMODE), 'raw', 'Y')

    // dyn: exactly like badge textures (DynamicTexture + update)
    const dtx = new DynamicTexture('flipx-dtx', { width: W, height: W }, boardScene, false)
    {
      const c = dtx.getContext() as CanvasRenderingContext2D
      c.fillStyle = '#0000ff'; c.fillRect(0, 0, W, W)
      c.fillStyle = '#ff0000'; c.fillRect(0, 0, W / 2, W)
      dtx.update()
    }
    await measure(dtx, 'dyn', 'X')
    const dty = new DynamicTexture('flipx-dty', { width: W, height: W }, boardScene, false)
    {
      const c = dty.getContext() as CanvasRenderingContext2D
      c.fillStyle = '#00ff00'; c.fillRect(0, 0, W, W)
      c.fillStyle = '#ff0000'; c.fillRect(0, 0, W, W / 2)
      dty.update()
    }
    await measure(dty, 'dyn', 'Y')

    // rtt: stage-render the pattern quad (no flips, front-on camera) into an
    // RTT, then display that RTT — the live-preview path
    const stage = new Scene(engine)
    const sc = new ArcRotateCamera('flipx-sc', Math.PI / 2, Math.PI / 2, 10, Vector3.Zero(), stage)
    sc.mode = ArcRotateCamera.ORTHOGRAPHIC_CAMERA
    sc.orthoTop = 1
    sc.orthoBottom = -1
    sc.orthoLeft = -1
    sc.orthoRight = 1
    sc.inputs.clear()
    sc.detachControl()
    stage.activeCamera = sc
    const splane = MeshBuilder.CreatePlane('flipx-sp', { width: 2, height: 2 }, stage)
    const smat = makeCardMaterial(stage)
    splane.material = smat
    const makeRttProbe = async (pattern: Uint8Array): Promise<RenderTargetTexture> => {
      const sdt = new DynamicTexture('flipx-sdt', { width: W, height: W }, stage, false)
      const c = sdt.getContext() as CanvasRenderingContext2D
      for (let y = 0; y < W; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4
          const r = pattern[i], g = pattern[i + 1], b = pattern[i + 2]
          c.fillStyle = `rgb(${r},${g},${b})`
          c.fillRect(x, y, 1, 1)
        }
      }
      sdt.update()
      smat.setTexture('tex', sdt)
      smat.setVector2('flip', new Vector2(0, 0))
      const rtt = new RenderTargetTexture('flipx-rtt', { width: 64, height: 64 }, stage)
      rtt.renderTargetOptions.generateDepthBuffer = true
      rtt.clearColor = new Color4(0, 0, 0, 0)
      sc.outputRenderTarget = rtt
      for (let i = 0; i < 3; i++) {
        stage.render()
        await sleep(40)
      }
      sc.outputRenderTarget = null
      return rtt
    }
    const rttX = await makeRttProbe(dataX)
    await measure(rttX, 'rtt', 'X')
    rttX.dispose()
    const rttY = await makeRttProbe(dataY)
    await measure(rttY, 'rtt', 'Y')
    rttY.dispose()
    stage.dispose()
  } catch {
    // leave defaults (no flips) if calibration fails
  } finally {
    mesh.dispose()
  }
  return { flipX, flipY }
}

export function makeCardMaterial(scene: Scene): ShaderMaterial {
  if (!registered) {
    Effect.ShadersStore['cardVertexShader'] = VERT
    Effect.ShadersStore['cardFragmentShader'] = FRAG
    registered = true
  }
  const mat = new ShaderMaterial('card-shader', scene, 'card', {
    attributes: ['position', 'uv'],
    uniforms: ['worldViewProjection', 'tint', 'flip'],
    samplers: ['tex'],
  })
  mat.backFaceCulling = false
  mat.needAlphaBlending()
  mat.setTexture('tex', getWhite(scene))
  mat.setColor3('tint', Color3.White())
  mat.setVector2('flip', new Vector2(globalFlipX.raw, 1))
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

export function setCardTexture(mat: ShaderMaterial, tex: TextureT | null): void {
  mat.setTexture('tex', tex ?? getWhite(mat.getScene()))
}

export function setCardTint(mat: ShaderMaterial, hex: string): void {
  mat.setColor3('tint', Color3.FromHexString(hex))
}

export function setCardWhite(mat: ShaderMaterial): void {
  mat.setColor3('tint', Color3.White())
}

/**
 * Sampling orientation: BOTH axes come from the per-kind boot calibration
 * (nothing hardcoded — drivers differ on X and on Y).
 */
export function setCardFlip(mat: ShaderMaterial, kind: CardTextureKind): void {
  mat.setVector2('flip', new Vector2(globalFlipX[kind], globalFlipY[kind]))
}
