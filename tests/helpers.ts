import type { AppConfig } from '../src/config/index.js';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    provider: 'chatgpt-web',
    enablePaidApi: false,
    providerApiKey: undefined,
    providerApiModel: undefined,
    providerApiMaxOutputTokens: 4096,
    experimentalProviders: false,
    providerPermission: undefined,
    host: '127.0.0.1',
    port: 3210,
    apiToken: 'test-only-token-that-is-long-enough',
    dataDir: 'C:\\tmp\\tab2api-test',
    profileDir: 'C:\\tmp\\tab2api-test\\browser-profile',
    artifactDir: 'C:\\tmp\\tab2api-test\\debug-artifacts',
    headless: true,
    browserCdpEndpoint: undefined,
    concurrency: 1,
    queueCapacity: 16,
    requestTimeoutMs: 2_000,
    imageTimeoutMs: 5_000,
    bodyLimitBytes: 262_144,
    mediaLimitBytes: 10_485_760,
    temporaryChat: false,
    maxPromptTokens: 104_000,
    debug: false,
    logLevel: 'silent',
    ...overrides,
  };
}
