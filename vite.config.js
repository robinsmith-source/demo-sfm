import { defineConfig } from 'vite';

// Static, dependency-light build. `base: './'` makes the output relocatable so
// it can be dropped onto any static host (GitHub Pages, Netlify, S3, a sub-path)
// without rewriting asset URLs.
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
});
