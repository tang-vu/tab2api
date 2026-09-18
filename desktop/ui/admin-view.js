export function validKeyLabel(value) {
  const normalized = String(value).trim();
  return normalized.length >= 1 && [...normalized].length <= 80;
}

const clientKeyPattern = /^tab2api_[a-f0-9]{16}_[A-Za-z0-9_-]{43}$/;

export function claudeCodePowerShellSetup(value) {
  const token = String(value);
  if (!clientKeyPattern.test(token)) throw new Error('invalid client key');
  return [
    "$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:3210'",
    `$env:ANTHROPIC_AUTH_TOKEN = '${token}'`,
    "$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'",
    'claude --model claude-tab2api-chatgpt-web',
  ].join('\n');
}

export function administrationControls(phase, busy) {
  const ready = phase === 'ready';
  return {
    canLoad: ready && !busy,
    createDisabled: !ready || busy,
    refreshDisabled: !ready || busy,
    resetDisabled: !ready || busy,
  };
}

const MAX_QUEUE_COUNT = 1_000_000;

export function validQueueStatus(value) {
  if (typeof value !== 'object' || value === null) return false;
  return (
    typeof value.draining === 'boolean' &&
    Number.isSafeInteger(value.pending) &&
    value.pending >= 0 &&
    value.pending <= MAX_QUEUE_COUNT &&
    Number.isSafeInteger(value.active) &&
    value.active >= 0 &&
    value.active <= MAX_QUEUE_COUNT
  );
}

export function queueControls(phase, busy, status) {
  const ready = phase === 'ready';
  const draining = validQueueStatus(status) && status.draining;
  return {
    drainDisabled: !ready || busy || draining,
    resumeDisabled: !ready || busy || !draining,
  };
}

export function usageTotals(entry) {
  return {
    requests: Number(entry?.requests ?? 0),
    successful: Number(entry?.successful ?? 0),
    failed: Number(entry?.failed ?? 0),
    estimatedTokens:
      Number(entry?.estimatedInputTokens ?? 0) + Number(entry?.estimatedOutputTokens ?? 0),
    bytes: Number(entry?.inputBytes ?? 0) + Number(entry?.outputBytes ?? 0),
  };
}
