/**
 * ui.js — minimal DOM HUD: layer toggles, filmstrip, lightbox, stats.
 * Pure DOM; no framework. Communicates with the viewer through callbacks.
 */

const LAYERS = [
  { key: 'cloud',  label: 'Points' },
  { key: 'cams',   label: 'Cameras' },
  { key: 'photos', label: 'Photos' },
  { key: 'tracks', label: 'Tracks' },
  { key: 'grid',   label: 'Grid' },
];

export function buildLayerToggles(state, onToggle) {
  const nav = document.getElementById('layers');
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

export function buildFilmstrip(cameras, onSelect) {
  const strip = document.getElementById('filmstrip');
  cameras.forEach((cam, i) => {
    const div = document.createElement('button');
    div.className = 'thumb';
    div.title = cam.name;
    div.innerHTML = `<img src="${cam.file}" alt="${cam.name}" loading="lazy" />`;
    div.addEventListener('click', () => onSelect(i));
    strip.appendChild(div);
  });
}

export function setActiveThumb(index) {
  document.querySelectorAll('.thumb').forEach((el, j) =>
    el.classList.toggle('active', j === index));
}

export function setStats({ points, cameras, tracks }) {
  const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
  if (points != null)  document.getElementById('s-pts').textContent = fmt(points);
  if (cameras != null) document.getElementById('s-cams').textContent = cameras;
  if (tracks != null)  document.getElementById('s-tracks').textContent = fmt(tracks);
}

export function setFps(fps) {
  document.getElementById('s-fps').textContent = fps;
}

export function setSubtitle(text) {
  document.getElementById('subtitle').textContent = text;
}

export function hideLoading() {
  const el = document.getElementById('loading');
  el.classList.add('hidden');
  setTimeout(() => { el.style.display = 'none'; }, 500);
}

export function setLoadingStatus(text) {
  document.getElementById('loading-status').textContent = text;
}

// ── Lightbox ──────────────────────────────────────────────
export function createLightbox(cameras, onOpen) {
  const box = document.getElementById('lightbox');
  const img = document.getElementById('lb-img');
  const label = document.getElementById('lightbox-label');
  let index = 0;

  function open(i) {
    index = (i + cameras.length) % cameras.length;
    const cam = cameras[index];
    img.src = cam.file;
    img.alt = cam.name;
    label.textContent = `${cam.name} · ${index + 1} / ${cameras.length}`;
    box.classList.add('open');
    setActiveThumb(index);
    onOpen?.(index);
  }
  function close() {
    box.classList.remove('open');
    setActiveThumb(-1);
  }
  function step(d) { open(index + d); }

  document.getElementById('lightbox-close').addEventListener('click', close);
  document.getElementById('lb-prev').addEventListener('click', () => step(-1));
  document.getElementById('lb-next').addEventListener('click', () => step(1));
  box.addEventListener('click', (e) => { if (e.target === box) close(); });
  addEventListener('keydown', (e) => {
    if (!box.classList.contains('open')) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight') step(1);
    if (e.key === 'ArrowLeft') step(-1);
  });

  return { open, close, isOpen: () => box.classList.contains('open') };
}
