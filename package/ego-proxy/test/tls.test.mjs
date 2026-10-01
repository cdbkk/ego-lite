import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { checkProxy, parseProxy } from '../relay.mjs';
import { httpProxy, origin, listen } from './fixtures.mjs';

test('TLS upstreams verify certificates, and trusted TLS carries authentication and destination TLS', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ego-proxy-tls-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const certFile = join(dir, 'cert.pem'), keyFile = join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=origin.invalid', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:origin.invalid', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
  const credentials = { cert: await readFile(certFile), key: await readFile(keyFile) };
  const dest = await origin(); t.after(() => dest.close());
  const upstream = await httpProxy({ username: 'user', password: 'tls-secret', credentials }); t.after(() => upstream.close());
  const proxy = parseProxy(`https://user:tls-secret@127.0.0.1:${upstream.port}`);
  await assert.rejects(checkProxy(proxy, { url: `http://origin.invalid:${dest.port}/tls-upstream` }), /Proxy check destination returned a failure/);
  assert.equal(dest.hits.length, 0); assert.equal(upstream.records.length, 0);
  const secureDest = await listen(https.createServer(credentials, (_req, res) => res.end('{"ip":"127.0.0.1"}'))); t.after(() => secureDest.close());
  const plain = await httpProxy(); t.after(() => plain.close());
  await assert.rejects(checkProxy(parseProxy(`http://127.0.0.1:${plain.port}`), { url: `https://127.0.0.1:${secureDest.port}/` }), /TLS or connection failed/);
  const code = `import {checkProxy,parseProxy} from ${JSON.stringify(new URL('../relay.mjs', import.meta.url).href)};
    const a=await checkProxy(parseProxy(${JSON.stringify(`https://user:tls-secret@127.0.0.1:${upstream.port}`)}),{url:${JSON.stringify(`http://origin.invalid:${dest.port}/tls-upstream`)}});
    const b=await checkProxy(parseProxy(${JSON.stringify(`https://user:tls-secret@127.0.0.1:${upstream.port}`)}),{url:${JSON.stringify(`https://origin.invalid:${secureDest.port}/`)}});
    console.log(JSON.stringify({upstream:a.status,destination:b.status,body:b.body}));`;
  // The extra CA exists only in this test subprocess. Production never ignores TLS errors.
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, NODE_EXTRA_CA_CERTS: certFile }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', () => {});
  const [exit] = await once(child, 'exit'); assert.equal(exit, 0);
  const result = JSON.parse(output); assert.equal(result.upstream, 200); assert.equal(result.destination, 200);
  assert.ok(upstream.records.every(r => r.authenticated)); assert.equal(dest.hits.length, 1);
});
