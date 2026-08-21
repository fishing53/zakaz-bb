import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({
  root: resolve(__dirname),
  base: '/waiter/',
  publicDir: resolve(__dirname, 'public'),
  build: { outDir: resolve(__dirname, '../dist-waiter'), emptyOutDir: true, target: 'es2022' },
});
