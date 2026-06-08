#!/usr/bin/env python3
"""
Run a real Structure-from-Motion reconstruction on the photographs in
public/images/ using pycolmap (COLMAP's engine), and export the result to the
JSON the web viewer consumes.

This produces a point cloud that genuinely corresponds to the photos: every 3D
point is triangulated from SIFT features matched across the images, and every
camera pose is recovered by incremental SfM.

Outputs (in public/):
  pointcloud.json : {count, positions[x,y,z…] (COLMAP/CV coords), colors[r,g,b 0..1…]}
  cameras.json    : [{name, position, target, q[wxyz], t, intrinsics, observations[]}]

Usage:
  uv run reconstruct.py [image_dir] [out_dir]
"""

import sys
import json
import shutil
from pathlib import Path

import numpy as np
import pycolmap


PROJECT = Path(__file__).resolve().parent  # repo root; defaults anchor here


def main():
    image_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else PROJECT / "public" / "images"
    out_dir   = Path(sys.argv[2]) if len(sys.argv) > 2 else PROJECT / "public"
    out_dir.mkdir(parents=True, exist_ok=True)

    if not image_dir.exists():
        sys.exit(f"Image directory not found: {image_dir}")

    work = PROJECT / ".sfm_work" / "pycolmap"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    db_path = work / "database.db"
    sparse_dir = work / "sparse"
    sparse_dir.mkdir()

    print("=" * 60)
    print("Structure-from-Motion reconstruction (pycolmap)")
    print("=" * 60)

    # Only feed actual image files to COLMAP (skip K.txt / Readme.txt).
    exts = {".jpg", ".jpeg", ".png", ".tif", ".tiff"}
    image_names = sorted(p.name for p in image_dir.iterdir() if p.suffix.lower() in exts)
    print(f"Images ({len(image_names)}): {', '.join(image_names)}")

    # 1. SIFT feature extraction.
    print("\n[1/4] Extracting SIFT features…")
    pycolmap.extract_features(
        database_path=db_path,
        image_path=image_dir,
        image_names=image_names,
    )

    # 2. Exhaustive feature matching (every image against every other).
    print("\n[2/4] Matching features (exhaustive)…")
    pycolmap.match_exhaustive(database_path=db_path)

    # 3. Incremental sparse reconstruction.
    print("\n[3/4] Incremental mapping…")
    recs = pycolmap.incremental_mapping(
        database_path=db_path,
        image_path=image_dir,
        output_path=sparse_dir,
    )
    if not recs:
        sys.exit("Reconstruction failed: no model produced.")

    # Pick the largest reconstruction (most registered images).
    rec = max(recs.values(), key=lambda r: r.num_reg_images())
    print(f"\n  registered images : {rec.num_reg_images()} / {len(image_names)}")
    print(f"  3D points         : {rec.num_points3D():,}")
    print(f"  mean track length : {rec.compute_mean_track_length():.2f}")
    print(f"  mean reproj error : {rec.compute_mean_reprojection_error():.3f} px")

    # 4. Export to viewer JSON.
    print("\n[4/4] Exporting JSON…")
    export(rec, out_dir)
    print("\nDone. Run 'npm run dev' (or rebuild) to view the real reconstruction.")


def export(rec, out_dir):
    # Stable point ordering; build id -> output-index map for observations.
    point_ids = sorted(rec.points3D.keys())
    index_of = {pid: i for i, pid in enumerate(point_ids)}

    positions, colors = [], []
    obs_by_image = {}  # colmap image_id -> [output point index, …]
    for pid in point_ids:
        p = rec.points3D[pid]
        x, y, z = (float(v) for v in p.xyz)
        r, g, b = (int(v) for v in p.color)
        positions += [round(x, 5), round(y, 5), round(z, 5)]
        colors    += [round(r / 255, 4), round(g / 255, 4), round(b / 255, 4)]
        for el in p.track.elements:
            obs_by_image.setdefault(el.image_id, []).append(index_of[pid])

    pc_path = out_dir / "pointcloud.json"
    with open(pc_path, "w") as f:
        json.dump({"count": len(point_ids), "positions": positions, "colors": colors},
                  f, separators=(",", ":"))
    print(f"  {pc_path}  ({pc_path.stat().st_size / 1e6:.2f} MB, {len(point_ids):,} pts)")

    MAX_OBS = 600
    cams_out = []
    # Sort by image name so the viewer's filmstrip ordering is deterministic.
    for image in sorted(rec.images.values(), key=lambda im: im.name):
        cam = rec.cameras[image.camera_id]

        # cam_from_world: world -> camera rigid transform.
        cfw = image.cam_from_world
        qx, qy, qz, qw = (float(v) for v in cfw.rotation.quat)  # Eigen order [x,y,z,w]
        tx, ty, tz = (float(v) for v in cfw.translation)

        center = [float(v) for v in image.projection_center()]
        # Look-at target: 5 units along the viewing direction.
        fwd = np.asarray(image.viewing_direction(), dtype=float)
        target = [round(center[i] + fwd[i] * 5.0, 5) for i in range(3)]

        entry = {
            "name": image.name,
            "position": [round(v, 5) for v in center],
            "target": target,
            "q": [round(qw, 8), round(qx, 8), round(qy, 8), round(qz, 8)],
            "t": [round(tx, 8), round(ty, 8), round(tz, 8)],
            "intrinsics": intrinsics(cam),
        }
        obs = obs_by_image.get(image.image_id, [])
        if obs:
            entry["observations"] = obs[:MAX_OBS]
        cams_out.append(entry)

    cams_path = out_dir / "cameras.json"
    with open(cams_path, "w") as f:
        json.dump(cams_out, f, separators=(",", ":"))
    print(f"  {cams_path}  ({len(cams_out)} cameras)")


def intrinsics(cam):
    p = [float(v) for v in cam.params]
    model = cam.model.name if hasattr(cam.model, "name") else str(cam.model)
    # Two-focal-length models put fx, fy first; single-focal models share one f.
    if model in ("PINHOLE", "OPENCV", "OPENCV_FISHEYE", "FULL_OPENCV"):
        fx, fy, cx, cy = p[0], p[1], p[2], p[3]
    else:  # SIMPLE_PINHOLE, SIMPLE_RADIAL, RADIAL, …
        fx = fy = p[0]
        cx, cy = p[1], p[2]
    return {
        "fx": round(fx, 4), "fy": round(fy, 4),
        "cx": round(cx, 4), "cy": round(cy, 4),
        "width": int(cam.width), "height": int(cam.height),
    }


if __name__ == "__main__":
    main()
