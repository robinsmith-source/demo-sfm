import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

const virtualDatasetsId = 'virtual:datasets';
const resolvedVirtualDatasetsId = `\0${virtualDatasetsId}`;

function displayName(id) {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function discoverDatasets(root) {
  const datasetsDir = path.resolve(root, 'public/datasets');
  const metadataPath = path.join(datasetsDir, 'index.json');
  const configured = fs.existsSync(metadataPath)
    ? JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
    : [];
  const metadata = new Map(configured.map((entry) => [entry.id, entry]));
  const ids = fs.readdirSync(datasetsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
  const existing = new Set(ids);
  const orderedIds = [
    ...configured.map((entry) => entry.id).filter((id) => existing.has(id)),
    ...ids.filter((id) => !metadata.has(id)).sort(),
  ];

  return orderedIds.map((id) => {
    const datasetDir = path.join(datasetsDir, id);
    return {
      name: displayName(id),
      ...metadata.get(id),
      id,
      imageDir: fs.existsSync(path.join(datasetDir, 'images')) ? 'images' : '.',
    };
  });
}

function datasetsPlugin() {
  return {
    name: 'datasets',
    resolveId(id) {
      if (id === virtualDatasetsId) return resolvedVirtualDatasetsId;
    },
    load(id) {
      if (id === resolvedVirtualDatasetsId) {
        return `export default ${JSON.stringify(discoverDatasets(process.cwd()))};`;
      }
    },
    configureServer(server) {
      const datasetsDir = path.resolve(server.config.root, 'public/datasets');
      const metadataPath = path.join(datasetsDir, 'index.json');
      server.watcher.add(datasetsDir);
      server.watcher.on('all', (event, file) => {
        if (!['addDir', 'unlinkDir'].includes(event) && file !== metadataPath) return;
        const module = server.moduleGraph.getModuleById(resolvedVirtualDatasetsId);
        if (module) server.moduleGraph.invalidateModule(module);
        server.ws.send({ type: 'full-reload' });
      });
    },
  };
}

// Static, dependency-light build. `base: './'` makes the output relocatable so
// it can be dropped onto any static host (GitHub Pages, Netlify, S3, a sub-path)
// without rewriting asset URLs.
export default defineConfig({
  base: './',
  plugins: [datasetsPlugin()],
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
});
