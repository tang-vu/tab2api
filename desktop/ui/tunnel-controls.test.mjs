import assert from 'node:assert/strict';
import test from 'node:test';
import { tunnelControlState, tunnelOperationDetail } from './tunnel-controls.js';

const ready = {
  supported: true,
  cloudflared_installed: true,
  config_ready: true,
  access_probe_ready: true,
  task_installed: false,
  running: false,
};

test('ready tunnel controls allow both activation modes', () => {
  const controls = tunnelControlState(ready, true);
  assert.equal(controls.accessDisabled, false);
  assert.equal(controls.bearerDisabled, false);
  assert.equal(controls.disableDisabled, true);
});

test('an in-flight transition disables all tunnel controls and exposes progress text', () => {
  const controls = tunnelControlState(ready, true, 'enable_bearer_tunnel');
  assert.equal(controls.busy, true);
  assert.ok(
    Object.entries(controls)
      .filter(([key]) => key.endsWith('Disabled'))
      .every(([, value]) => value),
  );
  assert.equal(tunnelOperationDetail('enable_bearer_tunnel'), 'tunnelEnablingBearer');
  assert.equal(tunnelOperationDetail('disable_tunnel'), 'tunnelDisabling');
});

test('invalid hostnames block activation without blocking setup access', () => {
  const controls = tunnelControlState(ready, false);
  assert.equal(controls.accessDisabled, true);
  assert.equal(controls.bearerDisabled, true);
  assert.equal(controls.folderDisabled, false);
});
