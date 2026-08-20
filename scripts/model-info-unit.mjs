// Headless checks for the studio model-info helpers (SPEC AMENDMENT 66):
// model name for the nostr `content` field, the green->red size heat colour,
// and the big / near-limit import warnings.
//   bun scripts/model-info-unit.mjs
import {
  formatCount, formatSize, modelNameForPublish, modelWarnings, sizeHeatColor,
} from '../src/studio/modelInfo.ts'
import { LIMITS } from '../src/theme.ts'

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

const stats = (patch = {}) => ({
  nodes: 3, meshes: 2, primitives: 2, vertices: 1200, indices: 3600, materials: 1,
  textures: 0, cameras: 0, lights: 0, skins: 0, animations: 0, channels: 0,
  keyframes: 0, decodedPixels: 0, depth: 2, ...patch,
})

// ---- modelNameForPublish ------------------------------------------------
check('file base name (extension stripped)', modelNameForPublish('tree.glb') === 'tree')
check('path + whitespace trimmed', modelNameForPublish('C:\\\\models\\\\my tree.glb') === 'my tree')
check('text override wins over the filename', modelNameForPublish('a.glb', 'hello world') === 'hello world')
check('text override uses the first non-empty line', modelNameForPublish('a.glb', '  \nfirst line\nsecond') === 'first line')
check('control chars collapse to single spaces', modelNameForPublish('a.glb', 'one\ttwo\nthree') === 'one two')
check('name is capped at the content budget', modelNameForPublish('a.glb', 'x'.repeat(400)).length === LIMITS.contentChars)
check('everything empty stays empty', modelNameForPublish() === '' && modelNameForPublish('', '') === '')
check('extensionless filename keeps its name', modelNameForPublish('noext') === 'noext')

// ---- sizeHeatColor ------------------------------------------------------
check('0 bytes is the green endpoint', sizeHeatColor(0) === '#98ca72', sizeHeatColor(0))
check('>= 20 MiB is the red endpoint', sizeHeatColor(LIMITS.modelBytesHard) === '#ff674b', sizeHeatColor(LIMITS.modelBytesHard))
check('past the limit clamps to red', sizeHeatColor(LIMITS.modelBytesHard * 2) === '#ff674b')
const mid = sizeHeatColor(LIMITS.modelBytesHard / 2)
check('mid-point lerps', mid === `#${[0xcc, 0x99, 0x5f].map((v) => v.toString(16)).join('')}`, mid)
check('negative clamps to green', sizeHeatColor(-5) === '#98ca72')

// green channel must fall monotonically 0 -> limit (green fades toward red)
{
  let prev = Infinity
  let monotonic = true
  for (let i = 0; i <= 20; i++) {
    const hex = sizeHeatColor((LIMITS.modelBytesHard * i) / 20)
    const g = parseInt(hex.slice(3, 5), 16)
    if (g > prev) monotonic = false
    prev = g
  }
  check('heat ramps monotonically green -> red', monotonic)
}

// ---- modelWarnings ------------------------------------------------------
check('a small tidy model warns nothing', modelWarnings(1024 * 1024, stats()).length === 0)
check('>= recommended size warns big', modelWarnings(LIMITS.modelBytesRecommended, stats()).some((w) => w.startsWith('big model')))
check('under the recommended size does not', !modelWarnings(LIMITS.modelBytesRecommended - 1, stats()).length)
check('near the vertex cap warns', modelWarnings(100, stats({ vertices: Math.ceil(LIMITS.vertices * 0.7) })).some((w) => w.includes('vertex limit')))
check('far under the vertex cap is quiet', !modelWarnings(100, stats({ vertices: 10 })).some((w) => w.includes('vertex')))
check('near the texture memory cap warns', modelWarnings(100, stats({ decodedPixels: Math.ceil(128 * 1024 * 1024 * 0.7) })).some((w) => w.includes('texture memory')))
check('near the scene-depth cap warns', modelWarnings(100, stats({ depth: Math.ceil(LIMITS.sceneDepth * 0.7) })).some((w) => w.includes('scene depth')))
check('near the animation-channel cap warns', modelWarnings(100, stats({ channels: Math.ceil(LIMITS.animationChannels * 0.7) })).some((w) => w.includes('animation channel')))

// ---- tiny formatters -----------------------------------------------------
check('formatCount groups thousands', formatCount(1234567) === '1,234,567')
check('formatSize tiers', formatSize(512) === '512 B' && formatSize(2048) === '2.0 KiB' && formatSize(3 * 1048576) === '3.0 MiB')

console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL MODEL-INFO UNIT CHECKS PASSED')
process.exit(fails.length ? 1 : 0)
