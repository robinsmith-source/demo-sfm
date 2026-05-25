#!/usr/bin/env bash
# COLMAP sparse reconstruction pipeline for SceauxCastle
set -e

IMAGES="$HOME/SceauxCastle/images"
OUT="$HOME/SceauxCastle_colmap"
DB="$OUT/database.db"
SPARSE="$OUT/sparse"

log() { echo -e "\n\033[1;36m=== $* ===\033[0m"; }

mkdir -p "$OUT" "$SPARSE"

log "1/4 — Feature extraction"
colmap feature_extractor \
    --database_path "$DB" \
    --image_path "$IMAGES" \
    --ImageReader.single_camera 1 \
    --SiftExtraction.use_gpu 0 \
    --SiftExtraction.max_num_features 8192

log "2/4 — Exhaustive matching"
colmap exhaustive_matcher \
    --database_path "$DB" \
    --SiftMatching.use_gpu 0

log "3/4 — Sparse mapper"
colmap mapper \
    --database_path "$DB" \
    --image_path "$IMAGES" \
    --output_path "$SPARSE"

log "4/4 — Export colored point cloud to PLY"
# Pick the largest reconstruction (folder 0)
colmap model_converter \
    --input_path  "$SPARSE/0" \
    --output_path "$OUT/cloud.ply" \
    --output_type PLY

log "DONE"
echo "PLY → $OUT/cloud.ply"
wc -l "$OUT/cloud.ply" 2>/dev/null || ls -lh "$OUT/cloud.ply"
