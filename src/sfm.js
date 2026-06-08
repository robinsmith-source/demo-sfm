/**
 * sfm.js — Structure-from-Motion geometry.
 *
 * This module owns every piece of 3D math the viewer relies on:
 *
 *   1. Coordinate-system conversion.  openMVG / COLMAP express the world in the
 *      computer-vision convention (+X right, +Y DOWN, +Z forward / into the
 *      scene).  three.js uses the OpenGL convention (+X right, +Y UP, +Z toward
 *      the viewer).  Loading CV coordinates straight into three.js renders the
 *      scene upside-down and back-to-front, so every point, camera centre and
 *      basis vector is passed through `cvToThree()`.
 *
 *   2. The pinhole camera model.  Camera pose is recovered from the COLMAP
 *      world->camera rotation (quaternion) and translation:
 *          C = -Rᵀ t              (camera centre in world space)
 *          basis columns of Rᵀ    (camera axes in world space)
 *      Frustums are built from the intrinsics (fx, fy, cx, cy, w, h) so they
 *      match the real field of view rather than a hard-coded angle.
 *
 *   3. A geometrically self-consistent synthetic reconstruction used when no
 *      real reconstruction JSON is present.  Crucially the tracks here are not
 *      random: every point is *projected* into every camera with the real
 *      pinhole model, and a track is only recorded where the point genuinely
 *      lands inside that camera's image — the same visibility test feature
 *      matching enforces.  This makes the demo validate the rendering logic.
 */

import { Vector3, Matrix3, Quaternion, Matrix4 } from 'three';

// 180° rotation about X: (x, y, z) -> (x, -y, -z). Converts CV world <-> three.js.
export function cvToThree(x, y, z) {
  return new Vector3(x, -y, -z);
}

// Same flip applied to a direction (no translation component; it is orthonormal).
function cvDirToThree(v) {
  return new Vector3(v.x, -v.y, -v.z);
}

/**
 * Recover a camera's world-space pose + orthonormal basis from a COLMAP pose.
 *
 * @param {number[]} q  world->camera quaternion [qw, qx, qy, qz]
 * @param {number[]} t  world->camera translation [tx, ty, tz]
 * @returns {{center, right, up, forward}} all Vector3 in three.js space
 */
export function poseFromColmap(q, t) {
  const [qw, qx, qy, qz] = q;
  // Rotation matrix R (world -> camera), row-major.
  const R = new Matrix3().set(
    1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw),     2 * (qx * qz + qy * qw),
    2 * (qx * qy + qz * qw),     1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
    2 * (qx * qz - qy * qw),     2 * (qy * qz + qx * qw),     1 - 2 * (qx * qx + qy * qy),
  );
  const e = R.elements; // column-major storage from three.js

  // Camera axes in world space are the columns of Rᵀ = rows of R.
  const camRight = new Vector3(e[0], e[3], e[6]); // R row 0
  const camDown  = new Vector3(e[1], e[4], e[7]); // R row 1  (CV +Y points down)
  const camFwd   = new Vector3(e[2], e[5], e[8]); // R row 2  (view direction)

  // Camera centre C = -Rᵀ t.
  const tv = new Vector3(t[0], t[1], t[2]);
  const center = new Vector3(
    -(e[0] * tv.x + e[1] * tv.y + e[2] * tv.z),
    -(e[3] * tv.x + e[4] * tv.y + e[5] * tv.z),
    -(e[6] * tv.x + e[7] * tv.y + e[8] * tv.z),
  );

  // Convert everything to three.js space (CV up = -down).
  return {
    center:  cvToThree(center.x, center.y, center.z),
    right:   cvDirToThree(camRight).normalize(),
    up:      cvDirToThree(camDown.negate()).normalize(),
    forward: cvDirToThree(camFwd).normalize(),
  };
}

/**
 * Build an orthonormal camera basis from a centre + look-at target (used when a
 * reconstruction supplies positions/targets but no rotation).
 */
export function basisFromLookAt(center, target, worldUp = new Vector3(0, 1, 0)) {
  const forward = new Vector3().subVectors(target, center).normalize();
  let right = new Vector3().crossVectors(forward, worldUp);
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0); // looking straight up/down
  right.normalize();
  const up = new Vector3().crossVectors(right, forward).normalize();
  return { center: center.clone(), right, up, forward };
}

