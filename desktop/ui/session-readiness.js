export const sessionStates = [
  'ready',
  'login_required',
  'security_challenge',
  'generation_in_progress',
  'rate_limited',
  'ui_changed',
  'browser_disconnected',
];

const presentationByState = {
  unavailable: {
    labelKey: 'sessionUnavailable',
    detailKey: 'sessionUnavailableDetail',
    tone: 'offline',
  },
  unchecked: {
    labelKey: 'sessionUnchecked',
    detailKey: 'sessionUncheckedDetail',
    tone: 'neutral',
  },
  checking: {
    labelKey: 'sessionChecking',
    detailKey: 'sessionCheckingDetail',
    tone: 'checking',
  },
  ready: { labelKey: 'sessionReady', detailKey: 'sessionReadyDetail', tone: 'ready' },
  login_required: {
    labelKey: 'sessionLoginRequired',
    detailKey: 'sessionLoginRequiredDetail',
    tone: 'warning',
  },
  security_challenge: {
    labelKey: 'sessionChallenge',
    detailKey: 'sessionChallengeDetail',
    tone: 'warning',
  },
  generation_in_progress: {
    labelKey: 'sessionBusy',
    detailKey: 'sessionBusyDetail',
    tone: 'checking',
  },
  rate_limited: {
    labelKey: 'sessionRateLimited',
    detailKey: 'sessionRateLimitedDetail',
    tone: 'warning',
  },
  ui_changed: {
    labelKey: 'sessionUiChanged',
    detailKey: 'sessionUiChangedDetail',
    tone: 'danger',
  },
  browser_disconnected: {
    labelKey: 'sessionDisconnected',
    detailKey: 'sessionDisconnectedDetail',
    tone: 'danger',
  },
  failed: { labelKey: 'sessionCheckFailed', detailKey: 'sessionCheckFailedDetail', tone: 'danger' },
};

export function readinessPresentation(servicePhase, sessionState, inFlight = false) {
  const effectiveState =
    servicePhase !== 'ready'
      ? 'unavailable'
      : inFlight
        ? 'checking'
        : Object.hasOwn(presentationByState, sessionState)
          ? sessionState
          : 'failed';
  return {
    ...presentationByState[effectiveState],
    state: effectiveState,
    checkDisabled: servicePhase !== 'ready' || inFlight,
  };
}

export function shouldApplyReadinessResult(servicePhase, requestEpoch, currentEpoch) {
  return servicePhase === 'ready' && requestEpoch === currentEpoch;
}
