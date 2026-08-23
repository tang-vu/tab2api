import assert from 'node:assert/strict';
import test from 'node:test';
import { autostartPresentation, validAutostartStatus } from './startup-controls.js';

test('autostart status accepts only a native boolean payload', () => {
  assert.equal(validAutostartStatus({ enabled: true }), true);
  assert.equal(validAutostartStatus({ enabled: false }), true);
  assert.equal(validAutostartStatus({ enabled: 'true' }), false);
  assert.equal(validAutostartStatus({ enabled: true, path: 'must-not-cross' }), false);
  assert.equal(validAutostartStatus([{ enabled: true }]), false);
  assert.equal(validAutostartStatus(null), false);
});

test('unknown and in-flight states stay disabled', () => {
  assert.deepEqual(autostartPresentation(undefined, undefined, false), {
    checked: false,
    disabled: true,
    labelKey: 'autostartUnknown',
    tone: 'muted',
  });
  assert.deepEqual(autostartPresentation({ enabled: true }, 'disabling', false), {
    checked: false,
    disabled: true,
    labelKey: 'autostartDisabling',
    tone: 'working',
  });
});

test('verified settings are editable and retain their exact native state', () => {
  assert.deepEqual(autostartPresentation({ enabled: true }, undefined, false), {
    checked: true,
    disabled: false,
    labelKey: 'autostartEnabled',
    tone: 'success',
  });
  assert.deepEqual(autostartPresentation({ enabled: false }, undefined, false), {
    checked: false,
    disabled: false,
    labelKey: 'autostartDisabled',
    tone: 'muted',
  });
});

test('typed failures remain actionable without inventing a new state', () => {
  assert.deepEqual(autostartPresentation({ enabled: true }, undefined, true), {
    checked: true,
    disabled: false,
    labelKey: 'autostartError',
    tone: 'error',
  });
  assert.deepEqual(autostartPresentation(undefined, undefined, true), {
    checked: false,
    disabled: true,
    labelKey: 'autostartError',
    tone: 'error',
  });
});
