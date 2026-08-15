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

  it('never accepts a turn that still carries a working marker', () => {
    // ChatGPT renders the copy action before the answer exists and shows a status line such
    // as "Analyzing image". Without the pending flag that line is stable enough to be
    // returned to the client as if it were the model's answer.
    const machine = new CompletionStateMachine(0, 2);
    const analysing = {
      assistantCount: 1,
      text: 'Đang phân tích ảnh',
      generating: false,
      completionActionAvailable: true,
      pending: true,
    } as const;
    expect(machine.observe(analysing)).toBe('waiting');
    expect(machine.observe(analysing)).toBe('waiting');
    expect(machine.observe(analysing)).toBe('waiting');

    // Once the marker clears, the real answer still has to hold steady on its own.
    const answered = {
      assistantCount: 1,
      text: '6',
      generating: false,
      completionActionAvailable: true,
      pending: false,
    } as const;
    expect(machine.observe(answered)).toBe('waiting');
    expect(machine.observe(answered)).toBe('complete');
  });

  it('accepts a new completion action when a stale stop control remains visible', () => {
    const machine = new CompletionStateMachine(0, 2);
    expect(
      machine.observe({
        assistantCount: 1,
        text: 'done',
        generating: true,
        completionActionAvailable: true,
      }),
    ).toBe('waiting');
    expect(
      machine.observe({
        assistantCount: 1,
        text: 'done',
        generating: true,
        completionActionAvailable: true,
      }),
    ).toBe('complete');
  });
});
