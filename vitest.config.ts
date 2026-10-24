import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // One file at a time: the plugin's and the outbox's suites time a shutdown, which the other suites' work would starve.
    fileParallelism: false,
  },
});
