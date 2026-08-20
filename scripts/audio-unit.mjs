// Embedded GLB audio extraction checks. Runs without a browser/audio device.
//   bun scripts/audio-unit.mjs
import {
  extractEmbeddedAudio, extractEmbeddedAudioBytes, inspectEmbeddedAudio,
} from '../src/audio/embedded.ts'
import { LIMITS } from '../src/theme.ts'

const failures = []
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

function wav(size = 44) {
  const out = new Uint8Array(Math.max(44, size))
  out.set([0x52, 0x49, 0x46, 0x46], 0) // RIFF
  out.set([0x57, 0x41, 0x56, 0x45], 8) // WAVE
  return out
}

function mp3() {
  return new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64])
}

function glb(payload, extension = 'KHR_audio', options = {}) {
  const prefix = new Uint8Array(options.prefix ?? [7, 8, 9, 10])
  const binLength = (prefix.length + payload.length + 3) & ~3
  const bin = new Uint8Array(binLength)
  bin.set(prefix)
  bin.set(payload, prefix.length)
  const clip = {
    bufferView: options.bufferView ?? 0,
    mimeType: options.mime ?? (extension === 'KHR_audio' ? 'audio/mpeg' : 'audio/wav'),
  }
  const ext = extension === 'KHR_audio'
    ? { KHR_audio: { audio: options.noClip ? [] : [clip], sources: [], emitters: [] } }
    : { MSFT_audio_emitter: { clips: options.noClip ? [] : [clip], sources: [], emitters: [] } }
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: prefix.length, byteLength: options.byteLength ?? payload.length }],
    extensionsUsed: [extension],
    extensions: ext,
  }
  const encoded = new TextEncoder().encode(JSON.stringify(json))
  const jsonLength = (encoded.length + 3) & ~3
  const total = 12 + 8 + jsonLength + 8 + bin.length
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonLength, true)
  view.setUint32(16, 0x4e4f534a, true)
  out.fill(0x20, 20, 20 + jsonLength)
  out.set(encoded, 20)
  const binHead = 20 + jsonLength
  view.setUint32(binHead, bin.length, true)
  view.setUint32(binHead + 4, 0x004e4942, true)
  out.set(bin, binHead + 8)
  return out
}

{
  const bytes = glb(mp3(), 'KHR_audio')
  const audio = extractEmbeddedAudioBytes(bytes)
  check('KHR_audio MP3 extracts from its bufferView offset',
    audio?.type === 'audio/mpeg' && audio.size === mp3().length)
  check('byte extraction is identity-cached', audio === extractEmbeddedAudioBytes(bytes))
}

{
  const bytes = glb(wav(), 'MSFT_audio_emitter')
  const inspection = inspectEmbeddedAudio(bytes)
  check('MSFT_audio_emitter WAV extracts',
    inspection.extension === 'MSFT_audio_emitter'
      && inspection.audio?.type === 'audio/wav'
      && inspection.audio.size === 44)
}

{
  const blob = new Blob([glb(wav(), 'MSFT_audio_emitter')])
  const first = extractEmbeddedAudio(blob)
  const second = extractEmbeddedAudio(blob)
  check('Blob extraction caches the in-flight parse Promise', first === second)
  check('Blob extraction resolves a playable typed Blob', (await first)?.type === 'audio/wav')
}

{
  const bytes = glb(wav(), 'MSFT_audio_emitter', { byteLength: LIMITS.audioBytes + 1 })
  const inspection = inspectEmbeddedAudio(bytes)
  check('256 KiB cap refuses an oversized declared clip without hiding its presence',
    inspection.present && !inspection.audio && /exceeds/.test(inspection.reason ?? ''), inspection.reason)
}

{
  const bytes = glb(wav(), 'KHR_audio', { mime: 'audio/mpeg' })
  const inspection = inspectEmbeddedAudio(bytes)
  check('MIME/file-signature mismatch is refused', inspection.present && !inspection.audio && /signature/.test(inspection.reason ?? ''))
}

{
  const bytes = glb(wav(), 'MSFT_audio_emitter', { bufferView: 7 })
  const inspection = inspectEmbeddedAudio(bytes)
  check('bad bufferView is refused safely', inspection.present && !inspection.audio && /bufferView/.test(inspection.reason ?? ''))
}

{
  const bare = new Uint8Array(20)
  const view = new DataView(bare.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  check('GLB without audio returns undefined', extractEmbeddedAudioBytes(bare) === undefined)
}

console.log(failures.length ? `FAILURES: ${failures.join(' | ')}` : 'ALL AUDIO UNIT CHECKS PASSED')
process.exit(failures.length ? 1 : 0)
