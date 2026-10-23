import * as pdfjs from '/vendor/build/pdf.mjs';
import { Rotation, ROTATION_MS } from './rotation.mjs';
import { bindSwipes } from './swipe.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/build/pdf.worker.mjs';
const $ = selector => document.querySelector(selector);
const rotation = new Rotation();
let papers = [];
let index = 0;
let nextIndex = 0;
let historyPosition = -1;
const history = [];
let views = [];
let loading = false;
let wakeLock;
let idleTimer;

function notice(message) {
  const text = document.createElement('span');
  text.textContent = message;
  const dismiss = document.createElement('button');
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', () => { $('#notice').hidden = true; });
  $('#notice').replaceChildren(text, dismiss);
  $('#notice').hidden = false;
  console.error(message);
}

function pauseForReading() {
  if (!rotation.paused) rotation.toggle();
  updateTimer();
}

function updateTimer() {
  const remaining = rotation.left();
  const seconds = Math.ceil(remaining / 1000);
  $('#countdown').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  $('#progress').value = remaining;
  $('#pause').textContent = rotation.paused ? 'Resume' : 'Pause';
  $('#status').textContent = loading ? 'Loading original PDFs' : rotation.paused ? 'Paused · take your time' : 'Next perspectives in';
}

class PaperView {
  constructor(paper) {
    this.paper = paper;
    this.zoom = 1;
    this.generation = 0;
    this.element = document.createElement('article');
    this.element.className = 'paper';
    this.element.innerHTML = `<header class="paper-header"><div><h2></h2><p class="paper-meta"></p></div><div class="paper-tools"><a target="_blank" rel="noopener">PDF</a><button class="minus">−</button><button class="fit">Fit</button><button class="plus">+</button></div></header><div class="page-viewport" tabindex="0"><div class="page-sheet"><p class="loading">Opening the original color front page…</p></div></div>`;
    this.element.querySelector('h2').textContent = paper.name;
    this.meta = this.element.querySelector('.paper-meta');
    this.meta.textContent = paper.location;
    this.viewport = this.element.querySelector('.page-viewport');
    this.viewport.setAttribute('aria-label', `${paper.name} front page; swipe left or right to change newspapers, or zoom to scroll and read`);
    this.sheet = this.element.querySelector('.page-sheet');
    this.bindTapZoom();
    const link = this.element.querySelector('a');
    link.href = `/api/paper/${paper.id}`;
    link.setAttribute('aria-label', `Open ${paper.name} original PDF`);
    for (const [selector, label, action] of [
      ['.minus', 'Zoom out', () => this.setZoom(this.zoom - .5)],
      ['.plus', 'Zoom in', () => this.setZoom(this.zoom + .5)],
      ['.fit', 'Fit entire page', () => this.setZoom(1)]
    ]) {
      const button = this.element.querySelector(selector);
      button.setAttribute('aria-label', `${label}: ${paper.name}`);
      button.addEventListener('click', action);
    }
  }

  async load() {
    this.abort = new AbortController();
    try {
      await this.task?.destroy();
      this.task = undefined;
      const response = await fetch(`/api/paper/${this.paper.id}`, { signal: this.abort.signal });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      const sourceDate = response.headers.get('X-Source-Date');
      const age = Number(response.headers.get('X-Source-Age-Days'));
      this.meta.textContent = `${this.paper.location} · Feed ${sourceDate}${age ? ` (${age}d earlier)` : ''}`;
      this.task = pdfjs.getDocument({
        data: new Uint8Array(await response.arrayBuffer()),
        cMapUrl: '/vendor/cmaps/', cMapPacked: true,
        standardFontDataUrl: '/vendor/standard_fonts/', wasmUrl: '/vendor/wasm/', iccUrl: '/vendor/iccs/',
        isEvalSupported: false
      });
      this.pdf = await this.task.promise;
      this.page = await this.pdf.getPage(1);
      await this.render();
      return true;
    } catch (error) {
      if (this.disposed) return;
      console.error(`Cannot display ${this.paper.name}`, error);
      this.sheet.replaceChildren();
      const box = document.createElement('div');
      box.className = 'error';
      const title = document.createElement('strong');
      title.textContent = 'Front page unavailable';
      const message = document.createElement('p');
      message.textContent = error.message;
      const retry = document.createElement('button');
      retry.textContent = 'Retry this newspaper';
      retry.addEventListener('click', () => { void this.load(); }, { once: true });
      box.append(title, message, retry);
      this.sheet.append(box);
      return false;
    }
  }

