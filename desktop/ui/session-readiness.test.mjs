import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readinessPresentation,
  sessionStates,
  shouldApplyReadinessResult,
} from './session-readiness.js';

test('a successful readiness check is distinct from process liveness', () => {
  assert.deepEqual(readinessPresentation('ready', 'ready'), {
    labelKey: 'sessionReady',
    detailKey: 'sessionReadyDetail',
    tone: 'ready',
    state: 'ready',
    checkDisabled: false,
  });
  assert.equal(readinessPresentation('stopped', 'ready').state, 'unavailable');
});

test('every typed non-ready result remains actionable and retryable', () => {
  for (const state of sessionStates.filter((value) => value !== 'ready')) {
    const presentation = readinessPresentation('ready', state);
    assert.notEqual(presentation.state, 'failed');
    assert.notEqual(presentation.detailKey, 'sessionReadyDetail');
    assert.equal(presentation.checkDisabled, false);
  }
});

test('checks are serialized and timeout failures remain retryable', () => {
  const checking = readinessPresentation('ready', 'unchecked', true);
  assert.equal(checking.state, 'checking');
  assert.equal(checking.checkDisabled, true);
  const failed = readinessPresentation('ready', 'failed');
  assert.equal(failed.state, 'failed');
  assert.equal(failed.checkDisabled, false);
});

test('late readiness results are cancelled when the service lifecycle changes', () => {
  assert.equal(shouldApplyReadinessResult('ready', 4, 4), true);
  assert.equal(shouldApplyReadinessResult('ready', 3, 4), false);
  assert.equal(shouldApplyReadinessResult('stopped', 4, 4), false);
});
