import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';

const token = 'this-is-a-test-token-with-32-characters';

describe('configuration security', () => {
  it('accepts loopback with a profile inside the data directory', async () => {
    const config = await loadConfig(
      {
        TAB2API_API_TOKEN: token,
        TAB2API_DATA_DIR: '.runtime',
        TAB2API_PROFILE_DIR: '.runtime/profile',
      },
      'C:\\work\\tab2api',
    );
    expect(config.host).toBe('127.0.0.1');
    expect(config.profileDir.startsWith(config.dataDir)).toBe(true);
  });

  it.each(['0.0.0.0', '192.168.1.10', 'localhost', '::'])(
    'rejects non-explicit-loopback host %s',
    async (host) => {
      await expect(
        loadConfig(
          {
            TAB2API_API_TOKEN: token,
            TAB2API_HOST: host,
            TAB2API_DATA_DIR: '.runtime',
            TAB2API_PROFILE_DIR: '.runtime/profile',
          },
          'C:\\work\\tab2api',
        ),
      ).rejects.toThrow(/127\.0\.0\.1/);
    },
  );

  it('rejects profile traversal outside the data directory', async () => {
    await expect(
      loadConfig(
        {
          TAB2API_API_TOKEN: token,
          TAB2API_DATA_DIR: '.runtime',
          TAB2API_PROFILE_DIR: '..\\personal-profile',
        },
        'C:\\work\\tab2api',
      ),
    ).rejects.toThrow(/inside TAB2API_DATA_DIR/);
  });

  it('requires one explicit profile ID for the GPM backend', async () => {
    await expect(
      loadConfig(
        {
          TAB2API_API_TOKEN: token,
          TAB2API_BROWSER_BACKEND: 'gpm',
          TAB2API_DATA_DIR: '.runtime',
          TAB2API_PROFILE_DIR: '.runtime/profile',
        },
        'C:\\work\\tab2api',
      ),
    ).rejects.toThrow(/GPM_PROFILE_ID/);
  });

  it('rejects a non-loopback GPM Local API', async () => {
    await expect(
      loadConfig(
        {
          TAB2API_API_TOKEN: token,
          TAB2API_BROWSER_BACKEND: 'gpm',
          TAB2API_GPM_PROFILE_ID: '37f783ac-2635-4d53-ab8d-a300c790ecdc',
          TAB2API_GPM_BASE_URL: 'http://192.168.1.10:9495/api/v1',
          TAB2API_DATA_DIR: '.runtime',
          TAB2API_PROFILE_DIR: '.runtime/profile',
        },
        'C:\\work\\tab2api',
      ),
    ).rejects.toThrow(/loopback/);
  });

  it('accepts a single GPM profile on a loopback Local API', async () => {
    const config = await loadConfig(
      {
        TAB2API_API_TOKEN: token,
        TAB2API_BROWSER_BACKEND: 'gpm',
        TAB2API_GPM_PROFILE_ID: '37f783ac-2635-4d53-ab8d-a300c790ecdc',
        TAB2API_GPM_BASE_URL: 'http://127.0.0.1:9495/api/v1/',
        TAB2API_DATA_DIR: '.runtime',
        TAB2API_PROFILE_DIR: '.runtime/profile',
      },
      'C:\\work\\tab2api',
    );
    expect(config.browserBackend).toBe('gpm');
    expect(config.gpmBaseUrl).toBe('http://127.0.0.1:9495/api/v1');
  });

  it('accepts bounded browser concurrency and rejects unsafe values', async () => {
    const base = {
      TAB2API_API_TOKEN: token,
      TAB2API_DATA_DIR: '.runtime',
      TAB2API_PROFILE_DIR: '.runtime/profile',
    };
    await expect(
      loadConfig({ ...base, TAB2API_CONCURRENCY: '2' }, 'C:\\work\\tab2api'),
    ).resolves.toMatchObject({ concurrency: 2 });
    await expect(
      loadConfig({ ...base, TAB2API_CONCURRENCY: '5' }, 'C:\\work\\tab2api'),
    ).rejects.toThrow();
  });

  it.each(['http://127.0.0.1:54321', 'http://[::1]:54321'])(
    'accepts an explicit loopback-only desktop CDP endpoint %s',
    async (endpoint) => {
      await expect(
        loadConfig(
          {
            TAB2API_API_TOKEN: token,
            TAB2API_DATA_DIR: '.runtime',
            TAB2API_PROFILE_DIR: '.runtime/profile',
            TAB2API_BROWSER_CDP_ENDPOINT: endpoint,
          },
          'C:\\work\\tab2api',
        ),
      ).resolves.toMatchObject({ browserCdpEndpoint: endpoint });
    },
  );

  it.each([
    'http://0.0.0.0:54321',
    'http://localhost:54321',
    'http://192.168.1.20:54321',
    'https://127.0.0.1:54321',
    'http://127.0.0.1:54321/json/version',
    'http://user:password@127.0.0.1:54321',
    'http://127.0.0.1',
  ])('rejects unsafe or ambiguous desktop CDP endpoint %s', async (endpoint) => {
    await expect(
      loadConfig(
        {
          TAB2API_API_TOKEN: token,
          TAB2API_DATA_DIR: '.runtime',
          TAB2API_PROFILE_DIR: '.runtime/profile',
          TAB2API_BROWSER_CDP_ENDPOINT: endpoint,
        },
        'C:\\work\\tab2api',
      ),
    ).rejects.toThrow(/CDP endpoint/);
  });

  it('rejects combining a desktop CDP endpoint with GPM', async () => {
    await expect(
      loadConfig(
        {
          TAB2API_API_TOKEN: token,
          TAB2API_BROWSER_BACKEND: 'gpm',
          TAB2API_GPM_PROFILE_ID: '37f783ac-2635-4d53-ab8d-a300c790ecdc',
          TAB2API_BROWSER_CDP_ENDPOINT: 'http://127.0.0.1:54321',
          TAB2API_DATA_DIR: '.runtime',
          TAB2API_PROFILE_DIR: '.runtime/profile',
        },
        'C:\\work\\tab2api',
      ),
    ).rejects.toThrow(/cannot be combined/);
  });

  it('bounds media bytes and permits a longer image timeout', async () => {
    const base = {
      TAB2API_API_TOKEN: token,
      TAB2API_DATA_DIR: '.runtime',
      TAB2API_PROFILE_DIR: '.runtime/profile',
      TAB2API_IMAGE_TIMEOUT_MS: '300000',
    };
    await expect(loadConfig(base, 'C:\\work\\tab2api')).resolves.toMatchObject({
      imageTimeoutMs: 300_000,
      mediaLimitBytes: 10_485_760,
    });
    await expect(
      loadConfig({ ...base, TAB2API_MEDIA_LIMIT_BYTES: '999999999' }, 'C:\\work\\tab2api'),
    ).rejects.toThrow();
  });
});
