import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base './' => kisi bhi repo-name ke GitHub Pages path pe chalega
// outDir 'docs' => GitHub Pages "Deploy from branch: main /docs" se bina Actions ke live
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'docs',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
})
