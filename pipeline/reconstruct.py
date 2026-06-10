#!/usr/bin/env python3
"""
Run a real Structure-from-Motion reconstruction on a folder of photographs using
pycolmap (COLMAP's engine), and export the result to the JSON the web viewer
consumes.

This produces a point cloud that genuinely corresponds to the photos: every 3D
point is triangulated from SIFT features matched across the images, and every
camera pose is recovered by incremental SfM.

Datasets live under public/datasets/<id>/ with images/ in and data/ out:
  data/pointcloud.json : {count, positions[x,y,z…] (CV coords), colors[r,g,b 0..1…]}
  data/cameras.json    : [{name, position, target, q[wxyz], t, intrinsics, observations[]}]

Usage:
  uv run pipeline/reconstruct.py                       # every folder under public/datasets/
  uv run pipeline/reconstruct.py <dataset-id>          # one dataset, e.g. temple-ring
  uv run pipeline/reconstruct.py -i <folder>           # only the pictures in <folder>
  uv run pipeline/reconstruct.py -i <folder> -o <dir>  # arbitrary folder -> arbitrary out

  -i/--images takes a folder name: an absolute/relative path, or a bare name that
  is looked up under public/datasets/ (so `-i robot` builds public/datasets/robot/).

  -j/--jobs caps the CPU worker threads used by every stage. It defaults to one
  fewer than your core count so the reconstruction no longer pins every core (which
  was freezing low-power machines). Lower it further on a laptop, e.g. -j 2.
"""

import os
import sys
import json
import shutil
import argparse
from pathlib import Path

import numpy as np
import pycolmap


PROJECT = Path(__file__).resolve().parent.parent  # repo root (pipeline/ -> repo)
DATASETS = PROJECT / "public" / "datasets"


def default_jobs():
    # Leave a core free so the machine stays responsive instead of locking up at 100%.
    return max(1, (os.cpu_count() or 2) - 1)


def main():
    p = argparse.ArgumentParser(
        description="Run SfM reconstruction and export the web-viewer JSON.")
    p.add_argument("dataset", nargs="?",
                   help="dataset id under public/datasets/ (omit to build every dataset)")
    p.add_argument("-i", "--images", metavar="FOLDER",
                   help="folder of pictures to reconstruct; overrides the dataset's images/ dir")
    p.add_argument("-o", "--out", metavar="DIR",
                   help="output dir for the JSON (default: <dataset>/data, else <folder>/data)")
    p.add_argument("-j", "--jobs", type=int, default=default_jobs(),
                   help=f"max CPU worker threads per stage (default: {default_jobs()})")
    args = p.parse_args()

    jobs = max(1, args.jobs)

    # Explicit folder of pictures via --images: build just those.
    if args.images:
        image_dir = resolve_image_dir(args.images, args.dataset)
        out_dir = resolve_out_dir(args.out, args.dataset, image_dir)
        reconstruct_one(image_dir, out_dir, jobs=jobs, name=args.dataset or image_dir.name)
        return

    # Resolve which dataset ids to build. Existing metadata entries keep their
    # order; unregistered folders are appended automatically.
    if args.dataset:
        ids = [args.dataset]
    else:
        ids = discover_dataset_ids()

    for did in ids:
        dataset_dir = DATASETS / did
        image_dir = dataset_dir / "images"
        if not image_dir.is_dir():
            image_dir = dataset_dir
        out_dir = Path(args.out) if args.out else DATASETS / did / "data"
        print(f"\n########## dataset: {did} ##########")
        reconstruct_one(image_dir, out_dir, jobs=jobs, name=did)

    print("\nDone. Run 'pnpm dev' (or rebuild) to view the reconstructions.")


def discover_dataset_ids():
    """Return dataset folders, preserving optional metadata ordering."""
    configured = []
    manifest_path = DATASETS / "index.json"
    if manifest_path.exists():
        configured = [entry["id"] for entry in json.loads(manifest_path.read_text())]

    existing = {path.name for path in DATASETS.iterdir()
                if path.is_dir() and not path.name.startswith(".")}
    return ([did for did in configured if did in existing]
            + sorted(existing.difference(configured)))


