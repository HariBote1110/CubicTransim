import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['renderer/bench/**/*.test.ts'],
  },
});
