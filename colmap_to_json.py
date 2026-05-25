#!/usr/bin/env python3
"""
Convert COLMAP sparse reconstruction outputs to JSON files for Three.js.

Produces two files in the web project folder:
  pointcloud.json  — coloured 3D points
  cameras.json     — camera positions + look-at targets

Usage:
  python3 colmap_to_json.py [sparse_dir] [web_dir]

  sparse_dir : path to COLMAP sparse/0  (default: ~/SceauxCastle_colmap/sparse/0)
  web_dir    : where to write JSON files (default: current directory)
"""

import sys, os, struct, json, re
from pathlib import Path
import numpy as np

# ─────────────────────────────────────────────────────
# COLMAP binary readers
# ─────────────────────────────────────────────────────

def read_cameras_binary(path):
    cameras = {}
    with open(path, 'rb') as f:
        num = struct.unpack('<Q', f.read(8))[0]
        for _ in range(num):
            cam_id   = struct.unpack('<I', f.read(4))[0]
            model_id = struct.unpack('<I', f.read(4))[0]
            width    = struct.unpack('<Q', f.read(8))[0]
            height   = struct.unpack('<Q', f.read(8))[0]
            # number of params depends on model
            num_params = {0:3,1:4,2:4,3:5,4:5,5:8,6:8,7:9,
                          8:10,9:10,10:6,11:9,12:12,13:13}.get(model_id, 4)
            params = struct.unpack(f'<{num_params}d', f.read(8*num_params))
            cameras[cam_id] = {'width':width,'height':height,'params':params}
    return cameras


def read_images_binary(path):
    images = {}
    with open(path, 'rb') as f:
        num = struct.unpack('<Q', f.read(8))[0]
        for _ in range(num):
            img_id = struct.unpack('<I', f.read(4))[0]
            qw,qx,qy,qz = struct.unpack('<4d', f.read(32))
            tx,ty,tz    = struct.unpack('<3d', f.read(24))
            cam_id = struct.unpack('<I', f.read(4))[0]
            name_bytes = b''
            while True:
                c = f.read(1)
                if c == b'\x00': break
                name_bytes += c
            name = name_bytes.decode()
            num_pts = struct.unpack('<Q', f.read(8))[0]
            f.read(24 * num_pts)  # skip 2D points
            images[img_id] = {'qvec':(qw,qx,qy,qz),'tvec':(tx,ty,tz),'cam_id':cam_id,'name':name}
    return images


def read_points3d_binary(path):
    points = []
    with open(path, 'rb') as f:
        num = struct.unpack('<Q', f.read(8))[0]
        for _ in range(num):
            _pid = struct.unpack('<Q', f.read(8))[0]
            xyz  = struct.unpack('<3d', f.read(24))
            rgb  = struct.unpack('<3B', f.read(3))
            _err = struct.unpack('<d',  f.read(8))[0]
            n_track = struct.unpack('<Q', f.read(8))[0]
            f.read(8 * n_track)  # skip track
            points.append({'xyz': xyz, 'rgb': rgb})
    return points


def read_points3d_text(path):
    points = []
    with open(path) as f:
        for line in f:
            if line.startswith('#'): continue
            parts = line.split()
            if len(parts) < 7: continue
            x,y,z = float(parts[1]),float(parts[2]),float(parts[3])
            r,g,b = int(parts[4]),int(parts[5]),int(parts[6])
            points.append({'xyz':(x,y,z),'rgb':(r,g,b)})
    return points


def read_images_text(path):
    images = {}
    with open(path) as f:
        lines = [l for l in f if not l.startswith('#')]
    i = 0
    while i < len(lines):
        parts = lines[i].split()
        if not parts: i+=1; continue
        img_id = int(parts[0])
        qw,qx,qy,qz = float(parts[1]),float(parts[2]),float(parts[3]),float(parts[4])
        tx,ty,tz     = float(parts[5]),float(parts[6]),float(parts[7])
        cam_id = int(parts[8])
        name = parts[9]
        images[img_id] = {'qvec':(qw,qx,qy,qz),'tvec':(tx,ty,tz),'cam_id':cam_id,'name':name}
        i += 2  # skip 2D-point line
    return images


