import path from 'node:path';
import { config as loadDotEnv } from 'dotenv';
import { z } from 'zod';
import {
  assertLoopbackHost,
  assertLoopbackCdpEndpoint,
  resolveSafeDataPaths,
} from '../security/paths.js';
import { loadOrCreateToken } from '../security/token.js';

const booleanValue = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');
const integer = (minimum: number, maximum: number) =>
  z.coerce.number().int().min(minimum).max(maximum);

const environmentSchema = z.object({
  TAB2API_HOST: z.string().default('127.0.0.1'),
  TAB2API_PORT: integer(1, 65535).default(3210),
  TAB2API_API_TOKEN: z.string().min(24).optional(),
  TAB2API_DATA_DIR: z.string().min(1).default('.tab2api'),
  TAB2API_PROFILE_DIR: z.string().min(1).default(path.join('.tab2api', 'browser-profile')),
  TAB2API_HEADLESS: booleanValue,
  TAB2API_BROWSER_BACKEND: z.literal('playwright').default('playwright'),
  TAB2API_BROWSER_CDP_ENDPOINT: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().optional(),
  ),
  TAB2API_CONCURRENCY: integer(1, 4).default(1),
  TAB2API_QUEUE_CAPACITY: integer(1, 100).default(16),
  TAB2API_REQUEST_TIMEOUT_MS: integer(1_000, 600_000).default(120_000),
  TAB2API_IMAGE_TIMEOUT_MS: integer(30_000, 900_000).default(300_000),
  TAB2API_BODY_LIMIT_BYTES: integer(1_024, 1_048_576).default(262_144),
  TAB2API_MEDIA_LIMIT_BYTES: integer(1_048_576, 26_214_400).default(10_485_760),
  TAB2API_DEBUG: booleanValue,
  TAB2API_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export interface AppConfig {
  host: '127.0.0.1' | '::1';
  port: number;
  apiToken: string;
  dataDir: string;
  profileDir: string;
  artifactDir: string;
  headless: boolean;
  browserCdpEndpoint: string | undefined;
  concurrency: number;
  queueCapacity: number;
  requestTimeoutMs: number;
  imageTimeoutMs: number;
  bodyLimitBytes: number;
  mediaLimitBytes: number;
  debug: boolean;
  logLevel: string;
}

export async function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<AppConfig> {
  if (environment === process.env) loadDotEnv({ quiet: true });
  const parsed = environmentSchema.parse(environment);
  const host = assertLoopbackHost(parsed.TAB2API_HOST);
  const { dataDir, profileDir } = resolveSafeDataPaths(
    cwd,
    parsed.TAB2API_DATA_DIR,
    parsed.TAB2API_PROFILE_DIR,
  );
  const apiToken = await loadOrCreateToken(dataDir, parsed.TAB2API_API_TOKEN);
  return {
    host,
    port: parsed.TAB2API_PORT,
    apiToken,
    dataDir,
    profileDir,
    artifactDir: path.join(dataDir, 'debug-artifacts'),
    headless: parsed.TAB2API_HEADLESS,
    browserCdpEndpoint:
      parsed.TAB2API_BROWSER_CDP_ENDPOINT === undefined
        ? undefined
        : assertLoopbackCdpEndpoint(parsed.TAB2API_BROWSER_CDP_ENDPOINT),
    concurrency: parsed.TAB2API_CONCURRENCY,
    queueCapacity: parsed.TAB2API_QUEUE_CAPACITY,
    requestTimeoutMs: parsed.TAB2API_REQUEST_TIMEOUT_MS,
    imageTimeoutMs: parsed.TAB2API_IMAGE_TIMEOUT_MS,
    bodyLimitBytes: parsed.TAB2API_BODY_LIMIT_BYTES,
    mediaLimitBytes: parsed.TAB2API_MEDIA_LIMIT_BYTES,
    debug: parsed.TAB2API_DEBUG,
    logLevel: parsed.TAB2API_LOG_LEVEL,
  };
}
