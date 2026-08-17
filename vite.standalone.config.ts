import { defineConfig } from 'vite'
import base from './vite.config'
import { STANDALONE_CSP } from './csp'

// Standalone: ONE chunk, all assets as data: URIs.
//
// The single-file build opens from file:// (opaque origin) and inlines its
// own <script> plus data: Draco assets, so it cannot use the strict
// script-src 'self' of the web build. It DOES get its own CSP (csp.ts
// STANDALONE_CSP): scripts are the one thing that must fall back to
// 'unsafe-inline' + data:; everything else — connect/img/media/worker
// schemes, base-uri, object-src, frame-src — stays locked to what the app
// actually uses. (This used to ship with NO CSP at all, which is what
// GitHub Pages / githack / jsDelivr serve.)
export default defineConfig({
  ...base,
  plugins: [
    {
      name: 'form-zero-standalone-csp',
      transformIndexHtml: {
        order: 'post',
        handler(html) {
          return {
            html,
            tags: [
              { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: STANDALONE_CSP }, injectTo: 'head' },
            ],
          }
        },
      },
    },
  ],
  build: {
    outDir: 'release',
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100 * 1024 * 1024,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})
