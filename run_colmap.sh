#!/usr/bin/env bash
# Run the full COLMAP pipeline and export to Three.js JSON
# Usage: bash run_colmap.sh
set -e

IMAGES="$HOME/SceauxCastle/images"
OUT="$HOME/SceauxCastle_colmap"
DB="$OUT/database.db"
SPARSE="$OUT/sparse"
WEB="/mnt/c/Users/robin/WebstormProjects/openMVG"

log() { echo -e "\n\033[1;36m=== $* ===\033[0m"; }

# Clean previous run if requested
if [[ "$1" == "--clean" ]]; then
  log "Cleaning previous reconstruction"
  rm -rf "$OUT"
fi

mkdir -p "$OUT" "$SPARSE"

# ─── Features ───────────────────────────────────────
if [ ! -f "$DB" ]; then
  log "1/5 — Feature extraction"
  colmap feature_extractor \
    --database_path "$DB" \
    --image_path    "$IMAGES" \
    --ImageReader.single_camera 1 \
    --SiftExtraction.use_gpu 0 \
    --SiftExtraction.max_num_features 8192
else
  echo "Database exists, skipping feature extraction"
fi

# ─── Matching ───────────────────────────────────────
if [ ! -f "$OUT/.matched" ]; then
  log "2/5 — Exhaustive matching"
  colmap exhaustive_matcher \
    --database_path "$DB" \
    --SiftMatching.use_gpu 0
  touch "$OUT/.matched"
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
  --output_path "$OUT/cloud.ply" \
  --output_type PLY
echo "PLY: $(ls -lh $OUT/cloud.ply | awk '{print $5}')"

# ─── Convert to Three.js JSON ────────────────────────
log "5/5 — Convert to Three.js JSON"
python3 "$WEB/colmap_to_json.py" "$SPARSE/0" "$WEB"

log "ALL DONE — reload http://localhost:3333 to see real reconstruction"