  bindTapZoom() {
    let down;
    this.viewport.addEventListener('pointerdown', event => {
      down = { x: event.clientX, y: event.clientY, id: event.pointerId };
    }, { passive: true });
    this.viewport.addEventListener('pointerup', event => {
      if (!down || down.id !== event.pointerId) return;
      const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
      down = undefined;
      if (moved > 10 || !this.page || event.target.closest('button, a')) return;
      if (this.zoom > 1) { this.setZoom(1); return; }
      const canvas = this.sheet.querySelector('canvas');
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const fx = (event.clientX - rect.left) / rect.width;
      const fy = (event.clientY - rect.top) / rect.height;
      if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
      this.setZoom(2.5, { fx, fy });
    }, { passive: true });
  }

  setZoom(zoom, focus) {
    this.focus = focus;
    this.zoom = Math.max(1, Math.min(4, zoom));
    this.element.classList.toggle('is-zoomed', this.zoom > 1);
    if (this.zoom > 1) pauseForReading();
    void this.render().catch(error => notice(`Cannot zoom ${this.paper.name}: ${error.message}`));
  }

  async render() {
    if (!this.page || this.disposed) return;
    const generation = ++this.generation;
    this.renderTask?.cancel();
    const natural = this.page.getViewport({ scale: 1 });
    const fit = Math.min((this.viewport.clientWidth - 4) / natural.width, (this.viewport.clientHeight - 4) / natural.height);
    if (fit <= 0) return;
    const scale = fit * this.zoom;
    const viewport = this.page.getViewport({ scale });
    // Render at display pixel density, bounded to avoid huge Hub canvas allocations.
    const density = Math.min(window.devicePixelRatio || 1, 2, 6144 / Math.max(viewport.width, viewport.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width * density);
    canvas.height = Math.ceil(viewport.height * density);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${this.paper.name} original full-color front page`);
    this.renderTask = this.page.render({
      canvasContext: canvas.getContext('2d'), viewport,
      transform: [density, 0, 0, density, 0, 0]
    });
    try {
      await this.renderTask.promise;
      if (generation !== this.generation || this.disposed) return;
      this.sheet.replaceChildren(canvas);
      this.element.querySelector('.fit').textContent = this.zoom === 1 ? 'Fit' : `${Math.round(this.zoom * 100)}%`;
      this.element.querySelector('.minus').disabled = this.zoom === 1;
      this.element.querySelector('.plus').disabled = this.zoom === 4;
      if (this.zoom === 1) this.viewport.scrollTo(0, 0);
      else if (this.focus) {
        const { fx, fy } = this.focus;
        this.focus = undefined;
        this.viewport.scrollTo(
          canvas.offsetLeft + fx * viewport.width - this.viewport.clientWidth / 2,
          canvas.offsetTop + fy * viewport.height - this.viewport.clientHeight / 2
        );
      }
    } catch (error) {
      if (error.name !== 'RenderingCancelledException') throw error;
    }
  }

  async dispose() {
    this.disposed = true;
    this.abort?.abort();
    this.renderTask?.cancel();
    await this.task?.destroy();
  }
}

async function showPair(step = 0) {
  if (loading || !papers.length) return;
  loading = true;
  $('#spread').setAttribute('aria-busy', 'true');
  $('#previous').disabled = $('#next').disabled = true;
  if (step < 0 && historyPosition > 0) {
    index = history[--historyPosition];
  } else if (step > 0 && historyPosition < history.length - 1) {
    index = history[++historyPosition];
  } else {
    index = step < 0 ? (index - 2 + papers.length) % papers.length : nextIndex;
    history.splice(historyPosition + 1);
    history.push(index);
    // A bounded history supports Previous without retaining PDF documents.
    if (history.length > 100) history.shift();
    historyPosition = history.length - 1;
  }
  try {
    await Promise.all(views.map(view => view.dispose()));
    views = [papers[index], papers[(index + 1) % papers.length]].map(paper => new PaperView(paper));
    $('#spread').replaceChildren(...views.map(view => view.element));
    const tried = new Set([index, (index + 1) % papers.length]);
    nextIndex = (index + 2) % papers.length;
    const loaded = await Promise.all(views.map(view => view.load()));
    let skipped = 0;
    for (let slot = 0; slot < views.length; slot++) {
      while (!loaded[slot] && tried.size < papers.length) {
        skipped++;
        while (tried.has(nextIndex)) nextIndex = (nextIndex + 1) % papers.length;
        const candidate = nextIndex;
        tried.add(candidate);
        nextIndex = (candidate + 1) % papers.length;
        const replacement = new PaperView(papers[candidate]);
        await views[slot].dispose();
        views[slot].element.replaceWith(replacement.element);
        views[slot] = replacement;
        loaded[slot] = await replacement.load();
      }
    }
    $('#pair-label').textContent = `${loaded.filter(Boolean).length} front pages${skipped ? ` · ${skipped} unavailable skipped` : ' · around the world'}`;
  } catch (error) {
    notice(`Cannot change newspaper pair: ${error.message}`);
  } finally {
    rotation.reset();
    loading = false;
    $('#spread').setAttribute('aria-busy', 'false');
    $('#previous').disabled = $('#next').disabled = false;
    updateTimer();
  }
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = undefined; });
  } catch (error) {
    notice(`Screen wake lock unavailable: ${error.message}. Configure Windows power settings to keep the display on.`);
  }
}

$('#previous').addEventListener('click', () => { void showPair(-1); });
$('#next').addEventListener('click', () => { void showPair(1); });
bindSwipes($('#spread'), target => {
  if (loading || target.closest('button, a')) return false;
  return views.some(view => view.zoom === 1 && view.page && view.viewport.contains(target));
}, step => { void showPair(step); });
$('#pause').addEventListener('click', () => { rotation.toggle(); updateTimer(); });
$('#fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
    await requestWakeLock();
  } catch (error) { notice(`Fullscreen unavailable: ${error.message}`); }
});
$('#ambient').addEventListener('click', () => {
  const ambient = document.body.classList.toggle('ambient');
  $('#ambient').setAttribute('aria-pressed', String(ambient));
  showControls();
});
if (new URLSearchParams(location.search).get('ambient') === '1') $('#ambient').click();

// Browsers only allow fullscreen after a user gesture, so try now and retry on first touch/key.
async function autoFullscreen() {
  if (document.fullscreenElement) return true;
  try { await document.documentElement.requestFullscreen(); return true; } catch { return false; }
}
void autoFullscreen().then(ok => {
  if (ok) return;
  const retry = async event => {
    if (event.target.closest?.('#fullscreen')) return;
    if (await autoFullscreen()) cleanup();
  };
  const cleanup = () => {
    document.removeEventListener('pointerup', retry);
    document.removeEventListener('keydown', retry);
  };
  document.addEventListener('pointerup', retry);
  document.addEventListener('keydown', retry);
});
$('#close-help').addEventListener('click', () => $('#help').close());
function showControls() {
  document.body.classList.add('controls-visible');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!$('#toolbar').querySelector(':focus-visible')) document.body.classList.remove('controls-visible');
  }, 12000);
}
document.addEventListener('pointermove', showControls);
document.addEventListener('pointerdown', showControls);
document.addEventListener('keydown', event => {
  if (event.target.closest('button, a, dialog, .page-viewport')) return;
  if (event.code === 'Space') { event.preventDefault(); $('#pause').click(); }
  if (event.key === 'ArrowRight') void showPair(1);
  if (event.key === 'ArrowLeft') void showPair(-1);
  if (event.key.toLowerCase() === 'f') $('#fullscreen').click();
  if (event.key === 'Escape') {
    document.body.classList.remove('ambient');
    $('#ambient').setAttribute('aria-pressed', 'false');
  }
  if (event.key === '?') $('#help').showModal();
  showControls();
});
let bootId;
setInterval(async () => {
  try {
    const { boot } = await (await fetch('/api/version', { cache: 'no-store' })).json();
    if (bootId && boot !== bootId) location.reload();
    bootId = boot;
  } catch { /* server may be restarting during an update */ }
}, 60000);
let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const view of views) void view.render().catch(error => notice(`Cannot resize page: ${error.message}`));
  }, 150);
}).observe($('#spread'));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void requestWakeLock();
    if (!rotation.paused && rotation.left() === 0) void showPair(1);
  }
});
setInterval(() => {
  updateTimer();
  if (!rotation.paused && !loading && rotation.left() === 0) void showPair(1);
}, 250);

try {
  $('#date').textContent = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(new Date());
  setInterval(() => {
    $('#date').textContent = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(new Date());
  }, 60000);
  const response = await fetch('/api/papers');
  if (!response.ok) throw new Error(`Newspaper list returned HTTP ${response.status}`);
  papers = await response.json();
  if (papers.length < 2) throw new Error('At least two newspapers are required');
  await showPair();
  await requestWakeLock();
} catch (error) {
  notice(`Unable to start: ${error.message}. Reload the page to retry.`);
}
