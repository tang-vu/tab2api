import { describe, expect, it } from 'vitest';
import { chatSse, mapChatCompletion, mapResponse, responsesSse } from '../src/api/mappers.js';

describe('OpenAI response mapping', () => {
  it('maps chat without inventing model or token usage', () => {
    const response = mapChatCompletion('hello', 1_700_000_000_000);
    expect(response.model).toBe('chatgpt-web');
    expect(response.choices[0]?.message.content).toBe('hello');
    expect(response.usage.total_tokens).toBe(0);
    expect(response.tab2api.usage_available).toBe(false);
  });

  it('maps a completed Responses object with unavailable usage', () => {
    const response = mapResponse('hello');
    expect(response.output[0]?.content[0]?.text).toBe('hello');
    expect(response.usage).toBeNull();
  });

  it('terminates buffered SSE streams', () => {
    expect(chatSse(mapChatCompletion('x'))).toMatch(/data: \[DONE\]\n\n$/);
    const responseStream = responsesSse(mapResponse('x'));
    expect(responseStream).toContain('event: response.completed');
    expect(responseStream).toContain('"sequence_number":0');
    expect(responseStream).not.toContain('[DONE]');
  });
});
