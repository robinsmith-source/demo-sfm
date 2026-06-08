/**
 * main.ts — application entry point.
 *
 * Loads the dataset manifest (public/datasets/index.json), builds a selector,
 * and renders the chosen real COLMAP reconstruction. Switching datasets tears
 * down the previous scene entities and rebuilds them in place. There is no
 * synthetic fallback — only the real reconstructions produced by the pipeline.
 */

import { Vector3, type Group, type Points, type LineSegments, type GridHelper } from 'three';
import { loadRealReconstruction } from './sfm';
import {
  createViewer, buildPointCloud, buildCameras, buildPhotos,
  buildTracks, buildGrid, loadTextures, createPhotoPicker, disposeObject,
  type PickerRef,
} from './viewer';
import {
  buildDatasetSelector, buildLayerToggles, buildFilmstrip, createLightbox,
  setStats, setFps, setTitle, setSubtitle, setCredit,
  showLoading, hideLoading, setLoadingStatus, showError,
} from './ui';
import type { DatasetMeta, SfmCamera } from './types';

type LayerKey = 'cloud' | 'cams' | 'photos' | 'tracks' | 'grid';

interface Entities {
  cloud: Points | null;
  cams: Group | null;
  photos: Group | null;
  tracks: LineSegments | Group | null;
  grid: GridHelper;
}

