import { build } from 'vite';
import { fileURLToPath } from 'node:url';

/** A tiny real-browser shell around the production preparation controller. No document/store test port. */
export async function buildOfflinePreparationFixture(): Promise<string> {
  return buildFixture('../fixtures/offlinePreparationClient.ts');
}
export async function buildOfflineNavigationFixture(): Promise<string> {
  return buildFixture('../fixtures/offlineNavigationClient.ts');
}
async function buildFixture(path: string): Promise<string> {
  const entry = fileURLToPath(new URL(path, import.meta.url));
  const output = await build({ configFile: false, publicDir: false, logLevel: 'error',
    build: { write: false, target: 'es2022', minify: true,
      lib: { entry, formats: ['iife'], name: 'PointerCadPreparationFixture', fileName: () => 'main.js' } },
  });
  const chunks = (Array.isArray(output) ? output : [output]).flatMap(bundle => 'output' in bundle ? bundle.output : []);
  if (chunks.length !== 1 || chunks[0].type !== 'chunk' || chunks[0].imports.length !== 0
    || chunks[0].dynamicImports.length !== 0) throw new Error('Offline preparation fixture must be self-contained');
  return chunks[0].code;
}
