/**
 * sfm.ts — Structure-from-Motion geometry.
 *
 * This module owns the 3D math the viewer relies on:
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
 * There is no synthetic fallback: the viewer renders only the real point cloud
 * and camera poses produced by `pipeline/reconstruct.py`. If the reconstruction
 * JSON is missing, the loader returns null and the app reports how to generate it.
 */

import { Vector3, Matrix3, Quaternion, Matrix4 } from 'three';
import type { CameraBasis, DatasetMeta, Intrinsics, Reconstruction, SfmCamera, Track } from './types';

// ── Raw JSON shapes produced by pipeline/reconstruct.py ──
interface RawCloud {
  count: number;
  positions: number[];
  colors: number[];
}
interface RawCamera {
  name?: string;
  position?: [number, number, number];
  target?: [number, number, number];
  q?: number[];
  t?: number[];
  intrinsics?: Intrinsics;
  width?: number;
  height?: number;
  observations?: number[];
}

// 180° rotation about X: (x, y, z) -> (x, -y, -z). Converts CV world <-> three.js.
export function cvToThree(x: number, y: number, z: number): Vector3 {
  return new Vector3(x, -y, -z);
}

// Same flip applied to a direction (no translation component; it is orthonormal).
function cvDirToThree(v: Vector3): Vector3 {
  return new Vector3(v.x, -v.y, -v.z);
}

/**
 * Recover a camera's world-space pose + orthonormal basis from a COLMAP pose.
 *
 * @param q  world->camera quaternion [qw, qx, qy, qz]
 * @param t  world->camera translation [tx, ty, tz]
 */
export function poseFromColmap(q: number[], t: number[]): CameraBasis {
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
export function basisFromLookAt(center: Vector3, target: Vector3, worldUp = new Vector3(0, 1, 0)): CameraBasis {
  const forward = new Vector3().subVectors(target, center).normalize();
  const right = new Vector3().crossVectors(forward, worldUp);
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0); // looking straight up/down
  right.normalize();
  const up = new Vector3().crossVectors(right, forward).normalize();
  return { center: center.clone(), right, up, forward };
}

const DEFAULT_INTRINSICS = (w = 2880, h = 2160): Intrinsics => {
  // ~50° horizontal FOV fallback when intrinsics are unknown.
  const f = w / (2 * Math.tan((50 * Math.PI) / 180 / 2));
  return { fx: f, fy: f, cx: w / 2, cy: h / 2, width: w, height: h };
};

/**
 * Quaternion that orients an object (local +Z) so a textured plane faces back
 * toward the camera centre — i.e. it is readable when viewed from behind the
 * camera looking along its forward axis.
 */
export function planeQuaternion({ right, up, forward }: CameraBasis): Quaternion {
  const m = new Matrix4().makeBasis(right, up, forward.clone().negate());
  return new Quaternion().setFromRotationMatrix(m);
}

/**
 * Frustum corner positions (world space) at a given depth, from intrinsics.
 * Returns the 4 image corners in order TL, TR, BR, BL.
 */
