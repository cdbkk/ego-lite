import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PresetStore } from '../store.mjs';
import { cleanEnvironment, browserArguments } from '../browser.mjs';

test('presets are encrypted, private, authenticated and bound to their names', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ego-proxy-store-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32), store = new PresetStore({ directory, key });
  await store.set('regional', 'socks5://user:SECRET_PASSWORD@private.example:1080');
  assert.deepEqual(await store.list(), ['regional']); assert.equal((await store.get('regional')).password, 'SECRET_PASSWORD');
  const file = join(directory, 'presets.json'), text = await readFile(file, 'utf8');
  for (const secret of ['SECRET_PASSWORD', 'private.example', 'user']) assert.ok(!text.includes(secret));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const data = JSON.parse(text); data.presets.renamed = data.presets.regional;
  await writeFile(file, JSON.stringify(data)); await assert.rejects(store.get('renamed'), /could not be decrypted/);
  data.presets.regional.tag = randomBytes(16).toString('base64'); await writeFile(file, JSON.stringify(data));
  await assert.rejects(store.get('regional'), /could not be decrypted/);
});

test('invalid names and insecure directories fail rather than changing global settings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ego-proxy-store-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new PresetStore({ directory, key: randomBytes(32) });
  await assert.rejects(store.set('../escape', 'http://localhost:80'), /Preset names/);
  await store.set('one', 'http://localhost:80'); await store.remove('one'); assert.deepEqual(await store.list(), []);
  await assert.rejects(store.get('one'), /Unknown proxy preset/);
  await assert.rejects(store.get('constructor'), /Unknown proxy preset/);
  await chmod(directory, 0o755); await assert.rejects(store.list(), /permissions 0700/);
});

test('simultaneous preset writers fail explicitly rather than losing an update', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ego-proxy-store-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new PresetStore({ directory, key: randomBytes(32) });
  const results = await Promise.allSettled([store.set('one', 'http://localhost:80'), store.set('two', 'http://localhost:81')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /locked/);
  assert.equal((await store.list()).length, 1);
  await store.set('three', 'http://localhost:82'); assert.equal((await store.list()).length, 2);
});

test('browser environment excludes credentials and inherited app identity; routing disables implicit direct paths', () => {
  const env = cleanEnvironment({ PATH: '/usr/bin', __CFBundleIdentifier: 'co.cdbkk.vu', EGO_PROXY_URL: 'secret', EGO_PROXY_MASTER_KEY: 'secret', HTTP_PROXY: 'secret', no_proxy: '*', SAFE: 'ok' });
  assert.deepEqual(env, { PATH: '/usr/bin', SAFE: 'ok' });
  const args = browserArguments('/tmp/profile', 'service-name', 1234);
  assert.ok(args.includes('--proxy-server=http://127.0.0.1:1234'));
  assert.ok(args.includes('--proxy-bypass-list=<-loopback>'));
  assert.ok(args.includes('--disable-quic'));
  assert.ok(args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
  assert.ok(args.includes('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'));
  assert.ok(!args.some(arg => /ignore-certificate|no-sandbox|password/i.test(arg)));
});
