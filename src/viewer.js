/**
 * viewer.js — three.js scene, entities and render loop.
 *
 * All entity geometry is derived from the reconstruction's true camera basis and
 * intrinsics (see sfm.js): frustums use `frustumCorners`, photo planes are
 * oriented with `planeQuaternion` and sized by the real image aspect ratio, and
 * track lines connect each 3D point to the camera centres that actually observe
 * it. Nothing here invents geometry.
 */

import {
  WebGLRenderer, Scene, Color, Fog, PerspectiveCamera,
  AmbientLight, DirectionalLight, GridHelper, Group,
  BufferGeometry, Float32BufferAttribute, Points, PointsMaterial,
  LineSegments, LineBasicMaterial, Line, Mesh, SphereGeometry,
  MeshBasicMaterial, PlaneGeometry, EdgesGeometry, DoubleSide,
  TextureLoader, SRGBColorSpace, Vector3, Vector2, Raycaster,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { frustumCorners, planeQuaternion } from './sfm.js';

// Light, minimalist palette.
const COL = {
  bg: 0xf4f5f7,
  fog: 0xf4f5f7,
  grid: 0xd8dbe0,
  gridCenter: 0xc2c6cd,
  camera: 0x2563eb,   // blue accent for frustums + camera dots
  track: 0x10b981,    // green for feature tracks
  frame: 0x1f2937,    // photo borders
};

export function createViewer(canvas) {
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);

  const scene = new Scene();
  scene.background = new Color(COL.bg);
  scene.fog = new Fog(COL.fog, 60, 160);

  const camera = new PerspectiveCamera(55, innerWidth / innerHeight, 0.05, 1000);
  const HOME = { pos: new Vector3(20, 13, 24), target: new Vector3(0, 2.5, 0) };
  camera.position.copy(HOME.pos);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 2;
  controls.maxDistance = 200;
  controls.target.copy(HOME.target);

  scene.add(new AmbientLight(0xffffff, 1.8));
  const key = new DirectionalLight(0xffffff, 1.2);
  key.position.set(12, 24, 14);
  scene.add(key);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  return { renderer, scene, camera, controls, HOME };
}

// ── Point cloud ───────────────────────────────────────────
export function buildPointCloud({ positions, colors }) {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geo.computeBoundingSphere();
  const mat = new PointsMaterial({
    size: 0.06, vertexColors: true, sizeAttenuation: true,
  });
  return new Points(geo, mat);
}

// ── Camera frustums + centre dots ─────────────────────────
export function buildCameras(cameras, depth = 0.9) {
  const group = new Group();
  const lineMat = new LineBasicMaterial({ color: COL.camera, transparent: true, opacity: 0.85 });
  const dotGeo = new SphereGeometry(0.09, 8, 8);
  const dotMat = new MeshBasicMaterial({ color: COL.camera });

  cameras.forEach((cam) => {
    const corners = frustumCorners(cam, depth);
    const pts = [];
    // apex -> 4 corners
    corners.forEach((c) => { pts.push(cam.center.clone(), c.clone()); });
    // image rectangle
    for (let i = 0; i < 4; i++) pts.push(corners[i].clone(), corners[(i + 1) % 4].clone());
    group.add(new LineSegments(new BufferGeometry().setFromPoints(pts), lineMat));

    const dot = new Mesh(dotGeo, dotMat);
    dot.position.copy(cam.center);
    group.add(dot);
  });
  return group;
}

// ── Photo planes anchored on each camera's image plane ────
export function buildPhotos(cameras, textures, depth = 0.9) {
  const group = new Group();
  const meshes = [];

  cameras.forEach((cam, i) => {
    const tex = textures[i];
    if (!tex) return;
    const aspect = tex.image ? tex.image.width / tex.image.height : cam.intrinsics.width / cam.intrinsics.height;

    // Physical size of the image plane at `depth`, derived from intrinsics so
    // the photo exactly fills the frustum.
    const planeW = (cam.intrinsics.width / cam.intrinsics.fx) * depth;
    const planeH = planeW / aspect;
    const center = cam.center.clone().addScaledVector(cam.forward, depth);
    const quat = planeQuaternion(cam);

    const geo = new PlaneGeometry(planeW, planeH);
    const mat = new MeshBasicMaterial({ map: tex, side: DoubleSide, transparent: true, opacity: 0.96 });
    const mesh = new Mesh(geo, mat);
    mesh.position.copy(center);
    mesh.quaternion.copy(quat);
    mesh.userData = { imgIdx: i };
    group.add(mesh);
    meshes.push(mesh);

    const border = new LineSegments(
      new EdgesGeometry(geo),
      new LineBasicMaterial({ color: COL.frame, transparent: true, opacity: 0.35 }),
    );
    border.position.copy(center);
    border.quaternion.copy(quat);
    group.add(border);
  });

  return { group, meshes };
}

// ── Feature tracks: point <-> observing camera centres ────
export function buildTracks(tracks, cameras) {
  const pts = [];
  tracks.forEach(({ point, cams }) => {
    cams.forEach((ci) => {
      const cam = cameras[ci];
      if (cam) { pts.push(point.clone(), cam.center.clone()); }
    });
  });
  if (pts.length === 0) return new Group();
  return new LineSegments(
    new BufferGeometry().setFromPoints(pts),
    new LineBasicMaterial({ color: COL.track, transparent: true, opacity: 0.12 }),
  );
}

export function buildGrid(size = 80, divisions = 40) {
  const grid = new GridHelper(size, divisions, COL.gridCenter, COL.grid);
  grid.position.y = -0.02;
  grid.material.opacity = 0.6;
  grid.material.transparent = true;
  return grid;
}

// ── Texture loading ───────────────────────────────────────
export function loadTextures(files) {
  const loader = new TextureLoader();
  return Promise.all(files.map((f) => new Promise((resolve) => {
    loader.load(
      f,
      (tex) => { tex.colorSpace = SRGBColorSpace; resolve(tex); },
      undefined,
      () => resolve(null),
    );
  })));
}

// ── Raycasting against photo planes ───────────────────────
export function createPhotoPicker(renderer, camera, meshes, onPick) {
  const raycaster = new Raycaster();
  const mouse = new Vector2();
  let down = null;

  renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 5) return; // it was a drag, not a click
    mouse.x = (e.clientX / innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects(meshes);
    if (hits.length) onPick(hits[0].object.userData.imgIdx);
  });
}
