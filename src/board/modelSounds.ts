import type { AssetContainer } from '@babylonjs/core/assetContainer'
import type { Sound } from '@babylonjs/core/Audio/sound'
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import type { Scene } from '@babylonjs/core/scene'
import '@babylonjs/core/Audio/audioSceneComponent'

export interface SoundOwner {
  sounds: Sound[]
  soundTimer: number | null
}

/** Assign newly loaded MSFT_audio_emitter sounds to exactly one model slot. */
export function claimModelSounds(
  scene: Scene,
  container: AssetContainer,
  baseline: number,
  claimed: Set<Sound>,
): Sound[] {
  const all = scene.mainSoundTrack.soundCollection
  const meshes = new Set<unknown>(container.meshes)
  const owned: Sound[] = []
  const attached = (sound: Sound): TransformNode | null =>
    (sound as unknown as { _connectedTransformNode?: TransformNode })._connectedTransformNode ?? null

  for (const sound of all) {
    if (claimed.has(sound)) continue
    if (meshes.has(attached(sound))) { claimed.add(sound); owned.push(sound) }
  }
  for (const sound of all.slice(baseline)) {
    if (claimed.has(sound) || attached(sound)) continue
    claimed.add(sound); owned.push(sound)
  }
  return owned
}

/** Play ready sounds now and retry briefly while remaining clips decode. */
export function playModelSounds(owner: SoundOwner): void {
  if (owner.soundTimer !== null) clearInterval(owner.soundTimer)
  owner.soundTimer = null
  const pending = owner.sounds.filter((sound) => !sound.isReady())
  for (const sound of owner.sounds) if (sound.isReady()) sound.play()
  if (!pending.length) return

  let tries = 0
  owner.soundTimer = window.setInterval(() => {
    if (owner.soundTimer === null) return
    tries++
    for (const sound of pending) if (sound.isReady()) sound.play()
    if (pending.every((sound) => sound.isReady()) || tries >= 15) {
      clearInterval(owner.soundTimer)
      owner.soundTimer = null
    }
  }, 200)
}
