import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import type { Scene } from '@babylonjs/core/scene'
import type { AudioPlaybackState } from './player'
import { theme } from '../theme'

export type PostAudioButtonState = Exclude<AudioPlaybackState, 'unavailable'>
export type PostAudioTextures = Record<PostAudioButtonState, DynamicTexture>

/** Four shared Babylon button faces: play, loading, pause and error. */
export function makePostAudioTextures(scene: Scene, prefix: string, dark: boolean): PostAudioTextures {
  const states: PostAudioButtonState[] = ['stopped', 'loading', 'playing', 'error']
  const out = {} as PostAudioTextures
  for (const state of states) {
    const tex = new DynamicTexture(`${prefix}-${state}`, { width: 128, height: 128 }, scene, false, Texture.BILINEAR_SAMPLINGMODE)
    tex.hasAlpha = true
    paintPostAudioTexture(tex, state, dark)
    out[state] = tex
  }
  return out
}

export function repaintPostAudioTextures(textures: PostAudioTextures, dark: boolean): void {
  for (const state of Object.keys(textures) as PostAudioButtonState[]) {
    paintPostAudioTexture(textures[state], state, dark)
  }
}

function paintPostAudioTexture(tex: DynamicTexture, state: PostAudioButtonState, dark: boolean): void {
  const { width: w, height: h } = tex.getSize()
  const ctx = tex.getContext() as CanvasRenderingContext2D
  ctx.clearRect(0, 0, w, h)

  const active = state === 'playing' || state === 'loading'
  ctx.fillStyle = state === 'error'
    ? 'rgba(116,25,33,0.94)'
    : active
      ? theme.accent
      : dark ? 'rgba(12,12,14,0.84)' : 'rgba(250,250,252,0.90)'
  ctx.strokeStyle = state === 'error' || active
    ? 'rgba(255,255,255,0.88)'
    : dark ? 'rgba(255,255,255,0.46)' : 'rgba(0,0,0,0.36)'
  ctx.lineWidth = 4
  ctx.beginPath()
  ctx.arc(w / 2, h / 2, w * 0.43, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()

  const ink = state === 'error' || active ? '#FFFFFF' : dark ? theme.ink : '#101014'
  ctx.fillStyle = ink
  ctx.strokeStyle = ink
  ctx.lineWidth = 7
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  if (state === 'stopped') {
    // Familiar play triangle; this is an action, not a passive speaker badge.
    ctx.beginPath()
    ctx.moveTo(52, 40)
    ctx.lineTo(91, 64)
    ctx.lineTo(52, 88)
    ctx.closePath()
    ctx.fill()
  } else if (state === 'playing') {
    ctx.fillRect(46, 40, 12, 48)
    ctx.fillRect(70, 40, 12, 48)
  } else if (state === 'loading') {
    ctx.lineWidth = 8
    ctx.globalAlpha = 0.38
    ctx.beginPath(); ctx.arc(64, 64, 29, -Math.PI / 2, Math.PI * 0.15); ctx.stroke()
    ctx.globalAlpha = 1
    ctx.beginPath(); ctx.arc(64, 64, 29, Math.PI * 0.15, Math.PI * 0.82); ctx.stroke()
  } else {
    ctx.fillRect(59, 38, 10, 35)
    ctx.beginPath(); ctx.arc(64, 88, 6, 0, Math.PI * 2); ctx.fill()
  }

  // Tiny sound-wave cut confirms that the play/pause action is audio.
  if (state !== 'loading') {
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.arc(91, 94, 10, -1.25, -0.22)
    ctx.stroke()
  }
  tex.update()
}
