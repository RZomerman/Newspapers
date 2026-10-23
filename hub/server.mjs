import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import { papers } from './papers.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const MAX_PDF = 20 * 1024 * 1024;
const MAX_CACHE = 64 * 1024 * 1024;
const CACHE_MS = 20 * 60 * 1000;

export function sourceDates(now = new Date()) {
  // The original feed uses US Eastern publication days, including month rollover.
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
  return [0, 1, 2].map(offset => {
    const day = new Date(`${date}T12:00:00Z`);
    day.setUTCDate(day.getUTCDate() - offset);
    return { date: day.toISOString().slice(0, 10), day: day.getUTCDate(), offset };
  });
}

export function createApp({ fetchPdf = fetch, now = () => new Date(), logger = console } = {}) {
  const cache = new Map();
  const pending = new Map();
  let cacheBytes = 0;
  // Changes on every server start so open pages can detect an update and reload.
  const boot = Date.now().toString(36);

  async function newspaper(id) {
    const dates = sourceDates(now());
    const key = `${dates[0].date}:${id}`;
    const cached = cache.get(key);
    if (cached && cached.expires > now().getTime()) return cached;
    if (pending.has(key)) return pending.get(key);
    const work = (async () => {
      for (const candidate of dates) {
        const url = `https://cdn.freedomforum.org/dfp/pdf${candidate.day}/${id}.pdf`;
        const response = await fetchPdf(url, { signal: AbortSignal.timeout(15000) });
        if (response.status === 404) {
          await response.body?.cancel();
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Newspaper source returned HTTP ${response.status}`);
        }
        if (Number(response.headers.get('content-length')) > MAX_PDF) {
          await response.body?.cancel();
          throw new Error('Source PDF exceeds the 20 MB size limit');
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > MAX_PDF) throw new Error('Source PDF exceeds the 20 MB size limit');
          chunks.push(chunk);
        }
        const data = Buffer.concat(chunks);
        if (!data.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
          throw new Error('Newspaper source did not return a valid PDF');
        }
        const entry = { data, ...candidate, expires: now().getTime() + CACHE_MS };
        const previous = cache.get(key);
        if (previous) {
          cacheBytes -= previous.data.length;
          cache.delete(key);
        }
        while (cacheBytes + size > MAX_CACHE && cache.size) {
          const oldest = cache.keys().next().value;
          cacheBytes -= cache.get(oldest).data.length;
          cache.delete(oldest);
        }
        cache.set(key, entry);
        cacheBytes += size;
        return entry;
      }
      const error = new Error('No front page available for today or the previous two days');
      error.status = 404;
      throw error;
    })();
    pending.set(key, work);
    try {
      return await work;
    } finally {
      pending.delete(key);
    }
  }

  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'");
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' }).end();
        return;
      }
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname === '/api/papers') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(papers));
        return;
      }
      if (pathname === '/api/version') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ boot }));
        return;
      }
      if (pathname.startsWith('/api/paper/')) {
        const id = pathname.slice('/api/paper/'.length);
        if (!papers.some(paper => paper.id === id)) {
          res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Unknown newspaper' }));
          return;
        }
        const entry = await newspaper(id);
        res.writeHead(200, {
          'Content-Type': 'application/pdf', 'Content-Length': entry.data.length,
          'Cache-Control': 'no-store', 'X-Source-Date': entry.date,
          'X-Source-Age-Days': entry.offset
        });
        res.end(req.method === 'HEAD' ? undefined : entry.data);
        return;
      }
      const vendor = pathname.startsWith('/vendor/');
      const base = resolve(root, vendor ? 'node_modules\\pdfjs-dist' : 'public');
      const relative = vendor ? pathname.slice('/vendor/'.length) : pathname === '/' ? 'index.html' : pathname.slice(1);
      const file = resolve(base, relative);
      if (!file.startsWith(base + sep)) {
        res.writeHead(403).end();
        return;
      }
      const ext = file.split('.').pop();
      const mime = {
        html: 'text/html; charset=utf-8', css: 'text/css', mjs: 'text/javascript',
        js: 'text/javascript', bcmap: 'application/octet-stream', pfb: 'application/octet-stream',
        ttf: 'font/ttf', wasm: 'application/wasm'
      }[ext] || 'application/octet-stream';
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': vendor ? 'public, max-age=86400' : 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') {
        res.writeHead(404).end();
        return;
      }
      logger.error('Newspaper request failed:', error);
      res.writeHead(error.status || 502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const server = createApp();
  server.on('error', error => {
    console.error('Cannot start newspaper viewer:', error);
    process.exitCode = 1;
  });
  server.listen(port, host, () => console.log(`Newspaper viewer: http://${host}:${port}`));
}
