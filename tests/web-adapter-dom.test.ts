import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { WEB_UI_DEFINITIONS } from '../src/adapters/web/definitions.js';
import { inspectWebDocument } from '../src/adapters/web/dom.js';

function fixture(html: string): Document {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  // linkedom has no layout engine. This synthetic geometry models only hidden/display
  // fixture variants; no browser, provider connection, or account is involved.
  Object.defineProperty(document.defaultView, 'getComputedStyle', {
    configurable: true,
    value: (element: Element) => ({
      display: element.getAttribute('style')?.includes('display:none') ? 'none' : 'block',
      visibility: 'visible',
    }),
  });
  for (const element of document.querySelectorAll('*')) {
    Object.defineProperty(element, 'getClientRects', { value: () => [1] });
  }
  return document;
}

const composerHtml = {
  'claude-web':
    '<div class="ProseMirror" role="textbox" contenteditable="true"></div><button aria-label="Send message"></button>',
  'grok-web':
    '<textarea aria-label="Ask Grok anything"></textarea><button aria-label="Submit"></button>',
} as const;

for (const id of ['claude-web', 'grok-web'] as const) {
  const definition = WEB_UI_DEFINITIONS[id];
  const inspect = (html: string) => inspectWebDocument({ document: fixture(html), definition });
  describe(`${id} synthetic public DOM contract (not live verified)`, () => {
    it('serializes into an isolated page context without imported helpers', () => {
      const observed: unknown = runInNewContext(
        `(${inspectWebDocument.toString()})({ definition })`,
        {
          document: fixture(composerHtml[id]),
          definition,
        },
      );
      expect(observed).toMatchObject({ state: 'ready', composerCount: 1 });
    });

    it('deduplicates overlapping composer selectors and reads empty ready UI', () => {
      const snapshot = inspect(composerHtml[id]);
      expect(snapshot).toMatchObject({
        state: 'ready',
        composerCount: 1,
        composerEmpty: true,
        sendCount: 1,
      });
    });

    it('ignores hidden alternative composers and disabled send controls', () => {
      const snapshot = inspect(
        `${composerHtml[id]}<div hidden><div role="textbox" contenteditable="true"></div></div>`,
      );
      expect(snapshot.composerCount).toBe(1);
      expect(inspect(composerHtml[id].replace('<button ', '<button disabled ')).sendEnabled).toBe(
        false,
      );
    });

    it('rejects duplicate visible composers and unknown markup', () => {
      expect(inspect(composerHtml[id] + composerHtml[id]).state).toBe('ui_changed');
      expect(inspect('<main>New layout</main>').state).toBe('ui_changed');
    });

    it.each([
      ['<input type="password">', 'login_required'],
      ['<div id="challenge-running"></div>', 'security_challenge'],
      ['<iframe src="https://challenges.cloudflare.com/test"></iframe>', 'security_challenge'],
      ['<div role="alert">Verify you are human</div>', 'security_challenge'],
      ['<div data-testid="rate-limit"></div>', 'rate_limited'],
      ['<div role="alert">Too many requests</div>', 'rate_limited'],
      ['<div data-testid="generation-error">Provider error</div>', 'ui_changed'],
      ['<div role="alert">Something went wrong</div>', 'ui_changed'],
      ['<div role="alert">Unexpected backend response</div>', 'ui_changed'],
      ['<button aria-label="Stop response"></button>', 'generation_in_progress'],
    ] as const)('classifies %s safely', (markup, state) => {
      expect(inspect(composerHtml[id] + markup).state).toBe(state);
    });

    it('does not classify ordinary assistant text as challenge or rate-limit UI', () => {
      expect(
        inspect(
          `${composerHtml[id]}<div data-testid="assistant-message" data-message-id="answer-1" data-state="complete">Explain rate limits and verify you are human phrases</div>`,
        ).state,
      ).toBe('ready');
    });

    it('extracts public assistant identity and explicit ended evidence', () => {
      const snapshot = inspect(
        `${composerHtml[id]}<div data-testid="assistant-message" data-message-id="answer-1" data-state="complete"><p>Hello</p><button aria-label="Copy response"></button></div>`,
      );
      expect(snapshot.turns).toEqual([
        { id: 'answer-1', text: 'Hello', pending: false, ended: true, completionAction: true },
      ]);
    });

    it('preserves paragraphs and excludes assistant control labels from response text', () => {
      const observation = inspect(
        `${composerHtml[id]}<div data-testid="assistant-message" id="answer"><p>First <strong>paragraph</strong></p><p>Second<br>line</p><button aria-label="Copy response">Copy</button></div>`,
      );
      expect(observation.turns[0]?.text).toBe('First paragraph\nSecond\nline');
    });

    it('bounds the total serialized transcript text rather than each message alone', () => {
      const chunk = 'x'.repeat(Math.floor(definition.maxTextChars / 2) + 1);
      const observation = inspect(
        `${composerHtml[id]}<div data-testid="assistant-message" id="a">${chunk}</div><div data-testid="assistant-message" id="b">${chunk}</div>`,
      );
      expect(observation.invalid).toBe(true);
      expect(
        observation.turns.reduce((total, turn) => total + turn.text.length, 0),
      ).toBeLessThanOrEqual(definition.maxTextChars);
    });

    it('treats pending answer markers as active even without a stop button', () => {
      expect(
        inspect(
          `${composerHtml[id]}<div data-testid="assistant-message" data-turn-id="turn_1" data-is-streaming="true">Working</div>`,
        ).state,
      ).toBe('generation_in_progress');
    });

    it.each(['', 'unsafe id', 'x'.repeat(129)])(
      'rejects missing or unsafe assistant identity %s',
      (turnId) => {
        expect(
          inspect(
            `${composerHtml[id]}<div data-testid="assistant-message" data-message-id="${turnId}">Answer</div>`,
          ),
        ).toMatchObject({ invalid: true, state: 'ui_changed' });
      },
    );

    it('rejects duplicate logical identities, oversized text and observation counts', () => {
      const turn = '<div data-testid="assistant-message" data-message-id="duplicate">Answer</div>';
      expect(inspect(composerHtml[id] + turn + turn).invalid).toBe(true);
      expect(
        inspect(
          `${composerHtml[id]}<div data-testid="assistant-message" id="answer">${'x'.repeat(definition.maxTextChars + 1)}</div>`,
        ).invalid,
      ).toBe(true);
      expect(
        inspect(
          composerHtml[id] +
            '<div data-role="user" data-testid="user-message"></div>'.repeat(
              definition.maxElements + 1,
            ),
        ).invalid,
      ).toBe(true);
    });

    it('bounds deeply fragmented text traversal and status text', () => {
      const snapshot = inspect(
        `${composerHtml[id]}<div data-testid="assistant-message" id="answer">${'<span>x</span>'.repeat(4_097)}</div><div role="alert">${'x'.repeat(definition.maxStatusChars + 1)}</div>`,
      );
      expect(snapshot.invalid).toBe(true);
      expect(snapshot.turns[0]?.text.length).toBeLessThanOrEqual(4_096);
    });

    it('rejects disabled composers and ignores non-visible markers', () => {
      const disabled = composerHtml[id]
        .replace('role="textbox"', 'role="textbox" aria-disabled="true"')
        .replace('<textarea ', '<textarea disabled ');
      expect(inspect(disabled).state).toBe('ui_changed');
      expect(
        inspect(`${composerHtml[id]}<div data-testid="rate-limit" style="display:none"></div>`)
          .state,
      ).toBe('ready');
    });
  });
}
