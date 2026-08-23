export function validAutostartStatus(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof value.enabled === 'boolean'
  );
}

export function autostartPresentation(status, operation, failed) {
  const enabled = status?.enabled === true;
  if (operation === 'checking') {
    return { checked: enabled, disabled: true, labelKey: 'autostartChecking', tone: 'working' };
  }
  if (operation === 'enabling') {
    return { checked: true, disabled: true, labelKey: 'autostartEnabling', tone: 'working' };
  }
  if (operation === 'disabling') {
    return { checked: false, disabled: true, labelKey: 'autostartDisabling', tone: 'working' };
  }
  if (failed) {
    return {
      checked: enabled,
      disabled: status === undefined,
      labelKey: 'autostartError',
      tone: 'error',
    };
  }
  if (!status) {
    return { checked: false, disabled: true, labelKey: 'autostartUnknown', tone: 'muted' };
  }
  return {
    checked: enabled,
    disabled: false,
    labelKey: enabled ? 'autostartEnabled' : 'autostartDisabled',
    tone: enabled ? 'success' : 'muted',
  };
}
