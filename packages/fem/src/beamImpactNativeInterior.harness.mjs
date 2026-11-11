import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { join, sep } from 'node:path';
import process from 'node:process';

// Same separate-process harness as beamImpactNativeMatrices.test.mjs (started by beamImpactNativeInterior.test.ts with
// the translated plan on stdin): bundled pinned Pyodide, NumPy and OOFEM wheel only, no host Python or downloads. The
// impact response is produced by the exact runPython source of beamImpactRuntime.ts, then checked in Python against
// closed-form Timoshenko numbers by beamImpactNativeInterior.test.py.
const assets = fileURLToPath(new URL('../runtime/assets/', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../runtime/manifest.json', import.meta.url), 'utf8'));
const NUMPY = 'numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl';
const OOFEM = 'oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl';
for (const name of ['pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json', NUMPY, OOFEM,
  'beamAnalysis.py', 'beamImpact.py']) {
  const bytes = await readFile(join(assets, name));
  const pin = manifest.files[`assets/${name}`];
  assert.equal(bytes.length, pin.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256);
}
for (const [asset, source] of [['beamAnalysis.py', './beamAnalysis.py'], ['beamImpact.py', './beamImpact.py']]) {
  assert.deepEqual(await readFile(join(assets, asset)), await readFile(new URL(source, import.meta.url)));
}
const runtimeSource = await readFile(new URL('./beamImpactRuntime.ts', import.meta.url), 'utf8');
const snippets = [...runtimeSource.matchAll(/runtime\.runPython\(`([\s\S]*?)`\)/gu)];
assert.equal(snippets.length, 1, 'beamImpactRuntime.ts has exactly one runPython source');
const impactPython = snippets[0][1];

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const bench = JSON.parse(Buffer.concat(chunks).toString('utf8'));
assert.ok(Number.isSafeInteger(bench.expectedChecks) && bench.expectedChecks > 0, 'expected check count from the test');

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
  stdout: text => { output.push(text); process.stderr.write(text + '\n'); }, stderr: text => process.stderr.write(text + '\n') });
await runtime.loadPackage('numpy', { checkIntegrity: true });
await runtime.loadPackage(join(assets, OOFEM).split(sep).join('/'), { checkIntegrity: true });
runtime.FS.mkdirTree('/pcad_fem');
runtime.FS.writeFile('/pcad_fem/analysis-input.json', JSON.stringify(bench.plans.interior));
runtime.FS.writeFile('/pcad_fem/beam_analysis.py', await readFile(join(assets, 'beamAnalysis.py')));
runtime.FS.writeFile('/pcad_fem/beam_impact.py', await readFile(join(assets, 'beamImpact.py')));
const raw = runtime.runPython(impactPython);
assert.equal(typeof raw, 'string');
runtime.FS.writeFile('/pcad_fem/impact-raw.json', raw);
runtime.FS.writeFile('/pcad_fem/benchmark.json', JSON.stringify(bench));
runtime.FS.writeFile('/pcad_fem/benchmark.py', await readFile(new URL('./beamImpactNativeInterior.test.py', import.meta.url)));
const runtimeDiagnostics = output.splice(0);
runtime.runPython("exec(compile(open('/pcad_fem/benchmark.py').read(), '/pcad_fem/benchmark.py', 'exec'), {'__name__': '__main__'})");
function readCompletion(text) {
  assert.equal(typeof text, 'string', 'Native interior completion must be text');
  assert.ok(text.endsWith('\n') && text.indexOf('\n') === text.length - 1, 'Exactly one complete completion record required');
  const result = JSON.parse(text);
  assert.equal(text, JSON.stringify(result) + '\n', 'Canonical nonduplicate completion record required');
  assert.deepEqual(Object.keys(result).sort(), ['checks', 'report', 'schema', 'status']);
  assert.equal(result.schema, 'pcad-impact-native-interior-completion/1');
  assert.equal(result.status, 'passed', 'Native interior check did not complete successfully');
  assert.equal(result.checks, bench.expectedChecks, 'Every independent interior check must complete');
  assert.equal(result.report, `beam-impact-native-interior: ${bench.expectedChecks} independent checks passed`);
  return result.report;
}
const report = readCompletion(runtime.FS.readFile('/pcad_fem/benchmark-completion.jsonl', { encoding: 'utf8' }));
const oracle = JSON.parse(runtime.FS.readFile('/pcad_fem/interior-oracle.json', { encoding: 'utf8' }));
assert.equal(denied, 0, 'Check must use bundled assets only');
process.stdout.write(JSON.stringify({ raw: JSON.parse(raw), oracle, report: [report],
  runtimeDiagnostics: [...runtimeDiagnostics, ...output] }) + '\n');
