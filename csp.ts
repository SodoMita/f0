// Content-Security-Policy strings for the two builds.
//
// WEB_CSP — the dev server and the non-standalone release build. Strict:
// scripts only from self, no unsafe-eval, no frames/objects/base-uri tricks.
// 'wasm-unsafe-eval' is required by the LOCAL Draco decoder (AMENDMENT 68):
// the emscripten wrapper compiles the bundled draco_decoder_gltf.wasm with
// WebAssembly.instantiate, which Chromium gates on that keyword. Without it
// every Draco-compressed model (the whole symbol library included) fails to
// load. `data:` in connect-src is for the library GLBs, which the bundle
// inlines as data: URIs in both builds. `ws:` is required by Vite's HMR
// websocket in dev; the app itself only ever dials `wss:` relays
// (normalizeRelay). `http://localhost:*` + `http://127.0.0.1:*` are for
// local dev/preview only — the dev server serves the Draco wasm over plain
// http, which `https:` alone would block.
//
// STANDALONE_CSP — the single-file build (form-zero-standalone.html, which
// is what GitHub Pages / githack / jsDelivr mirrors serve). This file opens
// from file:// (opaque origin, where 'self' matches nothing) and inlines its
// own <script> plus data: Draco assets, so script-src cannot be 'self':
// 'unsafe-inline' + data: is the best that build can do. 'wasm-unsafe-eval'
// unblocks the inlined Draco decoder the same way as in WEB_CSP. Even so,
// base-uri/object-src/frame-src are locked down and every fetch/worker/media
// channel is restricted to the schemes the app actually uses, which blocks
// most injected-content payloads and keeps the "no network except user
// content" property true by policy.
export const WEB_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src https: wss: ws: blob: data: http://localhost:* http://127.0.0.1:*",
  "img-src 'self' blob: data: https:",
  "media-src blob: https:",
  "worker-src 'self' blob:",
  "font-src 'self' data:",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
].join('; ')

export const STANDALONE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' data: 'wasm-unsafe-eval'",
  "style-src 'unsafe-inline'",
  "connect-src https: wss: blob: data:",
  "img-src blob: data: https:",
  "media-src blob: data: https:",
  "worker-src blob: data:",
  "font-src data:",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
].join('; ')