export function frustumCorners(cam: SfmCamera, depth: number): Vector3[] {
  const { right, up, forward, center, intrinsics } = cam;
  const { fx, fy, cx, cy, width, height } = intrinsics;
  const pix: [number, number][] = [
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

// ── Auto-levelling ────────────────────────────────────────
// COLMAP fixes orientation only up to an arbitrary rotation (gauge freedom), so
// one dataset comes out upright and the next is tipped on its side. For a ring
// or arc capture the camera centres are highly planar, and the normal of that
// plane is the natural "up" of the scene (the turntable / orbit axis). We fit
// that plane and rotate the whole reconstruction so the normal points to +Y —
// this stands the object up and lays the camera ring flat for every dataset.

// Power iteration for the dominant eigenvector of a symmetric 3x3 (row-major).
function dominantEigenvector(M: number[], seed: Vector3): Vector3 {
  const v = seed.clone().normalize();
  for (let i = 0; i < 64; i++) {
    const x = M[0] * v.x + M[1] * v.y + M[2] * v.z;
    const y = M[3] * v.x + M[4] * v.y + M[5] * v.z;
    const z = M[6] * v.x + M[7] * v.y + M[8] * v.z;
    v.set(x, y, z);
    const len = v.length();
    if (len < 1e-12) break;
    v.multiplyScalar(1 / len);
  }
  return v;
}

// Normal of the best-fit plane through a set of points (smallest-variance axis).
function fitPlaneNormal(points: Vector3[]): Vector3 {
  const mean = new Vector3();
  points.forEach((p) => mean.add(p));
  mean.multiplyScalar(1 / points.length);

  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of points) {
    const dx = p.x - mean.x, dy = p.y - mean.y, dz = p.z - mean.z;
    xx += dx * dx; xy += dx * dy; xz += dx * dz;
    yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }
  const C = [xx, xy, xz, xy, yy, yz, xz, yz, zz];

  // Two dominant in-plane axes via power iteration + deflation; normal = d1 × d2.
  const d1 = dominantEigenvector(C, new Vector3(1, 0.3, 0.1));
  const l1 = d1.x * (C[0] * d1.x + C[1] * d1.y + C[2] * d1.z)
           + d1.y * (C[3] * d1.x + C[4] * d1.y + C[5] * d1.z)
           + d1.z * (C[6] * d1.x + C[7] * d1.y + C[8] * d1.z);
  const D = [
    C[0] - l1 * d1.x * d1.x, C[1] - l1 * d1.x * d1.y, C[2] - l1 * d1.x * d1.z,
    C[3] - l1 * d1.y * d1.x, C[4] - l1 * d1.y * d1.y, C[5] - l1 * d1.y * d1.z,
    C[6] - l1 * d1.z * d1.x, C[7] - l1 * d1.z * d1.y, C[8] - l1 * d1.z * d1.z,
  ];
  const seed2 = new Vector3(0.2, 1, 0.1).addScaledVector(d1, -0.2 * d1.y);
  const d2 = dominantEigenvector(D, seed2);
  return new Vector3().crossVectors(d1, d2).normalize();
}

// Reconstructions come out of COLMAP at an arbitrary scale (Sceaux ~3.4 RMS,
// the temple ring far smaller). Normalising every cloud to the same RMS radius
// lets the viewer's fixed constants — point size, frustum depth, fog, home
// camera — render any dataset correctly. The target matches Sceaux's native
// scale so that dataset is unchanged.
const TARGET_RMS_RADIUS = 3.42;

/**
 * Load the real reconstruction for a dataset, produced by `pipeline/reconstruct.py`.
 * Returns null when the JSON is missing so the caller can report how to build it.
 *
 * Each camera's source photograph is resolved from its `name` (the original
 * filename COLMAP registered), so the cloud, poses and photos always correspond
 * to the same images that were reconstructed.
 *
 * @param meta  dataset manifest entry (id resolves the paths; flipUp flips the up axis)
 *
 * Expected (all in COLMAP / CV coordinates — converted here):
 *   datasets/<id>/data/pointcloud.json : { count, positions:[x,y,z,…], colors:[r,g,b,…] }
 *   datasets/<id>/data/cameras.json    : [{ name, position:[x,y,z], target?, q?, t?, intrinsics?, observations? }]
 */
export async function loadRealReconstruction(meta: DatasetMeta): Promise<Reconstruction | null> {
  const base = `datasets/${meta.id}`;
  const imageBase = meta.imageDir === '.' ? base : `${base}/${meta.imageDir ?? 'images'}`;
  let cloud: RawCloud;
  let cams: RawCamera[];
  try {
    const [pcRes, camRes] = await Promise.all([
      fetch(`${base}/data/pointcloud.json`),
      fetch(`${base}/data/cameras.json`),
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

  // Uniform scale to the canonical RMS radius (see TARGET_RMS_RADIUS).
  let sumSq = 0;
  for (let i = 0; i < positions.length; i += 3) {
    sumSq += positions[i] ** 2 + positions[i + 1] ** 2 + positions[i + 2] ** 2;
  }
  const rms = Math.sqrt(sumSq / nPts) || 1;
  const scale = TARGET_RMS_RADIUS / rms;
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] *= scale; positions[i + 1] *= scale; positions[i + 2] *= scale;
  }

  const cameras: SfmCamera[] = cams.map((c, i) => {
    let basis: CameraBasis;
    if (Array.isArray(c.q) && Array.isArray(c.t)) {
      basis = poseFromColmap(c.q, c.t);
    } else {
      const pos = c.position!;
      const center = cvToThree(pos[0], pos[1], pos[2]);
      const target = c.target
        ? cvToThree(c.target[0], c.target[1], c.target[2])
        : new Vector3().addVectors(center, new Vector3(0, 0, -1));
      basis = basisFromLookAt(center, target);
    }
    basis.center.sub(centroid).multiplyScalar(scale); // match the recentred + rescaled cloud
    const intr: Intrinsics = c.intrinsics
      ? { fx: c.intrinsics.fx, fy: c.intrinsics.fy, cx: c.intrinsics.cx, cy: c.intrinsics.cy,
          width: c.intrinsics.width, height: c.intrinsics.height }
      : DEFAULT_INTRINSICS(c.width, c.height);
    const name = c.name ?? `cam_${i}`;
    return {
      name,
      file: `${imageBase}/${name}`, // the actual reconstructed photograph (dataset-relative)
      ...basis,
      intrinsics: intr,
      observations: c.observations ?? [],
    };
  });

  // Auto-level: rotate so the camera-ring/arc plane is horizontal (object upright).
  const normal = fitPlaneNormal(cameras.map((c) => c.center));
  if (normal.y < 0) normal.negate();              // canonical: upward-facing normal
  if (meta.flipUp) normal.negate();               // dataset override when it lands upside-down
  const levelQ = new Quaternion().setFromUnitVectors(normal, new Vector3(0, 1, 0));
  const tmp = new Vector3();
  for (let i = 0; i < positions.length; i += 3) {
    tmp.set(positions[i], positions[i + 1], positions[i + 2]).applyQuaternion(levelQ);
    positions[i] = tmp.x; positions[i + 1] = tmp.y; positions[i + 2] = tmp.z;
  }
  for (const cam of cameras) {
    cam.center.applyQuaternion(levelQ);
    cam.right.applyQuaternion(levelQ);
    cam.up.applyQuaternion(levelQ);
    cam.forward.applyQuaternion(levelQ);
  }

  // Build track lines from real observations when available.
  const tracks: Track[] = [];
  if (cams.some((c) => Array.isArray(c.observations) && c.observations.length)) {
    const byPoint = new Map<number, number[]>();
    cams.forEach((c, ci) => {
      (c.observations ?? []).forEach((pi) => {
        if (!byPoint.has(pi)) byPoint.set(pi, []);
        byPoint.get(pi)!.push(ci);
      });
    });
    // Sample the eligible points uniformly rather than taking the first N: the
    // insertion order is grouped by camera, so a first-N cap would draw tracks
    // only to the earliest cameras and leave the far side of a ring bare.
    const eligible = [...byPoint.entries()].filter(([, seenBy]) => seenBy.length >= 2);
    const MAX_TRACKS = 600;
    const stride = Math.max(1, Math.floor(eligible.length / MAX_TRACKS));
    for (let i = 0; i < eligible.length; i += stride) {
      const [pi, seenBy] = eligible[i];
      const px = positions[pi * 3], py = positions[pi * 3 + 1], pz = positions[pi * 3 + 2];
      tracks.push({ point: new Vector3(px, py, pz), cams: seenBy });
    }
  }

  return {
    positions,
    colors,
    pointCount: nPts,
    cameras,
    tracks,
    trackCount: cloud.count,
  };
}