const DEFAULT_INTRINSICS = (w = 2880, h = 2160) => {
  // ~50° horizontal FOV fallback when intrinsics are unknown.
  const f = w / (2 * Math.tan((50 * Math.PI) / 180 / 2));
  return { fx: f, fy: f, cx: w / 2, cy: h / 2, width: w, height: h };
};

/**
 * Quaternion that orients an object (local +Z) so a textured plane faces back
 * toward the camera centre — i.e. it is readable when viewed from behind the
 * camera looking along its forward axis.
 */
export function planeQuaternion({ right, up, forward }) {
  const m = new Matrix4().makeBasis(right, up, forward.clone().negate());
  return new Quaternion().setFromRotationMatrix(m);
}

/**
 * Frustum corner positions (world space) at a given depth, from intrinsics.
 * Returns the 4 image corners in order TL, TR, BR, BL.
 */
export function frustumCorners(cam, depth) {
  const { right, up, forward, center, intrinsics } = cam;
  const { fx, fy, cx, cy, width, height } = intrinsics;
  const pix = [
    [0, 0], [width, 0], [width, height], [0, height],
  ];
  return pix.map(([px, py]) => {
    const u = (px - cx) / fx;     // camera-space x per unit depth
    const w = -(py - cy) / fy;    // camera-space y (image row grows downward)
    return new Vector3()
      .copy(center)
      .addScaledVector(forward, depth)
      .addScaledVector(right, u * depth)
      .addScaledVector(up, w * depth);
  });
}

/**
 * Project a world point into a camera. Returns {px, py, depth} or null if the
 * point is behind the camera. This is the exact pinhole projection that decides
 * whether a feature is observable in an image.
 */
export function projectPoint(cam, p) {
  const v = new Vector3().subVectors(p, cam.center);
  const depth = v.dot(cam.forward);
  if (depth <= 1e-4) return null;
  const { fx, fy, cx, cy } = cam.intrinsics;
  const px = cx + (fx * v.dot(cam.right)) / depth;
  const py = cy - (fy * v.dot(cam.up)) / depth;
  return { px, py, depth };
}

function isVisible(cam, p) {
  const proj = projectPoint(cam, p);
  if (!proj) return false;
  const { width, height } = cam.intrinsics;
  return proj.px >= 0 && proj.px < width && proj.py >= 0 && proj.py < height;
}

// ── Deterministic RNG so the synthetic scene is stable across reloads ──
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a synthetic but geometrically valid sparse reconstruction of a castle.
 * Points live directly in three.js (Y-up) world space; cameras are placed on a
 * frontal arc, each looking at the structure, and observations are derived by
 * real projection.
 *
 * @param {string[]} imageFiles
 */
