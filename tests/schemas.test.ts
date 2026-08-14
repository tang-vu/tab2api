import { describe, expect, it } from 'vitest';
import { chatCompletionRequestSchema, responsesRequestSchema } from '../src/api/schemas.js';

describe('API schemas', () => {
  it('accepts supported text chat messages', () => {
    const result = chatCompletionRequestSchema.parse({
      model: 'client-alias',
      messages: [
        { role: 'system', content: 'rules' },
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      ],
    });
    expect(result.stream).toBe(false);
  });

  it('rejects unknown fields and unsupported multimodal content', () => {
    expect(() =>
      chatCompletionRequestSchema.parse({
        model: 'chatgpt-web',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: 'x' }] }],
        tools: [],
      }),
    ).toThrow();
    expect(() =>
      chatCompletionRequestSchema.parse({
        model: 'chatgpt-web',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.5,
      }),
    ).toThrow();
  });

  it('validates Responses string and message inputs', () => {
    expect(responsesRequestSchema.parse({ model: 'x', input: 'hello' }).input).toBe('hello');
    expect(() =>
      responsesRequestSchema.parse({ model: 'x', input: [{ role: 'user', content: [] }] }),
    ).toThrow();
  });
});
