import type { Sound } from '@babylonjs/core/Audio/sound'

/**
 * What a model's `MSFT_audio_emitter` extension ASKED for, per emitter.
 *
 * Babylon's glTF loader hardcodes `loop: false` on every clip Sound it
 * creates and keeps the extension's real `loop` flag only on its internal
 * `WeightedSound` (loaders/glTF/2.0/Extensions/MSFT_audio_emitter.js:
 * `new Sound(name, url, scene, null, { loop: false, ... })`, then
 * `new WeightedSound(emitter.loop || false, ...)`). That WeightedSound is
 * loader-private — it never reaches the scene graph — and FORM/0 plays the
 * clip Sounds directly, so a glTF that says `loop: true` played exactly once
 * and stopped (audit #82: the SOUND button lit, the beep ran 1.6 s, silence).
 *
 * We therefore read the flag where we already parse the file (validateGLB)
 * and re-apply it to the claimed Sounds. Keyed by sha256 because the viewer's
 * hand-off path adopts an already-parsed container and never sees the bytes.
 */
export interface AudioEmitterFact {
  /** `emitter.name` or Babylon's fallback `emitter<index>` — the Sound's name. */
  name: string
  loop: boolean
  volume: number
}

/** Bounded: one entry per distinct model this session actually validated. */
const CAP = 64
const bySha = new Map<string, AudioEmitterFact[]>()

/** Record a model's emitter facts (no-op without a hash or without audio). */
export function noteAudioFacts(sha256: string | undefined, facts: AudioEmitterFact[] | undefined): void {
  if (!sha256 || !facts?.length) return
  bySha.delete(sha256)          // re-insert at the back = LRU order
  bySha.set(sha256, facts)
  if (bySha.size > CAP) {
    const oldest = bySha.keys().next().value
    if (oldest !== undefined) bySha.delete(oldest)
  }
}

/** Emitter facts for a model hash, or null when this session never saw it. */
export function audioFacts(sha256: string | undefined): AudioEmitterFact[] | null {
  if (!sha256) return null
  return bySha.get(sha256) ?? null
}

/**
 * Re-apply the extension's loop/volume to claimed clip Sounds.
 *
 * Matching is by name (that is what the loader names them). Several emitters
 * can share Babylon's default `emitter0`, so an unnamed sound falls back to
 * the single fact when the model has exactly one — the common case.
 */
export function applyAudioFacts(sounds: readonly Sound[], facts: AudioEmitterFact[] | null): void {
  if (!facts?.length || !sounds.length) return
  const byName = new Map<string, AudioEmitterFact>()
  for (const f of facts) if (!byName.has(f.name)) byName.set(f.name, f)
  const only = facts.length === 1 ? facts[0] : null
  for (const s of sounds) {
    const f = byName.get(s.name) ?? only
    if (!f) continue
    s.loop = f.loop
    s.setVolume(f.volume)
  }
}
