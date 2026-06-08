#!/usr/bin/env python3
"""
Convert a binary/ASCII COLMAP PLY point cloud to a compact JSON
that Three.js can fetch and parse quickly.

Output format:
{
  "count": N,
  "positions": [x,y,z, x,y,z, ...],   // Float32 as list
  "colors":    [r,g,b, r,g,b, ...]    // 0-1 Float as list
}
"""
import struct, json, sys, os
from pathlib import Path

PROJECT = Path(__file__).resolve().parent  # repo root; defaults anchor here

def read_ply(path):
    positions = []
    colors    = []

    with open(path, 'rb') as f:
        # ── Parse header ──
        header = []
        while True:
            line = f.readline().decode('ascii', errors='ignore').strip()
            header.append(line)
            if line == 'end_header':
                break

        is_binary_little = any('binary_little_endian' in l for l in header)
        is_binary_big    = any('binary_big_endian'    in l for l in header)
        is_ascii         = not (is_binary_little or is_binary_big)

        # Count vertices and detect property order
        n_verts = 0
        props = []
        in_vertex = False
        for line in header:
            if line.startswith('element vertex'):
                n_verts = int(line.split()[-1])
                in_vertex = True
            elif line.startswith('element') and 'vertex' not in line:
                in_vertex = False
            elif in_vertex and line.startswith('property'):
                parts = line.split()
                props.append((parts[1], parts[2]))  # (type, name)

        print(f"  vertices: {n_verts:,}  properties: {[p[1] for p in props]}")

        prop_names = [p[1] for p in props]
        prop_types = [p[0] for p in props]

        def fmt_char(t):
            return {'float':'f','double':'d','uchar':'B','uint8':'B',
                    'int':'i','uint':'I','short':'h','ushort':'H',
                    'int8':'b','int16':'h','int32':'i','int64':'q',
                    'uint16':'H','uint32':'I','uint64':'Q'}.get(t,'f')

        struct_fmt = '<' if is_binary_little else ('>' if is_binary_big else '')
        struct_fmt += ''.join(fmt_char(t) for t in prop_types)
        row_size = struct.calcsize(struct_fmt) if not is_ascii else 0

        ix = prop_names.index('x') if 'x' in prop_names else 0
        iy = prop_names.index('y') if 'y' in prop_names else 1
        iz = prop_names.index('z') if 'z' in prop_names else 2
        ir = prop_names.index('red')   if 'red'   in prop_names else (
             prop_names.index('r')     if 'r'     in prop_names else -1)
        ig = prop_names.index('green') if 'green' in prop_names else (
             prop_names.index('g')     if 'g'     in prop_names else -1)
        ib = prop_names.index('blue')  if 'blue'  in prop_names else (
             prop_names.index('b')     if 'b'     in prop_names else -1)

        for _ in range(n_verts):
            if is_ascii:
                vals = list(map(float, f.readline().split()))
            else:
                raw  = f.read(row_size)
                vals = struct.unpack(struct_fmt, raw)

            positions += [vals[ix], vals[iy], vals[iz]]
            if ir >= 0:
                colors += [vals[ir]/255.0, vals[ig]/255.0, vals[ib]/255.0]
            else:
                colors += [1.0, 1.0, 1.0]

    return positions, colors


def main():
    ply_path = Path(sys.argv[1]) if len(sys.argv) > 1 else PROJECT / '.sfm_work/colmap/cloud.ply'
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else PROJECT / 'public/pointcloud.json'
    out_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"Reading {ply_path} …")
    positions, colors = read_ply(ply_path)
    n = len(positions) // 3
    print(f"  → {n:,} points")

    # Round to 5 decimals to trim file size
    positions = [round(v, 5) for v in positions]
    colors    = [round(v, 4) for v in colors]

    doc = {"count": n, "positions": positions, "colors": colors}
    print(f"Writing {out_path} …")
    with open(out_path, 'w') as f:
        json.dump(doc, f, separators=(',', ':'))
    size_mb = os.path.getsize(out_path) / 1e6
    print(f"  Done — {size_mb:.1f} MB")


if __name__ == '__main__':
    main()
