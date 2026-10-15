import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { createHash } from 'node:crypto'
import fs from 'node:fs'

export default defineConfig({
  plugins: [react(), {
    name: 'sao-build-identity',
    writeBundle(options, bundle) {
      const directory = path.resolve(options.dir || '../dist/client');
      const revision = process.env.SAO_BUILD_SHA || '';
      const assets = Object.values(bundle).filter(asset => asset.fileName.startsWith('assets/')).map(asset => ({
        file: asset.fileName,
        sha256: createHash('sha256').update(fs.readFileSync(path.join(directory, asset.fileName))).digest('hex'),
      }));
      fs.writeFileSync(path.join(directory, 'build-info.json'), JSON.stringify({ revision: /^[a-f0-9]{7,40}$/i.test(revision) ? revision : null, builtAt: new Date().toISOString(), assets }));
    },
  }],
  root: '.',
  build: { outDir: '../dist/client', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:3000' } },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } }
})
