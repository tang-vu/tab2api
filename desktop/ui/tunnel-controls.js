const operationDetails = {
  install_cloudflared: 'tunnelInstalling',
  enable_access_tunnel: 'tunnelEnablingAccess',
  enable_bearer_tunnel: 'tunnelEnablingBearer',
  disable_tunnel: 'tunnelDisabling',
  open_tunnel_folder: 'tunnelOpeningFolder',
};

export function tunnelOperationDetail(operation) {
  return operationDetails[operation];
}

export function tunnelControlState(status, hostnameValid, operation) {
  const busy = Boolean(operation);
  return {
    busy,
    hostnameDisabled: busy,
    installDisabled: busy || !status.supported || status.cloudflared_installed,
    accessDisabled:
      busy ||
      !status.supported ||
      !status.cloudflared_installed ||
      !status.config_ready ||
      !status.access_probe_ready ||
      status.running ||
      !hostnameValid,
    bearerDisabled:
      busy ||
      !status.supported ||
      !status.cloudflared_installed ||
      !status.config_ready ||
      status.running ||
      !hostnameValid,
    disableDisabled: busy || !status.supported || !status.task_installed,
    folderDisabled: busy || !status.supported,
  };
}
