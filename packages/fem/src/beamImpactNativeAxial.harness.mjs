import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { join, sep, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const assets = join(root, 'packages/fem/runtime/assets');
const manifest = JSON.parse(await readFile(join(root, 'packages/fem/runtime/manifest.json'), 'utf8'));
const NUMPY = 'numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl';
const OOFEM = 'oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl';
for (const name of ['pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip',
  'pyodide-lock.json', NUMPY, OOFEM, 'beamAnalysis.py', 'beamImpact.py']) {
  const bytes = await readFile(join(assets, name)), pin = manifest.files[`assets/${name}`];
  assert.equal(bytes.length, pin.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256);
}
for (const name of ['beamAnalysis.py', 'beamImpact.py']) {
  assert.deepEqual(await readFile(join(assets, name)), await readFile(join(root, 'packages/fem/src', name)));
}
const source = await readFile(join(root, 'packages/fem/src/beamImpactRuntime.ts'), 'utf8');
const snippets = [...source.matchAll(/runtime\.runPython\(`([\s\S]*?)`\)/gu)];
assert.equal(snippets.length, 1);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const plan = JSON.parse(Buffer.concat(chunks).toString('utf8'));
let denied = 0;
globalThis.fetch = () => { denied++; return Promise.reject(new Error('offline-request-denied')); };
if (typeof globalThis.WebSocket === 'function') globalThis.WebSocket = new Proxy(globalThis.WebSocket, {
  construct() { denied++; throw new Error('offline-request-denied'); },
});
const { loadPyodide } = await import(pathToFileURL(join(assets, 'pyodide.mjs')));
const diagnostics = [];
const runtime = await loadPyodide({ indexURL: assets + sep, packageBaseUrl: assets + sep,
  packageCacheDir: assets, lockFileContents: await readFile(join(assets, 'pyodide-lock.json'), 'utf8'),
  stdLibURL: join(assets, 'python_stdlib.zip'), packages: [], fullStdLib: false,
  stdout: text => { diagnostics.push(text); process.stderr.write(text + '\n'); },
  stderr: text => process.stderr.write(text + '\n') });
await runtime.loadPackage('numpy', { checkIntegrity: true });
await runtime.loadPackage(join(assets, OOFEM).split(sep).join('/'), { checkIntegrity: true });
runtime.FS.mkdirTree('/pcad_fem');
runtime.FS.writeFile('/pcad_fem/analysis-input.json', JSON.stringify(plan));
runtime.FS.writeFile('/pcad_fem/beam_analysis.py', await readFile(join(assets, 'beamAnalysis.py')));
runtime.FS.writeFile('/pcad_fem/beam_impact.py', await readFile(join(assets, 'beamImpact.py')));
const raw = runtime.runPython(snippets[0][1]);
assert.equal(typeof raw, 'string'); assert(raw.length <= 6_000_000);
assert.equal(denied, 0);
process.stdout.write(JSON.stringify({ raw: JSON.parse(raw), diagnostics, denied }) + '\n');
