// Headless checks for the export-review settings helpers (SPEC AMENDMENT
// 86/87): the card size dials (aspect + resolution -> the published `dim`),
// the per-attribute Draco bits + speed settings, and the aspect label.
//   bun scripts/export-card-unit.mjs
import {
  aspectLabel, cardDimFromSettings, cardSettingsFromDim, sanitizeDracoBits, dracoBitsNote,
  DRACO_ATTRIBS, DRACO_BITS_DEFAULT, DRACO_BITS_MAX, DRACO_BITS_MIN,
  DRACO_SPEED_DEFAULT, DRACO_SPEED_MAX, DRACO_SPEED_MIN,
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

// ---- draco settings: every encoder setting in the encoder's range -------
{
  // The five attribute kinds the encoder actually quantizes (TANGENT is not
  // one of them — GENERIC covers it).
  check('draco attributes match the encoder kinds',
    JSON.stringify(DRACO_ATTRIBS) === JSON.stringify(['POSITION', 'NORMAL', 'TEX_COORD', 'COLOR', 'GENERIC']),
    JSON.stringify(DRACO_ATTRIBS))
  const def = sanitizeDracoBits({})
  check('empty input falls back to the balanced defaults',
    def.POSITION === 12 && def.NORMAL === 9 && def.TEX_COORD === 11 && def.COLOR === 8 && def.GENERIC === 11,
    JSON.stringify(def))
  check('defaults are byte-identical to the old balanced preset', dracoBitsNote(def) === 'pos 12/nrm 9/uv 11/col 8/gen 11 bits', dracoBitsNote(def))
  const one = sanitizeDracoBits({ POSITION: 10 })
  check('one dial changes only its attribute', one.POSITION === 10 && one.NORMAL === 9 && one.TEX_COORD === 11 && one.COLOR === 8 && one.GENERIC === 11, JSON.stringify(one))
  const clamped = sanitizeDracoBits({ POSITION: 99, NORMAL: 0, TEX_COORD: -5, COLOR: 15.7 })
  check('values clamp + round into the encoder range',
    clamped.POSITION === DRACO_BITS_MAX && clamped.NORMAL === DRACO_BITS_MIN && clamped.TEX_COORD === DRACO_BITS_MIN && clamped.COLOR === 16,
    JSON.stringify(clamped))
  const hi = sanitizeDracoBits({ POSITION: 30 })
  check('encoder max bits (30) is accepted', hi.POSITION === 30, String(hi.POSITION))
  check('bits range is 1..30', DRACO_BITS_MIN === 1 && DRACO_BITS_MAX === 30)
  check('speed range is 0..10, default 5', DRACO_SPEED_MIN === 0 && DRACO_SPEED_MAX === 10 && DRACO_SPEED_DEFAULT === 5)
  check('aspect bounds are the dim format bounds', CARD_ASPECT_MIN === 0.5 && CARD_ASPECT_MAX === 2.0)
}

if (fails.length) {
  console.error(`\nFAIL  ${fails.length} export-card check(s): ${fails.join(' · ')}`)
  process.exit(1)
}
console.log(`\nok  ${'export-card-unit'} passed`)
