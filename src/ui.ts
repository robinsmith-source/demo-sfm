/**
 * ui.ts — minimal DOM HUD: dataset selector, layer toggles, filmstrip,
 * lightbox, stats. Pure DOM; no framework. Communicates with the viewer through
 * callbacks. Everything that depends on the active dataset (filmstrip, title,
 * stats, the lightbox's camera list) can be rebuilt on a dataset switch.
 */

import type { DatasetMeta, SfmCamera } from './types';

const el = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const LAYERS = [
  { key: 'cloud',  label: 'Points' },
  { key: 'cams',   label: 'Cameras' },
  { key: 'photos', label: 'Photos' },
  { key: 'tracks', label: 'Tracks' },
  { key: 'grid',   label: 'Grid' },
] as const;

// ── Dataset selector ──────────────────────────────────────
export function buildDatasetSelector(
  datasets: DatasetMeta[],
  currentId: string,
  onSelect: (id: string) => void,
): void {
  const sel = el<HTMLSelectElement>('dataset');
  sel.innerHTML = '';
  datasets.forEach((d) => {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.name;
    if (d.id === currentId) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', () => onSelect(sel.value));
}

export function buildLayerToggles(
  state: Record<string, boolean>,
  onToggle: (key: string, on: boolean) => void,
): void {
  const nav = el('layers');
  LAYERS.forEach(({ key, label }) => {
    const btn = document.createElement('button');
    btn.className = 'layer-btn' + (state[key] ? ' active' : '');
    btn.dataset.key = key;
    btn.innerHTML = `<span class="dot dot-${key}"></span>${label}`;
    btn.addEventListener('click', () => {
      state[key] = !state[key];
      btn.classList.toggle('active', state[key]);
      onToggle(key, state[key]);
    });
    nav.appendChild(btn);
  });
}

export function buildFilmstrip(cameras: SfmCamera[], onSelect: (i: number) => void): void {
  const strip = el('filmstrip');
  strip.innerHTML = ''; // clear any previous dataset's thumbnails
  cameras.forEach((cam, i) => {
    const div = document.createElement('button');
    div.className = 'thumb';
    div.title = cam.name;
    div.innerHTML = `<img src="${cam.file}" alt="${cam.name}" loading="lazy" />`;
    div.addEventListener('click', () => onSelect(i));
    strip.appendChild(div);
  });
}

export function setActiveThumb(index: number): void {
  document.querySelectorAll('.thumb').forEach((node, j) =>
    node.classList.toggle('active', j === index));
}

export function setStats({ points, cameras, tracks }: { points?: number; cameras?: number; tracks?: number }): void {
  const fmt = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
  if (points != null)  el('s-pts').textContent = fmt(points);
  if (cameras != null) el('s-cams').textContent = String(cameras);
  if (tracks != null)  el('s-tracks').textContent = fmt(tracks);
}

export function setFps(fps: number): void {
  el('s-fps').textContent = String(fps);
}

export function setTitle(text: string): void {
  el('ds-title').textContent = text;
}

export function setSubtitle(text: string): void {
  el('subtitle').textContent = text;
}

export function setCredit(text: string): void {
  el('credit').textContent = text;
}

// ── Loading / error overlay ───────────────────────────────
export function showLoading(text = 'Loading…'): void {
  const overlay = el('loading');
  overlay.innerHTML = `<div class="spinner"></div><p id="loading-status">${text}</p>`;
  overlay.classList.remove('hidden');
  overlay.style.display = 'flex';
}

export function setLoadingStatus(text: string): void {
  const status = document.getElementById('loading-status');
  if (status) status.textContent = text;
}

export function hideLoading(): void {
  const overlay = el('loading');
  overlay.classList.add('hidden');
  setTimeout(() => { overlay.style.display = 'none'; }, 500);
}

// Replace the loading spinner with an actionable message (e.g. data not generated).
export function showError(title: string, detail: string, command: string): void {
  const overlay = el('loading');
  overlay.classList.remove('hidden');
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <h2 class="err-title">${title}</h2>
    <p class="err-detail">${detail}</p>
    ${command ? `<code class="err-cmd">${command}</code>` : ''}`;
}

// ── Lightbox ──────────────────────────────────────────────
export interface Lightbox {
  open: (i: number) => void;
  close: () => void;
  isOpen: () => boolean;
}

// `getCameras` returns the active dataset's camera list, so the lightbox stays
// correct across dataset switches without rebinding its DOM listeners.
export function createLightbox(getCameras: () => SfmCamera[], onOpen?: (i: number) => void): Lightbox {
  const box = el('lightbox');
  const img = el<HTMLImageElement>('lb-img');
  const label = el('lightbox-label');
  let index = 0;

  function open(i: number): void {
    const cameras = getCameras();
    if (!cameras.length) return;
    index = (i + cameras.length) % cameras.length;
    const cam = cameras[index];
    img.src = cam.file;
    img.alt = cam.name;
    label.textContent = `${cam.name} · ${index + 1} / ${cameras.length}`;
    box.classList.add('open');
    setActiveThumb(index);
    onOpen?.(index);
  }
  function close(): void {
    box.classList.remove('open');
    setActiveThumb(-1);
  }
  function step(d: number): void { open(index + d); }

  el('lightbox-close').addEventListener('click', close);
  el('lb-prev').addEventListener('click', () => step(-1));
  el('lb-next').addEventListener('click', () => step(1));
  box.addEventListener('click', (e) => { if (e.target === box) close(); });
  addEventListener('keydown', (e) => {
    if (!box.classList.contains('open')) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight') step(1);
    if (e.key === 'ArrowLeft') step(-1);
  });

  return { open, close, isOpen: () => box.classList.contains('open') };
}
