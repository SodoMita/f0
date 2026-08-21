// Headless unit checks for the paint editor's Babylon-free core
// (store / hash / DDA / stroke / history / math).
//   bun scripts/paint-unit.mjs
import { StampStore } from '../src/studio/paint/store.ts'
import { SpatialHash } from '../src/studio/paint/hash.ts'
import { History } from '../src/studio/paint/history.ts'
import { walkGrid, rayPlane } from '../src/studio/paint/dda.ts'
import { stampAlong, smoothPath, widthFromPressure, effectivePressure } from '../src/studio/paint/stroke.ts'
import { IDENTITY_QUAT, quatAlign } from '../src/studio/paint/math.ts'
import { GRID, MAX_STAMPS, SHAPES, SHAPE_ID, UNDO_CAP } from '../src/studio/paint/types.ts'

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

{
  const store = new StampStore()
  const a = store.add({
    shape: 'cube', px: 1, py: 2, pz: 3, qx: 0, qy: 0, qz: 0, qw: 1,
    sx: 0.25, sy: 0.1, sz: 0.25, r: 1, g: 0, b: 0, a: 1,
  })
  const b = store.add({
    shape: 'sphere', px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1,
    sx: 0.2, sy: 0.2, sz: 0.2, r: 0, g: 1, b: 0, a: 1,
  })
  check('store assigns incrementing ids', a.id === 1 && b.id === 2)
  check('store.count after two adds', store.count === 2)
  const removed = store.removeId(a.id)
  check('swap-last delete returns the stamp', removed?.id === 1 && removed.px === 1)
  check('swap-last leaves the other stamp', store.count === 1 && store.at(0).id === 2)
  check('index map follows the swapped stamp', store.get(2)?.shape === 'sphere')
  check('remove missing id is null', store.removeId(99) === null)
}

{
  check('square and triangle are paint brushes', SHAPES.includes('square') && SHAPES.includes('triangle'))
  check('paint shape ids stay unique', new Set(Object.values(SHAPE_ID)).size === SHAPES.length)
  const store = new StampStore()
  for (const shape of ['square', 'triangle']) {
    store.add({
      shape, px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1,
      sx: 1, sy: 1, sz: 0.02, r: 1, g: 1, b: 1, a: 1,
    })
  }
  check('square and triangle round-trip through packed store', store.at(0).shape === 'square' && store.at(1).shape === 'triangle')
}

{
  const store = new StampStore()
  const hash = new SpatialHash()
  const s = store.add({
    shape: 'cube', px: 0.12, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1,
    sx: 0.25, sy: 0.1, sz: 0.25, r: 1, g: 1, b: 1, a: 1,
  })
  hash.insert(s)
  const near = hash.query(0.1, 0, 0, 0.2)
  const far = hash.query(8, 0, 0, 0.2)
  check('spatial hash finds nearby stamp', near.includes(s.id))
  check('spatial hash misses far query', !far.includes(s.id))
  hash.remove(s.id)
  check('spatial hash remove', hash.query(0.1, 0, 0, 0.2).length === 0)
}

{
  const cells = []
  walkGrid([0.01, 0.01, 0.01], [1, 0, 0], GRID, 0.2, (ix, iy, iz) => {
    cells.push([ix, iy, iz])
    return true
  })
  check('DDA walks +X through several GRID cells', cells.length >= 4, `n=${cells.length}`)
  check('DDA starts in the origin cell', cells[0][0] === 0 && cells[0][1] === 0)
  const hit = rayPlane([0, 0, 5], [0, 0, -1], [0, 0, 0], [0, 0, 1])
  check('ray-plane hits z=0 from +Z', !!hit && Math.abs(hit[2]) < 1e-9)
  const miss = rayPlane([0, 0, 5], [0, 0, 1], [0, 0, 0], [0, 0, 1])
  check('ray-plane misses when pointing away', miss === null)
}

{
  const pts = [
    { x: 0, y: 0, z: 0, pressure: 0.8, t: 0 },
    { x: 1, y: 0, z: 0, pressure: 0.8, t: 16 },
  ]
  const { emitted, carry } = stampAlong(pts, 0.25, 0)
  check('stampAlong emits ~spacing steps', emitted.length === 4, `n=${emitted.length}`)
  check('stampAlong leftover is < spacing', carry < 0.25 && carry >= 0)
  // Session feeds one NEW segment at a time. Re-walking the whole polyline
  // with leftover carry would restamp. Sequential chunks must stay gapless
  // and unique.
  let acc = 0
  const chunks = []
  const path = [
    { x: 0, y: 0, z: 0, pressure: 1, t: 0 },
    { x: 0.3, y: 0, z: 0, pressure: 1, t: 1 },
    { x: 0.7, y: 0, z: 0, pressure: 1, t: 2 },
    { x: 1.0, y: 0, z: 0, pressure: 1, t: 3 },
  ]
  for (let i = 1; i < path.length; i++) {
    const step = stampAlong([path[i - 1], path[i]], 0.25, acc)
    acc = step.carry
    chunks.push(...step.emitted)
  }
  const xs = chunks.map((p) => +p.x.toFixed(4))
  const unique = new Set(xs)
  check('chunked stampAlong does not restamp', unique.size === xs.length, `xs=${xs.join(',')}`)
  check('chunked stampAlong covers the 1-unit stroke', chunks.length === 4, `n=${chunks.length}`)
  const sm = smoothPath([
    { x: 0, y: 0, z: 0, pressure: 1, t: 0 },
    { x: 1, y: 10, z: 0, pressure: 1, t: 1 },
    { x: 2, y: 0, z: 0, pressure: 1, t: 2 },
  ], 3)
  check('smoothPath keeps endpoints', sm[0].x === 0 && sm[sm.length - 1].x === 2)
  check('smoothPath pulls the spike in', sm[1].y < 10)
  check('mouse pressure is a mid constant', effectivePressure(0, 'mouse') > 0.5)
  check('width grows with pressure', widthFromPressure(1, 1) > widthFromPressure(0.2, 1))
}

{
  const h = new History(3)
  const log = []
  h.push({ label: 'a', undo: () => log.push('ua'), redo: () => log.push('ra') })
  h.push({ label: 'b', undo: () => log.push('ub'), redo: () => log.push('rb') })
  h.undo(); h.undo(); h.redo()
  h.push({ label: 'c', undo: () => log.push('uc'), redo: () => log.push('rc') })
  check('undo/redo order', log.join(',') === 'ub,ua,ra')
  check('new edit clears redo tail', h.canRedo === false && h.canUndo === true)
  check('undo cap constant is >= 100', UNDO_CAP >= 100)
  check('stamp budget is 50k', MAX_STAMPS === 50_000)
}

{
  const q = quatAlign([1, 0, 0], [0, 1, 0])
  const len = Math.hypot(...q)
  check('align quat is unit', Math.abs(len - 1) < 1e-6, `len=${len.toFixed(5)}`)
  check('identity quat is w=1', IDENTITY_QUAT[3] === 1)
}

console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL PAINT UNIT CHECKS PASSED')
process.exit(fails.length ? 1 : 0)
