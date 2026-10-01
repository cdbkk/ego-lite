import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { origin, socksProxy } from './fixtures.mjs';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
function command(args, directory, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, EGO_PROXY_DIRECTORY: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end(input);
  });
}

test('installed CLI workflow saves securely, checks routing and executes the fork SDK in a real proxied browser', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ego-proxy-cli-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const dest = await origin(); t.after(() => dest.close());
  const proxy = await socksProxy({ username: 'cli-user', password: 'cli-secret' }); t.after(() => proxy.close());
  const url = `socks5://cli-user:cli-secret@127.0.0.1:${proxy.port}`;
  const unsafe = await command(['add', 'cli-test', url], directory); assert.equal(unsafe.code, 1); assert.ok(!unsafe.stderr.includes('cli-secret'));
  assert.equal((await command(['add', 'cli-test'], directory, url)).code, 0);
  const list = await command(['list'], directory); assert.equal(list.stdout.trim(), 'cli-test');
  const check = await command(['check', 'cli-test', `http://origin.invalid:${dest.port}/check`], directory);
  assert.equal(check.code, 0); assert.equal(JSON.parse(check.stdout).status, 200);
  const script = `const task = await taskSpace("CLI proxy gate"); const page = task.page("p1"); await page.goto("http://origin.invalid:${dest.port}/cli"); cliLog("CLI_ROUTED=" + await page.evaluate(() => document.body.innerText)); await task.finish({keep:[]});`;
  const run = await command(['run', 'cli-test', '-e', script], directory);
  assert.equal(run.code, 0, run.stderr); assert.match(run.stdout, /CLI_ROUTED=.*"path":"\/cli"/);
  for (const text of [list.stdout, check.stdout, run.stdout, run.stderr]) assert.ok(!text.includes('cli-secret'));
  assert.ok(proxy.records.length >= 2);
  assert.equal((await command(['remove', 'cli-test'], directory)).code, 0);
  assert.equal((await command(['list'], directory)).stdout.trim(), 'No proxy presets');
});