export function buildSyntheticReconstruction(imageFiles) {
  const rng = mulberry32(7);
  const positions = [];
  const colors = [];

  const stone  = [0.80, 0.74, 0.63];
  const stoneD = [0.58, 0.52, 0.44];
  const roof   = [0.42, 0.30, 0.28];
  const lawn   = [0.46, 0.58, 0.34];
  const window = [0.40, 0.55, 0.75];

  const pushPt = (x, y, z, c, jitter = 0.04) => {
    positions.push(
      x + (rng() - 0.5) * jitter,
      y + (rng() - 0.5) * jitter,
      z + (rng() - 0.5) * jitter,
    );
    colors.push(c[0], c[1], c[2]);
  };

  // Building dimensions (centred at origin, sitting on the ground plane y=0).
  const W = 10, H = 5.5, D = 6;

  // Ground / lawn (kept sparse — SfM rarely reconstructs flat textureless grass).
  for (let i = 0; i < 1800; i++) {
    pushPt((rng() - 0.5) * 26, 0.02, (rng() - 0.5) * 20, lawn, 0.12);
  }
  // Four façades.
  for (let i = 0; i < 11000; i++) {
    const x = (rng() - 0.5) * W;
    const y = rng() * H;
    const face = Math.floor(rng() * 4);
    let px, py, pz, col;
    if (face === 0)      { px = x;     py = y; pz = D / 2;            col = rng() < 0.07 ? window : (y < 0.5 ? stoneD : stone); }
    else if (face === 1) { px = x;     py = y; pz = -D / 2;          col = stone; }
    else if (face === 2) { px = -W / 2; py = y; pz = (rng() - 0.5) * D; col = stoneD; }
    else                 { px = W / 2;  py = y; pz = (rng() - 0.5) * D; col = stoneD; }
    pushPt(px, py, pz, col, 0.05);
  }
  // Hip roof.
  for (let i = 0; i < 4500; i++) {
    const x = (rng() - 0.5) * W;
    const z = (rng() - 0.5) * D;
    const y = H + 2.4 - (Math.abs(x) / (W / 2)) * 1.3 - (Math.abs(z) / (D / 2)) * 0.9;
    pushPt(x, y, z, roof, 0.05);
  }
  // Two side wings.
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3500; i++) {
      pushPt(sx * (W / 2 + rng() * 3.5 + 0.5), rng() * 4.2, (rng() - 0.5) * 4.5, stone, 0.05);
    }
    for (let i = 0; i < 1200; i++) {
      const x = sx * (W / 2 + 1.8 + rng() * 1.7);
      const z = (rng() - 0.5) * 4.5;
      pushPt(x, 4.2 + 1.4 - Math.abs(Math.abs(x) - W / 2 - 2) / 2 * 0.8, z, roof, 0.06);
    }
  }
  // A few foreground trees for parallax.
  for (const [tx, tz] of [[-7, 4.5], [7, 4.5], [-9, -3]]) {
    for (let i = 0; i < 900; i++) {
      const th = rng() * Math.PI * 2;
      const r = rng() * 1.1;
      pushPt(tx + Math.cos(th) * r, 0.4 + rng() * 3.2, tz + Math.sin(th) * r,
        [0.20 + rng() * 0.12, 0.46 + rng() * 0.18, 0.18 + rng() * 0.08], 0.1);
    }
  }

  const pointCount = positions.length / 3;
  const pointVecs = [];
  for (let i = 0; i < pointCount; i++) {
    pointVecs.push(new Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]));
  }

  // ── Cameras on a frontal arc, each looking at the building's mid-height ──
  const intr = DEFAULT_INTRINSICS();
  const n = imageFiles.length;
  const sceneTarget = new Vector3(0, H * 0.5, 0);
  const cameras = imageFiles.map((file, i) => {
    const camRng = mulberry32(100 + i);
    const t = n > 1 ? i / (n - 1) : 0.5;
    const angle = (-1.0 + 2.0 * t) + (camRng() - 0.5) * 0.1;       // sweep ~±57°
    const dist = 15 + (camRng() - 0.5) * 3;
    const height = 2.4 + camRng() * 2.6;
    const center = new Vector3(
      Math.sin(angle) * dist,
      height,
      Math.cos(angle) * dist + (camRng() - 0.5) * 2,
    );
    const target = new Vector3(
      sceneTarget.x + (camRng() - 0.5) * 1.5,
      sceneTarget.y + (camRng() - 0.5) * 1.0,
      0,
    );
    const basis = basisFromLookAt(center, target);
    return {
      name: file.split('/').pop(),
      file,
      ...basis,
      intrinsics: intr,
      observations: [], // filled below
    };
  });

  // ── Real visibility: project every point into every camera ──
  // Subsample the points used for track lines so the overlay stays readable.
  const trackCandidates = [];
  const stride = Math.max(1, Math.floor(pointCount / 400));
  for (let pi = 0; pi < pointCount; pi += stride) {
    const seenBy = [];
    for (let ci = 0; ci < cameras.length; ci++) {
      if (isVisible(cameras[ci], pointVecs[pi])) seenBy.push(ci);
    }
    if (seenBy.length >= 2) trackCandidates.push({ point: pointVecs[pi], cams: seenBy });
  }

  // Per-camera observation counts (over the full cloud) for honest stats.
  let totalObs = 0;
  for (let ci = 0; ci < cameras.length; ci++) {
    let count = 0;
    for (let pi = 0; pi < pointCount; pi += 4) {
      if (isVisible(cameras[ci], pointVecs[pi])) count++;
    }
    cameras[ci].observationCount = count * 4;
    totalObs += cameras[ci].observationCount;
  }

  return {
    source: 'synthetic',
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    pointCount,
    cameras,
    tracks: trackCandidates,
    trackCount: trackCandidates.length,
    observationCount: totalObs,
  };
}

