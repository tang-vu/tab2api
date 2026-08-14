import type { Browser, BrowserContext, Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { GpmBrowserManager } from '../src/browser/gpm-manager.js';
import { testConfig } from './helpers.js';

const profileId = '37f783ac-2635-4d53-ab8d-a300c790ecdc';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function started(endpoint = 'ws://127.0.0.1:40444/devtools/browser/test') {
  return {
    success: true,
    data: {
      profile_id: profileId,
      remote_debugging_port: 40444,
      websocket_debugging_url: endpoint,
    },
    message: 'OK',
  };
}

describe('GPM Login browser manager', () => {
  it('starts exactly one configured profile and attaches to loopback CDP', async () => {
    const urls: string[] = [];
    const page = { close: async () => undefined } as unknown as Page;
    const context = { newPage: async () => page } as unknown as BrowserContext;
    let connectedEndpoint = '';
    const browser = {
      contexts: () => [context],
      isConnected: () => true,
      close: async () => undefined,
      on: () => browser,
    } as unknown as Browser;
    const manager = new GpmBrowserManager(
      testConfig({ browserBackend: 'gpm', gpmProfileId: profileId }),
      async (url) => {
        urls.push(url);
        return jsonResponse(started());
      },
      async (endpoint) => {
        connectedEndpoint = endpoint;
        return browser;
      },
    );

    expect(await manager.getPage()).toBe(page);
    expect(urls[0]).toBe(`http://127.0.0.1:9495/api/v1/profiles/start/${profileId}`);
    expect(connectedEndpoint).toBe('ws://127.0.0.1:40444/devtools/browser/test');
  });

  it('refuses a non-loopback DevTools endpoint', async () => {
    const manager = new GpmBrowserManager(
      testConfig({ browserBackend: 'gpm', gpmProfileId: profileId }),
      async () => jsonResponse(started('ws://192.168.1.5:40444/devtools/browser/test')),
    );
    await expect(manager.getPage()).rejects.toThrow(/non-loopback/);
  });

  it('returns a safe typed error when the local API is unavailable', async () => {
    const manager = new GpmBrowserManager(
      testConfig({ browserBackend: 'gpm', gpmProfileId: profileId }),
      async () => {
        throw new Error('connection details that must not escape');
      },
    );
    await expect(manager.getPage()).rejects.toMatchObject({
      code: 'browser_disconnected',
      message: 'The GPM Login Local API is unavailable.',
    });
  });

  it('checks a configured profile without requesting the profile list', async () => {
    const urls: string[] = [];
    const manager = new GpmBrowserManager(
      testConfig({ browserBackend: 'gpm', gpmProfileId: profileId }),
      async (url) => {
        urls.push(url);
        return jsonResponse({ success: true, data: { id: profileId }, message: 'OK' });
      },
    );
    await manager.checkApi();
    expect(urls).toEqual([`http://127.0.0.1:9495/api/v1/profiles/${profileId}`]);
  });

  it('stops only the configured profile during cleanup', async () => {
    const urls: string[] = [];
    const manager = new GpmBrowserManager(
      testConfig({ browserBackend: 'gpm', gpmProfileId: profileId }),
      async (url) => {
        urls.push(url);
        return jsonResponse({ success: true, data: null, message: 'OK' });
      },
    );
    await manager.close();
    expect(urls).toEqual([`http://127.0.0.1:9495/api/v1/profiles/stop/${profileId}`]);
  });
});
