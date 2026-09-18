import { describe, expect, it } from 'vitest';
import {
  buildDiagnostics,
  capabilitySnapshot,
  fingerprintObservation,
} from '../src/adapters/chatgpt/diagnostics.js';
import { emptyObservation } from '../src/adapters/chatgpt/session.js';
import { SELECTOR_CONTRACTS } from '../src/adapters/chatgpt/selector-contracts.js';

function observationWith(overrides: Partial<ReturnType<typeof emptyObservation>>) {
  return { ...emptyObservation('ready'), ...overrides };
}

describe('fingerprintObservation', () => {
  it('records every registry contract with satisfaction evidence', () => {
    const fingerprint = fingerprintObservation(
      observationWith({
        contracts: {
          composer: { count: 1, visible: 1, textMatch: false },
          projectRow: { count: 2, visible: 2, textMatch: false },
        },
      }),
      'https://chatgpt.com/c/00000000-0000-4000-8000-000000000099?x=1',
    );
    for (const name of Object.keys(SELECTOR_CONTRACTS)) {
      expect(fingerprint.contracts[name], name).toBeDefined();
    }
    expect(fingerprint.contracts.composer).toMatchObject({
      cardinality: 'zeroOrOne',
      count: 1,
      satisfied: true,
    });
    expect(fingerprint.contracts.projectRow?.satisfied).toBe(true);
  });

  it('flags contracts whose cardinality is not satisfied', () => {
    const fingerprint = fingerprintObservation(
      observationWith({
        contracts: {
          composer: { count: 3, visible: 3, textMatch: false },
          projectNameInput: { count: 2, visible: 2, textMatch: false },
        },
      }),
      'https://chatgpt.com/',
    );
    expect(fingerprint.contracts.composer?.satisfied).toBe(false);
    expect(fingerprint.contracts.projectNameInput?.satisfied).toBe(false);
  });

  it('redacts the URL to host and pathname only', () => {
    const fingerprint = fingerprintObservation(
      emptyObservation('ready'),
      'https://chatgpt.com/c/00000000-0000-4000-8000-000000000099?secret=query',
    );
    expect(fingerprint.url).toEqual({
      host: 'chatgpt.com',
      pathname: '/c/00000000-0000-4000-8000-000000000099',
    });
  });

  it('records an undefined url for an unparseable location', () => {
    const fingerprint = fingerprintObservation(emptyObservation('ready'), 'not a url');
    expect(fingerprint.url).toBeUndefined();
  });
});

describe('capabilitySnapshot', () => {
  it('marks rendered surfaces with observed and absent capabilities', () => {
    const capabilities = capabilitySnapshot(
      observationWith({
        composerVisible: true,
        effortControlPresent: true,
        fileInputCount: 1,
        assistant: { count: 2, text: 'x', pending: false },
      }),
      'chat',
    );
    expect(capabilities.chat).toBe('observed');
    expect(capabilities.reasoningEffort).toBe('observed');
    expect(capabilities.fileUploads).toBe('observed');
    expect(capabilities.turnTracking).toBe('observed');
    expect(capabilities.temporaryChat).toBe('unknown');
    expect(capabilities.projectNavigation).toBe('unknown');
  });

  it('reports absent rather than unknown on a rendered surface missing the control', () => {
    const capabilities = capabilitySnapshot(
      observationWith({ composerVisible: true }),
      'chat',
    );
    expect(capabilities.fileUploads).toBe('absent');
    expect(capabilities.reasoningEffort).toBe('absent');
  });

  it('stays unknown on an unrendered surface', () => {
    const capabilities = capabilitySnapshot(emptyObservation('ui_changed'), 'unknown');
    expect(capabilities.chat).toBe('unknown');
    expect(capabilities.fileUploads).toBe('unknown');
    expect(capabilities.turnTracking).toBe('unknown');
  });

  it('reports project navigation only on the projects surface', () => {
    const capabilities = capabilitySnapshot(
      observationWith({ projectRowCount: 2 }),
      'projects',
    );
    expect(capabilities.projectNavigation).toBe('observed');
    const missing = capabilitySnapshot(emptyObservation('ui_changed'), 'projects');
    expect(missing.projectNavigation).toBe('absent');
  });
});

describe('buildDiagnostics', () => {
  it('lists only contracts that failed their cardinality', () => {
    const fingerprint = fingerprintObservation(
      observationWith({
        contracts: {
          composer: { count: 2, visible: 2, textMatch: false },
          sendControl: { count: 1, visible: 1, textMatch: false },
        },
      }),
      'https://chatgpt.com/',
    );
    const diagnostics = buildDiagnostics('ready', fingerprint, undefined);
    expect(diagnostics.state).toBe('ready');
    expect(diagnostics.unsatisfiedContracts).toContain('composer');
    expect(diagnostics.unsatisfiedContracts).not.toContain('sendControl');
  });

  it('reports an empty unsatisfied list before the first observation', () => {
    const diagnostics = buildDiagnostics('browser_disconnected', undefined, undefined);
    expect(diagnostics.unsatisfiedContracts).toEqual([]);
    expect(diagnostics.fingerprint).toBeUndefined();
    expect(diagnostics.capabilities).toBeUndefined();
  });
});
