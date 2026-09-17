import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/manual/**'],
    // The first Fastify instantiation in a worker compiles its schema machinery, which can
    // cost tens of seconds on slow disks/AV-scanned checkouts; thirty seconds still bounds
    // a genuinely hung test while keeping that cold-start cost from reading as a failure.
    testTimeout: 30_000,
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
