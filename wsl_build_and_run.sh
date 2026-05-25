#!/usr/bin/env bash
# Full openMVG build + SfM pipeline — run inside WSL Ubuntu 24.04
set -e
set -o pipefail

SRC="$HOME/openMVG_src/src"
BUILD="$HOME/openMVG_build"
INSTALL="$HOME/openMVG_install"
IMAGES="$HOME/SceauxCastle/images"
OUT="$HOME/SceauxCastle_sfm"
SENSOR_DB="$SRC/software/SfM/cameraSensorWidthDatabase/sensor_width_camera_database.txt"
BIN="$INSTALL/bin"

log() { echo -e "\n\033[1;36m=== $* ===\033[0m"; }

# ─── 1. Dependencies ─────────────────────────────────
log "Installing build dependencies"
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
    build-essential cmake git \
    libpng-dev libjpeg-dev libtiff-dev \
    libboost-all-dev libeigen3-dev \
    libgoogle-glog-dev libgflags-dev \
    libatlas-base-dev libsuitesparse-dev libceres-dev \
    python3 python3-pip

# ─── 2. CMake configure ──────────────────────────────
log "Configuring CMake"
mkdir -p "$BUILD"
cmake -S "$SRC" -B "$BUILD" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$INSTALL" \
    -DOpenMVG_BUILD_TESTS=OFF \
    -DOpenMVG_BUILD_DOC=OFF \
    -DOpenMVG_USE_OPENMP=ON

# ─── 3. Compile ──────────────────────────────────────
log "Compiling ($(nproc) cores)"
cmake --build "$BUILD" --config Release -j$(nproc)
cmake --install "$BUILD"
echo "Binaries: $(ls $BIN | wc -l) files"

# ─── 4. SfM Pipeline ─────────────────────────────────
log "Step 1/5 — Image listing"
mkdir -p "$OUT"/{listing,features,matches,reconstruction,colorized}

"$BIN/openMVG_main_SfMInit_ImageListing" \
    -i "$IMAGES" \
    -o "$OUT/listing" \
    -d "$SENSOR_DB" \
    -c 3

log "Step 2/5 — Feature extraction (SIFT)"
"$BIN/openMVG_main_ComputeFeatures" \
    -i "$OUT/listing/sfm_data.json" \
    -o "$OUT/features" \
    -m SIFT \
    -n $(nproc)

log "Step 3/5 — Matching"
"$BIN/openMVG_main_ComputeMatches" \
    -i "$OUT/listing/sfm_data.json" \
    -o "$OUT/matches" \
    --feats_dir "$OUT/features" \
    -r 0.8 \
    -n FASTCASCADEHASHINGL2

log "Step 4/5 — Incremental SfM"
"$BIN/openMVG_main_IncrementalSfM" \
    -i "$OUT/listing/sfm_data.json" \
    -m "$OUT/matches" \
    -o "$OUT/reconstruction" \
    -f "$OUT/features"

log "Step 5/5 — Colorize point cloud"
"$BIN/openMVG_main_ComputeSfM_DataColor" \
    -i "$OUT/reconstruction/sfm_data.bin" \
    -o "$OUT/colorized/cloud.ply"

log "DONE — PLY at $OUT/colorized/cloud.ply"
wc -l "$OUT/colorized/cloud.ply"
