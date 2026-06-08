#!/usr/bin/env bash
# COLMAP-CLI Structure-from-Motion pipeline → Three.js JSON.
#
# This is the "I already have COLMAP installed" alternative to reconstruct.py
# (the recommended pycolmap path, which needs no system COLMAP). It runs the
# full sparse pipeline and exports pointcloud.json + cameras.json for the viewer.
#
# Usage:
#   bash run_colmap.sh [image_dir] [--clean]
#
# Defaults (override with args or env vars):
#   image_dir : public/images in this repo        (env: IMAGES)
#   work dir  : .sfm_work/colmap in this repo      (env: WORK)
#   GPU       : auto (NVIDIA present → on)         (env: USE_GPU=0|1)
set -euo pipefail

# Repo root = this script's directory. JSON lands in its public/ folder so the
# Vite viewer can fetch it; the work dir stays inside the repo (gitignored).
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CLEAN=0
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    *)       POSITIONAL+=("$arg") ;;
  esac
done

IMAGES="${IMAGES:-${POSITIONAL[0]:-$PROJECT/public/images}}"
WORK="${WORK:-$PROJECT/.sfm_work/colmap}"
DB="$WORK/database.db"
SPARSE="$WORK/sparse"
WEB="$PROJECT/public"

log() { echo -e "\n\033[1;36m=== $* ===\033[0m"; }

# ─── Prerequisites ──────────────────────────────────
if ! command -v colmap >/dev/null 2>&1; then
  echo "ERROR: 'colmap' not found on PATH." >&2
  echo >&2
  echo "Easiest, platform-agnostic path (no system COLMAP needed):" >&2
  echo "    uv sync && uv run reconstruct.py" >&2
  echo >&2
  echo "Or install the COLMAP CLI for your platform:" >&2
  if command -v pacman >/dev/null 2>&1; then
    # COLMAP is in the AUR, not the official Arch repos.
    if   command -v yay  >/dev/null 2>&1; then echo "    yay -S colmap" >&2
    elif command -v paru >/dev/null 2>&1; then echo "    paru -S colmap" >&2
    else echo "    COLMAP is in the AUR — install an AUR helper (e.g. yay/paru), then: yay -S colmap" >&2; fi
  elif command -v apt-get >/dev/null 2>&1; then echo "    sudo apt-get install colmap" >&2
  elif command -v dnf     >/dev/null 2>&1; then echo "    sudo dnf install colmap" >&2
  elif command -v zypper  >/dev/null 2>&1; then echo "    sudo zypper install colmap" >&2
  elif command -v brew    >/dev/null 2>&1; then echo "    brew install colmap" >&2
  else echo "    install COLMAP from your package manager" >&2; fi
  exit 1
fi

if [ ! -d "$IMAGES" ]; then
  echo "ERROR: image directory not found: $IMAGES" >&2
  exit 1
fi

# GPU is auto-on when an NVIDIA device is visible; override with USE_GPU=0|1.
if [ -z "${USE_GPU:-}" ]; then
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
    USE_GPU=1
  else
    USE_GPU=0
  fi
fi

if [ "$CLEAN" = 1 ]; then
  log "Cleaning previous reconstruction ($WORK)"
  rm -rf "$WORK"
fi

mkdir -p "$SPARSE"
echo "Images:  $IMAGES"
echo "Work:    $WORK"
echo "GPU:     $USE_GPU"

# ─── Features ───────────────────────────────────────
if [ ! -f "$DB" ]; then
  log "1/5 — Feature extraction"
  colmap feature_extractor \
    --database_path "$DB" \
    --image_path    "$IMAGES" \
    --ImageReader.single_camera 1 \
    --SiftExtraction.use_gpu "$USE_GPU" \
    --SiftExtraction.max_num_features 8192
else
  echo "Database exists, skipping feature extraction"
fi

# ─── Matching ───────────────────────────────────────
if [ ! -f "$WORK/.matched" ]; then
  log "2/5 — Exhaustive matching"
  colmap exhaustive_matcher \
    --database_path "$DB" \
    --SiftMatching.use_gpu "$USE_GPU"
  touch "$WORK/.matched"
else
  echo "Matches exist, skipping"
fi

# ─── Sparse reconstruction ──────────────────────────
if [ ! -d "$SPARSE/0" ]; then
  log "3/5 — Sparse mapper"
  colmap mapper \
    --database_path "$DB" \
    --image_path    "$IMAGES" \
    --output_path   "$SPARSE"
else
  echo "Sparse model exists, skipping mapper"
fi

# ─── Stats ──────────────────────────────────────────
log "Reconstruction stats"
colmap model_analyzer --path "$SPARSE/0" 2>/dev/null || true

# ─── Export PLY ─────────────────────────────────────
log "4/5 — Export PLY"
colmap model_converter \
  --input_path  "$SPARSE/0" \
  --output_path "$WORK/cloud.ply" \
  --output_type PLY
echo "PLY: $(ls -lh "$WORK/cloud.ply" | awk '{print $5}')"

# ─── Convert to Three.js JSON ────────────────────────
log "5/5 — Convert to Three.js JSON"
mkdir -p "$WEB"
python3 "$PROJECT/colmap_to_json.py" "$SPARSE/0" "$WEB"

log "ALL DONE — run 'npm run dev' (or rebuild) to see the real reconstruction"
