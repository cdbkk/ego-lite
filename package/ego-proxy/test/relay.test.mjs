import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { once } from 'node:events';
import { parseProxy, createRelay, checkProxy } from '../relay.mjs';
import { origin, httpProxy, socksProxy, viaRelay, listen } from './fixtures.mjs';

test('proxy URL validation rejects malformed endpoints without echoing secrets', () => {
  assert.deepEqual(parseProxy('socks5h://user:p%40ss@localhost:1080'), { scheme: 'socks5', host: 'localhost', port: 1080, username: 'user', password: 'p@ss' });
  assert.equal(parseProxy('http://[::1]:8080').host, '::1');
  for (const value of ['direct://localhost', 'http://user:SECRET@localhost/path', 'http://localhost?x=SECRET', 'http://bad%0A:SECRET@localhost', 'http://user%3Aname:SECRET@localhost']) {
    assert.throws(() => parseProxy(value), error => !error.message.includes('SECRET'));
  }
});

for (const protocol of ['http', 'socks5']) {
  test(`${protocol}: authenticated GET and streamed POST use upstream remote DNS; credentials never reach origin`, async t => {
    const dest = await origin(); t.after(() => dest.close());
    const upstream = await (protocol === 'http' ? httpProxy : socksProxy)({ username: 'u', password: 'SECRET' }); t.after(() => upstream.close());
    const relay = await createRelay(parseProxy(`${protocol}://u:SECRET@127.0.0.1:${upstream.port}`)); t.after(() => relay.close());
    const url = `http://origin.invalid:${dest.port}/hello`;
    const get = await viaRelay(relay.port, url);
    assert.equal(get.status, 200); assert.equal(JSON.parse(get.body).path, '/hello');
    const post = await viaRelay(relay.port, url, { method: 'POST', body: 'upload payload', headers: { 'proxy-authorization': 'must not reach origin' } });
    assert.equal(post.status, 200); assert.equal(JSON.parse(post.body).body, 'upload payload');
    assert.equal(dest.hits.length, 2); assert.equal(upstream.records.length, 2);
    assert.ok(upstream.records.every(r => r.authenticated));
    assert.ok(dest.hits.every(r => !r.headers['proxy-authorization']));
    if (protocol === 'socks5') assert.ok(upstream.records.every(r => r.host === 'origin.invalid'));
  });

  test(`${protocol}: wrong credentials block traffic without a direct retry`, async t => {
    const dest = await origin(); t.after(() => dest.close());
    const upstream = await (protocol === 'http' ? httpProxy : socksProxy)({ username: 'u', password: 'correct' }); t.after(() => upstream.close());
    const relay = await createRelay(parseProxy(`${protocol}://u:wrong@127.0.0.1:${upstream.port}`)); t.after(() => relay.close());
    const response = await viaRelay(relay.port, `http://127.0.0.1:${dest.port}/direct-is-reachable`);
    assert.equal(response.status, 502); assert.equal(dest.hits.length, 0); assert.equal(relay.stats.failed, 1);
  });
}

test('dead upstream refuses locally reachable destinations', async t => {
  const dest = await origin(); t.after(() => dest.close());
  const upstream = await httpProxy(); const deadPort = upstream.port; await upstream.close();
  const relay = await createRelay(parseProxy(`http://127.0.0.1:${deadPort}`), { timeout: 200 }); t.after(() => relay.close());
  assert.equal((await viaRelay(relay.port, `http://127.0.0.1:${dest.port}/no-fallback`)).status, 502);
  assert.equal(dest.hits.length, 0);
});

test('CONNECT and WebSocket upgrades preserve bidirectional bytes through upstream', async t => {
  const dest = await origin(); t.after(() => dest.close());
  const upstream = await socksProxy(); t.after(() => upstream.close());
  const relay = await createRelay(parseProxy(`socks5://127.0.0.1:${upstream.port}`)); t.after(() => relay.close());
  const socket = net.connect(relay.port, '127.0.0.1'); socket.on('error', () => {}); t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write(`CONNECT origin.invalid:${dest.port} HTTP/1.1\r\nHost: origin.invalid:${dest.port}\r\n\r\n`);
  let data = ''; socket.on('data', chunk => data += chunk);
  while (!data.includes('\r\n\r\n')) await once(socket, 'data');
  assert.match(data, /200 Connection Established/);
  socket.write(`GET /tunnel HTTP/1.1\r\nHost: origin.invalid:${dest.port}\r\nConnection: close\r\n\r\n`);
  await once(socket, 'close'); assert.match(data, /"path":"\/tunnel"/);
  const ws = net.connect(relay.port, '127.0.0.1'); ws.on('error', () => {}); t.after(() => ws.destroy()); await once(ws, 'connect');
  let bytes = ''; ws.on('data', chunk => bytes += chunk);
  ws.write(`GET http://origin.invalid:${dest.port}/ws HTTP/1.1\r\nHost: origin.invalid:${dest.port}\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n`);
  while (!bytes.includes('\r\n\r\n')) await once(ws, 'data');
  assert.match(bytes, /101 Switching/); ws.write('bidirectional');
  while (!bytes.includes('bidirectional')) await once(ws, 'data');
  assert.ok(upstream.records.length >= 2);
});

test('proxy checks use the relay and do not return arbitrary origin bodies to the CLI', async t => {
  const dest = await origin(); t.after(() => dest.close());
  const upstream = await httpProxy(); t.after(() => upstream.close());
  const result = await checkProxy(parseProxy(`http://127.0.0.1:${upstream.port}`), { url: `http://origin.invalid:${dest.port}/check` });
  assert.equal(result.status, 200); assert.equal(upstream.records.length, 1); assert.equal(dest.hits.length, 1);
});

test('truncated upstream HTTP bodies abort downstream promptly instead of hanging', { timeout: 3000 }, async t => {
  const dest = await listen(http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Length': '100' }); res.write('short'); setTimeout(() => res.destroy(), 10);
  })); t.after(() => dest.close());
  const proxy = await httpProxy(); t.after(() => proxy.close());
  const relay = await createRelay(parseProxy(`http://127.0.0.1:${proxy.port}`)); t.after(() => relay.close());
  await new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: relay.port, path: `http://origin.invalid:${dest.port}/` }, response => {
      response.resume(); response.on('error', () => {}); response.once('aborted', resolve); response.once('end', () => reject(new Error('Truncated response incorrectly completed')));
    }); request.once('error', reject);
  });
  assert.equal(relay.stats.failed, 1);
});

test('HTTP forwarding and checks work with a proxy that forbids CONNECT', async t => {
  const dest = await origin(); t.after(() => dest.close());
  const proxy = await httpProxy({ username: 'u', password: 'secret', allowConnect: false }); t.after(() => proxy.close());
  const endpoint = parseProxy(`http://u:secret@127.0.0.1:${proxy.port}`);
  const relay = await createRelay(endpoint); t.after(() => relay.close());
  assert.equal((await viaRelay(relay.port, `http://origin.invalid:${dest.port}/forward-only`)).status, 200);
  assert.equal((await checkProxy(endpoint, { url: `http://origin.invalid:${dest.port}/check-forward-only` })).status, 200);
  assert.ok(proxy.records.every(r => r.method === 'GET' && r.authenticated));
  assert.ok(dest.hits.every(r => !r.headers['proxy-authorization']));
});
