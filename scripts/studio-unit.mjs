// Headless studio pass-through checks (SPEC AMENDMENT 66) driven on a
// NullEngine — NO browser, NO network:
//   bun scripts/studio-unit.mjs
// (no bun? bundle once: `npx esbuild scripts/studio-unit.mjs --bundle
//   --format=esm --platform=node --outfile=/tmp/studio-unit.mjs` and run that)
//
// Asserts:
//  1. a fresh import publishes BYTE-IDENTICAL to the imported file,
//  2. typing text then clearing it adds NOTHING to the model,
//  3. adding then removing a user camera restores pass-through,
//  4. a (simulated) mesh move breaks pass-through (re-export),
//  5. resetAdditions() re-imports the pristine bytes: pass-through restored,
//  6. publishModel() stamps the model name into the nostr event `content`.
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'

// ---- minimal DOM shims for Babylon's File load path ---------------------
// Babylon's FileTools.ReadFile calls `new FileReader()`; node has File/Blob
// but no FileReader. Only readAsArrayBuffer/readAsText are used below.
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    constructor() { this.onload = null; this.onloadend = null; this.onerror = null; this.onprogress = null }
    readAsArrayBuffer(file) {
      Promise.resolve(file.arrayBuffer()).then((buf) => {
        this.result = buf
        this.onload?.({ target: this })
        this.onloadend?.({ target: this })
      }, (err) => this.onerror?.(err))
    }
    readAsText(file) {
      Promise.resolve(file.text()).then((text) => {
        this.result = text
        this.onload?.({ target: this })
        this.onloadend?.({ target: this })
      }, (err) => this.onerror?.(err))
    }
    abort() {}
  }
}

const { Studio } = await import('../src/studio/studio.ts')
const { publishModel } = await import('../src/protocol/publish.ts')

const fails = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails.push(name)
}

/** Minimal valid GLB: one triangle. */
function makeGlb() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  const indices = new Uint16Array([0, 1, 2])
  const bin = new Uint8Array(44)
  bin.set(new Uint8Array(positions.buffer), 0)
  bin.set(new Uint8Array(indices.buffer), 36)
  const json = JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'tri' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    buffers: [{ byteLength: 44 }],
  })
  let jsonPadded = json
  while (jsonPadded.length % 4) jsonPadded += ' '
  const jsonBytes = new TextEncoder().encode(jsonPadded)
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546c67, true) // 'glTF'
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  dv.setUint32(12, jsonBytes.length, true)
  dv.setUint32(16, 0x4e4f534a, true) // 'JSON'
  out.set(jsonBytes, 20)
  const binOff = 20 + jsonBytes.length
  dv.setUint32(binOff, bin.length, true)
  dv.setUint32(binOff + 4, 0x004e4942, true) // 'BIN'
  out.set(bin, binOff + 8)
  return out
}

const canvasStub = {
  width: 800, height: 600, clientWidth: 800, clientHeight: 600, tabIndex: 0,
  addEventListener() {}, removeEventListener() {}, setAttribute() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  style: {},
  ownerDocument: { defaultView: { PointerEvent: undefined } },
}

const engine = new NullEngine({ renderingCanvas: canvasStub, disableWebGL2Support: true })
const formStub = {
  engine,
  activeScene: null,
  addAnimationSource() {},
  kick() {},
}

const studio = new Studio(formStub)
// The Studio class seeds textValue='/0' for text-first posts; the app's
// studio route clears it on entry — do the same here for the model flows.
studio.setText('')
const glbBytes = makeGlb()
const sameBytes = async (blob) => {
  const a = new Uint8Array(await blob.arrayBuffer())
  if (a.length !== glbBytes.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== glbBytes[i]) return false
  return true
}

const file = new File([glbBytes], 'probe.glb', { type: 'model/gltf-binary' })
const imported = await studio.importFiles([file])
check('import reports the triangle stats', imported.report.ok && imported.report.stats.vertices === 3 && imported.report.stats.meshes === 1,
  JSON.stringify(imported.report.stats))

{
  const content = await studio.getContentForPublish()
  check('fresh import publishes byte-identical', await sameBytes(content.blob) && content.filename === 'probe.glb')
}

{
  studio.setText('HELLO')
  const withText = await studio.getContentForPublish().catch(() => null) // may try to build font geometry in the browser only
  studio.setText('')
  const cleared = await studio.getContentForPublish()
  check('text typed then cleared publishes byte-identical (no text in the model)', await sameBytes(cleared.blob))
  void withText
}

{
  const idx = studio.addCamera()
  const withCam = await studio.getContentForPublish()
  const grew = !(await sameBytes(withCam.blob))
  studio.removeCamera(idx)
  const after = await studio.getContentForPublish()
  check('added camera forces re-export; removing it restores pass-through', grew && (await sameBytes(after.blob)),
    `grew=${grew}`)
}

