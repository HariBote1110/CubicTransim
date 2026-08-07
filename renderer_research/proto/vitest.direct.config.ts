import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['renderer_research/proto/bench/**/*.test.ts'],
  },
});
