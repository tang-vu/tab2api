import type { AppConfig } from '../src/config/index.js';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: '127.0.0.1',
    port: 3210,
    apiToken: 'test-only-token-that-is-long-enough',
    dataDir: 'C:\\tmp\\tab2api-test',
    profileDir: 'C:\\tmp\\tab2api-test\\browser-profile',
    artifactDir: 'C:\\tmp\\tab2api-test\\debug-artifacts',
    headless: true,
    browserBackend: 'playwright',
    gpmProfileId: undefined,
    gpmBaseUrl: 'http://127.0.0.1:9495/api/v1',
    queueCapacity: 16,
    requestTimeoutMs: 2_000,
    bodyLimitBytes: 262_144,
    debug: false,
    logLevel: 'silent',
    ...overrides,
  };
}
