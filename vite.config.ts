import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // Vite's default output directory. Keeping the framework default matters:
    // Vercel's Vite preset expects `dist`, and pointing `outputDirectory`
    // somewhere else (it was `dist/public`) prevented `api/` functions from
    // being built into a lambda, so every /api request returned
    // FUNCTION_INVOCATION_FAILED regardless of the handler code.
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})