import { describe, expect, it } from 'vitest';
import {
  SELECTOR_CONTRACTS,
  contractCandidates,
  contractCss,
  serializeContracts,
  type ContractName,
} from '../src/adapters/chatgpt/selector-contracts.js';
import type { ErrorCode } from '../src/errors.js';
import type { SessionState } from '../src/provider.js';

const KNOWN_ERROR_CODES = new Set<ErrorCode>([
  'authentication_error',
  'audio_unavailable',
  'attachment_failed',
  'browser_disconnected',
  'cancelled',
  'composer_unavailable',
  'conversation_not_found',
  'draining',
  'generation_interrupted',
  'generation_timeout',
  'invalid_request',
  'login_required',
  'navigation_failed',
  'project_not_found',
  'prompt_too_large',
  'queue_full',
  'rate_limited',
  'security_challenge',
  'storage_unavailable',
  'submission_uncertain',
  'timeout',
  'ui_changed',
  'unsupported_capability',
]);

const KNOWN_SESSION_STATES = new Set<SessionState>([
  'ready',
  'login_required',
  'security_challenge',
  'generation_in_progress',
  'rate_limited',
  'ui_changed',
  'browser_disconnected',
]);

const PLAYWRIGHT_ONLY_SYNTAX = /(:has-text|:visible|:text|text=|\/i$)/;

describe('selector contract registry', () => {
  it('keeps the registry key and the contract name identical', () => {
    for (const [key, definition] of Object.entries(SELECTOR_CONTRACTS)) {
      expect(definition.name).toBe(key);
    }
  });

  it('declares a valid cardinality and typed failure/session on every contract', () => {
    for (const definition of Object.values(SELECTOR_CONTRACTS)) {
      expect(['zeroOrOne', 'zeroOrMany', 'exactlyOne']).toContain(definition.cardinality);
      if (definition.failure !== undefined) {
        expect(KNOWN_ERROR_CODES.has(definition.failure)).toBe(true);
      }
      if (definition.state !== undefined) {
        expect(KNOWN_SESSION_STATES.has(definition.state)).toBe(true);
      }
    }
  });

  it('gives every interaction contract at least one live candidate', () => {
    for (const definition of Object.values(SELECTOR_CONTRACTS)) {
      const hasLiveCandidates = definition.css.length + definition.playwright.length > 0;
      const isPagePatternOnly =
        (definition.pagePatterns?.length ?? 0) > 0 && definition.failure === undefined;
      expect(hasLiveCandidates || isPagePatternOnly, definition.name).toBe(true);
    }
  });

  it('keeps Playwright-engine syntax out of the standard css candidates', () => {
    for (const definition of Object.values(SELECTOR_CONTRACTS)) {
      for (const selector of definition.css) {
        expect(PLAYWRIGHT_ONLY_SYNTAX.test(selector), `${definition.name}: ${selector}`).toBe(
          false,
        );
      }
    }
  });

  it('pairs every textScope with textPatterns and vice versa', () => {
    for (const definition of Object.values(SELECTOR_CONTRACTS)) {
      expect(definition.textScope !== undefined, definition.name).toBe(
        definition.textPatterns !== undefined,
      );
    }
  });
});

describe('contract candidate accessors', () => {
  it('returns css candidates before Playwright-only candidates', () => {
    const definition = SELECTOR_CONTRACTS.login;
    const candidates = contractCandidates('login');
    expect(candidates).toEqual([...definition.css, ...definition.playwright]);
    expect(candidates.length).toBeGreaterThan(definition.css.length);
  });

  it('exposes standard-CSS-only candidates for evaluate and fixtures', () => {
    const name: ContractName = 'login';
    expect(contractCss(name)).toEqual(SELECTOR_CONTRACTS[name].css);
    for (const selector of contractCss(name)) {
      expect(PLAYWRIGHT_ONLY_SYNTAX.test(selector)).toBe(false);
    }
  });
});

describe('serializeContracts', () => {
  it('serializes the whole registry to plain JSON data', () => {
    const serialized = serializeContracts();
    expect(Object.keys(serialized).sort()).toEqual(
      Object.keys(SELECTOR_CONTRACTS).sort(),
    );
    const roundTripped = JSON.parse(JSON.stringify(serialized)) as Record<
      string,
      { css: string[] }
    >;
    for (const [name, definition] of Object.entries(SELECTOR_CONTRACTS)) {
      expect(roundTripped[name]?.css).toEqual([...definition.css]);
    }
  });

  it('omits undefined optional fields rather than emitting nulls', () => {
    const serialized = serializeContracts();
    for (const definition of Object.values(serialized)) {
      expect('textScope' in definition && definition.textScope === undefined).toBe(false);
      expect('pagePatterns' in definition && definition.pagePatterns === undefined).toBe(
        false,
      );
    }
  });
});
