import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { collectTurnIds, isTurnIdSafe, selectNewTurnId } from '../src/adapters/chatgpt/dom.js';

function document(html: string): Document {
  return parseHTML(`<main>${html}</main>`).document;
}

describe('logical turn binding', () => {
  it('collects data-turn-id values in DOM order', () => {
    const doc = document(
      '<article data-turn-id="t1"></article><article data-turn-id="t2"></article>',
    );
    expect(collectTurnIds(doc)).toEqual(['t1', 't2']);
  });

  it('ignores elements with empty turn ids', () => {
    const doc = document('<article data-turn-id=""></article><article></article>');
    expect(collectTurnIds(doc)).toEqual([]);
  });

  it('binds the newest id absent from the baseline', () => {
    const binding = selectNewTurnId(new Set(['t1']), ['t1', 't2', 't3']);
    expect(binding).toEqual({ kind: 'bound', id: 't3' });
  });

  it('binds the only turn of a fresh conversation', () => {
    expect(selectNewTurnId(new Set(), ['t1'])).toEqual({ kind: 'bound', id: 't1' });
  });

  it('stays unbound while virtualized history remounts known ids', () => {
    expect(selectNewTurnId(new Set(['t1', 't2']), ['t1', 't2'])).toEqual({ kind: 'none' });
  });

  it('refuses to bind an id rendered on more than one element', () => {
    const binding = selectNewTurnId(new Set(), ['t1', 't2', 't2']);
    expect(binding).toEqual({ kind: 'ambiguous', id: 't2' });
  });

  it('accepts only charset-safe ids for selector interpolation', () => {
    expect(isTurnIdSafe('turn-abc_123')).toBe(true);
    expect(isTurnIdSafe('a b')).toBe(false);
    expect(isTurnIdSafe('a".x')).toBe(false);
    expect(isTurnIdSafe('')).toBe(false);
    expect(isTurnIdSafe('x'.repeat(129))).toBe(false);
  });
});
