import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { classifyDocument, extractLatestAssistant } from '../src/adapters/chatgpt/dom.js';

function fixture(name: string): Document {
  const html = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  return parseHTML(html).document;
}

describe('ChatGPT DOM fixtures', () => {
  it.each(['chatgpt-ready-v1.html', 'chatgpt-ready-v2.html'])(
    'detects ready UI variant %s',
    (name) => {
      expect(classifyDocument(fixture(name))).toBe('ready');
    },
  );
  it('extracts multiline assistant text', () => {
    expect(extractLatestAssistant(fixture('chatgpt-ready-v2.html'))).toBe('Answer\\nwith code');
  });
  it.each([
    ['chatgpt-login.html', 'login_required'],
    ['chatgpt-challenge.html', 'security_challenge'],
    ['chatgpt-rate-limit.html', 'rate_limited'],
  ] as const)('classifies %s as %s', (name, state) => {
    expect(classifyDocument(fixture(name))).toBe(state);
  });
  it('reports unknown markup as UI changed', () => {
    expect(classifyDocument(parseHTML('<main>unknown</main>').document)).toBe('ui_changed');
  });
});
