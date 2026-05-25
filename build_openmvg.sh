#!/usr/bin/env bash
set -e

INSTALL_DIR="$HOME/openMVG_install"
BUILD_DIR="$HOME/openMVG_build"
SRC_DIR="$HOME/openMVG_src"

echo "=== Installing build dependencies ==="
sudo apt-get update -qq
sudo apt-get install -y \
    build-essential \
    cmake \
    git \
    libpng-dev \
    libjpeg-dev \
    libtiff-dev \
    libboost-all-dev \
    libeigen3-dev \
    libflann-dev \
    libgoogle-glog-dev \
    libgflags-dev \
    libatlas-base-dev \
    libsuitesparse-dev \
    libceres-dev \
    libopencv-dev \
    2>&1

echo "=== Cloning openMVG ==="
if [ ! -d "$SRC_DIR" ]; then
    git clone --recursive https://github.com/openMVG/openMVG.git "$SRC_DIR"
else
    echo "Source already exists, updating submodules..."
    cd "$SRC_DIR" && git submodule update --init --recursive
fi

echo "=== Building openMVG ==="
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"
cmake \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
    -DOpenMVG_BUILD_TESTS=OFF \
    -DOpenMVG_BUILD_DOC=OFF \
    "$SRC_DIR/src"

make -j$(nproc)
make install

echo ""
echo "=== Build complete! ==="
echo "Binaries installed to: $INSTALL_DIR/bin"
ls "$INSTALL_DIR/bin/"
