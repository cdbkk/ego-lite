import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startBrowser } from '../browser.mjs';
import { createRelay, parseProxy } from '../relay.mjs';
import { httpProxy } from './fixtures.mjs';

test('native startup cancellation removes profile lock; execution timeout and stop leave no owned browser', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ego-proxy-lifecycle-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const proxy = await httpProxy(); t.after(() => proxy.close());
  const relay = await createRelay(parseProxy(`http://127.0.0.1:${proxy.port}`)); t.after(() => relay.close());
  const controller = new AbortController();
  const cancelled = startBrowser('cancelled', relay.port, { directory, signal: controller.signal });
  const cancelledRejection = assert.rejects(cancelled, /interrupted/);
  await sleep(100); controller.abort(); await cancelledRejection;
  await assert.rejects(access(join(directory, 'profiles/cancelled/.ego-proxy.lock')), { code: 'ENOENT' });
  const browser = await startBrowser('timeout', relay.port, { directory }); t.after(() => browser.stop());
  await assert.rejects(startBrowser('timeout', relay.port, { directory }), /already locked/);
  await assert.rejects(browser.execute('await new Promise(r => setTimeout(r, 30000));', { timeout: 300 }), /timed out/);
  const running = browser.execute('await new Promise(r => setTimeout(r, 30000));', { timeout: 5000 });
  const rejection = assert.rejects(running, /interrupted/);
  await sleep(100); await browser.stop(); await rejection;
  assert.throws(() => process.kill(browser.pid, 0), { code: 'ESRCH' });
  await assert.rejects(access(join(directory, 'profiles/timeout/.ego-proxy.lock')), { code: 'ENOENT' });
});
