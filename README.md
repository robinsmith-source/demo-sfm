# Sceaux Castle · Structure-from-Motion Viewer

An interactive [three.js](https://threejs.org/) viewer for a sparse 3D
reconstruction of the [Sceaux Castle dataset](https://github.com/openMVG/ImageDataset_SceauxCastle),
built as a static site with [Vite](https://vitejs.dev/).

The viewer shows the sparse point cloud, recovered camera poses (as frustums with
their source photographs pinned to the image plane), and feature **tracks** that
link each 3D point to the cameras that observe it.

## Quick start

```bash
npm install
npm run dev        # local dev server with HMR
npm run build      # production build → dist/
npm run preview    # serve the production build locally
```

`npm run build` emits a fully static `dist/` folder. `base: './'` in
`vite.config.js` keeps every asset path relative, so the output can be dropped
onto **any** static host (GitHub Pages, Netlify, Cloudflare Pages, S3, a
sub-path) with no extra configuration.

## Data: real vs. synthetic

On load the viewer tries to fetch a real reconstruction:

- `public/pointcloud.json` — coloured 3D points
- `public/cameras.json` — camera poses + intrinsics + observations

If those files are absent, it falls back to a **geometrically self-consistent
synthetic reconstruction**: a synthetic castle point cloud with cameras placed on
a frontal arc. The tracks shown for the synthetic scene are *not* random — every
point is projected into every camera with the real pinhole model and a track is
recorded only where the point genuinely lands inside that camera's image, the
same visibility test feature matching enforces (`src/sfm.js`).

### Generating the real reconstruction

All pipelines reconstruct the photos in `public/images/` by default and write
the JSON into `public/`. Paths are not hard-coded — pass a different image
directory as the first argument (or via the documented env vars) to reconstruct
any dataset.

**Recommended — pycolmap (no system build, works on any distro):**

```bash
uv sync                                # installs pycolmap (prebuilt engine) + numpy
uv run reconstruct.py                  # → public/pointcloud.json + cameras.json
# reconstruct a different dataset:  uv run reconstruct.py /path/to/images
```

**Alternative — COLMAP CLI** (if you already have `colmap` installed; exports
intrinsics + per-image observations too):

```bash
bash run_colmap.sh                     # add --clean to start fresh
# internally: python3 colmap_to_json.py <sparse/0> public/
```

`run_colmap.sh` auto-detects an NVIDIA GPU (override with `USE_GPU=0|1`) and
prints the right install command for your package manager if `colmap` is missing.

**Alternative — openMVG from source** (`build_openmvg.sh` detects your package
manager — pacman / apt / dnf / zypper / brew — and installs the build deps):

```bash
bash build_openmvg.sh                  # build + install openMVG once
python3 run_reconstruction.py          # run the openMVG SfM pipeline
python3 ply_to_json.py .sfm_work/openmvg/05_colorized/colorized.ply
```

Then re-run `npm run dev` / `npm run build`. The generated JSON files are
git-ignored because they are large and reproducible. All scratch output lands in
`.sfm_work/` (also git-ignored).

## Geometry notes

The recovered geometry follows the computer-vision convention used by openMVG and
COLMAP (**+X right, +Y down, +Z forward**), while three.js uses OpenGL's
convention (**+X right, +Y up, +Z toward the viewer**). All points, camera
centres and basis vectors are converted on load via a 180° rotation about X
(`cvToThree`, `src/sfm.js`) so the scene is upright and correctly oriented.

Camera poses are rebuilt from the world→camera rotation/translation:

```
C = -Rᵀ t                 # camera centre in world space
camera axes = columns of Rᵀ
```

Frustums and photo planes are sized from the real intrinsics (`fx, fy, cx, cy,
w, h`) rather than a hard-coded field of view, so a photo exactly fills its
frustum.

## Project layout

```
index.html          Vite entry
src/
  main.js           bootstrap: load data, build entities, wire HUD, render loop
  sfm.js            geometry: coordinate conversion, pinhole model, synthetic recon
  viewer.js         three.js scene + entity builders
  ui.js             HUD: layer toggles, filmstrip, lightbox, stats
  style.css         light, minimal styling
public/
  images/           the 11 source photographs
  *.json            (generated) reconstruction data
*.py / *.sh         offline openMVG / COLMAP pipeline + JSON exporters
```

## Controls

| Action | Control |
| --- | --- |
| Rotate | Left-drag |
| Pan | Right-drag |
| Zoom | Scroll |
| Reset view | `R` |
| Auto-orbit | `A` |
| Expand a photo | Click a thumbnail or a photo plane |

## Credits

Imagery: *Château de Sceaux*, © 2012 Pierre Moulon. Dataset courtesy of the
openMVG project.
