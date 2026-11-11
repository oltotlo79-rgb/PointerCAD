import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { join, sep } from 'node:path';
import process from 'node:process';

// Separate Node process: bounded by the ordinary Vitest caller, no host Python or downloads.
const assets = fileURLToPath(new URL('../runtime/assets/', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../runtime/manifest.json', import.meta.url), 'utf8'));
for (const name of ['pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) {
  const bytes = await readFile(join(assets, name));
  const pin = manifest.files[`assets/${name}`];
  assert.equal(bytes.length, pin.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256);
}
let denied = 0;
globalThis.fetch = () => { denied++; return Promise.reject(new Error('offline-request-denied')); };
if (typeof globalThis.WebSocket === 'function') globalThis.WebSocket = new Proxy(globalThis.WebSocket, {
  construct() { denied++; throw new Error('offline-request-denied'); },
});
const { loadPyodide } = await import(pathToFileURL(join(assets, 'pyodide.mjs')));
const output = [];
const runtime = await loadPyodide({ indexURL: assets + sep, packageBaseUrl: assets + sep,
  packageCacheDir: assets, lockFileContents: await readFile(join(assets, 'pyodide-lock.json'), 'utf8'),
  stdLibURL: join(assets, 'python_stdlib.zip'), packages: [], fullStdLib: false,
  stdout: text => output.push(text), stderr: text => process.stderr.write(text + '\n') });
runtime.FS.mkdirTree('/pcad_force_test');
runtime.FS.writeFile('/pcad_force_test/wrapper.py', await readFile(new URL('./solidPlasticAnalysis.py', import.meta.url)));
runtime.FS.writeFile('/pcad_force_test/test.py', await readFile(new URL('./solidPlasticForceBalance.test.py', import.meta.url)));
runtime.runPython("import sys; sys.argv = ['/pcad_force_test/test.py', '/pcad_force_test/wrapper.py']; exec(compile(open(sys.argv[0]).read(), sys.argv[0], 'exec'))");
assert.equal(denied, 0, 'Regression must use bundled assets only');
assert.deepEqual(output, ['solid-plastic-force-balance: 7 independent cases passed']);
process.stdout.write(output[0] + '\n');
