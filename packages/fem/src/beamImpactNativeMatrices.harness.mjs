import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { join, sep } from 'node:path';
import process from 'node:process';

// Separate Node process (the solidPlasticForceBalance.test.mjs pattern), started by beamImpactNativeFixture.test.ts with
// the translated plans on stdin. Bundled pinned Pyodide, NumPy and OOFEM wheel only; no host Python or downloads.
// The Python executed for the impact response is the exact runPython source of beamImpactRuntime.ts, read from it.
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
// The deployed assets and the source modules must be the same programs.
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
// NumPy as in beamImpactCoupled.test.mjs (Root-executed 017 pattern); loader messages may precede the JSON line.
await runtime.loadPackage('numpy', { checkIntegrity: true });
// The same call as analyzeBeamImpact with a local path instead of the browser asset URL (forward slashes, no scheme).
await runtime.loadPackage(join(assets, OOFEM).split(sep).join('/'), { checkIntegrity: true });
runtime.FS.mkdirTree('/pcad_fem');
runtime.FS.writeFile('/pcad_fem/analysis-input.json', JSON.stringify(bench.plans.one));
runtime.FS.writeFile('/pcad_fem/beam_analysis.py', await readFile(join(assets, 'beamAnalysis.py')));
runtime.FS.writeFile('/pcad_fem/beam_impact.py', await readFile(join(assets, 'beamImpact.py')));
const raw = runtime.runPython(impactPython);
assert.equal(typeof raw, 'string');
runtime.FS.writeFile('/pcad_fem/benchmark.json', JSON.stringify(bench));
runtime.FS.writeFile('/pcad_fem/benchmark.py', await readFile(new URL('./beamImpactNativeMatrices.test.py', import.meta.url)));
const runtimeDiagnostics = output.splice(0);
runtime.runPython("exec(compile(open('/pcad_fem/benchmark.py').read(), '/pcad_fem/benchmark.py', 'exec'), {'__name__': '__main__'})");
function readBenchmarkCompletion(text) {
  assert.equal(typeof text, 'string', 'Native benchmark completion must be text');
  assert.ok(text.endsWith('\n') && text.indexOf('\n') === text.length - 1,
    'Exactly one complete native benchmark record required');
  const result = JSON.parse(text);
  assert.equal(text, JSON.stringify(result) + '\n', 'Canonical nonduplicate completion record required');
  assert.ok(result !== null && typeof result === 'object' && !Array.isArray(result), 'Completion object required');
  assert.deepEqual(Object.keys(result).sort(), ['checks', 'report', 'schema', 'status']);
  assert.equal(result.schema, 'pcad-impact-native-completion/1');
  assert.equal(result.status, 'passed', 'Native benchmark did not complete successfully');
  assert.equal(result.checks, 36, 'All 36 independent physics checks must complete');
  assert.equal(result.report, 'beam-impact-native-matrices: 36 independent checks passed');
  return result.report;
}
const report = readBenchmarkCompletion(runtime.FS.readFile('/pcad_fem/benchmark-completion.jsonl', { encoding: 'utf8' }));
assert.equal(denied, 0, 'Benchmark must use bundled assets only');
process.stdout.write(JSON.stringify({ raw: JSON.parse(raw), report: [report],
  runtimeDiagnostics: [...runtimeDiagnostics, ...output] }) + '\n');
