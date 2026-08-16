import assert from 'node:assert/strict';
import test from 'node:test';
import { administrationControls, usageTotals, validKeyLabel } from './admin-view.js';

test('API-key labels are trimmed and bounded', () => {
  assert.equal(validKeyLabel(' personal laptop '), true);
  assert.equal(validKeyLabel('   '), false);
  assert.equal(validKeyLabel('x'.repeat(81)), false);
});

test('administration controls require a ready service and serialize mutations', () => {
  assert.deepEqual(administrationControls('ready', false), {
    canLoad: true,
    createDisabled: false,
    refreshDisabled: false,
    resetDisabled: false,
  });
  assert.equal(administrationControls('stopped', false).canLoad, false);
  assert.equal(administrationControls('ready', true).createDisabled, true);
});

test('usage totals remain content-free numeric summaries', () => {
  assert.deepEqual(
    usageTotals({
      requests: 4,
      successful: 3,
      failed: 1,
      estimatedInputTokens: 10,
      estimatedOutputTokens: 7,
      inputBytes: 40,
      outputBytes: 28,
    }),
    { requests: 4, successful: 3, failed: 1, estimatedTokens: 17, bytes: 68 },
  );
});
