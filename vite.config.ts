import { defineConfig } from 'vite'

// Strict CSP. connect-src must allow wss: (relays) and https: (Blossom).
// worker-src blob: is required by Babylon's Draco decoder workers.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src https: wss: ws: blob:",
  "img-src 'self' blob: data: https:",
  "media-src blob: https:",
  "worker-src 'self' blob:",
  "font-src 'self' data:",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
].join('; ')

export default defineConfig({
  base: './',
  server: { host: true, allowedHosts: true },
  build: {
    outDir: 'release',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 3000,
    cssCodeSplit: false,
  },
  plugins: [
    {
      name: 'form-zero-csp',
      transformIndexHtml: {
        order: 'post',
        handler(html) {
          return {
            html,
            tags: [
              { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head' },
            ],
          }
        },
      },
    },
  ],
})
