import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: { outDir: '../dist/client' },
  server: { proxy: { '/api': 'http://localhost:3000' } },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } }
})
