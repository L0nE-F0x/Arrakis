import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        gauntlet: resolve(import.meta.dirname, 'gauntlet.html')
      }
    }
  }
});
