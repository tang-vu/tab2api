import type { Browser, BrowserContext, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { CdpBrowserManager } from '../src/browser/cdp-manager.js';
import { createBrowserController } from '../src/browser/factory.js';
import { BrowserManager } from '../src/browser/manager.js';
import { testConfig } from './helpers.js';

interface FakePage {
  close: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
}

function fakePage(): FakePage {
  return {
    close: vi.fn(async () => undefined),
    once: vi.fn(),
  };
}

describe('app-managed browser CDP connection', () => {
  it('keeps persistent-context pages untouched and owns only fresh request tabs', async () => {
    const existing = fakePage();
    const requestPage = fakePage();
    const newPage = vi.fn(async () => requestPage as unknown as Page);
    const context = {
      pages: () => [existing],
      newPage,
    } as unknown as BrowserContext;
    const listeners = new Map<string, () => void>();
    const browserClose = vi.fn(async () => undefined);
    const browser = {
      contexts: () => [context],
      isConnected: () => true,
      once: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
      close: browserClose,
    } as unknown as Browser;
    const connect = vi.fn(async () => browser);
    const manager = new CdpBrowserManager(
      testConfig({ browserCdpEndpoint: 'http://127.0.0.1:54321' }),
      connect,
    );

    expect(await manager.getPage()).toBe(requestPage);
    expect(newPage).toHaveBeenCalledOnce();
    expect(existing.close).not.toHaveBeenCalled();
    await manager.close();
    expect(requestPage.close).toHaveBeenCalledOnce();
    expect(existing.close).not.toHaveBeenCalled();
    expect(browserClose).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith('http://127.0.0.1:54321');
  });

  it('deduplicates concurrent attachment and reconnects once after disconnection', async () => {
    const firstPage = fakePage();
    const secondPage = fakePage();
    const thirdPage = fakePage();
    const newPage = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage)
      .mockResolvedValueOnce(thirdPage);
    const context = {
      newPage,
    } as unknown as BrowserContext;
    let disconnected: (() => void) | undefined;
    const browser = {
      contexts: () => [context],
      isConnected: () => true,
      once: vi.fn((_event: string, listener: () => void) => {
        disconnected = listener;
      }),
      close: vi.fn(async () => undefined),
    } as unknown as Browser;
    const connect = vi.fn(async () => browser);
    const manager = new CdpBrowserManager(
      testConfig({ browserCdpEndpoint: 'http://127.0.0.1:54321' }),
      connect,
    );

    await Promise.all([manager.getPage(), manager.getPage()]);
    expect(connect).toHaveBeenCalledOnce();
    disconnected?.();
    await manager.getPage();
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('returns a typed redacted error and cleans a connection without a context', async () => {
    const browserClose = vi.fn(async () => undefined);
    const browser = {
      contexts: () => [],
      close: browserClose,
    } as unknown as Browser;
    const manager = new CdpBrowserManager(
      testConfig({ browserCdpEndpoint: 'http://127.0.0.1:54321' }),
      async () => browser,
    );

    await expect(manager.getPage()).rejects.toMatchObject({ code: 'browser_disconnected' });
    expect(browserClose).toHaveBeenCalledOnce();
  });

  it('does not create a request tab when shutdown races with CDP attachment', async () => {
    const newPage = vi.fn();
    const context = { newPage } as unknown as BrowserContext;
    const browserClose = vi.fn(async () => undefined);
    const browser = {
      contexts: () => [context],
      isConnected: () => true,
      once: vi.fn(),
      close: browserClose,
    } as unknown as Browser;
    let finishConnect: ((browser: Browser) => void) | undefined;
    const connection = new Promise<Browser>((resolve) => {
      finishConnect = resolve;
    });
    const manager = new CdpBrowserManager(
      testConfig({ browserCdpEndpoint: 'http://127.0.0.1:54321' }),
      () => connection,
    );

    const page = manager.getPage();
    const closing = manager.close();
    finishConnect?.(browser);

    await expect(page).rejects.toMatchObject({ code: 'browser_disconnected' });
    await closing;
    expect(newPage).not.toHaveBeenCalled();
    expect(browserClose).toHaveBeenCalledOnce();
  });

  it('keeps launchPersistentContext as the default Playwright controller', () => {
    expect(createBrowserController(testConfig())).toBeInstanceOf(BrowserManager);
    expect(
      createBrowserController(testConfig({ browserCdpEndpoint: 'http://127.0.0.1:54321' })),
    ).toBeInstanceOf(CdpBrowserManager);
  });
});
