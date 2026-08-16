import { defineConfig } from 'vite'
import base from './vite.config'

// Standalone: ONE chunk, all assets as data: URIs. No CSP meta here because
// the inline <script> and data: Draco assets cannot satisfy script-src 'self';
// the single-file build runs from file:// and fetches nothing but user content.
export default defineConfig({
  ...base,
  plugins: [],
  build: {
    outDir: 'release',
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100 * 1024 * 1024,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})
