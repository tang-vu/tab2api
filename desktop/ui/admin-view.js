export function validKeyLabel(value) {
  const normalized = String(value).trim();
  return normalized.length >= 1 && [...normalized].length <= 80;
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
