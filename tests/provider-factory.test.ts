import { describe, expect, it, vi } from 'vitest';
import { createProvider } from '../src/providers/factory.js';
import { createLogger } from '../src/observability/logger.js';
import { testConfig } from './helpers.js';

function browser() {
  return {
    getPage: vi.fn().mockRejectedValue(new Error('No live browser in tests')),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('provider factory', () => {
  it('constructs the unchanged default without opening a browser', () => {
    const controller = browser();
    expect(createProvider(controller, testConfig(), createLogger('silent')).id).toBe('chatgpt-web');
    expect(controller.getPage).not.toHaveBeenCalled();
  });

  it.each(['claude-web', 'grok-web'] as const)('only creates opted-in %s', (id) => {
    const controller = browser();
    expect(() =>
      createProvider(controller, testConfig({ provider: id }), createLogger('silent')),
    ).toThrow(/disabled/);
    expect(
      createProvider(
        controller,
        testConfig({ provider: id, experimentalProviders: true, providerPermission: id }),
        createLogger('silent'),
      ).id,
    ).toBe(id);
    expect(controller.getPage).not.toHaveBeenCalled();
  });
});
