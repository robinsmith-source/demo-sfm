/**
 * types.ts — shared domain types for the viewer.
 */

import type { Vector3 } from 'three';

export interface Intrinsics {
  fx: number; fy: number; cx: number; cy: number; width: number; height: number;
}

/** An orthonormal camera basis in three.js world space. */
export interface CameraBasis {
  center: Vector3;
  right: Vector3;
  up: Vector3;
  forward: Vector3;
}

/** A reconstructed camera: pose + intrinsics + the photo it came from. */
export interface SfmCamera extends CameraBasis {
  name: string;
  file: string;
  intrinsics: Intrinsics;
  observations: number[];
}

/** A 3D point and the indices of the cameras that observe it. */
export interface Track {
  point: Vector3;
  cams: number[];
}

/** A fully loaded, normalised reconstruction ready to render. */
export interface Reconstruction {
  positions: Float32Array;
  colors: Float32Array;
  pointCount: number;
  cameras: SfmCamera[];
  tracks: Track[];
  trackCount: number;
}

/** One entry in public/datasets/index.json. */
export interface DatasetMeta {
  id: string;
  name: string;
  subtitle?: string;
  credit?: string;
  /**
   * Auto-levelling stands the object up by aligning the camera-ring plane to
   * the horizon, but the up/down sign is ambiguous for a symmetric ring orbit.
   * Set true if a dataset comes out upside-down to flip it right way up.
   */
  flipUp?: boolean;
}
