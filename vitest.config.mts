import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'server/**/*.test.ts', 'contracts/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
