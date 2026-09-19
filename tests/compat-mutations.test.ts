import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import {
  observeChatDom,
  type DomObservation,
  type DomRoot,
} from '../src/adapters/chatgpt/observe-dom.js';
import { serializeContracts } from '../src/adapters/chatgpt/selector-contracts.js';

function fixture(name: string): Document {
  const html = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  return parseHTML(html).document;
}

function observe(
  root: DomRoot,
  options: Partial<Parameters<typeof observeChatDom>[1]> = {},
): DomObservation {
  return observeChatDom(root, {
    url: 'https://chatgpt.com/',
    contracts: serializeContracts(),
    ...options,
  });
}

function mustQuery(root: Document, selector: string): Element {
  const element = root.querySelector(selector);
  if (element === null) throw new Error(`fixture lost its ${selector} element`);
  return element;
}

describe('expanded DOM fixtures', () => {
  it('reads a generating turn as in-flight with a pending bound turn', () => {
    const observation = observe(fixture('chatgpt-generating.html'), {
      boundTurnId: 'turn-assistant-1',
    });
    expect(observation.session).toBe('generation_in_progress');
    expect(observation.stopVisible).toBe(true);
    expect(observation.turnIds).toEqual(['turn-user-1', 'turn-assistant-1']);
    expect(observation.assistant.pending).toBe(true);
    expect(observation.boundTurn?.pending).toBe(true);
  });

  it('reads a completed turn with final text and a completion action', () => {
    const observation = observe(fixture('chatgpt-complete-turn.html'), {
      boundTurnId: 'turn-assistant-1',
    });
    expect(observation.session).toBe('ready');
    expect(observation.boundTurn?.text).toBe('Hello!');
    expect(observation.boundTurn?.pending).toBe(false);
    expect(observation.boundTurn?.completionActions).toBe(1);
    expect(observation.completionActionCount).toBe(1);
  });

  it('collects temporary-chat evidence from the dedicated header', () => {
    const observation = observe(fixture('chatgpt-temporary-chat.html'));
    expect(observation.session).toBe('ready');
    expect(observation.temporaryChatEvidence).toBe(true);
  });

  it('counts project rows and the new-project control on the projects surface', () => {
    const observation = observe(fixture('chatgpt-projects.html'));
    expect(observation.projectRowCount).toBe(2);
    expect(observation.newProjectControl).toBe(true);
  });

  it('detects the effort control and its option surface', () => {
    const observation = observe(fixture('chatgpt-effort-composer.html'));
    expect(observation.session).toBe('ready');
    expect(observation.effortControlPresent).toBe(true);
    expect(observation.contracts.effortOption?.count).toBe(2);
  });

  it('reports a missing conversation only when the URL names one', () => {
    const doc = fixture('chatgpt-not-found.html');
    expect(observe(doc, { url: 'https://chatgpt.com/c/abc-123' }).missing).toBe(
      'conversation_not_found',
    );
    expect(observe(doc, { url: 'https://chatgpt.com/g/g-p-abc' }).missing).toBe(
      'project_not_found',
    );
    expect(observe(doc, { url: 'https://chatgpt.com/' }).missing).toBeUndefined();
  });

  it('counts the file input and attachment-ready markers', () => {
    const observation = observe(fixture('chatgpt-attachment-ready.html'));
    expect(observation.session).toBe('ready');
    expect(observation.fileInputCount).toBe(1);
    expect(observation.contracts.attachmentReady?.count).toBeGreaterThan(0);
  });
});

