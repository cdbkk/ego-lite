#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { PresetStore, validateName } from './store.mjs';
import { createRelay, checkProxy } from './relay.mjs';
import { startBrowser } from './browser.mjs';

const help = `ego-proxy: isolated ego lite instances with authenticated upstream proxies

  ego-proxy add NAME             Read a proxy URL from stdin; save encrypted preset
  ego-proxy list                 List preset names (never credentials)
  ego-proxy remove NAME          Remove an encrypted preset; keep its browser profile
  ego-proxy check NAME [URL]     Test routing and report exit IP when URL returns one
  ego-proxy run NAME [-e SCRIPT | --file FILE] [--timeout SECONDS]
                                Execute through an isolated, proxied ego instance

Supported URLs: http://, https://, socks5://, socks5h://
Pass credentials on stdin, never as command arguments. Run reads a script from
stdin when neither -e nor --file is supplied. Default script timeout: 120 seconds.
`;

async function input() {
  let data = '';
  for await (const chunk of process.stdin) { data += chunk; if (data.length > 1024 * 1024) throw new Error('Input exceeds 1 MiB'); }
  return data;
}

async function main(args) {
  const [command, name, ...rest] = args;
  if (!command || ['-h', '--help', 'help'].includes(command)) { console.log(help); return; }
  const store = new PresetStore({ directory: process.env.EGO_PROXY_DIRECTORY });
  if (command === 'list') { if (name) throw new Error('list takes no arguments'); console.log((await store.list()).join('\n') || 'No proxy presets'); return; }
  validateName(name);
  if (command === 'add') {
    if (rest.length) throw new Error('Read the proxy URL from stdin; credential URLs cannot be command arguments');
    if (process.stdin.isTTY) throw new Error('Pipe a proxy URL from a password manager or use a shell read with hidden input; see README');
    await store.set(name, (await input()).trim()); console.log(`Saved proxy preset: ${name}`); return;
  }
  if (command === 'remove') { if (rest.length) throw new Error('remove takes one preset name'); await store.remove(name); console.log(`Removed preset: ${name}`); return; }
  if (command === 'check') {
    if (rest.length > 1) throw new Error('check accepts one optional destination URL');
    const result = await checkProxy(await store.get(name), { url: rest[0] });
    let ip;
    try { ip = JSON.parse(result.body).ip; } catch {}
    const { body, ...metadata } = result;
    console.log(JSON.stringify({ preset: name, ...metadata, ...(typeof ip === 'string' && /^[a-f0-9:.]{3,64}$/i.test(ip) ? { exitIp: ip } : {}) }, null, 2)); return;
  }
  if (command !== 'run') throw new Error('Unknown command; use ego-proxy --help');
  let script, timeout = 120000;
  for (let i = 0; i < rest.length; i++) {
    const option = rest[i], value = rest[++i];
    if (value === undefined) throw new Error(`Missing value for ${option}`);
    if (option === '-e' || option === '--file') {
      if (script !== undefined) throw new Error('Choose one script source');
      script = option === '-e' ? value : await readFile(value, 'utf8');
    } else if (option === '--timeout') {
      const seconds = Number(value); if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86400) throw new Error('Timeout must be 1 to 86400 seconds'); timeout = seconds * 1000;
    } else throw new Error(`Unknown run option: ${option}`);
  }
  script ??= await input();
  if (!script.trim()) throw new Error('A browser script is required');
  const relay = await createRelay(await store.get(name));
  let browser;
  const controller = new AbortController();
  let interrupted = false;
  const cleanup = async () => { await browser?.stop(); await relay.close(); };
  const onSignal = () => { interrupted = true; controller.abort(); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    browser = await startBrowser(name, relay.port, { directory: store.directory, signal: controller.signal });
    const result = await browser.execute(script, { timeout });
    // User script output is intentional; internal process logs are stripped.
    const output = result.output.split('\n').filter(line => !/ego-browser\[\d+:.*ApplePersistence=NO/.test(line)).join('\n').trim();
    if (output) console.log(output);
    console.error(JSON.stringify({ preset: name, proxy: 'enabled', connections: relay.stats.connected, failedConnections: relay.stats.failed }));
  } catch (error) { if (!interrupted) throw error; process.exitCode = 130; }
  finally { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); await cleanup(); }
}

main(process.argv.slice(2)).catch(error => { console.error(`ego-proxy: ${error.message}`); process.exitCode = 1; });
