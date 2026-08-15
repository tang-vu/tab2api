import { describe, expect, it } from 'vitest';
import {
  chatCompletionRequestSchema,
  imageGenerationRequestSchema,
  responsesRequestSchema,
  speechRequestSchema,
} from '../src/api/schemas.js';

const pixel =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

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

  it('accepts data-URL vision and rejects remote images', () => {
    expect(
      chatCompletionRequestSchema.parse({
        model: 'chatgpt-web',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'describe' },
              { type: 'image_url', image_url: { url: pixel } },
            ],
          },
        ],
      }),
    ).toBeDefined();
    expect(() =>
      chatCompletionRequestSchema.parse({
        model: 'chatgpt-web',
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'https://example.com/private.png' } }],
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects unknown fields', () => {
    expect(() =>
      chatCompletionRequestSchema.parse({
        model: 'chatgpt-web',
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 0.5,
      }),
    ).toThrow();
  });

  it('validates the supported image and speech subsets', () => {
    expect(imageGenerationRequestSchema.parse({ prompt: 'a blue square' }).n).toBe(1);
    expect(
      speechRequestSchema.parse({ model: 'tts-1', input: 'hello', voice: 'alloy' }).speed,
    ).toBe(1);
    expect(() =>
      speechRequestSchema.parse({
        model: 'tts-1',
        input: 'hello',
        voice: 'alloy',
        response_format: 'mp3',
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
