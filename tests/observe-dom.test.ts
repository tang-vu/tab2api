import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import {
  isVisible,
  matchContract,
  observeChatDom,
  queryAll,
  visibleText,
  type DomObservation,
  type DomRoot,
} from '../src/adapters/chatgpt/observe-dom.js';
import { serializeContracts } from '../src/adapters/chatgpt/selector-contracts.js';

function fixture(name: string): Document {
  const html = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
  return parseHTML(html).document;
}

function dom(html: string): Document {
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

describe('observeChatDom session classification', () => {
  it.each([
    ['chatgpt-ready-v1.html', 'ready'],
    ['chatgpt-ready-v2.html', 'ready'],
    ['chatgpt-login.html', 'login_required'],
    ['chatgpt-challenge.html', 'security_challenge'],
    ['chatgpt-rate-limit.html', 'rate_limited'],
  ] as const)('classifies %s as %s', (name, session) => {
    expect(observe(fixture(name) as unknown as DomRoot).session).toBe(session);
  });

  it('reports unknown markup as ui_changed', () => {
    expect(observe(dom('<main>unrelated</main>') as unknown as DomRoot).session).toBe(
      'ui_changed',
    );
  });

  it('treats an unknown surface as still generating when told generation is in flight', () => {
    const observation = observe(dom('<main>remounting</main>') as unknown as DomRoot, {
      duringGeneration: true,
    });
    expect(observation.session).toBe('generation_in_progress');
  });

  it('detects generation in progress from a visible stop control', () => {
    const root = dom(
      '<main><button data-testid="stop-button">Stop generating</button></main>',
    ) as unknown as DomRoot;
    const observation = observe(root);
    expect(observation.session).toBe('generation_in_progress');
    expect(observation.stopVisible).toBe(true);
  });

  it('does not call a hidden composer ready', () => {
    const root = dom(
      '<main><textarea id="prompt-textarea" hidden></textarea></main>',
    ) as unknown as DomRoot;
    const observation = observe(root);
    expect(observation.composerPresent).toBe(true);
    expect(observation.composerVisible).toBe(false);
    expect(observation.session).not.toBe('ready');
  });
});

describe('observeChatDom missing surfaces', () => {
  const notFoundPage = '<main><p>We couldn\'t find the page you were looking for.</p></main>';

  it('reports a missing conversation only when the URL names one and nothing renders', () => {
    const observation = observe(dom(notFoundPage) as unknown as DomRoot, {
      url: 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000099',
    });
    expect(observation.missing).toBe('conversation_not_found');
  });

  it('reports a missing project for a project URL with not-found text', () => {
    const observation = observe(dom(notFoundPage) as unknown as DomRoot, {
      url: 'https://chatgpt.com/g/g-p-0123456789abcdef/project',
    });
    expect(observation.missing).toBe('project_not_found');
  });

  it('ignores not-found text on surfaces that still render turns', () => {
    const root = dom(
      `${notFoundPage}<div data-turn-id="t1"></div>`,
    ) as unknown as DomRoot;
    const observation = observe(root, {
      url: 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000099',
    });
    expect(observation.missing).toBeUndefined();
  });
});

describe('observeChatDom turn evidence', () => {
  it('collects bounded turn ids', () => {
    const root = dom(
      '<main><div data-turn-id="a"></div><div data-turn-id="b"></div><div data-turn-id></div></main>',
    ) as unknown as DomRoot;
    expect(observe(root).turnIds).toEqual(['a', 'b']);
  });

  it('binds to exactly one turn element and reads its assistant text', () => {
    const root = dom(
      `<main>
        <div data-turn-id="keep">
          <div data-message-author-role="assistant"><div class="markdown">bound answer</div></div>
        </div>
        <div data-turn-id="other">
          <div data-message-author-role="assistant"><div class="markdown">earlier</div></div>
        </div>
      </main>`,
    ) as unknown as DomRoot;
    const observation = observe(root, { boundTurnId: 'keep' });
    expect(observation.boundTurn?.elements).toBe(1);
    expect(observation.boundTurn?.text).toContain('bound answer');
  });

  it('reports an absent bound turn without fabricating text', () => {
    const observation = observe(dom('<main></main>') as unknown as DomRoot, {
      boundTurnId: 'missing',
    });
    expect(observation.boundTurn).toEqual({
      elements: 0,
      text: '',
      pending: false,
      completionActions: 0,
    });
  });

  it('marks a bound turn pending while working markers render inside it', () => {
    const root = dom(
      `<main>
        <div data-turn-id="t">
          <div data-message-author-role="assistant"><div aria-busy="true"></div></div>
        </div>
      </main>`,
    ) as unknown as DomRoot;
    expect(observe(root, { boundTurnId: 't' }).boundTurn?.pending).toBe(true);
  });

  it('counts completion actions inside the bound turn only', () => {
    const root = dom(
      `<main>
        <div data-turn-id="t"><button data-testid="copy-turn-action-button">Copy</button></div>
        <div data-turn-id="u"><button data-testid="copy-turn-action-button">Copy</button></div>
      </main>`,
    ) as unknown as DomRoot;
    const observation = observe(root, { boundTurnId: 't' });
    expect(observation.boundTurn?.completionActions).toBe(1);
    expect(observation.completionActionCount).toBe(2);
  });
});

describe('observeChatDom capability evidence', () => {
  it('detects temporary chat evidence from a marker or the URL', () => {
    const marked = dom('<main><div data-testid="temporary-chat-badge"></div></main>');
    expect(observe(marked as unknown as DomRoot).temporaryChatEvidence).toBe(true);
    const bare = dom('<main></main>');
    expect(
      observe(bare as unknown as DomRoot, {
        url: 'https://chatgpt.com/?temporary-chat=true',
      }).temporaryChatEvidence,
    ).toBe(true);
    expect(observe(bare as unknown as DomRoot).temporaryChatEvidence).toBe(false);
  });

  it('detects the effort control case-insensitively', () => {
    const root = dom('<main><button data-testid="composer-EFFORT-picker"></button></main>');
    expect(observe(root as unknown as DomRoot).effortControlPresent).toBe(true);
  });

  it('counts file inputs and generated images separately', () => {
    const root = dom(
      `<main>
        <input type="file" />
        <input type="file" />
        <div data-message-author-role="assistant"><img alt="Generated image" src="x" /></div>
      </main>`,
    );
    const observation = observe(root as unknown as DomRoot);
    expect(observation.fileInputCount).toBe(2);
    expect(observation.generatedImageCount).toBe(1);
    expect(observation.generatedImageFallbackCount).toBe(0);
  });

  it('counts project rows and the new-project control', () => {
    const root = dom(
      `<main>
        <div role="grid"><div role="row"></div><div role="row"></div></div>
        <button aria-label="New project">Create</button>
      </main>`,
    );
    const observation = observe(root as unknown as DomRoot);
    expect(observation.projectRowCount).toBe(2);
    expect(observation.newProjectControl).toBe(true);
  });

  it('exposes bounded per-contract evidence for every registry contract', () => {
    const observation = observe(fixture('chatgpt-ready-v1.html') as unknown as DomRoot);
    for (const name of Object.keys(serializeContracts())) {
      const evidence = observation.contracts[name];
      expect(evidence, name).toBeDefined();
      expect(evidence?.count).toBeGreaterThanOrEqual(0);
    }
    expect(observation.contracts.composer?.count).toBe(1);
  });
});

describe('visibleText', () => {
  it('skips hidden subtrees and preserves pre whitespace', () => {
    const root = dom(
      `<main>
        <div style="display:none">invisible</div>
        <div hidden>also invisible</div>
        <pre>line1\n  indented   kept</pre>
        <p>visible   collapsed</p>
      </main>`,
    ) as unknown as DomRoot;
    const text = visibleText(root.documentElement ?? (root as never));
    expect(text).not.toContain('invisible');
    expect(text).toContain('line1\n  indented   kept');
    expect(text).toContain('visible collapsed');
  });

  it('turns block boundaries and <br> into newlines', () => {
    const root = dom('<main><p>one</p><p>two<br>three</p></main>') as unknown as DomRoot;
    const text = visibleText(root.documentElement ?? (root as never));
    expect(text).toBe('one\ntwo\nthree');
  });
});

describe('observer helpers', () => {
  it('queryAll tolerates unsupported selector syntax', () => {
    const root = dom('<main><p>x</p></main>') as unknown as DomRoot;
    expect(queryAll(root, 'main p')).toHaveLength(1);
    expect(queryAll(root, ':::definitely not valid:::')).toHaveLength(0);
  });

  it('isVisible applies structural heuristics without checkVisibility', () => {
    const root = dom('<main><p id="a">x</p><p id="b" hidden>y</p></main>');
    const [a, b] = queryAll(root as unknown as DomRoot, 'p');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (a === undefined || b === undefined) return;
    expect(isVisible(a)).toBe(true);
    expect(isVisible(b)).toBe(false);
  });

  it('matchContract matches text patterns inside the declared scope', () => {
    const root = dom(
      '<main><button>Say hello</button><a href="/auth/login">Log in</a></main>',
    ) as unknown as DomRoot;
    const matched = matchContract(root, {
      css: [],
      textScope: ['main button', 'main a'],
      textPatterns: ['log in'],
    });
    expect(matched).toHaveLength(1);
  });

  it('caps page-text scanning for state patterns', () => {
    const root = dom(
      '<main><p>checking your browser</p></main>',
    ) as unknown as DomRoot;
    const capped = observe(root, { maxPageTextChars: 5 });
    expect(capped.session).toBe('ui_changed');
  });
});
