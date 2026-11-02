import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@dda/spec': resolve(__dirname, 'packages/spec/src/index.ts'),
      '@dda/core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@dda/adapters': resolve(__dirname, 'packages/adapters/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    reporters: ['default'],
  },
});
