import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/manual/**'],
    coverage: { reporter: ['text', 'json-summary'], exclude: ['src/cli/**'] },
  },
});
