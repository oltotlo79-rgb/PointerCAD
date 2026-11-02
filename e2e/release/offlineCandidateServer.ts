import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, lstat, readdir } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { offlineAssetRoute, offlineAssetUrl, readOfflineAssetManifest } from '../../scripts/vite/offlineProtocol.mjs';
import { captureWebBuildSources } from '../../scripts/vite/webBuildSources.mjs';
import { sourceFileHash } from '../../scripts/release/desktopFileInventory.mjs';

export interface OfflineCandidateFaults {
  /** Asset path whose served preparation bytes differ in one byte. */
  readonly corrupt?: string;
  /** Number of preparation asset responses that complete before the connection drops. */
  readonly disconnectAfterAssets?: number;
}

interface W21TestFixtureSelection {
  readonly receipt: string; readonly sha256: string; readonly specFile: string; readonly project: string;
}

function fixtureRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function fixtureArray(value: unknown): value is unknown[] { return Array.isArray(value); }
function fixtureRows(value: unknown): { path: string; bytes: number; sha256: string }[] {
  assert(fixtureArray(value));
  const result: { path: string; bytes: number; sha256: string }[] = [], seen = new Set<string>();
  for (const item of value) {
    assert(fixtureRecord(item));
    assert.deepEqual(Object.keys(item).sort(), ['bytes', 'path', 'sha256']);
    assert(typeof item.path === 'string' && typeof item.bytes === 'number' && Number.isSafeInteger(item.bytes)
      && item.bytes >= 0 && item.bytes <= 25 * 1024 * 1024 && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(item.sha256));
    offlineAssetUrl(item.path); assert(!seen.has(item.path)); seen.add(item.path);
    result.push({ path: item.path, bytes: item.bytes, sha256: item.sha256 });
  }
  return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
async function fixtureInside(root: string, name: string): Promise<string> {
  offlineAssetUrl(name); let path = root;
  for (const part of name.split('/')) { path = join(path, part); assert(!(await lstat(path)).isSymbolicLink(), 'Fixture link refused'); }
  return path;
}
async function fixtureInventory(folder: string): Promise<{ path: string; bytes: number; sha256: string }[]> {
  const rows: { path: string; bytes: number; sha256: string }[] = [];
  const walk = async (base: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(base, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), 'Fixture link refused');
      const path = prefix + entry.name, absolute = join(base, entry.name); offlineAssetUrl(path);
      if (entry.isDirectory()) await walk(absolute, path + '/');
      else {
        assert(entry.isFile()); const size = (await lstat(absolute)).size;
        assert(size <= 25 * 1024 * 1024, 'Fixture file limit exceeded');
        const bytes = await readFile(absolute); assert.equal(bytes.byteLength, size);
        rows.push({ path, bytes: size, sha256: createHash('sha256').update(bytes).digest('hex') });
        assert(rows.length <= 1000, 'Fixture file count exceeded');
      }
    }
  };
  await walk(folder, ''); assert(rows.reduce((total, row) => total + row.bytes, 0) <= 1_073_741_824);
  return rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Test-only receipt, not manual certification. The only listener caller supplies actual captured inputs. */
