import { build } from 'vite';
import { fileURLToPath, URL } from 'node:url';

/** A single classic script works in all supported browsers. No runtime imports or CDN are used. */
export async function buildOfflineServiceWorker() {
  const output = await build({
    configFile: false, publicDir: false, logLevel: 'error',
    build: { write: false, target: 'es2022', minify: true,
      lib: { entry: fileURLToPath(new URL('../../apps/web/service-worker/main.ts', import.meta.url)),
        formats: ['iife'], name: 'PointerCadOfflineWorker', fileName: () => 'service-worker.js' },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const bundles = Array.isArray(output) ? output : [output];
  const chunks = bundles.flatMap(bundle => 'output' in bundle ? bundle.output : []);
  if (chunks.length !== 1 || chunks[0].type !== 'chunk' || chunks[0].imports.length !== 0
    || chunks[0].dynamicImports.length !== 0 || chunks[0].fileName !== 'service-worker.js') {
    throw new Error('Offline service worker must be one self-contained classic script');
  }
  return chunks[0].code;
}

export function offlineServiceWorker() {
  return {
    name: 'pointercad-offline-service-worker', apply: 'build',
    async buildStart() {
      this.emitFile({ type: 'asset', fileName: 'service-worker.js', source: await buildOfflineServiceWorker() });
    },
  };
}
