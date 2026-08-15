import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  detectLanguage,
  languageOptions,
  loadLanguage,
  messages,
  saveLanguage,
  translate,
} from './i18n.js';

test('detects supported operating-system locales without IP lookup', () => {
  assert.equal(detectLanguage(['vi-VN', 'en-US']), 'vi');
  assert.equal(detectLanguage(['ja-JP']), 'ja');
  assert.equal(detectLanguage(['pt-BR', 'de-DE']), 'de');
  assert.equal(detectLanguage(['unknown']), 'en');
});

test('all advertised languages provide the complete English key set', () => {
  assert.equal(languageOptions.length, 8);
  const englishKeys = Object.keys(messages.en).sort();
  for (const [code] of languageOptions) {
    assert.deepEqual(Object.keys(messages[code]).sort(), englishKeys);
    for (const value of Object.values(messages[code])) {
      assert.equal(typeof value, 'string');
      assert.notEqual(value.trim(), '');
    }
  }
  for (const [code] of languageOptions.slice(1)) {
    for (const key of [
      'settings',
      'guideTitle',
      'serviceReady',
      'confirmBearer',
      'tunnelHostname',
      'hostnameError',
    ]) {
      assert.notEqual(messages[code][key], messages.en[key]);
    }
  }
});

test('a saved supported language wins and unsupported values fall back to locale', () => {
  const values = new Map([['tab2api.language', 'vi']]);
  const storage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
  };
  assert.equal(loadLanguage(storage, ['de-DE']), 'vi');
  assert.equal(saveLanguage(storage, 'ja'), true);
  assert.equal(loadLanguage(storage, ['de-DE']), 'ja');
  assert.equal(saveLanguage(storage, 'unsupported'), false);
  values.set('tab2api.language', 'unsupported');
  assert.equal(loadLanguage(storage, ['de-DE']), 'de');
});

test('locked storage never blocks local locale detection', () => {
  const storage = {
    getItem: () => {
      throw new Error('locked');
    },
    setItem: () => {
      throw new Error('locked');
    },
  };
  assert.equal(loadLanguage(storage, ['ko-KR']), 'ko');
  assert.equal(saveLanguage(storage, 'ko'), false);
  assert.equal(translate('missing', 'settings'), 'Settings');
});

test('every translated DOM key exists and locale selection performs no network lookup', async () => {
  const [html, app, i18n] = await Promise.all([
    readFile(new URL('./index.html', import.meta.url), 'utf8'),
    readFile(new URL('./app.js', import.meta.url), 'utf8'),
    readFile(new URL('./i18n.js', import.meta.url), 'utf8'),
  ]);
  const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(keys.length > 30);
  for (const key of keys) assert.ok(Object.hasOwn(messages.en, key), `missing key: ${key}`);
  assert.doesNotMatch(
    `${app}\n${i18n}`,
    /\bfetch\s*\(|navigator\.geolocation|getCurrentPosition\s*\(/,
  );
  assert.match(html, /id="tunnel-hostname"/);
  assert.match(app, /enable_access_tunnel', \{ hostname: tunnelHostname\(\) \}/);
  assert.match(app, /tab2api\.tunnelHostname/);
});
