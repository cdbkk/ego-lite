import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { createRelay, parseProxy } from '../relay.mjs';
import { listen, origin, httpProxy } from './fixtures.mjs';

function bounded(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  })]).finally(() => clearTimeout(timer));
}

async function client(t, port) {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  let bytes = '';
  socket.on('data', chunk => { bytes += chunk.toString('latin1'); });
  await once(socket, 'connect');
  return { socket, async until(text) {
    while (!bytes.includes(text)) {
      await bounded(once(socket, 'data'), 1000, `Client never received ${text}`);
    }
    return bytes;
  } };
}

for (const [name, scheme, response] of [
  ['truncated HTTP headers', 'http', 'HTTP/1.1 200 Connection Established\r\n'],
  ['oversized HTTP headers', 'http', `HTTP/1.1 200 OK\r\nX-Fill: ${'x'.repeat(16384)}\r\n\r\n`],
  ['truncated SOCKS5 greeting', 'socks5', Buffer.from([5])],
]) {
  test(`${name} fail closed without contacting a reachable destination`, { timeout: 3000 }, async t => {
    const dest = await origin(); t.after(() => dest.close());
    const upstream = await listen(net.createServer(socket => {
      socket.once('data', () => socket.end(response));
    })); t.after(() => upstream.close());
    const relay = await createRelay(parseProxy(`${scheme}://127.0.0.1:${upstream.port}`), { timeout: 300 });
    t.after(() => relay.close());
    const request = await client(t, relay.port);
    request.socket.write(`CONNECT 127.0.0.1:${dest.port} HTTP/1.1\r\nHost: 127.0.0.1:${dest.port}\r\n\r\nGET /must-not-arrive HTTP/1.1\r\nHost: 127.0.0.1:${dest.port}\r\nConnection: close\r\n\r\n`);
    assert.equal(await request.until('\r\n\r\n'), 'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    assert.equal(dest.hits.length, 0);
    assert.equal(relay.stats.connected, 0);
    assert.equal(relay.stats.failed, 1);
  });
}

test('a silent upstream handshake times out and closes its socket', { timeout: 3000 }, async t => {
  let accepted;
  const handshake = new Promise(resolve => { accepted = resolve; });
  const upstream = await listen(net.createServer(socket => {
    socket.once('data', () => accepted({ closed: once(socket, 'close') }));
  })); t.after(() => upstream.close());
  const relay = await createRelay(parseProxy(`http://fixture-user:fixture-secret@127.0.0.1:${upstream.port}`), { timeout: 100 });
  t.after(() => relay.close());
  const request = await client(t, relay.port);
  const started = performance.now();
  request.socket.write('CONNECT destination.invalid:443 HTTP/1.1\r\nHost: destination.invalid:443\r\n\r\n');
  const { closed } = await handshake;
  assert.equal(await request.until('\r\n\r\n'), 'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  assert.ok(performance.now() - started < 1500, 'Handshake deadline did not bound the request');
  await bounded(closed, 500, 'Timed-out upstream socket remained open');
  assert.equal(relay.stats.connected, 0);
});

test('relay.close cancels a stalled CONNECT handshake promptly', { timeout: 3000 }, async t => {
  let accepted;
  const handshake = new Promise(resolve => { accepted = resolve; });
  const upstream = await listen(net.createServer(socket => {
    socket.once('data', () => accepted({ closed: once(socket, 'close') }));
  })); t.after(() => upstream.close());
  const relay = await createRelay(parseProxy(`http://127.0.0.1:${upstream.port}`), { timeout: 1500 });
  let closing;
  t.after(() => closing ?? relay.close());
  const { socket } = await client(t, relay.port);
  socket.write('CONNECT destination.invalid:443 HTTP/1.1\r\nHost: destination.invalid:443\r\n\r\n');
  const { closed } = await handshake;
  closing = relay.close();
  await bounded(Promise.all([closing, closed]), 500, 'Relay shutdown left the upstream handshake open until its timeout');
  assert.equal(relay.stats.connected, 0);
  assert.equal(relay.stats.active, 0);
});

for (const kind of ['CONNECT', 'WebSocket']) {
  test(`${kind}: client disconnect cancels a pending upstream handshake`, { timeout: 3000 }, async t => {
    let accepted;
    const handshake = new Promise(resolve => { accepted = resolve; });
    const upstream = await listen(net.createServer(socket => {
      socket.once('data', () => accepted({ closed: once(socket, 'close') }));
    })); t.after(() => upstream.close());
    const relay = await createRelay(parseProxy(`http://127.0.0.1:${upstream.port}`), { timeout: 1500 });
    t.after(() => relay.close());
    const { socket } = await client(t, relay.port);
    socket.write(kind === 'CONNECT'
      ? 'CONNECT destination.invalid:443 HTTP/1.1\r\nHost: destination.invalid:443\r\n\r\n'
      : 'GET http://destination.invalid/ws HTTP/1.1\r\nHost: destination.invalid\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n');
    const { closed } = await handshake;
    socket.destroy();
    await bounded(closed, 500, 'Disconnected client left the upstream handshake open until its timeout');
    assert.equal(relay.stats.connected, 0);
    assert.equal(relay.stats.active, 0);
  });
}

test('authenticated CONNECT and WebSocket routes keep proxy credentials out of origin headers', { timeout: 5000 }, async t => {
  const dest = await origin(); t.after(() => dest.close());
  const upstream = await httpProxy({ username: 'fixture-user', password: 'fixture-secret' });
  t.after(() => upstream.close());
  const relay = await createRelay(parseProxy(`http://fixture-user:fixture-secret@127.0.0.1:${upstream.port}`));
  t.after(() => relay.close());
  const tunnel = await client(t, relay.port);
  tunnel.socket.write(`CONNECT origin.invalid:${dest.port} HTTP/1.1\r\nHost: origin.invalid:${dest.port}\r\nProxy-Authorization: Basic client-secret\r\n\r\n`);
  await tunnel.until('200 Connection Established');
  tunnel.socket.write(`GET /connect-secret-check HTTP/1.1\r\nHost: origin.invalid:${dest.port}\r\nConnection: close\r\n\r\n`);
  await tunnel.until('"path":"/connect-secret-check"');
  const ws = await client(t, relay.port);
  ws.socket.write(`GET http://origin.invalid:${dest.port}/ws HTTP/1.1\r\nHost: origin.invalid:${dest.port}\r\nProxy-Authorization: Basic client-secret\r\nProxy-Connection: keep-alive\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n`);
  await ws.until('101 Switching Protocols');
  assert.equal(upstream.records.length, 2);
  assert.ok(upstream.records.every(record => record.authenticated));
  assert.equal(dest.hits.length, 2);
  for (const hit of dest.hits) {
    assert.equal(hit.headers['proxy-authorization'], undefined);
    assert.equal(hit.headers['proxy-connection'], undefined);
    assert.doesNotMatch(JSON.stringify(hit.headers), /fixture-secret|client-secret|Zml4dHVyZS11c2VyOmZpeHR1cmUtc2VjcmV0/);
  }
});
