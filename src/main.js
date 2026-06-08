/**
 * main.js — application entry point.
 *
 * Loads a real openMVG/COLMAP reconstruction (pointcloud.json + cameras.json) if
 * available, otherwise falls back to a geometrically consistent synthetic one,
 * then wires the viewer and the HUD together.
 */

import { loadRealReconstruction, buildSyntheticReconstruction } from './sfm.js';
import {
  createViewer, buildPointCloud, buildCameras, buildPhotos,
  buildTracks, buildGrid, loadTextures, createPhotoPicker,
} from './viewer.js';
import {
  buildLayerToggles, buildFilmstrip, createLightbox,
  setStats, setFps, setSubtitle, hideLoading, setLoadingStatus,
} from './ui.js';

const IMAGE_FILES = Array.from({ length: 11 }, (_, i) =>
  `images/100_71${String(i).padStart(2, '0')}.JPG`);

async function main() {
  const canvas = document.getElementById('scene');
  const { renderer, scene, camera, controls, HOME } = createViewer(canvas);

  setLoadingStatus('Loading reconstruction…');
  const recon = (await loadRealReconstruction(IMAGE_FILES))
    ?? buildSyntheticReconstruction(IMAGE_FILES);

  setSubtitle(recon.source === 'real'
    ? 'openMVG · sparse reconstruction'
    : 'Structure from Motion · demo');

  setLoadingStatus('Loading photographs…');
  const textures = await loadTextures(recon.cameras.map((c) => c.file));

  // ── Build entities ──
  const cloud = buildPointCloud(recon);
  const cams = buildCameras(recon.cameras);
  const { group: photos, meshes: photoMeshes } = buildPhotos(recon.cameras, textures);
  const tracks = buildTracks(recon.tracks, recon.cameras);
  const grid = buildGrid();
  scene.add(cloud, cams, photos, tracks, grid);

  const entities = { cloud, cams, photos, tracks, grid };
  const layerState = { cloud: true, cams: true, photos: true, tracks: true, grid: true };

  // ── HUD ──
  setStats({
    points: recon.pointCount,
    cameras: recon.cameras.length,
    tracks: recon.trackCount,
  });
  buildLayerToggles(layerState, (key, on) => { entities[key].visible = on; });
  buildFilmstrip(recon.cameras, (i) => lightbox.open(i));

  // ── Fly-to on photo selection ──
  let flyTarget = null;
  function flyToCamera(i) {
    const cam = recon.cameras[i];
    // Pull back along the camera's view axis so its frustum fills the frame.
    flyTarget = {
      pos: cam.center.clone().addScaledVector(cam.forward, -5),
      look: cam.center.clone().addScaledVector(cam.forward, 3),
    };
  }
  const lightbox = createLightbox(recon.cameras, flyToCamera);
  createPhotoPicker(renderer, camera, photoMeshes, (i) => lightbox.open(i));

  // ── Keyboard ──
  let autoOrbit = false;
  addEventListener('keydown', (e) => {
    if (lightbox.isOpen()) return;
    if (e.key === 'r' || e.key === 'R') {
      camera.position.copy(HOME.pos);
      controls.target.copy(HOME.target);
      flyTarget = null;
    }
    if (e.key === 'a' || e.key === 'A') autoOrbit = !autoOrbit;
  });

  hideLoading();

  // ── Render loop ──
  let last = performance.now();
  let frames = 0, acc = 0;
  function animate(now) {
    requestAnimationFrame(animate);
    const dt = (now - last) / 1000; last = now;

    frames++; acc += dt;
    if (acc > 0.5) { setFps(Math.round(frames / acc)); frames = 0; acc = 0; }

    if (flyTarget) {
      camera.position.lerp(flyTarget.pos, 0.06);
      controls.target.lerp(flyTarget.look, 0.06);
      if (camera.position.distanceTo(flyTarget.pos) < 0.2) flyTarget = null;
    }
    controls.autoRotate = autoOrbit && !flyTarget;
    controls.autoRotateSpeed = 0.5;

    controls.update();
    renderer.render(scene, camera);
  }
  requestAnimationFrame(animate);
}

main();