describe('selector drift mutations', () => {
  it('falls back to the placeholder candidate when the composer id is renamed', () => {
    const doc = fixture('chatgpt-ready-v1.html');
    mustQuery(doc, '#prompt-textarea').setAttribute('id', 'prompt-box');
    const observation = observe(doc);
    expect(observation.session).toBe('ready');
    expect(observation.composerPresent).toBe(true);
  });

  it('reports an unsatisfied composer contract when every candidate is gone', () => {
    const doc = fixture('chatgpt-ready-v1.html');
    mustQuery(doc, '#prompt-textarea').remove();
    const observation = observe(doc);
    expect(observation.composerPresent).toBe(false);
    expect(observation.contracts.composer?.count).toBe(0);
    expect(observation.session).toBe('ui_changed');
  });

  it('treats a hidden composer as not ready', () => {
    const doc = fixture('chatgpt-ready-v1.html');
    mustQuery(doc, '#prompt-textarea').setAttribute('hidden', '');
    const observation = observe(doc);
    expect(observation.composerPresent).toBe(true);
    expect(observation.composerVisible).toBe(false);
    expect(observation.session).not.toBe('ready');
  });

  it('drops the send-control contract when its test id drifts', () => {
    const doc = fixture('chatgpt-complete-turn.html');
    const send = mustQuery(doc, 'button[data-testid="send-button"]');
    send.setAttribute('data-testid', 'send-turn-button');
    send.removeAttribute('aria-label');
    const observation = observe(doc);
    expect(observation.contracts.sendControl?.count).toBe(0);
    expect(observation.session).toBe('ready');
  });

  it('still matches the copy action through its aria-label when the test id drifts', () => {
    const doc = fixture('chatgpt-complete-turn.html');
    mustQuery(doc, 'button[data-testid="copy-turn-action-button"]').setAttribute(
      'data-testid',
      'copy-button',
    );
    const observation = observe(doc);
    expect(observation.completionActionCount).toBe(1);
  });

  it('loses completion evidence when every copy-action candidate drifts', () => {
    const doc = fixture('chatgpt-complete-turn.html');
    const copy = mustQuery(doc, 'button[data-testid="copy-turn-action-button"]');
    copy.setAttribute('data-testid', 'copy-button');
    copy.removeAttribute('aria-label');
    const observation = observe(doc);
    expect(observation.completionActionCount).toBe(0);
  });

  it('loses turn binding when data-turn-id is removed', () => {
    const doc = fixture('chatgpt-generating.html');
    for (const el of Array.from(doc.querySelectorAll('[data-turn-id]'))) {
      el.removeAttribute('data-turn-id');
    }
    const observation = observe(doc, { boundTurnId: 'turn-assistant-1' });
    expect(observation.turnIds).toEqual([]);
    expect(observation.boundTurn?.elements).toBe(0);
  });

  it('keeps classifying ready when the v2 composer loses its virtualkeyboard marker', () => {
    const doc = fixture('chatgpt-ready-v2.html');
    mustQuery(doc, '[contenteditable="true"]').removeAttribute('data-virtualkeyboard');
    const observation = observe(doc);
    expect(observation.session).toBe('ready');
    expect(observation.composerPresent).toBe(true);
  });
});

describe('content-versus-state disambiguation', () => {
  it('does not misread assistant text quoting a rate limit as a rate-limited session', () => {
    const doc = parseHTML(
      `<main>
        <div data-message-author-role="assistant"><div class="markdown">
          You may hit a rate limit or too many requests errors; try again later.
        </div></div>
        <textarea id="prompt-textarea" placeholder="Message ChatGPT"></textarea>
        <button data-testid="send-button" aria-label="Send"></button>
      </main>`,
    ).document;
    const observation = observe(doc);
    expect(observation.session).toBe('ready');
    expect(observation.contracts.rateLimit?.textMatch).toBe(false);
  });

  it('does not treat not-found phrasing inside an answer as a missing surface', () => {
    const doc = parseHTML(
      `<main>
        <div data-turn-id="turn-1">
          <div data-message-author-role="assistant"><div class="markdown">
            That file could not be found; it may have been deleted.
          </div></div>
        </div>
        <textarea id="prompt-textarea" placeholder="Message ChatGPT"></textarea>
      </main>`,
    ).document;
    const observation = observe(doc, { url: 'https://chatgpt.com/c/abc-123' });
    expect(observation.missing).toBeUndefined();
  });

  it('still matches state text outside assistant turns', () => {
    const doc = parseHTML(
      `<main>
        <p>You have reached the current usage limit.</p>
        <div data-message-author-role="assistant"><div class="markdown">ok</div></div>
      </main>`,
    ).document;
    const observation = observe(doc);
    expect(observation.session).toBe('rate_limited');
  });
});