# ─────────────────────────────────────────────────────
# Quaternion → rotation matrix → camera centre
# ─────────────────────────────────────────────────────
def quat_to_rot(q):
    qw,qx,qy,qz = q
    R = np.array([
        [1-2*(qy**2+qz**2), 2*(qx*qy-qz*qw),   2*(qx*qz+qy*qw)  ],
        [2*(qx*qy+qz*qw),   1-2*(qx**2+qz**2), 2*(qy*qz-qx*qw)  ],
        [2*(qx*qz-qy*qw),   2*(qy*qz+qx*qw),   1-2*(qx**2+qy**2)],
    ])
    return R

def camera_centre(qvec, tvec):
    R = quat_to_rot(qvec)
    t = np.array(tvec)
    C = -R.T @ t   # world position of camera
    return C.tolist()

def camera_target(qvec, tvec):
    R = quat_to_rot(qvec)
    t = np.array(tvec)
    C   = -R.T @ t
    fwd = R.T @ np.array([0, 0, 1])  # look direction in world
    target = C + fwd * 5.0
    return target.tolist()


# ─────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────
def main():
    sparse_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / 'SceauxCastle_colmap/sparse/0'
    web_dir    = Path(sys.argv[2]) if len(sys.argv) > 2 else Path('.')

    print(f"Reading COLMAP sparse from: {sparse_dir}")

    # Detect binary vs text format
    bin_pts  = sparse_dir / 'points3D.bin'
    txt_pts  = sparse_dir / 'points3D.txt'
    bin_imgs = sparse_dir / 'images.bin'
    txt_imgs = sparse_dir / 'images.txt'

    # ── Points ──
    if bin_pts.exists():
        print("  reading points3D.bin …")
        raw_pts = read_points3d_binary(bin_pts)
    elif txt_pts.exists():
        print("  reading points3D.txt …")
        raw_pts = read_points3d_text(txt_pts)
    else:
        sys.exit(f"No points3D file found in {sparse_dir}")

    print(f"  {len(raw_pts):,} 3D points")

    positions, colors = [], []
    for p in raw_pts:
        x,y,z = p['xyz']
        r,g,b = p['rgb']
        positions += [round(x,5), round(y,5), round(z,5)]
        colors    += [round(r/255,4), round(g/255,4), round(b/255,4)]

    pc_path = web_dir / 'pointcloud.json'
    print(f"Writing {pc_path} …")
    with open(pc_path, 'w') as f:
        json.dump({'count': len(raw_pts), 'positions': positions, 'colors': colors},
                  f, separators=(',', ':'))
    print(f"  → {pc_path.stat().st_size / 1e6:.1f} MB")

    # ── Cameras ──
    if bin_imgs.exists():
        print("  reading images.bin …")
        raw_imgs = read_images_binary(bin_imgs)
    elif txt_imgs.exists():
        print("  reading images.txt …")
        raw_imgs = read_images_text(txt_imgs)
    else:
        print("  No images file — skipping cameras.json")
        return

    cams_out = []
    for img in sorted(raw_imgs.values(), key=lambda x: x['name']):
        C = camera_centre(img['qvec'], img['tvec'])
        T = camera_target(img['qvec'], img['tvec'])
        cams_out.append({
            'name': img['name'],
            'position': [round(v,5) for v in C],
            'target':   [round(v,5) for v in T],
        })

    cams_path = web_dir / 'cameras.json'
    print(f"Writing {cams_path} ({len(cams_out)} cameras) …")
    with open(cams_path, 'w') as f:
        json.dump(cams_out, f, separators=(',',':'))
    print("Done!")


if __name__ == '__main__':
    main()
