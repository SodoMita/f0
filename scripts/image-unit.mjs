// Image-as-plane units — no browser needed:
//   bun scripts/image-unit.mjs
// Guards src/studio/imageTool.ts: images keep their NATIVE resolution (no
// downscale cap — the post size limit bounds them), the only up-front
// refusal is the engine's hard texture-side ceiling, and waitTextureReady
// resolves on ready/load and rejects on timeout without leaking its timer.
import { IMAGE_SIDE_HARD_LIMIT, waitTextureReady } from '../src/studio/imageTool.ts'
import { LIMITS } from '../src/theme.ts'

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

// 1. there is NO resolution cap below the engine's hard limit (native res
//    is the default — see decodeImageFile, which downscales nothing)
check('no cap below the engine texture ceiling',
  typeof IMAGE_SIDE_HARD_LIMIT === 'number' && IMAGE_SIDE_HARD_LIMIT === LIMITS.textureSide,
  `hard limit = ${IMAGE_SIDE_HARD_LIMIT}px`)

// 2. waitTextureReady resolves immediately when already ready
{
  let resolved = false
  const tex = { isReady: () => true, onLoadObservable: { addOnce() {} } }
  waitTextureReady(tex).then(() => { resolved = true })
  await Promise.resolve()
  check('waitTextureReady resolves when already ready', resolved)
}

// 3. waitTextureReady resolves on the load observable
{
  let listener = null
  const tex = {
    isReady: () => false,
    onLoadObservable: { addOnce(fn) { listener = fn } },
  }
  let resolved = false
  void waitTextureReady(tex).then(() => { resolved = true })
  await Promise.resolve()
  listener()
  await Promise.resolve()
  check('waitTextureReady resolves on load', resolved)
}

// 4. waitTextureReady rejects on timeout (and does not leak the timer)
{
  const before = process.getActiveResourcesInfo?.().filter((r) => r === 'Timeout').length ?? 0
  let rejected = null
  const tex = {
    isReady: () => false,
    onLoadObservable: { addOnce() {} },
  }
  void waitTextureReady(tex, 20).catch((e) => { rejected = e.message })
  await new Promise((r) => setTimeout(r, 60))
  check('waitTextureReady rejects on timeout', rejected === 'texture load timed out', String(rejected))
  const after = process.getActiveResourcesInfo?.().filter((r) => r === 'Timeout').length ?? 0
  check('waitTextureReady clears its timer on timeout', after === before, `${before} -> ${after}`)
}

if (fails.length) {
  console.error(`\nFAIL  ${fails.length} image check(s): ${fails.join(', ')}`)
  process.exit(1)
}
console.log('\nALL IMAGE UNITS PASSED')
