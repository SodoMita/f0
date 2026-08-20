import { LIMITS } from '../theme'
import { limitDecodedPixels, type LimitReport } from '../model/limits'

/**
 * Studio model-info helpers (SPEC AMENDMENT 66). Pure functions — no Babylon,
 * no DOM — so scripts/model-info-unit.mjs can drive them directly.
 */

/**
 * The model name published in the nostr event `content` (empty in format
 * v4). A typed text post names itself by its first line; an imported model
 * names itself by its file base name. Single line, no control characters,
 * bounded by LIMITS.contentChars (relays index `content` for NIP-50).
 */
export function modelNameForPublish(filename?: string, textOverride?: string): string {
  let name = ''
  const firstLine = (textOverride ?? '').split('\n').map((l) => l.trim()).find(Boolean)
  if (firstLine) {
    name = firstLine
  } else if (filename) {
    const base = filename.split(/[\\/]/).pop() ?? filename
    name = base.replace(/\.[^.]+$/, '')
  }
  name = name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return name.slice(0, LIMITS.contentChars)
}

/**
 * Model-size heat colour: green at 0 bytes, red at >= the 20 MiB hard limit.
 * RGB lerp between theme.success (#98CA72) and theme.danger (#FF674B) so the
 * endpoints stay exactly on-palette in both app themes.
 */
export function sizeHeatColor(bytes: number): string {
  const t = Math.min(1, Math.max(0, bytes / LIMITS.modelBytesHard))
  const from = [0x98, 0xca, 0x72]
  const to = [0xff, 0x67, 0x4b]
  const mix = from.map((v, i) => Math.round(v + (to[i] - v) * t))
  return `#${mix.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/** 12,345 — compact grouping for stat rows. */
export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/** 1.4 MiB / 820 KiB — byte display for the size row. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KiB`
  return `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MiB`
}

/** A validated model within `NEAR` of a safety cap is warned about. */
const NEAR = 0.7

/**
 * Warnings for an import that PASSED validation but is big or
 * near-limit ("dangerous-adjacent"). Models over a hard cap never reach
 * this list — validateGLB refuses them at import with the reason shown.
 */
export function modelWarnings(bytes: number, stats: LimitReport['stats']): string[] {
  const out: string[] = []
  if (bytes >= LIMITS.modelBytesRecommended) {
    out.push(`big model: ${formatSize(bytes)} of the ${formatSize(LIMITS.modelBytesHard)} limit — cards and viewers load it slowly`)
  }
  const near = (label: string, value: number, cap: number): void => {
    if (cap > 0 && value >= cap * NEAR) out.push(`near the ${label} limit: ${formatCount(value)} / ${formatCount(cap)}`)
  }
  near('vertex', stats.vertices, LIMITS.vertices)
  near('triangle', Math.floor(stats.indices / 3), LIMITS.indices / 3)
  near('mesh', stats.meshes, LIMITS.meshes)
  near('primitive', stats.primitives, LIMITS.primitives)
  near('node', stats.nodes, LIMITS.nodes)
  near('material', stats.materials, LIMITS.materials)
  near('texture', stats.textures, LIMITS.textures)
  near('camera', stats.cameras, LIMITS.cameras)
  near('light', stats.lights, LIMITS.lights)
  near('skin', stats.skins, LIMITS.skins)
  near('animation channel', stats.channels, LIMITS.animationChannels)
  near('keyframe', stats.keyframes, LIMITS.keyframes)
  near('scene depth', stats.depth, LIMITS.sceneDepth)
  if (stats.decodedPixels >= limitDecodedPixels() * NEAR) {
    out.push(`near the texture memory limit: ${formatSize(stats.decodedPixels)} / ${formatSize(limitDecodedPixels())}`)
  }
  return out
}
