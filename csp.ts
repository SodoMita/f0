// Content-Security-Policy strings for the two builds.
//
// WEB_CSP — the dev server and the non-standalone release build. Strict:
// scripts only from self, no unsafe-eval, no frames/objects/base-uri tricks.
// `ws:` is required by Vite's HMR websocket in dev; the app itself only ever
// dials `wss:` relays (normalizeRelay). `connect-src 'self'` is required for
// the local Draco decoder: Babylon fetches the draco_decoder_gltf.wasm
// binary over XHR, so same-origin fetches must be allowed whether the site is
// served over http (dev server) or https (production).
//
// STANDALONE_CSP — the single-file build (form-zero-standalone.html, which
// is what GitHub Pages / githack / jsDelivr mirrors serve). This file opens
// from file:// (opaque origin, where 'self' matches nothing) and inlines its
// own <script> plus data: Draco assets, so script-src cannot be 'self':
// 'unsafe-inline' + data: is the best that build can do. Even so,
// base-uri/object-src/frame-src are locked down and every fetch/worker/media
// channel is restricted to the schemes the app actually uses, which blocks
// most injected-content payloads and keeps the "no network except user
// content" property true by policy.
export const WEB_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' https: wss: ws: blob:",
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
  "script-src 'unsafe-inline' data:",
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
