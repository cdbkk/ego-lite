import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseProxy } from './relay.mjs';

export const defaultDirectory = join(homedir(), 'Library', 'Application Support', 'ego-proxy');
export function validateName(name) {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(name || '')) throw new Error('Preset names must start with a letter and contain at most 48 lowercase letters, digits or hyphens');
  return name;
}

export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new Error('Proxy directory must be owned by the current user with permissions 0700');
  }
}

export async function atomicJson(path, value) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
  finally { await unlink(temporary).catch(() => {}); }
}

// A fixed service/account and a generated hex secret make security's stdin parser safe.
// The master key is sent on stdin, never in process arguments or diagnostic output.
function keychainKey(create) {
  if (process.platform !== 'darwin') throw new Error('Preset storage requires macOS Keychain');
  const args = ['find-generic-password', '-a', 'master-key', '-s', 'co.cdbkk.ego-proxy', '-w'];
  try {
    const key = execFileSync('/usr/bin/security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid master key');
    return Buffer.from(key, 'hex');
  } catch (error) {
    // status 44 is errSecItemNotFound. Other errors must never create a replacement key.
    if (!create || error.status !== 44) throw new Error('Keychain master key unavailable; unlock your login Keychain');
    const key = randomBytes(32);
    try {
      execFileSync('/usr/bin/security', ['-i'], { input: `add-generic-password -a master-key -s co.cdbkk.ego-proxy -w ${key.toString('hex')}\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const persisted = execFileSync('/usr/bin/security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      if (persisted !== key.toString('hex')) throw new Error();
    } catch { throw new Error('Could not save the proxy master key in Keychain'); }
    return key;
  }
}

export class PresetStore {
  constructor({ directory = defaultDirectory, key } = {}) { this.directory = directory; this.testKey = key; }
  async read() {
    await privateDirectory(this.directory);
    try {
      const d = JSON.parse(await readFile(join(this.directory, 'presets.json'), 'utf8'));
      if (d.version !== 1 || !d.presets || typeof d.presets !== 'object' || Array.isArray(d.presets)) throw new Error();
      return d;
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, presets: {} }; throw new Error('Proxy preset store is invalid'); }
  }
  async key(create, hasPresets = false) {
    if (this.testKey) return this.testKey;
    return keychainKey(create && !hasPresets);
  }
  async list() { const d = await this.read(); return Object.keys(d.presets).sort(); }
  async writeLocked(action) {
    await privateDirectory(this.directory);
    const lock = join(this.directory, '.presets.lock');
    try { await writeFile(lock, JSON.stringify({ owner: process.pid }), { flag: 'wx', mode: 0o600 }); }
    catch { throw new Error('Proxy presets are locked by another writer; inspect .presets.lock before retrying'); }
    try { return await action(); } finally { await unlink(lock).catch(() => {}); }
  }
  async get(name) {
    validateName(name);
    const d = await this.read(), item = d.presets[name];
    if (!Object.hasOwn(d.presets, name)) throw new Error(`Unknown proxy preset: ${name}`);
    const key = await this.key(false);
    try {
      const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(item.iv, 'base64'));
      cipher.setAAD(Buffer.from(`ego-proxy:v1:${name}`)); cipher.setAuthTag(Buffer.from(item.tag, 'base64'));
      const url = Buffer.concat([cipher.update(Buffer.from(item.data, 'base64')), cipher.final()]).toString('utf8');
      return parseProxy(url);
    } catch { throw new Error('Proxy preset could not be decrypted or validated'); }
  }
  async set(name, url) {
    validateName(name); parseProxy(url);
    return this.writeLocked(async () => {
    const d = await this.read(), key = await this.key(true, Object.keys(d.presets).length > 0);
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`ego-proxy:v1:${name}`));
    const data = Buffer.concat([cipher.update(url, 'utf8'), cipher.final()]);
    d.presets[name] = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    await atomicJson(join(this.directory, 'presets.json'), d);
    });
  }
  async remove(name) {
    validateName(name);
    return this.writeLocked(async () => {
    const d = await this.read();
    if (!Object.hasOwn(d.presets, name)) throw new Error(`Unknown proxy preset: ${name}`);
    delete d.presets[name]; await atomicJson(join(this.directory, 'presets.json'), d);
    });
  }
}
