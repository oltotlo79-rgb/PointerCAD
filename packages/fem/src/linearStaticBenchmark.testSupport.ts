import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isLoader, isRuntime, type PyodideRuntime } from './runtime.js';

/** W14 independent linear-static oracles. Constants are fixed here and every expectation is an elementary closed
 * form; nothing is read back from a translator, plan or native result. */

/** Packaged offline Pyodide + OOFEM, exactly the existing pinned-asset pattern (size + SHA-256 from the manifest). */
 const FEM_ASSETS = fileURLToPath(new URL('../runtime/assets/', import.meta.url));
 const OOFEM_WHEEL = 'oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl';
const manifest: unknown = JSON.parse(readFileSync(new URL('../runtime/manifest.json', import.meta.url), 'utf8'));
export function verifiedAsset(name: string): Uint8Array {
  if (typeof manifest !== 'object' || manifest === null || !('files' in manifest)
    || typeof manifest.files !== 'object' || manifest.files === null) throw new Error('Missing asset manifest');
  const pin: unknown = Object.entries(manifest.files).find(([key]) => key === `assets/${name}`)?.[1];
  if (typeof pin !== 'object' || pin === null || !('sha256' in pin) || !('bytes' in pin)) throw new Error(`Missing pin: ${name}`);
  const bytes = new Uint8Array(readFileSync(join(FEM_ASSETS, name)));
  const actual = { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
  if (actual.bytes !== pin.bytes || actual.sha256 !== pin.sha256) throw new Error(`Asset pin mismatch: ${name}`);
  return bytes;
}
export const wheelLocation = (): string => join(FEM_ASSETS, OOFEM_WHEEL).split(sep).join('/');
export async function loadPackagedRuntime(): Promise<PyodideRuntime> {
  for (const name of ['package.json', 'pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip',
    'pyodide-lock.json', 'numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl', OOFEM_WHEEL]) verifiedAsset(name);
  const loader: unknown = await import(/* @vite-ignore */ pathToFileURL(join(FEM_ASSETS, 'pyodide.mjs')).href);
  if (!isLoader(loader)) throw new Error('Invalid packaged Pyodide loader');
  const loaded = await loader.loadPyodide({ indexURL: FEM_ASSETS + sep, packageBaseUrl: FEM_ASSETS + sep,
    packageCacheDir: FEM_ASSETS, lockFileContents: readFileSync(join(FEM_ASSETS, 'pyodide-lock.json'), 'utf8'),
    stdLibURL: join(FEM_ASSETS, 'python_stdlib.zip'), packages: ['numpy'], fullStdLib: false,
    stdout: () => undefined, stderr: () => undefined });
  if (!isRuntime(loaded)) throw new Error('Invalid packaged Pyodide runtime');
  return loaded;
}
