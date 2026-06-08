#!/usr/bin/env python3
"""
openMVG SfM pipeline — the "from-source openMVG" alternative to the recommended
pycolmap path (reconstruct.py). Run after build_openmvg.sh completes, then
convert the result with:  uv run ply_to_json.py <colorized.ply>

Paths are configurable via env vars (sensible defaults shown):
  IMAGE_DIR    images to reconstruct      (default: <repo>/public/images)
  OUTPUT_DIR   pipeline output            (default: <repo>/.sfm_work/openmvg)
  OPENMVG_BIN  installed openMVG binaries (default: ~/openMVG_install/bin)
  SENSOR_DB    camera sensor width DB     (default: alongside OPENMVG_BIN's source)

Or pass the image dir as the first CLI argument.
"""

import os
import sys
import subprocess
import shutil
from pathlib import Path

# Repo root = this script's directory.
PROJECT = Path(__file__).resolve().parent
HOME = Path.home()


def env_path(name, default):
    return Path(os.environ[name]) if name in os.environ else default


OPENMVG_BIN = env_path("OPENMVG_BIN", HOME / "openMVG_install" / "bin")
SENSOR_DB = env_path(
    "SENSOR_DB",
    HOME / "openMVG_src" / "src" / "software" / "SfM"
    / "cameraSensorWidthDatabase" / "sensor_width_camera_database.txt",
)

# Image dir: CLI arg → $IMAGE_DIR → repo's public/images.
IMAGE_DIR = (
    Path(sys.argv[1]) if len(sys.argv) > 1
    else env_path("IMAGE_DIR", PROJECT / "public" / "images")
)
OUTPUT_DIR = env_path("OUTPUT_DIR", PROJECT / ".sfm_work" / "openmvg")

# Pipeline output subdirs
LISTING_DIR = OUTPUT_DIR / "01_listing"
FEATURES_DIR = OUTPUT_DIR / "02_features"
MATCHES_DIR = OUTPUT_DIR / "03_matches"
RECONSTRUCTION_DIR = OUTPUT_DIR / "04_reconstruction"
COLORIZED_DIR = OUTPUT_DIR / "05_colorized"
MVS_DIR = OUTPUT_DIR / "06_mvs_export"


def run(cmd, **kwargs):
    print(f"\n>>> {' '.join(str(c) for c in cmd)}\n")
    result = subprocess.run([str(c) for c in cmd], check=True, **kwargs)
    return result


def main():
    print("=" * 60)
    print("OpenMVG SfM Reconstruction - SceauxCastle")
    print("=" * 60)

    # Validate prerequisites
    if not OPENMVG_BIN.exists():
        sys.exit(f"ERROR: openMVG binaries not found at {OPENMVG_BIN}\nRun build_openmvg.sh first.")

    if not IMAGE_DIR.exists():
        sys.exit(f"ERROR: Image directory not found at {IMAGE_DIR}\n"
                 "Pass an image dir as the first argument, set $IMAGE_DIR, "
                 "or place images in public/images/.")

    # Create output directories
    for d in [LISTING_DIR, FEATURES_DIR, MATCHES_DIR, RECONSTRUCTION_DIR, COLORIZED_DIR, MVS_DIR]:
        d.mkdir(parents=True, exist_ok=True)

    bin = lambda name: OPENMVG_BIN / name

    # Step 1: Image listing - reads EXIF to extract camera intrinsics
    print("\n[1/6] Image listing...")
    run([
        bin("openMVG_main_SfMInit_ImageListing"),
        "-i", IMAGE_DIR,
        "-o", LISTING_DIR,
        "-d", SENSOR_DB,
        "-c", "3",   # radial k3 distortion model
    ])

    # Step 2: Feature extraction (SIFT)
    print("\n[2/6] Computing features...")
    run([
        bin("openMVG_main_ComputeFeatures"),
        "-i", LISTING_DIR / "sfm_data.json",
        "-o", FEATURES_DIR,
        "-m", "SIFT",
        "-n", str(os.cpu_count()),
    ])

    # Step 3: Match images
    print("\n[3/6] Computing matches...")
    run([
        bin("openMVG_main_ComputeMatches"),
        "-i", LISTING_DIR / "sfm_data.json",
        "-o", MATCHES_DIR,
        "--feats_dir", FEATURES_DIR,
        "-r", "0.8",   # ratio test threshold
        "-n", "FASTCASCADEHASHINGL2",
    ])

    # Step 4: Incremental SfM reconstruction
    print("\n[4/6] Incremental SfM reconstruction...")
    run([
        bin("openMVG_main_IncrementalSfM"),
        "-i", LISTING_DIR / "sfm_data.json",
        "-m", MATCHES_DIR,
        "-o", RECONSTRUCTION_DIR,
        "-f", FEATURES_DIR,
    ])

    # Step 5: Add color to the point cloud
    print("\n[5/6] Colorizing point cloud...")
    run([
        bin("openMVG_main_ComputeSfM_DataColor"),
        "-i", RECONSTRUCTION_DIR / "sfm_data.bin",
        "-o", COLORIZED_DIR / "colorized.ply",
    ])

    # Step 6: Export for openMVS (dense reconstruction)
    print("\n[6/6] Exporting to openMVS format...")
    mvs_bin = Path(shutil.which("openMVG_main_openMVG2openMVS") or "")
    if mvs_bin.exists():
        run([
            mvs_bin,
            "-i", RECONSTRUCTION_DIR / "sfm_data.bin",
            "-o", MVS_DIR / "scene.mvs",
            "-d", MVS_DIR,
        ])
    else:
        print("  openMVG2openMVS not found, skipping MVS export.")

    print("\n" + "=" * 60)
    print("RECONSTRUCTION COMPLETE")
    print("=" * 60)
    print(f"  Sparse point cloud (PLY): {COLORIZED_DIR / 'colorized.ply'}")
    print(f"  SfM data:                 {RECONSTRUCTION_DIR / 'sfm_data.bin'}")
    print(f"  Cameras + images:         {RECONSTRUCTION_DIR}")
    if (MVS_DIR / "scene.mvs").exists():
        print(f"  MVS scene:                {MVS_DIR / 'scene.mvs'}")
    print("\nOpen colorized.ply with MeshLab or CloudCompare to view the 3D model.")


if __name__ == "__main__":
    main()
