import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/manual/**/*.test.ts'], testTimeout: 180_000 },
});
