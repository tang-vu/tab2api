import assert from 'node:assert/strict';
import test from 'node:test';
import { viewState } from './view-tabs.js';

test('browser view shows the browser and its docked native window', () => {
  assert.deepEqual(viewState('browser', 'docked'), {
    activeView: 'browser',
    browserHidden: false,
    docsHidden: true,
    adminHidden: true,
    nativeBrowserVisible: true,
  });
});

test('documentation view hides the docked native window', () => {
  assert.deepEqual(viewState('docs', 'docked'), {
    activeView: 'docs',
    browserHidden: true,
    docsHidden: false,
    adminHidden: true,
    nativeBrowserVisible: false,
  });
});

test('administration view hides both other panes and the docked native window', () => {
  assert.deepEqual(viewState('admin', 'docked'), {
    activeView: 'admin',
    browserHidden: true,
    docsHidden: true,
    adminHidden: false,
    nativeBrowserVisible: false,
  });
});

test('external browsers are not hidden and invalid views fall back safely', () => {
  assert.equal(viewState('docs', 'external').nativeBrowserVisible, undefined);
  assert.equal(viewState('unknown', 'docked').activeView, 'browser');
});
