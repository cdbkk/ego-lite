import net from 'node:net';
import http from 'node:http';
import tls from 'node:tls';
import { once } from 'node:events';

export async function listen(server) {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, port: server.address().port, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

export async function origin() {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk);
    req.on('end', () => {
      hits.push({ url: req.url, method: req.method, headers: req.headers, body });
      if (req.url === '/html') { res.setHeader('Content-Type', 'text/html'); res.end('<html><title>Proxy fixture</title><body>routed<script>fetch("/fetch").then(r=>r.text()).then(t=>document.body.dataset.fetched=t)</script><img src="/image"></body></html>'); }
      else res.end(JSON.stringify({ ok: true, body, path: req.url }));
    });
  });
  server.on('upgrade', (req, socket, head) => {
    hits.push({ url: req.url, headers: req.headers });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n');
    if (head.length) socket.write(head);
    socket.on('data', chunk => socket.write(chunk));
  });
  return { ...await listen(server), hits };
}

export async function httpProxy({ username = '', password = '', denied = false, credentials, allowConnect = true } = {}) {
  const records = [];
  const required = username ? 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64') : undefined;
  const parser = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url); if (url.protocol !== 'http:') throw new Error(); }
    catch { res.writeHead(400).end(); return; }
    const authenticated = !denied && req.headers['proxy-authorization'] === required;
    records.push({ target: url.host, method: req.method, authenticated });
    if (!authenticated) { res.writeHead(407).end(); return; }
    const headers = { ...req.headers, host: url.host };
    delete headers['proxy-authorization']; delete headers['proxy-connection'];
    const outgoing = http.request({ host: '127.0.0.1', port: url.port || 80, method: req.method, path: url.pathname + url.search, headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    outgoing.on('error', () => res.destroy()); res.on('close', () => outgoing.destroy()); req.pipe(outgoing);
  });
  const server = credentials ? tls.createServer(credentials) : parser;
  const handle = (req, client, head) => {
    records.push({ target: req.url, method: 'CONNECT', authenticated: req.headers['proxy-authorization'] === required });
    if (denied || req.headers['proxy-authorization'] !== required) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'); return; }
    if (!allowConnect) { client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return; }
    const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url);
    if (!match) { client.destroy(); return; }
    const remote = net.connect(Number(match[2]), '127.0.0.1'); remote.on('error', () => client.destroy());
    remote.on('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head); client.pipe(remote); remote.pipe(client); });
    client.on('close', () => remote.destroy()); remote.on('close', () => client.destroy());
  };
  parser.on('connect', handle);
  parser.on('upgrade', (req, client, head) => {
    let url;
    try { url = new URL(req.url); } catch { client.destroy(); return; }
    const authenticated = !denied && req.headers['proxy-authorization'] === required;
    records.push({ target: url.host, method: 'UPGRADE', authenticated });
    if (!authenticated) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n'); return; }
    const remote = net.connect(Number(url.port || 80), '127.0.0.1'); remote.on('error', () => client.destroy());
    remote.on('connect', () => {
      const headers = { ...req.headers, host: url.host }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
      remote.write(`${req.method} ${url.pathname + url.search} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (head.length) remote.write(head); client.pipe(remote); remote.pipe(client);
    });
    client.on('close', () => remote.destroy()); remote.on('close', () => client.destroy());
  });
  if (credentials) {
    // Feed TLS streams into an HTTP parser, keeping the upstream independently encrypted.
    server.on('secureConnection', socket => parser.emit('connection', socket));
  }
  return { ...await listen(server), records };
}

export async function socksProxy({ username = '', password = '', denied = false } = {}) {
  const records = [];
  const server = net.createServer(async socket => {
    let buffer = Buffer.alloc(0), wake, ended = false;
    const data = chunk => { buffer = Buffer.concat([buffer, chunk]); wake?.(); wake = null; };
    socket.on('data', data); socket.on('close', () => { ended = true; wake?.(); });
    const read = async n => { while (buffer.length < n) { if (ended) throw new Error('closed'); await new Promise(resolve => wake = resolve); } const result = buffer.subarray(0, n); buffer = buffer.subarray(n); return result; };
    try {
      const greeting = await read(2), methods = await read(greeting[1]);
      if (greeting[0] !== 5 || !methods.includes(username ? 2 : 0)) throw new Error('bad greeting');
      socket.write(Buffer.from([5])); await new Promise(r => setTimeout(r, 2)); socket.write(Buffer.from([username ? 2 : 0]));
      let authenticated = !username;
      if (username) {
        const authHeader = await read(2), user = (await read(authHeader[1])).toString();
        const length = (await read(1))[0], pass = (await read(length)).toString();
        authenticated = !denied && user === username && pass === password;
        socket.write(Buffer.from([1, authenticated ? 0 : 1]));
        if (!authenticated) { socket.end(); return; }
      }
      const request = await read(5);
      if (request[0] !== 5 || request[1] !== 1 || request[3] !== 3) throw new Error('expected remote DNS');
      const host = (await read(request[4])).toString(), port = (await read(2)).readUInt16BE();
      records.push({ host, port, authenticated });
      if (denied) { socket.end(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0, 0])); return; }
      const remote = net.connect(port, '127.0.0.1'); remote.on('error', () => socket.destroy());
      await once(remote, 'connect'); socket.pause(); socket.off('data', data);
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
      if (buffer.length) remote.write(buffer);
      socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy());
      socket.pipe(remote); remote.pipe(socket); socket.resume();
    } catch { socket.destroy(); }
  });
  return { ...await listen(server), records };
}

export function viaRelay(port, url, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers, timeout: 5000 }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', chunk => data += chunk); res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('Fixture request timed out'))); req.on('error', reject); req.end(body);
  });
}