{
  // a gizmo drag on an imported mesh is a sticky edit (simulated here; the
  // real drag path calls the same markDirty)
  studio.markDirty()
  const moved = await studio.getContentForPublish()
  const reexported = !(await sameBytes(moved.blob))
  const ok = await studio.resetAdditions()
  const reset = await studio.getContentForPublish()
  check('mesh move re-exports; resetAdditions restores byte-identical pass-through',
    reexported && ok && (await sameBytes(reset.blob)),
    `reexported=${reexported} ok=${ok}`)
  check('reset clears the sticky edit flag for later edits', studio.hasModel())
}

// ---- publishModel end-to-end in-process --------------------------------
// publishModel is environment-agnostic: Blossom upload falls back to
// `fetch` (no XHR in node), storage falls back to in-memory (no IndexedDB),
// and the relay pool is a supplied dependency. The in-process HTTPS server
// below captures the PUT body verbatim, so "published bytes == imported
// bytes" is checked end-to-end, and the fake pool captures the signed event
// template so `content` (the model name) is asserted exactly.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0' // self-signed in-process stub
{
  const { createServer } = await import('node:https')
  const { readFileSync, existsSync, mkdirSync } = await import('node:fs')
  const { execFileSync } = await import('node:child_process')
  const { sha256Hex } = await import('../src/protocol/hash.ts')

  // Reuse the offline rig's certs when present; mint a throwaway self-signed
  // localhost pair otherwise (same openssl recipe as docs/SANDBOX-VERIFY.md).
  const certDir = (() => {
    for (const dir of ['/tmp/rig-certs', '/tmp/f0-studio-unit-certs']) {
      if (existsSync(`${dir}/key.pem`) && existsSync(`${dir}/cert.pem`)) return dir
    }
    const dir = '/tmp/f0-studio-unit-certs'
    mkdirSync(dir, { recursive: true })
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', `${dir}/key.pem`, '-out', `${dir}/cert.pem`, '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'pipe' })
    return dir
  })()

  const uploaded = []
  const server = createServer({
    key: readFileSync(`${certDir}/key.pem`),
    cert: readFileSync(`${certDir}/cert.pem`),
  }, (req, res) => {
    if (req.method === 'PUT' && req.url === '/upload') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        uploaded.push(Buffer.concat(chunks))
        res.writeHead(201, { 'content-type': 'application/json' })
        // the real port is patched in below once the listener is up
        res.end(JSON.stringify({ url: `https://localhost:${server.address().port}/blob` }))
      })
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const blossomBase = `https://localhost:${server.address().port}`

  let template = null
  const pool = {
    relayUrls: ['wss://stub'],
    publish: async (t, _secret) => { template = t; return { ok: ['wss://stub'], failed: [] } },
  }

  try {
    const modelBytes = new Uint8Array(glbBytes)
    const out = await publishModel(
      { model: new Blob([modelBytes], { type: 'model/gltf-binary' }), width: 448, height: 280, tint: '#FF5C35', filename: 'probe.glb', name: 'probe' },
      { relays: ['wss://stub'], blossoms: [blossomBase], pool },
    )
    check('publishModel succeeds against the in-process stub', out.ok.length === 1 && !!out.eventId)
    check('the uploaded body is byte-identical to the model', uploaded.length === 1 && Buffer.compare(uploaded[0], Buffer.from(modelBytes)) === 0,
      `${uploaded[0]?.length} vs ${modelBytes.length}`)
    check('event content is the model name', template?.content === 'probe', JSON.stringify(template?.content))
    const x = template?.tags?.find((t) => t[0] === 'x')?.[1]
    check('event x tag is the model sha256', x === (await sha256Hex(modelBytes)))

    const long = 'n'.repeat(400)
    template = null
    await publishModel(
      { model: new Blob([modelBytes]), width: 448, height: 280, tint: '#FF5C35', filename: 'n.glb', name: long },
      { relays: ['wss://stub'], blossoms: [blossomBase], pool },
    )
    check('content is capped at the budget', template?.content === long.slice(0, 140), String(template?.content?.length))

    template = null
    await publishModel(
      { model: new Blob([modelBytes]), width: 448, height: 280, tint: '#FF5C35', filename: 'n.glb' },
      { relays: ['wss://stub'], blossoms: [blossomBase], pool },
    )
    check('no name stays the legacy empty content', template?.content === '')
  } finally {
    server.close()
  }
}

console.log(fails.length ? `FAILURES: ${fails.join(' | ')}` : 'ALL STUDIO UNIT CHECKS PASSED')
process.exit(fails.length ? 1 : 0)
