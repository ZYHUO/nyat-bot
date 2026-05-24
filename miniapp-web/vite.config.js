import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  base: '/miniapp/',
  build: {
    outDir: resolve(__dirname, '../miniapp'),
    emptyOutDir: true,
  },
  test: {
    environment: 'node',
  },
});
