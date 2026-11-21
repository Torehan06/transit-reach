import { defineConfig } from 'vite';

export default defineConfig({
  base: '/transit-reach/',
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
  },
});
