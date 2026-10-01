import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBrowser } from '../browser.mjs';
import { parseProxy, createRelay } from '../relay.mjs';
import { origin, httpProxy, socksProxy } from './fixtures.mjs';

// This gate intentionally does not skip missing native software or onboarding.
test('real ego: two named instances use different authenticated proxies; outage cannot reach a local origin directly', { timeout: 90000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ego-proxy-browser-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dest = await origin(); t.after(() => dest.close());
  const http = await httpProxy({ username: 'http-user', password: 'http-secret' });
  const socks = await socksProxy({ username: 'socks-user', password: 'socks-secret' });
  let httpClosed = false;
  t.after(async () => { if (!httpClosed) await http.close(); await socks.close(); });
  const relayA = await createRelay(parseProxy(`http://http-user:http-secret@127.0.0.1:${http.port}`));
  const relayB = await createRelay(parseProxy(`socks5://socks-user:socks-secret@127.0.0.1:${socks.port}`));
  t.after(async () => { await relayA.close(); await relayB.close(); });
  const a = await startBrowser('http-test', relayA.port, { directory }); t.after(() => a.stop());
  const b = await startBrowser('socks-test', relayB.port, { directory }); t.after(() => b.stop());
  assert.notEqual(a.service, b.service); assert.notEqual(a.profile, b.profile);
  const script = (name, route) => `
    const task = await taskSpace(${JSON.stringify(name)});
    const page = task.page("p1");
    await page.goto("http://origin.invalid:${dest.port}/${route}");
    cliLog("BROWSER_ROUTED_" + ${JSON.stringify(route)} + "=" + await page.evaluate(() => document.body.innerText));
    await task.finish({ keep: [] });
  `;
  const ra = await a.execute(script('http proxy integration', 'http'), { timeout: 20000 });
  const rb = await b.execute(script('socks proxy integration', 'socks'), { timeout: 20000 });
  assert.match(ra.output, /BROWSER_ROUTED_http=.*"path":"\/http"/);
  assert.match(rb.output, /BROWSER_ROUTED_socks=.*"path":"\/socks"/);
  assert.ok(http.records.some(r => r.target === `origin.invalid:${dest.port}` && r.authenticated));
  assert.ok(socks.records.some(r => r.host === 'origin.invalid' && r.port === dest.port && r.authenticated));
  assert.ok(dest.hits.every(r => !r.headers['proxy-authorization']));
  const html = await b.execute(`
    const task = await taskSpace("proxy subresources integration"); const page = task.page("p1");
    await page.goto("http://origin.invalid:${dest.port}/html");
    await page.waitForFunction(() => Boolean(document.body.dataset.fetched), undefined, { timeout: 5000 });
    cliLog("SUBRESOURCES_ROUTED=" + await page.evaluate(() => document.body.dataset.fetched));
    await task.finish({ keep: [] });
  `, { timeout: 20000 });
  assert.match(html.output, /SUBRESOURCES_ROUTED=/);
  assert.ok(dest.hits.some(r => r.url === '/fetch')); assert.ok(dest.hits.some(r => r.url === '/image'));
  const rtc = await b.execute(`
    const task = await taskSpace("WebRTC proxy policy gate"); const page = task.page("p1");
    await page.goto("http://origin.invalid:${dest.port}/rtc");
    const result = await page.evaluate(async () => {
      const connection = new RTCPeerConnection({iceServers: []}); const candidates = [];
      connection.createDataChannel("policy-check");
      connection.onicecandidate = event => { if (event.candidate) candidates.push(event.candidate.candidate); };
      await connection.setLocalDescription(await connection.createOffer());
      await new Promise(resolve => { connection.onicegatheringstatechange = () => { if (connection.iceGatheringState === "complete") resolve(); }; setTimeout(resolve, 1500); });
      connection.close(); return {nonRelayCandidates: candidates.filter(c => !c.includes(" typ relay ")).length};
    });
    cliLog("RTC_POLICY=" + JSON.stringify(result)); await task.finish({keep:[]});
  `, { timeout: 15000 });
  assert.match(rtc.output, /RTC_POLICY=\{"nonRelayCandidates":0\}/);
  const before = dest.hits.length;
  await http.close(); httpClosed = true;
  const outage = await a.execute(`
    const task = await taskSpace("proxy outage integration"); const page = task.page("p1");
    let blocked = false;
    try { await page.goto("http://127.0.0.1:${dest.port}/must-not-go-direct"); } catch { blocked = true; }
    const body = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    cliLog("OUTAGE_BLOCKED=" + (blocked || !body.includes('"ok":true')));
    await task.finish({ keep: [] });
  `, { timeout: 20000 });
  assert.match(outage.output, /OUTAGE_BLOCKED=true/);
  assert.equal(dest.hits.length, before); assert.ok(relayA.stats.failed > 0);
  // The other instance continues routing after its neighbour's upstream is gone.
  assert.match((await b.execute(script('socks remains healthy', 'still-socks'))).output, /BROWSER_ROUTED_still-socks=.*"path":"\/still-socks"/);
});
