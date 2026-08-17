import { defineConfig } from 'vite'
import { WEB_CSP } from './csp'

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
              { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: WEB_CSP }, injectTo: 'head' },
            ],
          }
        },
      },
    },
  ],
})
