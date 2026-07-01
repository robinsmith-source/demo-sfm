# Structure-from-Motion Viewer

An interactive [three.js](https://threejs.org/) viewer for **real** sparse 3D
reconstructions. Each scene's point cloud, camera poses and feature tracks are
produced by COLMAP from the source photographs — nothing is synthesized.

Datasets are discovered from `public/datasets/` and are switchable live from the dropdown:

- **Sceaux Castle** — a building, 11 photos ([openMVG dataset](https://github.com/openMVG/ImageDataset_SceauxCastle))
- **Temple Ring** — a full 3D object captured as a 47-view ring ([Middlebury MVS](https://vision.middlebury.edu/mview/data/))
- **HdM Letters** — HdM Stuttgart's lettering, 26 views
- **Robot** — a locally captured object reconstructed from a photo orbit

The viewer shows the sparse point cloud, the recovered camera poses (frustums
with each source photo pinned to its image plane), and the feature **tracks**
linking 3D points to the cameras that observe them.

## Toolchains

| Part | Manager | Why |
| --- | --- | --- |
| Web viewer | [pnpm](https://pnpm.io/) + [Vite](https://vitejs.dev/) + [TypeScript](https://www.typescriptlang.org/) | static, dependency-light, type-checked build |
| Reconstruction | [uv](https://docs.astral.sh/uv/) + [pycolmap](https://pypi.org/project/pycolmap/) | prebuilt COLMAP engine, no system build |

## Quick start

```bash
# View it — the reconstructed JSON for every dataset is already committed
pnpm install
pnpm dev                  # local dev server with HMR
pnpm typecheck            # tsc --noEmit
pnpm build                # type-check + production build -> dist/
pnpm preview              # serve the production build locally

# Optional: regenerate a dataset's reconstruction from its source photos
uv sync
pnpm reconstruct          # alias for: uv run pipeline/reconstruct.py (all datasets)
```

The viewer discovers every folder under `public/datasets/` at dev/build time and
loads the selected dataset's `data/pointcloud.json` + `data/cameras.json`.
`public/datasets/index.json` is optional metadata for custom names, subtitles,
credits, ordering, and orientation overrides; folders not listed there still
appear automatically. If a dataset's data is absent the viewer shows the exact
command to generate it rather than inventing a scene.

## Datasets

Each dataset is a self-contained folder:

```
public/datasets/
  index.json                     optional metadata overrides and ordering
  <id>/
    images/                      source photographs (committed)
    data/                        generated JSON, committed (rebuild with the pipeline)
```

Every reconstruction is normalised to a canonical scale on load (`sfm.ts`), so a
sprawling building and a compact object ring both frame correctly with the same
viewer constants.

### Reconstruct a specific dataset

```bash
uv run pipeline/reconstruct.py temple-ring          # one dataset by id
uv run pipeline/reconstruct.py /any/images /any/out # arbitrary folders
```

### Add your own object (e.g. another ring)

```bash
# 1. drop photos in
mkdir -p public/datasets/my-object/images
cp /path/to/ring/*.jpg public/datasets/my-object/images/

# 2. reconstruct + view (the folder is discovered automatically)
uv run pipeline/reconstruct.py my-object
pnpm dev
```

A clean "ring around a single object" capture (20–50 photos, even spacing,
textured surface) reconstructs best. The pipeline runs SIFT extraction →
exhaustive matching → incremental mapping, then exports the largest model. Each
camera's source photo is resolved from the filename COLMAP registered, so the
cloud, poses and photos always correspond to the same images.

**Orientation.** COLMAP only solves orientation up to an arbitrary rotation, so
the viewer auto-levels each scene by aligning the camera-ring/arc plane to the
horizon (`fitPlaneNormal` in `sfm.ts`) — this stands the object up and lays the
ring flat. The up/down *sign* is ambiguous for a symmetric ring; if a dataset
loads upside-down, add `"flipUp": true` to its manifest entry (as the Temple
Ring does).

## Deploying

### GitHub Pages (automatic)

[.github/workflows/deploy.yml](.github/workflows/deploy.yml) type-checks, builds
with Vite, and publishes `dist/` on every push to `main`. There is no
reconstruction step in CI — the JSON under `public/datasets/*/data/` is committed,
so CI just bundles what's already there. One-time setup: **Settings → Pages →
Source: GitHub Actions**.

### Any static host (manual)

`pnpm build` emits a fully static `dist/`. `base: './'` in `vite.config.js` keeps
every asset path relative, so the output drops onto any static host (Netlify,
Cloudflare Pages, S3, a sub-path) with no extra configuration. Run
`pnpm reconstruct` first only if you're adding or regenerating a dataset —
existing `data/` JSON is already committed and gets bundled as-is.

## Geometry notes

The recovered geometry follows the computer-vision convention used by COLMAP
(**+X right, +Y down, +Z forward**), while three.js uses OpenGL's convention
(**+X right, +Y up, +Z toward the viewer**). All points, camera centres and basis
vectors are converted on load via a 180° rotation about X (`cvToThree`,
[src/sfm.ts](src/sfm.ts)) so the scene is upright and correctly oriented.

Camera poses are rebuilt from the world→camera rotation/translation:

```
C = -Rᵀ t                 # camera centre in world space
camera axes = columns of Rᵀ
```

Frustums and photo planes are sized from the real intrinsics (fx, fy, cx, cy, w,
h) rather than a hard-coded field of view, so each photo exactly fills its
frustum.

## Project layout

```
index.html              Vite entry
tsconfig.json           TypeScript config (strict, noEmit — Vite/esbuild transpiles)
src/
  main.ts               bootstrap: manifest, dataset switching, WASD movement, render loop
  sfm.ts                geometry: coordinate conversion, pinhole model, JSON loader, scale normalisation
  viewer.ts             three.js scene + entity builders + teardown
  ui.ts                 HUD: dataset selector, layer toggles, filmstrip, lightbox, stats
  types.ts              shared domain types
  style.css             light, minimal styling
public/datasets/
  index.json            optional dataset metadata overrides and ordering
  <id>/images/          source photographs (committed)
  <id>/data/            pointcloud.json + cameras.json (generated by the pipeline, committed)
pipeline/
  reconstruct.py        the COLMAP (pycolmap) reconstruction + JSON exporter
  redmask.py            one-off helper: isolates red lettering in the hdm source photos
pyproject.toml          uv-managed Python project
package.json            pnpm-managed web project
.github/workflows/      GitHub Pages deploy
```

## Controls

| Action | Control |
| --- | --- |
| Switch dataset | Dropdown (top-left) |
| Rotate | Left-drag |
| Pan | Right-drag |
| Zoom | Scroll |
| Move / strafe | `W` `A` `S` `D` |
| Move down / up | `Q` / `E` |
| Move faster | Hold `Shift` |
| Reset view | `R` |
| Auto-orbit | `O` |
| Expand a photo | Click a thumbnail or a photo plane |

## Credits

- *Château de Sceaux* imagery © 2012 Pierre Moulon, courtesy of the openMVG project.
- *Temple Ring* from the [Middlebury Multi-View Stereo](https://vision.middlebury.edu/mview/)
  evaluation (Seitz et al., CVPR 2006).
