import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp, sourceDates } from '../server.mjs';
import { Rotation, ROTATION_MS } from '../public/rotation.mjs';

const pdf = () => new Response('%PDF-1.7\nTest fixture', { headers: { 'Content-Type': 'application/pdf' } });
const fixedNow = () => new Date('2026-10-16T14:00:00Z');

async function serve(t, options = {}) {
  const server = createApp({ now: fixedNow, logger: { error() {} }, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('rotation changes at exactly 300000 ms and not earlier', () => {
  let clock = 0;
  const timer = new Rotation(() => clock);
  assert.equal(ROTATION_MS, 300000);
  clock = 299999;
  assert.equal(timer.left(), 1);
  clock++;
  assert.equal(timer.left(), 0);
  timer.reset();
  assert.equal(timer.left(), 300000);
});

test('pause freezes time; resume preserves remainder; reset keeps pause state', () => {
  let clock = 0;
  const timer = new Rotation(() => clock);
  clock = 100000;
  timer.toggle();
  clock = 1000000;
  assert.equal(timer.left(), 200000);
  timer.toggle();
  clock += 199999;
  assert.equal(timer.left(), 1);
  clock++;
  assert.equal(timer.left(), 0);
  timer.toggle();
  timer.reset();
  assert.equal(timer.paused, true);
  assert.equal(timer.left(), 300000);
});

test('feed dates honor Eastern timezone, leap year and month/year rollover', () => {
  assert.deepEqual(sourceDates(new Date('2026-01-01T04:00:00Z')).map(d => d.date),
    ['2025-12-31', '2025-12-30', '2025-12-29']);
  assert.deepEqual(sourceDates(new Date('2024-03-01T16:00:00Z')).map(d => d.day), [1, 29, 28]);
});

test('serves app, local PDF worker, and all original newspaper IDs', async t => {
  const base = await serve(t);
  const response = await fetch(`${base}/api/papers`);
  const papers = await response.json();
  assert.equal(papers.length, 12);
  assert.equal(new Set(papers.map(p => p.id)).size, 12);
  assert.equal((await fetch(base)).status, 200);
  const worker = await fetch(`${base}/vendor/build/pdf.worker.mjs`);
  assert.equal(worker.status, 200);
  assert.equal(worker.headers.get('content-type'), 'text/javascript');
  assert.match(worker.headers.get('content-security-policy'), /'wasm-unsafe-eval'/);
  await worker.body.cancel();
  assert.equal((await fetch(`${base}/vendor/iccs/CGATS001Compat-v2-micro.icc`)).status, 200);
  assert.equal((await fetch(`${base}/vendor/wasm/qcms_bg.wasm`)).headers.get('content-type'), 'application/wasm');
});

test('PDF proxy returns original bytes, labels source date, coalesces and caches requests', async t => {
  let calls = 0;
  const base = await serve(t, { fetchPdf: async url => {
    calls++;
    assert.equal(url, 'https://cdn.freedomforum.org/dfp/pdf16/NY_NYT.pdf');
    await new Promise(resolve => setTimeout(resolve, 20));
    return pdf();
  } });
  const responses = await Promise.all([fetch(`${base}/api/paper/NY_NYT`), fetch(`${base}/api/paper/NY_NYT`)]);
  assert.equal(calls, 1);
  for (const response of responses) {
    assert.equal(response.headers.get('x-source-date'), '2026-10-16');
    assert.equal(response.headers.get('x-source-age-days'), '0');
    assert.match(await response.text(), /^%PDF-/);
  }
  await fetch(`${base}/api/paper/NY_NYT`);
  assert.equal(calls, 1);
});

test('only 404 falls back; prior date and age are explicitly returned', async t => {
  const urls = [];
  const base = await serve(t, { fetchPdf: async url => {
    urls.push(url);
    return urls.length < 3 ? new Response('', { status: 404 }) : pdf();
  } });
  const response = await fetch(`${base}/api/paper/NET_DV`);
  assert.equal(response.status, 200);
  assert.equal(urls.length, 3);
  assert.equal(response.headers.get('x-source-date'), '2026-10-14');
  assert.equal(response.headers.get('x-source-age-days'), '2');
});

test('unavailable front pages return a visible error after three attempts', async t => {
  let calls = 0;
  const base = await serve(t, { fetchPdf: async () => { calls++; return new Response('', { status: 404 }); } });
  const response = await fetch(`${base}/api/paper/NET_DV`);
  assert.equal(response.status, 404);
  assert.equal(calls, 3);
  assert.match((await response.json()).error, /No front page/);
});

for (const [name, fetchPdf, message] of [
  ['upstream server failure', async () => new Response('', { status: 503 }), /HTTP 503/],
  ['rate limit', async () => new Response('', { status: 429 }), /HTTP 429/],
  ['network timeout', async () => { throw new Error('Timed out'); }, /Timed out/],
  ['HTML masquerading as PDF', async () => new Response('<html>Oops</html>'), /valid PDF/],
  ['oversized PDF', async () => new Response('%PDF-', { headers: { 'Content-Length': '22000000' } }), /20 MB/]
]) {
  test(`${name} is not cached or silently replaced with an older paper`, async t => {
    let calls = 0;
    const base = await serve(t, { fetchPdf: async (...args) => { calls++; return fetchPdf(...args); } });
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${base}/api/paper/NY_NYT`);
      assert.equal(response.status, 502);
      assert.match((await response.json()).error, message);
    }
    assert.equal(calls, 2);
  });
}

test('unknown paper, missing file, traversal and unsupported methods are rejected', async t => {
  const base = await serve(t, { fetchPdf: async () => { throw new Error('Must not fetch'); } });
  assert.equal((await fetch(`${base}/api/paper/UNTRUSTED`)).status, 404);
  assert.equal((await fetch(`${base}/missing`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e%5cserver.mjs`)).status, 404);
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
  const response = await fetch(`${base}/`, { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
});

test('cache refreshes at twenty minutes and on a new Eastern feed day', async t => {
  let date = new Date('2026-10-16T14:00:00Z');
  let calls = 0;
  const base = await serve(t, { now: () => date, fetchPdf: async () => { calls++; return pdf(); } });
  await fetch(`${base}/api/paper/NY_NYT`);
  date = new Date('2026-10-16T14:19:59Z');
  await fetch(`${base}/api/paper/NY_NYT`);
  assert.equal(calls, 1);
  date = new Date('2026-10-16T14:20:00Z');
  await fetch(`${base}/api/paper/NY_NYT`);
  assert.equal(calls, 2);
  date = new Date('2026-10-17T04:00:00Z');
  await fetch(`${base}/api/paper/NY_NYT`);
  assert.equal(calls, 3);
});
