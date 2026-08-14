import { describe, expect, it } from 'vitest';
import { CompletionStateMachine } from '../src/adapters/chatgpt/completion-state.js';

describe('completion state machine', () => {
  it('requires a new message, stopped generation, and stable text', () => {
    const machine = new CompletionStateMachine(1, 3);
    expect(machine.observe({ assistantCount: 1, text: 'old', generating: false })).toBe('waiting');
    expect(machine.observe({ assistantCount: 2, text: 'hel', generating: true })).toBe('waiting');
    expect(machine.observe({ assistantCount: 2, text: 'hello', generating: false })).toBe(
      'waiting',
    );
    expect(machine.observe({ assistantCount: 2, text: 'hello', generating: false })).toBe(
      'waiting',
    );
    expect(machine.observe({ assistantCount: 2, text: 'hello', generating: false })).toBe(
      'complete',
    );
  });

  it('resets stability when text changes', () => {
    const machine = new CompletionStateMachine(0, 2);
    expect(machine.observe({ assistantCount: 1, text: 'a', generating: false })).toBe('waiting');
    expect(machine.observe({ assistantCount: 1, text: 'ab', generating: false })).toBe('waiting');
    expect(machine.observe({ assistantCount: 1, text: 'ab', generating: false })).toBe('complete');
  });
});
