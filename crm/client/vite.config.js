import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Port 5174: 5173 belongs to tgs-training-platform, 3000 to ticketing-system.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': { target: 'http://localhost:3002', changeOrigin: true },
      /* Public, unauthenticated pages served by Express, not the SPA. Without
         these the dev server hands them to React Router, which has no such
         route and bounces the visitor to the dashboard.

         Anchored regexes, not bare prefixes: a plain '/q' key also matches
         '/quotes' and would proxy the whole app page to a backend that has no
         such route. */
      '^/u/': { target: 'http://localhost:3002', changeOrigin: true },
      '^/q/': { target: 'http://localhost:3002', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
})
