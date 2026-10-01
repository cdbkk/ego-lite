import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PresetStore } from '../store.mjs';

test('real macOS Keychain master key encrypts and reopens presets without appearing in their file', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ego-proxy-keychain-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new PresetStore({ directory });
  await store.set('keychain-test', 'http://fixture-user:fixture-secret@127.0.0.1:12345');
  const reopened = new PresetStore({ directory });
  assert.equal((await reopened.get('keychain-test')).password, 'fixture-secret');
  const text = await readFile(join(directory, 'presets.json'), 'utf8');
  assert.ok(!text.includes('fixture-secret')); assert.ok(!text.includes('fixture-user'));
});
