import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { loggerOptions } from '../src/observability/logger.js';

describe('structured log redaction', () => {
  it('redacts authorization, local token, prompt, and response', async () => {
    let output = '';
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = pino(loggerOptions('info'), destination);
    logger.info({
      req: {
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { authorization: 'Bearer secret-auth' },
      },
      authorization: 'Bearer secret-auth',
      apiToken: 'secret-token',
      clientSecret: 'secret-cloudflare-access',
      digest: 'secret-key-digest',
      prompt: 'secret-prompt',
      response: 'secret-response',
    });
    await new Promise((resolve) => destination.end(resolve));
    expect(output).not.toContain('secret-auth');
    expect(output).not.toContain('secret-token');
    expect(output).not.toContain('secret-prompt');
    expect(output).not.toContain('secret-response');
    expect(output).not.toContain('secret-cloudflare-access');
    expect(output).not.toContain('secret-key-digest');
    expect(output).toContain('[REDACTED]');
  });
});
