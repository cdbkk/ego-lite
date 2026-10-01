import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import { once } from 'node:events';

export function parseProxy(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid proxy URL'); }
  const scheme = url.protocol.slice(0, -1);
  if (!['http', 'https', 'socks5', 'socks5h'].includes(scheme)) {
    throw new Error('Use an http, https, socks5 or socks5h proxy URL');
  }
  if (url.pathname && url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Proxy URLs cannot include a path, query or fragment');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || (scheme === 'https' ? 443 : scheme === 'http' ? 80 : 1080));
  let username, password;
  try { username = decodeURIComponent(url.username); password = decodeURIComponent(url.password); }
  catch { throw new Error('Invalid proxy credential encoding'); }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || /[\r\n\0]/.test(username + password)) {
    throw new Error('Invalid proxy endpoint or credentials');
  }
  if (Buffer.byteLength(username) > 255 || Buffer.byteLength(password) > 255) {
    throw new Error('Proxy credentials exceed 255 bytes');
  }
  if (password && !username || username.includes(':')) throw new Error('Invalid proxy username');
  return { scheme: scheme === 'socks5h' ? 'socks5' : scheme, host, port, username, password };
}

function authority(host, port) { return `${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`; }

function tunnelAgent(socket) {
  const agent = new http.Agent({ keepAlive: false });
  agent.createConnection = () => socket;
  return agent;
}

function proxyAuthorization(proxy) {
  return proxy.username ? `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}` : undefined;
}

async function openProxyConnection(proxy, { timeout, signal, onSocket }) {
  const socket = proxy.scheme === 'https'
    ? tls.connect({ host: proxy.host, port: proxy.port, servername: net.isIP(proxy.host) ? undefined : proxy.host })
    : net.connect({ host: proxy.host, port: proxy.port });
  socket.on('error', () => {}); onSocket?.(socket); socket.pause();
  const cancel = () => socket.destroy(new Error('Upstream cancelled'));
  const timer = setTimeout(() => socket.destroy(new Error('Upstream timeout')), timeout);
  signal?.addEventListener('abort', cancel, { once: true });
  socket.once('close', () => signal?.removeEventListener('abort', cancel));
  if (signal?.aborted) cancel();
  try {
    await once(socket, proxy.scheme === 'https' ? 'secureConnect' : 'connect');
    socket.setTimeout(120000, () => socket.destroy()); return socket;
  } catch { socket.destroy(); throw new Error('Upstream connection failed or timed out'); }
  finally { clearTimeout(timer); }
}

// Own the handshake buffer; put surplus tunnel bytes back before forwarding.
class Reader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiter = null;
    this.error = null;
    this.onData = chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.wake(); };
    this.onError = () => { this.error = new Error('Upstream connection failed'); this.wake(); };
    socket.on('data', this.onData).on('error', this.onError).on('end', this.onError).on('close', this.onError);
  }
  wake() { this.waiter?.(); this.waiter = null; }
  async read(size) {
    while (this.buffer.length < size) {
      if (this.error) throw this.error;
      await new Promise(resolve => { this.waiter = resolve; });
    }
    const result = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return result;
  }
  async headers() {
    for (;;) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end >= 0 && end + 4 <= 16384) return (await this.read(end + 4)).toString('latin1');
      if (this.buffer.length >= 16384) throw new Error('Upstream response headers too large');
      if (this.error) throw this.error;
      await new Promise(resolve => { this.waiter = resolve; });
    }
  }
  release() {
    this.socket.pause();
    this.socket.off('data', this.onData).off('error', this.onError).off('end', this.onError).off('close', this.onError);
    if (this.buffer.length) this.socket.unshift(this.buffer);
  }
}

