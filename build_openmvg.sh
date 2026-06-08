#!/usr/bin/env bash
# Build openMVG from source — the "from-source SfM" alternative to the
# recommended pycolmap path (reconstruct.py). Only needed if you want to run
# run_reconstruction.py (the openMVG pipeline).
#
# Detects your package manager (pacman / apt / dnf / zypper / brew) and installs
# the right dependency package names, then clones, builds and installs openMVG.
#
# Override paths with env vars:
#   SRC_DIR     (default: ~/openMVG_src)
#   BUILD_DIR   (default: ~/openMVG_build)
#   INSTALL_DIR (default: ~/openMVG_install)
set -euo pipefail

SRC_DIR="${SRC_DIR:-$HOME/openMVG_src}"
BUILD_DIR="${BUILD_DIR:-$HOME/openMVG_build}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/openMVG_install}"

log() { echo -e "\n\033[1;36m=== $* ===\033[0m"; }

# ─── Dependency install (distro-aware) ───────────────
install_deps() {
  local sudo=""
  [ "$(id -u)" -ne 0 ] && sudo="sudo"

  if command -v pacman >/dev/null 2>&1; then
    log "Installing build dependencies (pacman)"
    $sudo pacman -S --needed --noconfirm \
      base-devel cmake git \
      libpng libjpeg-turbo libtiff \
      boost eigen flann \
      google-glog gflags openblas suitesparse ceres-solver opencv

  elif command -v apt-get >/dev/null 2>&1; then
    log "Installing build dependencies (apt)"
    $sudo apt-get update -qq
    $sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
      build-essential cmake git \
      libpng-dev libjpeg-dev libtiff-dev \
      libboost-all-dev libeigen3-dev libflann-dev \
      libgoogle-glog-dev libgflags-dev \
      libatlas-base-dev libsuitesparse-dev libceres-dev libopencv-dev

  elif command -v dnf >/dev/null 2>&1; then
    log "Installing build dependencies (dnf)"
    $sudo dnf install -y \
      gcc gcc-c++ make cmake git \
      libpng-devel libjpeg-turbo-devel libtiff-devel \
      boost-devel eigen3-devel flann-devel \
      glog-devel gflags-devel atlas-devel suitesparse-devel ceres-solver-devel opencv-devel

  elif command -v zypper >/dev/null 2>&1; then
    log "Installing build dependencies (zypper)"
    $sudo zypper install -y \
      gcc gcc-c++ make cmake git \
      libpng16-devel libjpeg8-devel libtiff-devel \
      boost-devel eigen3-devel flann-devel \
      glog-devel gflags-devel suitesparse-devel ceres-solver-devel opencv-devel

  elif command -v brew >/dev/null 2>&1; then
    log "Installing build dependencies (brew)"
    brew install cmake git libpng jpeg libtiff boost eigen flann \
      glog gflags suite-sparse ceres-solver opencv

  else
    echo "ERROR: no supported package manager found (pacman/apt/dnf/zypper/brew)." >&2
    echo "Install the openMVG build deps manually, then re-run with deps already present." >&2
    exit 1
  fi
}

install_deps

# ─── Clone ───────────────────────────────────────────
log "Cloning openMVG → $SRC_DIR"
if [ ! -d "$SRC_DIR" ]; then
  git clone --recursive https://github.com/openMVG/openMVG.git "$SRC_DIR"
else
  echo "Source exists, updating submodules…"
  git -C "$SRC_DIR" submodule update --init --recursive
fi

# ─── Build ───────────────────────────────────────────
log "Configuring CMake"
cmake -S "$SRC_DIR/src" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
  -DOpenMVG_BUILD_TESTS=OFF \
  -DOpenMVG_BUILD_DOC=OFF \
  -DOpenMVG_USE_OPENMP=ON

NPROC="$( (command -v nproc >/dev/null 2>&1 && nproc) || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
log "Compiling ($NPROC cores)"
cmake --build "$BUILD_DIR" --config Release -j"$NPROC"
cmake --install "$BUILD_DIR"

log "Build complete — binaries in $INSTALL_DIR/bin"
ls "$INSTALL_DIR/bin/"