/**
 * Load a real reconstruction produced by the Python exporters, if present.
 * Returns null when the JSON is missing so the caller can fall back to synthetic.
 *
 * Expected (all in COLMAP / CV coordinates — converted here):
 *   pointcloud.json : { count, positions:[x,y,z,…], colors:[r,g,b,…] }
 *   cameras.json    : [{ name, position:[x,y,z], target?, q?, t?, intrinsics? }]
 */
export async function loadRealReconstruction(imageFiles) {
  let cloud, cams;
  try {
    const [pcRes, camRes] = await Promise.all([
      fetch('pointcloud.json'),
      fetch('cameras.json'),
    ]);
    if (!pcRes.ok || !camRes.ok) return null;
    cloud = await pcRes.json();
    cams = await camRes.json();
  } catch {
    return null;
  }
  if (!cloud?.count || !Array.isArray(cams) || cams.length === 0) return null;

  // Convert points CV -> three.js.
  const src = cloud.positions;
  const positions = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    positions[i] = src[i];
    positions[i + 1] = -src[i + 1];
    positions[i + 2] = -src[i + 2];
  }
  const colors = new Float32Array(cloud.colors);

  // Centre the cloud at the origin for comfortable orbiting.
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < positions.length; i += 3) { cx += positions[i]; cy += positions[i + 1]; cz += positions[i + 2]; }
  const nPts = positions.length / 3;
  cx /= nPts; cy /= nPts; cz /= nPts;
  for (let i = 0; i < positions.length; i += 3) { positions[i] -= cx; positions[i + 1] -= cy; positions[i + 2] -= cz; }
  const centroid = new Vector3(cx, cy, cz);

  const cameras = cams.map((c, i) => {
    let basis;
    if (Array.isArray(c.q) && Array.isArray(c.t)) {
      basis = poseFromColmap(c.q, c.t);
    } else {
      const center = cvToThree(c.position[0], c.position[1], c.position[2]);
      const target = c.target
        ? cvToThree(c.target[0], c.target[1], c.target[2])
        : new Vector3().addVectors(center, new Vector3(0, 0, -1));
      basis = basisFromLookAt(center, target);
    }
    basis.center.sub(centroid); // match the recentred cloud
    const intr = c.intrinsics
      ? { fx: c.intrinsics.fx, fy: c.intrinsics.fy, cx: c.intrinsics.cx, cy: c.intrinsics.cy,
          width: c.intrinsics.width, height: c.intrinsics.height }
      : DEFAULT_INTRINSICS(c.width, c.height);
    return {
      name: c.name ?? imageFiles[i]?.split('/').pop() ?? `cam_${i}`,
      file: imageFiles[i] ?? imageFiles[0],
      ...basis,
      intrinsics: intr,
      observations: c.observations ?? [],
    };
  });

  // Build track lines from real observations when available.
  const tracks = [];
  if (cams.some((c) => Array.isArray(c.observations) && c.observations.length)) {
    const byPoint = new Map();
    cams.forEach((c, ci) => {
      (c.observations ?? []).forEach((pi) => {
        if (!byPoint.has(pi)) byPoint.set(pi, []);
        byPoint.get(pi).push(ci);
      });
    });
    let added = 0;
    for (const [pi, seenBy] of byPoint) {
      if (seenBy.length < 2 || added >= 500) continue;
      const px = positions[pi * 3], py = positions[pi * 3 + 1], pz = positions[pi * 3 + 2];
      tracks.push({ point: new Vector3(px, py, pz), cams: seenBy });
      added++;
    }
  }

  return {
    source: 'real',
    positions,
    colors,
    pointCount: nPts,
    cameras,
    tracks,
    trackCount: cloud.count,
    observationCount: tracks.length,
  };
}