export async function openTunnel(proxy, host, port, { timeout = 10000, signal, onSocket } = {}) {
  if (!host || /[\s\0]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid tunnel destination');
  }
  const socket = proxy.scheme === 'https'
    ? tls.connect({ host: proxy.host, port: proxy.port, servername: net.isIP(proxy.host) ? undefined : proxy.host })
    : net.connect({ host: proxy.host, port: proxy.port });
  socket.on('error', () => {});
  onSocket?.(socket);
  const cancel = () => socket.destroy(new Error('Upstream cancelled'));
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => socket.destroy(new Error('Upstream timeout')), timeout);
  const reader = new Reader(socket);
  try {
    await once(socket, proxy.scheme === 'https' ? 'secureConnect' : 'connect');
    if (proxy.scheme === 'socks5') {
      socket.write(Buffer.from(proxy.username ? [5, 1, 2] : [5, 1, 0]));
      const greeting = await reader.read(2);
      const expected = proxy.username ? 2 : 0;
      if (greeting[0] !== 5 || greeting[1] !== expected) throw new Error('SOCKS5 authentication method rejected');
      if (proxy.username) {
        const user = Buffer.from(proxy.username), pass = Buffer.from(proxy.password);
        socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
        const auth = await reader.read(2);
        if (auth[0] !== 1 || auth[1] !== 0) throw new Error('Proxy authentication failed');
      }
      // Always use the domain-name form, including IP literals. The proxy resolves targets.
      const domain = Buffer.from(host);
      if (domain.length > 255) throw new Error('Tunnel hostname too long');
      const portBytes = Buffer.alloc(2); portBytes.writeUInt16BE(port);
      socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, domain.length]), domain, portBytes]));
      const reply = await reader.read(4);
      if (reply[0] !== 5 || reply[1] !== 0 || reply[2] !== 0) throw new Error('SOCKS5 upstream refused destination');
      const size = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3 ? (await reader.read(1))[0] : -1;
      if (size < 0) throw new Error('Malformed SOCKS5 response');
      await reader.read(size + 2);
    } else {
      const target = authority(host, port);
      const auth = proxy.username ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}\r\n` : '';
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
      const headers = await reader.headers();
      const status = /^HTTP\/1\.[01] (\d{3})(?: |\r)/.exec(headers)?.[1];
      if (status === '407') throw new Error('Proxy authentication failed');
      if (!status || Number(status) < 200 || Number(status) >= 300) throw new Error('HTTP upstream refused destination');
    }
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    reader.release();
    socket.setTimeout(120000, () => socket.destroy());
    return socket;
  } catch (error) {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel); socket.destroy(); reader.release();
    // Network errors can contain endpoint data; expose only our fixed messages.
    if (/^(Proxy authentication|SOCKS5|HTTP upstream|Malformed|Tunnel|Upstream response)/.test(error.message)) throw error;
    throw new Error('Upstream connection failed or timed out');
  }
}

function pendingClient(client, head) {
  const controller = new AbortController();
  const chunks = [head]; let length = head.length;
  const cancel = () => controller.abort();
  const collect = chunk => { length += chunk.length; if (length > 65536) client.destroy(); else chunks.push(chunk); };
  // Drain bounded early tunnel data so FIN is observable while upstream connects.
  client.on('data', collect).once('end', cancel).once('close', cancel); client.resume();
  return {
    signal: controller.signal,
    finish() { client.pause(); client.off('data', collect).off('end', cancel); return Buffer.concat(chunks); },
  };
}

export async function createRelay(proxy, { port = 0, timeout = 10000 } = {}) {
  const sockets = new Set();
  const shutdown = new AbortController();
  const stats = { connected: 0, failed: 0, active: 0 };
  const track = socket => {
    sockets.add(socket); socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 30000, headersTimeout: 10000 }, async (req, res) => {
    let url;
    try { url = new URL(req.url); if (url.protocol !== 'http:' || url.username || url.password) throw new Error(); }
    catch { res.writeHead(400).end('Absolute HTTP URL required'); return; }
    let tunnel;
    const cancelled = new AbortController();
    req.once('aborted', () => cancelled.abort()); res.once('close', () => cancelled.abort());
    try {
      const options = { timeout, signal: AbortSignal.any([shutdown.signal, cancelled.signal]), onSocket: track };
      const viaSocks = proxy.scheme === 'socks5';
      tunnel = viaSocks
        ? await openTunnel(proxy, url.hostname.replace(/^\[|\]$/g, ''), Number(url.port || 80), options)
        : await openProxyConnection(proxy, options);
      if (req.destroyed) { tunnel.destroy(); return; }
      const headers = { ...req.headers, host: url.host };
      const remove = ['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', ...(req.headers.connection || '').split(',').map(s => s.trim().toLowerCase())];
      for (const header of remove) delete headers[header];
      if (!viaSocks && proxyAuthorization(proxy)) headers['proxy-authorization'] = proxyAuthorization(proxy);
      const outgoing = http.request({ hostname: url.hostname, port: url.port || 80, method: req.method, path: viaSocks ? url.pathname + url.search : url.href, headers, agent: tunnelAgent(tunnel) }, response => {
        outgoing.setTimeout(120000);
        if (!viaSocks && response.statusCode === 407) { stats.failed++; response.resume(); res.writeHead(502).end('Proxy upstream unavailable'); return; }
        stats.connected++;
        const responseHeaders = { ...response.headers };
        for (const h of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-authentication-info', ...(response.headers.connection || '').split(',').map(s => s.trim().toLowerCase())]) delete responseHeaders[h];
        let responseFailed = false;
        const failResponse = () => { if (responseFailed) return; responseFailed = true; stats.failed++; res.destroy(); };
        response.on('aborted', failResponse).on('error', failResponse);
        res.writeHead(response.statusCode, responseHeaders); response.pipe(res);
      });
      outgoing.on('error', () => { stats.failed++; if (!res.headersSent) res.writeHead(502).end('Proxy upstream unavailable'); else res.destroy(); });
      outgoing.setTimeout(timeout, () => outgoing.destroy(new Error('Upstream response timed out')));
      req.on('aborted', () => outgoing.destroy());
      res.on('close', () => outgoing.destroy());
      req.pipe(outgoing);
      process.nextTick(() => tunnel.resume());
    } catch { stats.failed++; tunnel?.destroy(); if (!res.destroyed) res.writeHead(502).end('Proxy upstream unavailable'); }
  });
  server.maxConnections = 128;
  server.on('connection', track);
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connect', async (req, client, head) => {
    const pending = pendingClient(client, head);
    let host, targetPort;
    try {
      const match = /^(\[[^\]]+\]|[^:\s/]+):(\d+)$/.exec(req.url);
      if (!match) throw new Error();
      host = match[1].replace(/^\[|\]$/g, ''); targetPort = Number(match[2]);
      if (targetPort < 1 || targetPort > 65535) throw new Error();
    } catch { client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
    try {
      const remote = await openTunnel(proxy, host, targetPort, { timeout, signal: AbortSignal.any([shutdown.signal, pending.signal]), onSocket: track });
      if (client.destroyed || pending.signal.aborted) { remote.destroy(); return; }
      const early = pending.finish();
      stats.connected++; stats.active++;
      client.once('close', () => { stats.active--; remote.destroy(); });
      remote.once('close', () => client.destroy());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (early.length) remote.write(early);
      client.pipe(remote); remote.pipe(client); client.resume();
    } catch { stats.failed++; client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); }
  });
  // Forward upgrades in absolute form to HTTP proxies, or in origin form inside SOCKS tunnels.
  server.on('upgrade', async (req, client, head) => {
    const pending = pendingClient(client, head);
    try {
      const url = new URL(req.url);
      if (!['http:', 'ws:'].includes(url.protocol) || url.username || url.password) throw new Error();
      const options = { timeout, signal: AbortSignal.any([shutdown.signal, pending.signal]), onSocket: track };
      const viaSocks = proxy.scheme === 'socks5';
      const remote = viaSocks
        ? await openTunnel(proxy, url.hostname.replace(/^\[|\]$/g, ''), Number(url.port || 80), options)
        : await openProxyConnection(proxy, options);
      if (client.destroyed || pending.signal.aborted) { remote.destroy(); return; }
      const early = pending.finish();
      stats.connected++;
      const headers = { ...req.headers, host: url.host };
      delete headers['proxy-authorization']; delete headers['proxy-connection'];
      if (!viaSocks && proxyAuthorization(proxy)) headers['proxy-authorization'] = proxyAuthorization(proxy);
      const path = viaSocks ? url.pathname + url.search : url.href.replace(/^ws:/, 'http:');
      remote.write(`${req.method} ${path} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (early.length) remote.write(early);
      client.once('close', () => remote.destroy()); remote.once('close', () => client.destroy());
      client.pipe(remote); remote.pipe(client); client.resume();
    } catch { stats.failed++; client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); }
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port, stats,
    async close() { shutdown.abort(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}

export async function checkProxy(proxy, { url = 'https://api.ipify.org?format=json', timeout = 10000 } = {}) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Check URL must use HTTP or HTTPS without credentials');
  const started = performance.now();
  const relay = await createRelay(proxy, { timeout });
  try {
    const tunnel = target.protocol === 'https:' ? await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: relay.port, method: 'CONNECT', path: authority(target.hostname.replace(/^\[|\]$/g, ''), Number(target.port || (target.protocol === 'https:' ? 443 : 80))), timeout }, (res) => { res.resume(); reject(new Error('Proxy check did not establish a tunnel')); });
      request.on('connect', (res, socket, head) => { if (res.statusCode !== 200) { socket.destroy(); reject(new Error('Proxy check failed')); } else { if (head.length) socket.unshift(head); resolve(socket); } });
      request.on('timeout', () => request.destroy(new Error('Proxy check timed out'))).on('error', () => reject(new Error('Proxy check failed'))); request.end();
    }) : null;
    const result = await new Promise((resolve, reject) => {
      const host = target.hostname.replace(/^\[|\]$/g, '');
      const transport = tunnel ? tls.connect({ socket: tunnel, host, servername: net.isIP(host) ? undefined : host }) : null;
      const options = transport
        ? { hostname: host, method: 'GET', path: target.pathname + target.search, headers: { Host: target.host }, agent: tunnelAgent(transport), timeout }
        : { host: '127.0.0.1', port: relay.port, method: 'GET', path: target.href, headers: { Host: target.host }, timeout };
      const request = http.request(options, res => {
        let data = ''; res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; if (data.length > 65536) request.destroy(new Error('Proxy check response too large')); });
        res.on('error', () => reject(new Error('Proxy check response failed')));
        res.on('end', () => { if (res.statusCode < 200 || res.statusCode >= 300) reject(new Error('Proxy check destination returned a failure')); else resolve({ status: res.statusCode, body: data, elapsedMs: Math.round(performance.now() - started) }); });
      });
      transport?.on('error', () => request.destroy(new Error('Proxy check TLS or connection failed')));
      request.on('timeout', () => request.destroy(new Error('Proxy check timed out'))).on('error', () => reject(new Error('Proxy check TLS or connection failed'))); request.end();
      if (transport) process.nextTick(() => transport.resume());
    });
    return result;
  } finally { await relay.close(); }
}
