import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Route-level lazy loading reduced the largest chunk; keep the warning
    // threshold aligned with the current largest route bundle.
    chunkSizeWarningLimit: 900,
  },
})
