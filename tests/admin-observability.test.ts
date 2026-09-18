import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildServer } from '../src/api/server.js';
import { AppError } from '../src/errors.js';
import { EventLog } from '../src/observability/events.js';
import { createLogger } from '../src/observability/logger.js';
import { MetricsRegistry } from '../src/observability/metrics.js';
import type {
  GenerateRequest,
  GenerateResult,
  ProviderDiagnostics,
} from '../src/provider.js';
import { FakeProvider } from '../src/testing/fake-provider.js';
import { testConfig } from './helpers.js';

const auth = { authorization: 'Bearer test-only-token-that-is-long-enough' };

class DiagnosticsProvider extends FakeProvider {
  constructor(
    private readonly diagnosticsPayload: ProviderDiagnostics | undefined,
  ) {
    super();
  }

  diagnostics(): ProviderDiagnostics {
    if (this.diagnosticsPayload === undefined) {
      return {
        state: this.state,
        fingerprint: undefined,
        capabilities: undefined,
        unsatisfiedContracts: [],
      };
    }
    return this.diagnosticsPayload;
  }
}

function server(
  provider: FakeProvider,
  dependencies: { events?: EventLog; metrics?: MetricsRegistry } = {},
) {
  return buildServer({
    config: testConfig(),
    provider,
    logger: createLogger('silent'),
    ...(dependencies.events === undefined ? {} : { events: dependencies.events }),
    ...(dependencies.metrics === undefined ? {} : { metrics: dependencies.metrics }),
  });
}

describe('admin observability surfaces', () => {
  beforeAll(async () => {
    await server(new FakeProvider()).close();
  }, 60_000);

  it('protects the metrics and diagnostics routes', async () => {
    const app = server(new FakeProvider());
    for (const url of ['/admin/metrics', '/admin/diagnostics']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      const response = await app.inject({ method: 'GET', url, headers: auth });
      expect(response.statusCode, url).toBe(200);
    }
    await app.close();
  });

  it('reports bounded counters and queue state on /admin/metrics', async () => {
    const metrics = new MetricsRegistry();
    metrics.increment('turns.started');
    metrics.recordError('ui_changed');
    const app = server(new FakeProvider(), { metrics });
    const response = await app.inject({ method: 'GET', url: '/admin/metrics', headers: auth });
    const body = z
      .object({
        counters: z.record(z.string(), z.number()),
        errorsByCode: z.record(z.string(), z.number()),
        queue: z.object({ pending: z.number(), active: z.number(), draining: z.boolean() }),
        uptimeMs: z.number(),
      })
      .parse(response.json());
    expect(body.counters['turns.started']).toBe(1);
    expect(body.errorsByCode.ui_changed).toBe(1);
    expect(body.queue).toMatchObject({ pending: 0, active: 0, draining: false });
    expect(typeof body.uptimeMs).toBe('number');
    await app.close();
  });

  it('surfaces provider diagnostics and the event log on /admin/diagnostics', async () => {
    const events = new EventLog();
    events.record('browser.reset');
    const provider = new DiagnosticsProvider({
      state: 'ready',
      fingerprint: { capturedAt: '2025-01-01T00:00:00.000Z', contracts: {} },
      capabilities: { chat: 'observed' },
      unsatisfiedContracts: ['composer'],
    });
    const app = server(provider, { events });
    const response = await app.inject({
      method: 'GET',
      url: '/admin/diagnostics',
      headers: auth,
    });
    const body = z
      .object({
        session: z.string(),
        provider: z.object({
          unsatisfiedContracts: z.array(z.string()),
          fingerprint: z.object({ capturedAt: z.string() }),
        }),
        events: z.array(z.object({ type: z.string() })),
      })
      .parse(response.json());
    expect(body.session).toBe('ready');
    expect(body.provider.unsatisfiedContracts).toEqual(['composer']);
    expect(body.provider.fingerprint.capturedAt).toBe('2025-01-01T00:00:00.000Z');
    expect(body.events.map((event) => event.type)).toContain('browser.reset');
    await app.close();
  });

  it('falls back to a minimal provider report when diagnostics are unavailable', async () => {
    const app = server(new FakeProvider());
    const response = await app.inject({
      method: 'GET',
      url: '/admin/diagnostics',
      headers: auth,
    });
    expect(response.json()).toMatchObject({
      provider: { state: 'ready', unsatisfiedContracts: [] },
    });
    await app.close();
  });

  it('records request error metrics without logging content', async () => {
    const metrics = new MetricsRegistry();
    const events = new EventLog();
    const provider = new FakeProvider();
    provider.generate = async (_request: GenerateRequest): Promise<GenerateResult> => {
      throw new AppError('rate_limited', 'simulated rate limit');
    };
    const app = server(provider, { metrics, events });
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { model: 'tab2api', messages: [{ role: 'user', content: 'secret prompt' }] },
    });
    const snapshot = metrics.snapshot();
    expect(snapshot.errorsByCode.rate_limited).toBe(1);
    const eventDetails = JSON.stringify(events.list());
    expect(eventDetails).toContain('request.error');
    expect(eventDetails).not.toContain('secret prompt');
    await app.close();
  });

  it('records drain, resume, and reset lifecycle events', async () => {
    const events = new EventLog();
    const app = server(new FakeProvider(), { events });
    await app.inject({ method: 'POST', url: '/admin/drain', headers: auth });
    await app.inject({ method: 'POST', url: '/admin/resume', headers: auth });
    await app.inject({ method: 'POST', url: '/admin/session/reset', headers: auth });
    const types = events.list().map((event) => event.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'queue.draining',
        'queue.resumed',
        'browser.reset',
      ]),
    );
    await app.close();
  });
});
