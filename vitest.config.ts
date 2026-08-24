import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/manual/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary'],
      reportOnFailure: true,
      thresholds: {
        statements: 68,
        branches: 63,
        functions: 73,
        lines: 71,
        'src/api/**/*.ts': {
          statements: 80,
          branches: 65,
          functions: 90,
          lines: 85,
        },
        'src/security/**/*.ts': {
          statements: 85,
          branches: 77,
          functions: 90,
          lines: 89,
        },
        'src/store/**/*.ts': {
          statements: 85,
          branches: 85,
          functions: 85,
          lines: 85,
        },
      },
    },
  },
});
