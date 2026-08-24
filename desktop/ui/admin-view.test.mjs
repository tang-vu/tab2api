import assert from 'node:assert/strict';
import test from 'node:test';
import {
  administrationControls,
  claudeCodePowerShellSetup,
  usageTotals,
  validKeyLabel,
} from './admin-view.js';

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

test('Claude Code setup is ephemeral, loopback-only, and accepts only a created client key', () => {
  const token = `tab2api_${'a'.repeat(16)}_${'B'.repeat(43)}`;
  const setup = claudeCodePowerShellSetup(token);
  assert.match(setup, /ANTHROPIC_BASE_URL = 'http:\/\/127\.0\.0\.1:3210'/);
  assert.match(setup, /claude --model claude-tab2api-chatgpt-web/);
  assert.match(setup, /CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC/);
  assert.equal(setup.split(token).length - 1, 1);
  assert.throws(() => claudeCodePowerShellSetup('administrator-or-malformed-key'));
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
