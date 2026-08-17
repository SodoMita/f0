import { defineConfig } from 'vite'

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src https: wss: blob:",
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
  build: {
    outDir: 'release',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 7000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@babylonjs/')) return 'babylon'
          if (id.includes('nostr-tools') || id.includes('@noble')) return 'nostr'
        },
      },
    },
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
              {
                tag: 'meta',
                attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
                injectTo: 'head',
              },
            ],
          }
        },
      },
    },
  ],
})
