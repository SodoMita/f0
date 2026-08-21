// Headless checks for the export-review settings helpers (SPEC AMENDMENT 86):
// the card size dials (aspect + resolution -> the published `dim`), the
// single Draco bits dial, and the aspect label.
//   bun scripts/export-card-unit.mjs
import {
  aspectLabel, cardDimFromSettings, cardSettingsFromDim, dracoBits,
  DRACO_BITS_DEFAULT, DRACO_BITS_MAX, DRACO_BITS_MIN,
  CARD_ASPECT_MIN, CARD_ASPECT_MAX, CARD_RES_MIN, CARD_RES_MAX,
} from '../src/studio/exportInfo.ts'

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

// ---- cardDimFromSettings: aspect + long edge -> dim ---------------------
{
  const d = cardDimFromSettings(1.6, 448)
  check('default 16:10 @448 is the poster default', d.width === 448 && d.height === 280, JSON.stringify(d))
  const sq = cardDimFromSettings(1, 448)
  check('1:1 makes a square', sq.width === 448 && sq.height === 448, JSON.stringify(sq))
  const wide = cardDimFromSettings(2, 512)
  check('2:1 halves the short side', wide.width === 512 && wide.height === 256, JSON.stringify(wide))
  const tall = cardDimFromSettings(0.5, 512)
  check('1:2 halves the width', tall.width === 256 && tall.height === 512, JSON.stringify(tall))
  const tall9 = cardDimFromSettings(0.75, 448)
  check('3:4 portrait keeps the long edge as height', tall9.width === 336 && tall9.height === 448, JSON.stringify(tall9))
}

// ---- bounds: aspect + dim clamps, short edge never under the minimum ----
{
  const clamped = cardDimFromSettings(99, 100000)
  check('aspect and long edge clamp to the format bounds', clamped.width === CARD_RES_MAX && clamped.height === CARD_RES_MAX / CARD_ASPECT_MAX, JSON.stringify(clamped))
  const wideLow = cardDimFromSettings(2, 64)
  check('2:1 at 64px long edge floors to a 64px short side', wideLow.width === 128 && wideLow.height === 64, JSON.stringify(wideLow))
  const tallLow = cardDimFromSettings(0.5, 64)
  check('1:2 at 64px long edge floors to a 64px short side', tallLow.width === 64 && tallLow.height === 128, JSON.stringify(tallLow))
  const lo = cardDimFromSettings(1, 1)
  check('below-min long edge clamps to the minimum', lo.width === CARD_RES_MIN && lo.height === CARD_RES_MIN, JSON.stringify(lo))
  const outAspect = cardDimFromSettings(0.1, 448)
  check('extreme aspect clamps to the minimum', outAspect.width === 224 && outAspect.height === 448, JSON.stringify(outAspect))
}

// ---- cardSettingsFromDim: inverse (seeds the dials from previewDim) -----
{
  const s = cardSettingsFromDim(448, 280)
  check('inverse recovers aspect', Math.abs(s.aspect - 1.6) < 1e-9, String(s.aspect))
  check('inverse recovers the long edge', s.longEdge === 448, String(s.longEdge))
  const p = cardSettingsFromDim(358, 448)
  check('portrait inverse: long edge is the height', p.longEdge === 448 && Math.abs(p.aspect - 358 / 448) < 1e-9, JSON.stringify(p))
  const round = cardSettingsFromDim(1, 100000)
  check('inverse clamps into the format bounds', round.longEdge === CARD_RES_MAX, JSON.stringify(round))
}

// ---- aspectLabel -------------------------------------------------------
{
  check('1.6 labels as 16:10', aspectLabel(1.6) === '16:10', aspectLabel(1.6))
  check('1 labels as 1:1', aspectLabel(1) === '1:1', aspectLabel(1))
  check('4/3 labels as 4:3', aspectLabel(4 / 3) === '4:3', aspectLabel(4 / 3))
  check('16/9 labels as 16:9', aspectLabel(16 / 9) === '16:9', aspectLabel(16 / 9))
  check('custom ratio falls back to the number', aspectLabel(1.4) === '1.40', aspectLabel(1.4))
  check('out-of-range aspect clamps before labelling', aspectLabel(5) === '2:1', aspectLabel(5))
}

// ---- dracoBits: one dial -> per-attribute quantization -----------------
{
  const def = dracoBits(DRACO_BITS_DEFAULT)
  check('default 12 reproduces the balanced preset',
    def.POSITION === 12 && def.NORMAL === 9 && def.TANGENT === 10 && def.TEX_COORD === 11 && def.COLOR === 8 && def.GENERIC === 11,
    JSON.stringify(def))
  const low = dracoBits(10)
  check('10 bits dial: position follows the dial, others scale down',
    low.POSITION === 10 && low.NORMAL === 8 && low.TANGENT === 8 && low.TEX_COORD === 9 && low.COLOR === 7 && low.GENERIC === 9,
    JSON.stringify(low))
  const high = dracoBits(14)
  check('14 bits dial scales the rest up', high.POSITION === 14 && high.NORMAL === 11 && high.TANGENT === 12 && high.TEX_COORD === 13 && high.COLOR === 9 && high.GENERIC === 13, JSON.stringify(high))
  const clamped = dracoBits(99)
  check('dial clamps to the max', clamped.POSITION === DRACO_BITS_MAX && Object.values(clamped).every((v) => v <= DRACO_BITS_MAX), JSON.stringify(clamped))
  const clampedLow = dracoBits(1)
  check('dial clamps to the min', clampedLow.POSITION === DRACO_BITS_MIN && Object.values(clampedLow).every((v) => v >= DRACO_BITS_MIN), JSON.stringify(clampedLow))
  const fraction = dracoBits(12.7)
  check('dial rounds to a uint', fraction.POSITION === 13, String(fraction.POSITION))
  check('aspect bounds are the dim format bounds', CARD_ASPECT_MIN === 0.5 && CARD_ASPECT_MAX === 2.0)
}

if (fails.length) {
  console.error(`\nFAIL  ${fails.length} export-card check(s): ${fails.join(' · ')}`)
  process.exit(1)
}
console.log(`\nok  ${'export-card-unit'} passed`)