export async function validateW21TestFixture(root: string, folder: string, selection: W21TestFixtureSelection,
  currentInputs: Record<string, string>): Promise<readonly { path: string; recorded: string; current: string | null }[]> {
  assert(process.env.PCAD_DEDICATED_MEASUREMENT === 'w21', 'W21 fixture forbidden for release tests');
  assert(resolve(selection.specFile) === resolve(root, 'e2e/tests/occt-compile-reuse-solid.spec.ts')
    && ['functional', 'firefox'].includes(selection.project), 'Only the full W21 Web spec can select the fixture');
  assert(/^scratchpad\/claude\/agents\/cx-v103-consistency-sol-20261026\/w21-test-fixture\/root-fixture-\d{8}-\d{6}-\d{6}\/receipt\.json$/u.test(selection.receipt), 'Fixed Root fixture receipt path required');
  assert(/^[a-f0-9]{64}$/u.test(selection.sha256), 'Explicit Root receipt SHA required');
  const raw = await readFile(await fixtureInside(root, selection.receipt)); assert(raw.byteLength <= 8_388_608);
  assert.equal(createHash('sha256').update(raw).digest('hex'), selection.sha256, 'Root receipt SHA differs');
  const receipt: unknown = JSON.parse(raw.toString('utf8')); assert(fixtureRecord(receipt));
  assert.deepEqual(Object.keys(receipt).sort(), ['candidate', 'createdAt', 'files', 'format', 'html', 'pdf', 'releaseCertified', 'testOnly', 'webBuildSha256']);
  assert(receipt.format === 'pointercad-w21-test-fixture/1' && receipt.testOnly === true && receipt.releaseCertified === false);
  assert(typeof receipt.createdAt === 'string' && Number.isFinite(Date.parse(receipt.createdAt)));
  assert(typeof receipt.candidate === 'string' && /^w21-test-candidate-\d{8}-\d{6}-\d{6}$/u.test(receipt.candidate));
  assert.equal(folder, resolve(root, 'dist', receipt.candidate), 'Different candidate selected');
  const actual = await fixtureInventory(folder); assert.deepEqual(actual, fixtureRows(receipt.files), 'Fixture physical bytes changed');
  const buildBytes = await readFile(join(folder, 'web-build.json'));
  assert.equal(createHash('sha256').update(buildBytes).digest('hex'), receipt.webBuildSha256);
  const build: unknown = JSON.parse(buildBytes.toString('utf8')); assert(fixtureRecord(build));
  assert.deepEqual(build.inputs, currentInputs, 'Current Web inputs differ');
  const marker: unknown = JSON.parse(await readFile(join(folder, 'w21-test-fixture.json'), 'utf8'));
  assert(fixtureRecord(marker));
  assert.deepEqual(marker, { format: 'pointercad-w21-test-fixture-marker/1', testOnly: true, releaseCertified: false,
    manualCurrentCertified: false, webBuildSha256: receipt.webBuildSha256, html: receipt.html, pdf: receipt.pdf });
  const expectedManual: { path: string; bytes: number; sha256: string }[] = [];
  for (const [key, name, manifest] of [['html', 'w21-html-20261027-042346', 'manifest.json'],
    ['pdf', 'w21-pdf-20261027-042346', 'pdf-manifest.json']] as const) {
    const origin: unknown = receipt[key]; assert(fixtureRecord(origin));
    assert.deepEqual(Object.keys(origin).sort(), ['files', 'manifestSha256', 'name']); assert.equal(origin.name, name);
    const source = await fixtureInside(root, 'dist/' + name), rows = fixtureRows(origin.files);
    assert.deepEqual(await fixtureInventory(source), rows, 'Original manual bytes changed');
    assert.equal(createHash('sha256').update(await readFile(join(source, manifest))).digest('hex'), origin.manifestSha256);
    for (const row of rows) expectedManual.push({ ...row, path: (key === 'html' ? 'manual/' : 'manual/pdf/') + row.path });
  }
  expectedManual.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert.deepEqual(actual.filter(row => row.path.startsWith('manual/')), expectedManual, 'Attached manuals differ from originals');
  const manual: unknown = JSON.parse(await readFile(join(folder, 'manual/manifest.json'), 'utf8'));
  assert(fixtureRecord(manual) && fixtureRecord(manual.inputs));
  const differences: { path: string; recorded: string; current: string | null }[] = [];
  for (const [name, expected] of Object.entries(manual.inputs)) {
    assert(typeof expected === 'string' && /^[a-f0-9]{64}$/u.test(expected)); offlineAssetUrl(name);
    let current: string | null = null;
    try { current = sourceFileHash(await readFile(await fixtureInside(root, name))); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    if (current !== expected) differences.push({ path: name, recorded: expected, current });
  }
  assert(differences.length > 0, 'Historical-manual exception needs an actual recorded source difference');
  return differences;
}

/** Serve the exact assembled bytes and deployment headers, without a dev server or diagnostic product build. */
export async function serveOfflineCandidate(w21Fixture?: W21TestFixtureSelection) {
  const root = fileURLToPath(new URL('../..', import.meta.url)), name = process.env.PCAD_OFFLINE_CANDIDATE;
  assert(name !== undefined && /^[a-z0-9][a-z0-9-]*$/u.test(name), 'Specify an existing candidate name under dist/.');
  const folder = resolve(root, 'dist', name);
  for (const path of [join(root, 'dist'), folder]) assert(!(await lstat(path)).isSymbolicLink());
  const manifest = await readOfflineAssetManifest(JSON.parse(await readFile(join(folder, 'offline-assets.json'), 'utf8')));
  const build = JSON.parse(await readFile(join(folder, 'web-build.json'), 'utf8')) as { inputs: Record<string, string> };
  const currentInputs = await captureWebBuildSources(root);
  assert.deepEqual(currentInputs, build.inputs, 'Candidate sources changed; build and assemble a fresh candidate.');
  let marked = false;
  try { await lstat(join(folder, 'w21-test-fixture.json')); marked = true; }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  let historicalManualDifferences: readonly { path: string; recorded: string; current: string | null }[] = [];
  if (w21Fixture !== undefined) {
    assert(marked, 'Explicit W21 fixture marker required');
    historicalManualDifferences = await validateW21TestFixture(root, folder, w21Fixture, currentInputs);
  } else {
    assert(!marked, 'Test fixture cannot be used by standard/release offline tests');
    const manual = JSON.parse(await readFile(join(folder, 'manual/manifest.json'), 'utf8')) as { inputs: Record<string, string> };
    for (const [name, expected] of Object.entries(manual.inputs)) {
      offlineAssetUrl(name);
      let path = root;
      for (const component of name.split('/')) {
        path = join(path, component); assert(!(await lstat(path)).isSymbolicLink());
      }
      assert.equal(sourceFileHash(await readFile(path)), expected, 'Manual source changed: ' + name);
    }
  }
  const files = new Map<string, { bytes: Buffer; file: string; etag: string }>();
  for (const asset of [...manifest.assets, { url: 'offline-assets.json' }, { url: 'service-worker.js' }]) {
    const file = decodeURIComponent(asset.url), path = join(folder, file);
    if ('sha256' in asset) {
      const physical = asset.transport ?? asset;
      assert.equal((await lstat(path)).size, physical.byteLength, 'Physical asset size differs: ' + file);
    }
    const bytes = await readFile(path);
    if ('sha256' in asset) {
      const physical = asset.transport ?? asset;
      assert.equal(bytes.byteLength, physical.byteLength, 'Physical asset changed while reading: ' + file);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), physical.sha256, 'Physical asset hash differs: ' + file);
      if (asset.transport !== undefined) {
        const decoded = gunzipSync(bytes, { maxOutputLength: asset.byteLength + 1 });
        assert.equal(decoded.byteLength, asset.byteLength, 'Decoded asset size differs: ' + file);
        assert.equal(createHash('sha256').update(decoded).digest('hex'), asset.sha256, 'Decoded asset hash differs: ' + file);
      }
    }
    const value = { bytes, file, etag: '"' + createHash('sha256').update(bytes).digest('hex') + '"' };
    files.set('/' + asset.url, value); files.set('/' + offlineAssetRoute(asset.url), value);
  }
  // Match the host's checked-in header rules; do not invent headers that could hide a deployment omission.
  const rules: { pattern: RegExp; headers: Record<string, string> }[] = [];
  for (const line of (await readFile(join(folder, '_headers'), 'utf8')).split(/\r?\n/u)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (line.startsWith('/')) {
      const escaped = line.trim().replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '.*').replace(/:[a-z]+/gu, '[^/]+');
      rules.push({ pattern: new RegExp('^' + escaped + '$', 'u'), headers: {} });
    } else {
      const colon = line.indexOf(':'); assert(colon > 0 && rules.length > 0);
      rules[rules.length - 1].headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
  }
  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.pdf': 'application/pdf',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
  const offlineRequests: { path: string; destination: string; serviceWorker: string; status: number }[] = [];
  let disconnected = false;
  // Fault injection applies only to the product's preparation downloads (its own request marker),
  // never to ordinary page loads, so an injected failure cannot be mistaken for a broken page.
  let faults: OfflineCandidateFaults = {}, preparedAssets = 0;
  const injected: { path: string; fault: 'corrupt' | 'disconnect' }[] = [];
  const server = createServer((request, response) => {
    if (disconnected) {
      const detail = { path: request.url ?? '/', destination: String(request.headers['sec-fetch-dest'] ?? ''),
        serviceWorker: String(request.headers['service-worker'] ?? ''), status: 503 };
      offlineRequests.push(detail); console.log('[切断後の要求]', JSON.stringify(detail));
      response.writeHead(503); response.end('Network disconnected'); return;
    }
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname, file = files.get(pathname);
    // The host's own default for a file without a Cache-Control rule is ETag revalidation, not no-store:
    // https://developers.cloudflare.com/workers/static-assets/headers/
    const headers: Record<string, string> = { 'Content-Type': mime[extname(file?.file ?? '')] ?? 'application/octet-stream',
      ...(file === undefined ? { 'Cache-Control': 'no-store' } : { 'Cache-Control': 'public, max-age=0, must-revalidate', ETag: file.etag }) };
    for (const rule of rules) if (rule.pattern.test(pathname)) Object.assign(headers, rule.headers);
    let bytes = file?.bytes;
    if (file !== undefined && bytes !== undefined && request.headers['x-pointercad-offline-prepare'] === '1'
      && file.file !== 'offline-assets.json') {
      preparedAssets += 1;
      if (faults.disconnectAfterAssets !== undefined && preparedAssets > faults.disconnectAfterAssets) {
        // Send part of the body, then drop the connection as a lost network would.
        injected.push({ path: file.file, fault: 'disconnect' });
        response.writeHead(200, headers); response.write(bytes.subarray(0, Math.floor(bytes.byteLength / 2)));
        request.socket.destroy(); return;
      }
      if (faults.corrupt === file.file) {
        // Same length, one different byte: only the content fingerprint can detect it.
        injected.push({ path: file.file, fault: 'corrupt' });
        bytes = Buffer.from(bytes); bytes[0] ^= 0x20;
      }
    } else if (file !== undefined && request.headers['if-none-match'] === file.etag) {
      // Preparation downloads never revalidate, so a fault above cannot be answered from the browser cache.
      response.writeHead(304, headers); response.end(); return;
    }
    response.writeHead(file === undefined ? 404 : 200, headers); response.end(bytes ?? 'Missing candidate asset');
  });
  await new Promise<void>((accept, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); accept(); });
  });
  const address = server.address(); assert(address !== null && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}/`, manifest, folder, historicalManualDifferences,
    disconnect: () => { disconnected = true; }, networkRequestsAfterDisconnect: () => [...offlineRequests],
    /** Replace the preparation faults; the asset count restarts so each attempt is independent. */
    inject: (next: OfflineCandidateFaults) => {
      if (next.corrupt !== undefined) assert(manifest.assets.some(asset => decodeURIComponent(asset.url) === next.corrupt));
      faults = { ...next }; preparedAssets = 0;
    },
    injectedFaults: () => [...injected],
    close: () => new Promise<void>((accept, reject) => {
      server.close(error => { if (error !== undefined) reject(error); else accept(); }); server.closeAllConnections();
    }) };
}