async function main(): Promise<void> {
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const { renderer, scene, camera, controls, HOME } = createViewer(canvas);

  // Persistent, dataset-independent entity.
  const grid = buildGrid();
  scene.add(grid);

  // Mutable state shared across dataset switches.
  const layerState: Record<LayerKey, boolean> =
    { cloud: true, cams: true, photos: true, tracks: true, grid: true };
  const entities: Entities = { cloud: null, cams: null, photos: null, tracks: null, grid };
  const pickerRef: PickerRef = { meshes: [] };
  let cameras: SfmCamera[] = [];
  let flyTarget: { pos: Vector3; look: Vector3 } | null = null;

  function flyToCamera(i: number): void {
    const cam = cameras[i];
    if (!cam) return;
    // Pull back along the camera's view axis so its frustum fills the frame.
    flyTarget = {
      pos: cam.center.clone().addScaledVector(cam.forward, -5),
      look: cam.center.clone().addScaledVector(cam.forward, 3),
    };
  }

  // HUD wiring that persists across datasets (listeners bound once).
  buildLayerToggles(layerState, (key, on) => {
    const ent = entities[key as LayerKey];
    if (ent) ent.visible = on;
  });
  const lightbox = createLightbox(() => cameras, flyToCamera);
  createPhotoPicker(renderer, camera, pickerRef, (i) => lightbox.open(i));

  // ── Keyboard: reset, auto-orbit, and WASD/QE fly movement ──
  let autoOrbit = false;
  const held = new Set<string>();   // movement keys currently down
  let boost = false;                // Shift = move faster
  const MOVE_KEYS = 'wasdqe';

  addEventListener('keydown', (e) => {
    boost = e.shiftKey;
    if (lightbox.isOpen()) return;
    if ((e.target as HTMLElement)?.tagName === 'SELECT') return; // don't hijack the dropdown
    const k = e.key.toLowerCase();
    if (k === 'r') {
      camera.position.copy(HOME.pos);
      controls.target.copy(HOME.target);
      flyTarget = null;
    } else if (k === 'o') {
      autoOrbit = !autoOrbit;
    } else if (MOVE_KEYS.includes(k)) {
      held.add(k);
      e.preventDefault();
    }
  });
  addEventListener('keyup', (e) => { boost = e.shiftKey; held.delete(e.key.toLowerCase()); });
  addEventListener('blur', () => held.clear()); // avoid keys sticking after alt-tab

  // Move the camera + orbit target together so OrbitControls keeps working.
  const moveVec = new Vector3();
  const fwd = new Vector3();
  const right = new Vector3();
  function applyMovement(dt: number): void {
    if (held.size === 0) return;
    fwd.subVectors(controls.target, camera.position);
    fwd.y = 0; // walk along the ground plane; Q/E handle vertical
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    right.crossVectors(fwd, camera.up).normalize();

    moveVec.set(0, 0, 0);
    if (held.has('w')) moveVec.add(fwd);
    if (held.has('s')) moveVec.sub(fwd);
    if (held.has('d')) moveVec.add(right);
    if (held.has('a')) moveVec.sub(right);
    if (held.has('e')) moveVec.y += 1;
    if (held.has('q')) moveVec.y -= 1;
    if (moveVec.lengthSq() === 0) return;

    // Speed scales with zoom distance so it feels right at any scale.
    const dist = camera.position.distanceTo(controls.target);
    const speed = Math.max(2, dist) * (boost ? 2.4 : 1) * 0.9;
    moveVec.normalize().multiplyScalar(speed * dt);
    camera.position.add(moveVec);
    controls.target.add(moveVec);
    flyTarget = null; // cancel any fly-to in progress
  }

  // ── Load / switch a dataset ──
  async function loadDataset(meta: DatasetMeta): Promise<void> {
    showLoading('Loading reconstruction…');
    const recon = await loadRealReconstruction(meta);
    if (!recon) {
      showError('Reconstruction missing',
        `No data for “${meta.name}”. Generate it with:`,
        `uv run pipeline/reconstruct.py ${meta.id}`);
      return;
    }

    setLoadingStatus('Loading photographs…');
    const textures = await loadTextures(recon.cameras.map((c) => c.file));

    // Tear down the previous dataset's entities (keep the grid).
    for (const key of ['cloud', 'cams', 'photos', 'tracks'] as const) {
      const ent = entities[key];
      if (ent) { scene.remove(ent); disposeObject(ent); entities[key] = null; }
    }

    // Build the new entities.
    const cloud = buildPointCloud(recon);
    const cams = buildCameras(recon.cameras);
    const { group: photos, meshes } = buildPhotos(recon.cameras, textures);
    const tracks = buildTracks(recon.tracks, recon.cameras);
    scene.add(cloud, cams, photos, tracks);
    entities.cloud = cloud; entities.cams = cams; entities.photos = photos; entities.tracks = tracks;
    cloud.visible = layerState.cloud;
    cams.visible = layerState.cams;
    photos.visible = layerState.photos;
    tracks.visible = layerState.tracks;
    grid.visible = layerState.grid;

    cameras = recon.cameras;
    pickerRef.meshes = meshes;
    flyTarget = null;

    // HUD.
    setTitle(meta.name);
    setSubtitle(meta.subtitle ?? '');
    setCredit(meta.credit ?? '');
    setStats({ points: recon.pointCount, cameras: cameras.length, tracks: recon.trackCount });
    buildFilmstrip(cameras, (i) => lightbox.open(i));

    // Reset the view (normalised scale means HOME frames every dataset).
    camera.position.copy(HOME.pos);
    controls.target.copy(HOME.target);

    hideLoading();
  }

  // ── Dataset manifest → selector ──
  let manifest: DatasetMeta[] = [];
  try {
    const res = await fetch('datasets/index.json');
    if (res.ok) manifest = await res.json();
  } catch { /* handled below */ }
  if (!Array.isArray(manifest) || manifest.length === 0) {
    showError('No datasets found', 'Expected public/datasets/index.json with at least one entry.', '');
    return;
  }

  buildDatasetSelector(manifest, manifest[0].id, (id) => {
    const meta = manifest.find((d) => d.id === id);
    if (meta) loadDataset(meta);
  });

  await loadDataset(manifest[0]);

  // ── Render loop ──
  let last = performance.now();
  let frames = 0, acc = 0;
  function animate(now: number): void {
    requestAnimationFrame(animate);
    const dt = (now - last) / 1000; last = now;

    frames++; acc += dt;
    if (acc > 0.5) { setFps(Math.round(frames / acc)); frames = 0; acc = 0; }

    applyMovement(dt);

    if (flyTarget) {
      camera.position.lerp(flyTarget.pos, 0.06);
      controls.target.lerp(flyTarget.look, 0.06);
      if (camera.position.distanceTo(flyTarget.pos) < 0.2) flyTarget = null;
    }
    controls.autoRotate = autoOrbit && !flyTarget && held.size === 0;
    controls.autoRotateSpeed = 0.5;

    controls.update();
    renderer.render(scene, camera);
  }
  requestAnimationFrame(animate);
}

main();
