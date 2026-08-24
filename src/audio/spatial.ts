import { Sound } from '@babylonjs/core/Audio/sound'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import type { Scene } from '@babylonjs/core/scene'
import type { Camera } from '@babylonjs/core/Cameras/camera'
// Registers the AudioSceneComponent (and its Scene augmentation:
// audioListenerPositionProvider / audioListenerRotationProvider).
import '@babylonjs/core/Audio/audioSceneComponent'

/**
 * Positional post audio (merged from arena/01a01d04-f0, ported onto main's
 * Babylon-Sound stack).
 *
 * Every MSFT_audio_emitter Sound the GLB loader creates can be spatialized
 * with Babylon's native HRTF panner:
 *
 *  - Direct-3D cards and the viewer render the REAL model in the visible
 *    scene, so `attachToMesh` (registerAfterWorldMatrixUpdate) makes the
 *    sound follow its emitter automatically, and the scene's default
 *    listener (the active camera) is the actual viewing camera.
 *  - 2D poster/preview cards render the model in the OFFSCREEN stage scene
 *    whose slots are laid out in a fake strip (index * 800), so stage-space
 *    positions would not match the cards on screen. Those sounds are instead
 *    anchored with setPosition() to the real card's world position (the
 *    `soundPosition` provider on PreviewPool), and the stage scene's
 *    listener is pointed at whichever user-facing camera is active.
 *
 * The distance curve matches the flat camera geometry: cameras sit 30 world
 * units in front of the card plane, so a front-on post plays at full
 * loudness while lateral/depth cues survive as the camera orbits (3D) or
 * the feed scrolls. All calls are defensive: without WebAudio the sounds
 * simply stay flat (current behavior).
 */

export const SPATIAL_REF_DISTANCE = 30 // flat camera distance (core/gfx.flatCamera)
export const SPATIAL_MAX_DISTANCE = 240
export const SPATIAL_ROLLOFF = 0.35

/** Make a Babylon Sound spatial: HRTF panner + the flat-scene distance curve. */
export function spatializeSound(sound: Sound): void {
  try {
    sound.updateOptions({
      spatialSound: true,
      refDistance: SPATIAL_REF_DISTANCE,
      maxDistance: SPATIAL_MAX_DISTANCE,
      rolloffFactor: SPATIAL_ROLLOFF,
      distanceModel: 'inverse',
    })
    // Non-directional cones: a post that turns its back must not go silent.
    sound.setDirectionalCone(360, 360, 0)
  } catch {
    // Audio unavailable — the sound keeps playing flat, nothing breaks.
  }
}

export function spatializeSounds(sounds: Sound[]): void {
  for (const sound of sounds) spatializeSound(sound)
}

/** Anchor a sound to a node; position auto-tracks its world matrix. */
export function attachSound(sound: Sound, node: TransformNode): void {
  try {
    sound.attachToMesh(node)
  } catch {
    /* ignore */
  }
}

/**
 * Stop a sound from following its node. The GLB loader attaches every
 * MSFT_audio_emitter sound to its emitter mesh; on the offscreen preview
 * stage those meshes sit in a fake strip (index * 800) that must not drive
 * the panner — the app anchors stage sounds to the real card position
 * instead (see PreviewPool.soundPosition).
 */
export function detachSound(sound: Sound): void {
  try {
    sound.detachFromMesh()
  } catch {
    /* ignore */
  }
}

/** Anchor a sound to an explicit world position (2D cards, offscreen stage). */
export function moveSound(sound: Sound, position: Vector3): void {
  try {
    sound.setPosition(position)
  } catch {
    /* ignore */
  }
}

/** The camera spatial audio listens through (set by the active view). */
let listenerCamera: Camera | null = null

export function setSpatialListener(camera: Camera | null): void {
  listenerCamera = camera
}

export function getSpatialListener(): Camera | null {
  return listenerCamera
}

/**
 * Point a scene's listener at the app's active user-facing camera.
 * Call once per scene that owns sounds but renders offscreen (the preview
 * stage); scenes whose active camera is the real viewing camera keep the
 * default listener.
 */
export function bindSceneListener(scene: Scene): void {
  try {
    scene.audioListenerPositionProvider = () => {
      const cam = listenerCamera
      return cam ? cam.position : Vector3.Zero()
    }
    scene.audioListenerRotationProvider = () => {
      const cam = listenerCamera
      return cam ? cam.absoluteRotation.toEulerAngles() : Vector3.Zero()
    }
    // Refresh the panner/listener at 10 Hz instead of the 2 Hz default so
    // scrolling/orbiting audio tracks the feed closely.
    scene.audioPositioningRefreshRate = 100
  } catch {
    /* ignore */
  }
}