def resolve_image_dir(folder, dataset):
    """Resolve a folder name to an images directory.

    Accepts a real path (absolute or relative to the cwd), or a bare name that is
    looked up under the dataset and under public/datasets/.
    """
    candidates = [Path(folder)]
    if dataset:
        candidates += [DATASETS / dataset / "images" / folder, DATASETS / dataset / folder]
    candidates.append(DATASETS / folder)
    for c in candidates:
        if c.is_dir():
            return c
    sys.exit(f"Images folder not found: {folder}")


def resolve_out_dir(out, dataset, image_dir):
    if out:
        return Path(out)
    if dataset:
        return DATASETS / dataset / "data"
    return image_dir / "data"


def threaded_options(cls_name, jobs):
    """Build a pycolmap options object with num_threads capped, defensively.

    Returns None when the class or the field is unavailable so callers can simply
    skip passing the option (keeps us working across pycolmap versions).
    """
    cls = getattr(pycolmap, cls_name, None)
    if cls is None:
        return None
    opts = cls()
    if not hasattr(opts, "num_threads"):
        return None
    opts.num_threads = jobs
    return opts


def call_with_options(fn, option_kwargs, **kwargs):
    """Call fn with the optional options kwargs, falling back without them.

    If a particular pycolmap build doesn't accept the option kwarg, retry without
    it rather than crashing (the cap is best-effort).
    """
    if option_kwargs:
        try:
            return fn(**kwargs, **option_kwargs)
        except TypeError:
            pass
    return fn(**kwargs)


def reconstruct_one(image_dir, out_dir, jobs, name):
    out_dir.mkdir(parents=True, exist_ok=True)

    if not image_dir.exists():
        sys.exit(f"Image directory not found: {image_dir}")

    work = PROJECT / ".sfm_work" / name
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    db_path = work / "database.db"
    sparse_dir = work / "sparse"
    sparse_dir.mkdir()

    print("=" * 60)
    print("Structure-from-Motion reconstruction (pycolmap)")
    print(f"  images : {image_dir}")
    print(f"  out    : {out_dir}")
    print(f"  jobs   : {jobs} CPU thread(s) per stage")
    print("=" * 60)

    # Only feed actual image files to COLMAP (skip K.txt / Readme.txt / *_par.txt).
    exts = {".jpg", ".jpeg", ".png", ".tif", ".tiff"}
    image_names = sorted(p.name for p in image_dir.iterdir() if p.suffix.lower() in exts)
    if not image_names:
        sys.exit(f"No images found in: {image_dir}")
    print(f"Images ({len(image_names)}): {', '.join(image_names)}")

    sift_extract = threaded_options("SiftExtractionOptions", jobs)
    sift_match = threaded_options("SiftMatchingOptions", jobs)
    mapper = threaded_options("IncrementalPipelineOptions", jobs)

    # 1. SIFT feature extraction.
    print("\n[1/4] Extracting SIFT features…")
    call_with_options(
        pycolmap.extract_features,
        {"sift_options": sift_extract} if sift_extract else None,
        database_path=db_path,
        image_path=image_dir,
        image_names=image_names,
    )

    # 2. Exhaustive feature matching (every image against every other).
    print("\n[2/4] Matching features (exhaustive)…")
    call_with_options(
        pycolmap.match_exhaustive,
        {"sift_options": sift_match} if sift_match else None,
        database_path=db_path,
    )

    # 3. Incremental sparse reconstruction.
    print("\n[3/4] Incremental mapping…")
    recs = call_with_options(
        pycolmap.incremental_mapping,
        {"options": mapper} if mapper else None,
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

        # cam_from_world: world -> camera rigid transform (method in pycolmap 4.x).
        cfw = image.cam_from_world()
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
