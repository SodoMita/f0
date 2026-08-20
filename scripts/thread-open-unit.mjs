// Guard: opening a 2D thread must NOT treat "fit() shows the whole tree"
// as a reason to parse every GLB. nodeWorthTexture is the size gate
// syncPosters / syncPreviews / sync3D share.
import { nodeWorthTexture } from '../src/board/threadGate.ts'

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

const NODE_H = 4 // world units (non-root 16:10 node)
const CSS_H = 800

// Small tree after fit(): zoom floors at 0.6 → node is ~133 px. MUST load.
check(
  'small-tree fit (zoom 0.6) still loads a readable node',
  nodeWorthTexture(NODE_H, 0.6, CSS_H) === true,
  `px=${((NODE_H / (40 * 0.6)) * CSS_H).toFixed(1)}`,
)

// Typical 2–3 node thread at zoom 1: ~80 px. Still load.
check(
  'zoom 1 (80px node) still loads',
  nodeWorthTexture(NODE_H, 1, CSS_H) === true,
)

// Large tree after fit(): zoom 6, node is ~13 px. MUST skip — this is the
// freeze. Viewport-gating is a no-op because fit() put every node on screen.
check(
  'large-tree fit (zoom 6) skips postage-stamp nodes',
  nodeWorthTexture(NODE_H, 6, CSS_H) === false,
  `px=${((NODE_H / (40 * 6)) * CSS_H).toFixed(1)}`,
)

// Exactly 48 px is the floor.
const zoomAt48 = NODE_H / (48 / CSS_H) / 40
check(
  'threshold is 48 CSS px (inclusive)',
  nodeWorthTexture(NODE_H, zoomAt48, CSS_H) === true
  && nodeWorthTexture(NODE_H, zoomAt48 * 1.02, CSS_H) === false,
  `zoomAt48=${zoomAt48.toFixed(3)}`,
)

check('zero/negative zoom does not throw or load', nodeWorthTexture(NODE_H, 0, CSS_H) === true)

console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL CHECKS PASSED')
process.exit(fails.length ? 1 : 0)
