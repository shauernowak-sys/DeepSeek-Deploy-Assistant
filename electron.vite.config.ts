import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const alias = {
  '@dda/spec': resolve(__dirname, 'packages/spec/src/index.ts'),
  '@dda/core': resolve(__dirname, 'packages/core/src/index.ts'),
  '@dda/adapters': resolve(__dirname, 'packages/adapters/src/index.ts'),
};

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      outDir: 'out/main',
      // Bundle everything except electron itself so the packaged app does not depend on
      // pnpm's symlinked node_modules inside asar.
      rollupOptions: {
        external: ['electron'],
        input: resolve(__dirname, 'apps/desktop/src/main/index.ts'),
      },
    },
  },
  preload: {
    resolve: { alias },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        external: ['electron'],
        input: resolve(__dirname, 'apps/desktop/src/preload/index.ts'),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'apps/desktop/src/renderer'),
    resolve: { alias },
    plugins: [react()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: { input: resolve(__dirname, 'apps/desktop/src/renderer/index.html') },
    },
  },
});
