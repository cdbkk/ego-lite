import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { privateDirectory, validateName, atomicJson } from './store.mjs';

const sdkPath = fileURLToPath(new URL('../ego-browser/dist/out/index.js', import.meta.url));
export function cleanEnvironment(input = process.env) {
  const env = { ...input };
  for (const key of Object.keys(env)) {
    if (/^(__CFBundleIdentifier|__CFBundleExecutablePath|RESOURCEPATH|EGO_PROXY_.*|(?:https?|all|no)_proxy)$/i.test(key)) delete env[key];
  }
  return env;
}

export function browserArguments(profile, service, relayPort) {
  if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535) throw new Error('Invalid relay port');
  return [
    '--headless=new', `--user-data-dir=${resolve(profile)}`, `--startup-ego-browser-service=${service}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
    `--proxy-server=http://127.0.0.1:${relayPort}`, '--proxy-bypass-list=<-loopback>',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-features=DnsOverHttpsUpgrade,UseDnsHttpsSvcbAlpn',
  ];
}

function nativeCommand(quiet, service, script, bundle, { input, timeout = 30000, signal } = {}) {
  return new Promise((resolveResult, reject) => {
    if (signal?.aborted) { reject(new Error('Ego run interrupted')); return; }
    const args = [`--ego-server-name=${service}`, 'nodejs', '--sdk-path', bundle];
    if (script !== undefined) args.push('-e', script);
    const child = spawn(quiet, args, { env: cleanEnvironment(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', bytes = 0;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    signal?.addEventListener('abort', kill, { once: true });
    const timer = setTimeout(kill, timeout);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', kill); };
    const capture = data => { bytes += data.length; if (bytes > 1024 * 1024) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } else output += data; };
    child.stdout?.on('data', capture); child.stderr?.on('data', capture);
    child.on('error', () => { cleanup(); reject(new Error('Could not start the ego CLI wrapper')); });
    child.on('close', (code, terminationSignal) => {
      cleanup();
      if (signal?.aborted) { reject(new Error('Ego run interrupted')); return; }
      if (terminationSignal || bytes > 1024 * 1024) reject(new Error('Ego CLI timed out or exceeded its output limit'));
      else resolveResult({ code, output });
    });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}

export async function startBrowser(name, relayPort, {
  directory, app = '/Applications/ego lite.app/Contents/MacOS/ego lite',
  quiet = join(homedir(), '.local/bin/ego-quiet'), bundle = sdkPath, timeout = 15000, signal,
} = {}) {
  if (process.platform !== 'darwin') throw new Error('Native ego integration requires macOS');
  validateName(name);
  if (!directory) throw new Error('A managed profile directory is required');
  await readFile(bundle).catch(() => { throw new Error('Build the fork SDK first: cd package/ego-browser && npm ci && npm run build'); });
  const profile = join(directory, 'profiles', name);
  await privateDirectory(directory); await privateDirectory(join(directory, 'profiles')); await privateDirectory(profile);
  const lock = join(profile, '.ego-proxy.lock');
  try { await writeFile(lock, JSON.stringify({ owner: process.pid }), { flag: 'wx', mode: 0o600 }); }
  catch { throw new Error('This proxy profile is already locked; inspect the owner before removing its .ego-proxy.lock file'); }
  let appProcess;
  let stopPromise;
  const lifetime = new AbortController();
  const abort = () => { void stop(); };
  const stop = () => stopPromise ??= (async () => {
    lifetime.abort(); signal?.removeEventListener('abort', abort);
    if (appProcess?.pid) {
      try { process.kill(-appProcess.pid, 'SIGTERM'); } catch {}
      await sleep(250);
      try { process.kill(-appProcess.pid, 'SIGKILL'); } catch {}
    }
    await unlink(lock).catch(() => {});
  })();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new Error('Ego run interrupted');
    try { await readFile(join(profile, 'ego_config.json')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const existing = JSON.parse(await readFile(join(homedir(), 'Library/Application Support/Citro Labs/ego lite/ego_config.json'), 'utf8'));
      if (existing.not_first_run !== true) throw new Error('Complete onboarding in the installed ego lite app first');
      // Copy only the already-onboarded user's first-run metadata, never profile data.
      await atomicJson(join(profile, 'ego_config.json'), { not_first_run: true, uninstalled_agent_skill_links_removed: true });
    }
    const defaultProfile = join(profile, 'Default');
    await privateDirectory(defaultProfile);
    let preferences;
    try { preferences = JSON.parse(await readFile(join(defaultProfile, 'Preferences'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Managed browser preferences are invalid'); preferences = {}; }
    preferences.webrtc = { ...preferences.webrtc, ip_handling_policy: 'disable_non_proxied_udp' };
    preferences.dns_over_https = { ...preferences.dns_over_https, mode: 'off' };
    preferences.network_prediction_options = 2;
    await atomicJson(join(defaultProfile, 'Preferences'), preferences);
    const service = `ego-proxy-${name}-${randomBytes(8).toString('hex')}`;
    if (signal?.aborted || lifetime.signal.aborted) throw new Error('Ego run interrupted');
    appProcess = spawn(app, browserArguments(profile, service, relayPort), { env: cleanEnvironment(), detached: true, stdio: 'ignore' });
    let appError = false, exited = false;
    appProcess.on('error', () => { appError = true; }); appProcess.on('exit', () => { exited = true; });
    const deadline = Date.now() + timeout;
    const marker = 'EGO_PROXY_READY_' + randomBytes(12).toString('hex');
    for (;;) {
      await sleep(250);
      if (signal?.aborted || lifetime.signal.aborted) throw new Error('Ego run interrupted');
      if (appError || exited) throw new Error('Isolated ego instance exited during startup');
      try {
        const result = await nativeCommand(quiet, service, `cliLog(${JSON.stringify(marker)})`, bundle, { timeout: Math.max(500, Math.min(2500, deadline - Date.now())), signal: lifetime.signal });
        if (result.code === 0 && result.output.includes(marker)) break;
        if (/onboarding/i.test(result.output)) throw new Error('Isolated ego instance requires onboarding');
      } catch (error) {
        if (/onboarding|interrupted/.test(error.message)) throw error;
        if (Date.now() >= deadline) throw new Error('Named ego instance could not be verified; no script was executed');
      }
      if (Date.now() >= deadline) throw new Error('Named ego instance could not be verified; no script was executed');
    }
    return {
      service, profile, pid: appProcess.pid, stop,
      async execute(script, options = {}) {
        if (exited || appError) throw new Error('Isolated ego instance is no longer running');
        const result = await nativeCommand(quiet, service, script, bundle, { ...options, signal: lifetime.signal });
        if (result.code !== 0 || /Please complete the onboarding|Failed to connect to ego_cli/.test(result.output)) {
          const error = new Error(`Ego script failed (exit ${result.code}); native diagnostics are available on error.nativeOutput`);
          error.nativeOutput = result.output;
          throw error;
        }
        return result;
      },
    };
  } catch (error) { await stop(); throw error; }
}
