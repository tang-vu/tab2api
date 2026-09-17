import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import {
  CHATGPT_IMAGE_RESERVE_TOKENS,
  CHATGPT_MAX_PROMPT_TOKENS,
  CHATGPT_PLATFORM_RESERVE_TOKENS,
  assertPromptWithinLimit,
  estimateTokens,
  promptBudget,
} from '../src/observability/tokens.js';

describe('o200k token estimation', () => {
  it('counts ordinary prose with the real tokenizer, not a byte ratio', () => {
    const count = estimateTokens('The quick brown fox jumps over the lazy dog.');
    expect(count).toBeGreaterThan(4);
    expect(count).toBeLessThan(20);
  });

  it('counts dense data honestly instead of dividing by four', () => {
    // Deterministic pseudo-random base64 holds far more tokens than a mergeable run of the
    // same length, which is exactly why a character ratio cannot stand in for a tokenizer.
    let seed = 42;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const dense = Array.from({ length: 4_096 }, () => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return alphabet[seed % alphabet.length];
    }).join('');
    const repeated = 'A'.repeat(4_096);
    expect(estimateTokens(dense)).toBeGreaterThan(estimateTokens(repeated));
    expect(estimateTokens(dense)).toBeGreaterThan(4_096 / 4);
  });

  it('handles emoji and combining sequences across chunk boundaries', () => {
    // Long enough to cross the 4,096-char chunk boundary with surrogate pairs straddling it.
    const text = 'a'.repeat(4_090) + '👨‍👩‍👧‍👦'.repeat(20) + ' tail';
    const count = estimateTokens(text);
    expect(count).toBeGreaterThan(estimateTokens('a'.repeat(4_090)));
    expect(Number.isInteger(count)).toBe(true);
  });

  it('returns zero for empty and undefined input', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });
});

describe('prompt budget', () => {
  it('adds the platform reserve and per-image reserves to the text count', () => {
    const budget = promptBudget('hello world', 2);
    expect(budget.textTokens).toBe(estimateTokens('hello world'));
    expect(budget.imageTokens).toBe(2 * CHATGPT_IMAGE_RESERVE_TOKENS);
    expect(budget.totalTokens).toBe(
      budget.textTokens + budget.imageTokens + CHATGPT_PLATFORM_RESERVE_TOKENS,
    );
  });

  it('rejects a serialized prompt above the configured ceiling before a tab opens', () => {
    // A mergeable run would compress under the ceiling, so the oversize prompt uses the
    // same deterministic dense data as the density test (~0.7 tokens per character).
    let seed = 42;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const denseBlock = Array.from({ length: 4_096 }, () => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return alphabet[seed % alphabet.length];
    }).join('');
    const oversized = denseBlock.repeat(150);
    expect(() => assertPromptWithinLimit(oversized, 0, CHATGPT_MAX_PROMPT_TOKENS)).toThrow(
      AppError,
    );
    expect(() => assertPromptWithinLimit(oversized, 0, CHATGPT_MAX_PROMPT_TOKENS)).toThrow(
      /104,000/,
    );
  });

  it('accepts a prompt that fits under the configured ceiling', () => {
    const budget = assertPromptWithinLimit('short prompt', 1, CHATGPT_MAX_PROMPT_TOKENS);
    expect(budget.imageTokens).toBe(CHATGPT_IMAGE_RESERVE_TOKENS);
  });
});
