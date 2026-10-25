import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type BrowserContext, type ConsoleMessage, type ElectronApplication, type Page, type PlaywrightWorkerArgs, type TestInfo, type Worker } from '@playwright/test';
import { expressionValueFromNumber as value } from '../../packages/expression/src/index.js';
import { absoluteCoordinate, createEmptyPartDocument, createPrimitiveFeature, type BooleanFeature, type PrimitiveFeature } from '../../packages/model/src/index.js';
import { writePcadFile } from '../../packages/io/src/index.js';
import { OFFLINE_MAX_TOTAL_BYTES, offlineAssetUrl, readOfflineAssetManifest } from '../../scripts/vite/offlineProtocol.mjs';
import { collectOfflineAssetFiles } from '../../scripts/vite/offlineAssets.mjs';
import { captureWebBuildSources } from '../../scripts/vite/webBuildSources.mjs';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { launchDesktop, openTarget, profileDirectoryFor } from './electronAppFlow.js';
import { waitForStartupReady } from './startupHealth.js';
import { serveOfflineCandidate } from '../release/offlineCandidateServer.js';
import { linuxSampler, windowsSampler, type RawFrame, type Sampler } from './processResourceSampler.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Playwright = PlaywrightWorkerArgs['playwright'];
type Mode = 'cold' | 'warm';
interface Phase {
  readonly stream: 'broker' | 'loader'; readonly phase: string; readonly elapsedMs: number;
  readonly atEpochMs: number; readonly instanceId?: string; readonly owner?: string;
  readonly timeOrigin?: number;
  readonly generation?: number; readonly sha256?: string; readonly byteLength?: number;
}
interface WorkerLife { readonly url: string; readonly observedAtEpochMs: number; timeOrigin?: number; closedAtEpochMs?: number }
interface NetworkAsset { readonly url: string; readonly status: number; readonly headers: Record<string, string>; readonly serviceWorker: boolean }
interface Observation {
  readonly phases: Phase[]; readonly workers: WorkerLife[]; readonly network: NetworkAsset[];
  readonly errors: string[]; readonly pending: Promise<void>[];
}
export interface OcctPair {
  readonly index: number; readonly offline: boolean; readonly profile: string;
  readonly cold: { readonly startupMs: number; readonly sha256: string };
  readonly warm: { readonly startupMs: number; readonly sha256: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ServedDistribution {
  readonly url: string; readonly folder: string; readonly server: 'root-owned' | 'in-test';
  readonly close: () => Promise<void>;
}

/**
 * Locate the real, current assembled offline distribution (PCAD_W21_WEB_ROOT, inside this checkout).
 * With PCAD_W21_WEB_URL, a Root-owned local HTTP server already serves it (unchanged behaviour).
 * Without it, PCAD_W21_WEB_ROOT must be dist/<candidate>: the existing offline candidate server
 * (e2e/release/offlineCandidateServer.ts: the same _headers, MIME, ETag and source checks) serves
 * that folder inside this test on 127.0.0.1, and the caller closes it when the pair ends.
 */
async function serveWebDistribution(): Promise<ServedDistribution> {
  const address = process.env['PCAD_W21_WEB_URL'], directory = process.env['PCAD_W21_WEB_ROOT'];
  if (directory === undefined) throw new Error('W21 needs PCAD_W21_WEB_ROOT (and PCAD_W21_WEB_URL for a Root-owned server) for a real, current assembled offline distribution.');
  const folder = resolve(root, directory), local = relative(root, folder);
  if (local === '' || isAbsolute(local) || local === '..' || local.startsWith('..' + sep)) throw new Error('W21 distribution must stay inside this checkout.');
  if (address !== undefined) return { url: address, folder, server: 'root-owned', close: () => Promise.resolve() };
  const name = relative(join(root, 'dist'), folder);
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) throw new Error('Without PCAD_W21_WEB_URL, PCAD_W21_WEB_ROOT must be dist/<candidate> for the in-test offline candidate server.');
  const requested = process.env['PCAD_OFFLINE_CANDIDATE'];
  if (requested !== undefined && requested !== name) throw new Error('PCAD_OFFLINE_CANDIDATE and PCAD_W21_WEB_ROOT name different candidates.');
  // serveOfflineCandidate() takes the candidate name from this test process's environment.
  process.env['PCAD_OFFLINE_CANDIDATE'] = name;
  const candidate = await serveOfflineCandidate();
  if (resolve(candidate.folder) !== folder) {
    await candidate.close();
    throw new Error('The in-test server folder differs from PCAD_W21_WEB_ROOT.');
  }
  return { url: candidate.url, folder, server: 'in-test', close: candidate.close };
}

/** Read the real assembled release; never synthesize an offline manifest for a test. */
async function actualWebDistribution(playwright: Playwright, info: TestInfo): Promise<ServedDistribution> {
  const served = await serveWebDistribution();
  try { return { ...served, url: await verifyServedDistribution(playwright, info, served) }; }
  catch (error) { await served.close(); throw error; }
}

async function verifyServedDistribution(playwright: Playwright, info: TestInfo, served: ServedDistribution): Promise<string> {
  const url = new URL(served.url), folder = served.folder;
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') throw new Error('W21 distribution must be served by a local HTTP server (Root-owned or in-test).');
  const collected = await collectOfflineAssetFiles(root, folder);
  const files = [...collected.files];
  for (const path of collected.excluded) files.push({ path, bytes: await readFile(join(folder, path)) });
  expect(files.length).toBeLessThanOrEqual(1000);
  for (const file of files) expect(file.bytes.byteLength, file.path).toBeLessThanOrEqual(25 * 1024 * 1024);
  expect(files.reduce((sum, file) => sum + file.bytes.byteLength, 0)).toBeLessThanOrEqual(OFFLINE_MAX_TOTAL_BYTES);
  const buildBytes = await readFile(join(folder, 'web-build.json'));
  const build: unknown = JSON.parse(buildBytes.toString('utf8'));
  if (!isRecord(build) || build.format !== 'pointercad-web-build/1' || !isRecord(build.inputs) || !isRecord(build.outputs)) throw new Error('Real Web build inventory is absent');
  expect(build.inputs).toEqual(await captureWebBuildSources(root));
  for (const [path, expected] of Object.entries(build.outputs)) {
    const file = files.find(file => file.path === path);
    if (file === undefined) throw new Error(`Missing real build output: ${path}`);
    expect(sha256(file.bytes), path).toBe(expected);
  }
  const manifestBytes = await readFile(join(folder, 'offline-assets.json'));
  const manifestInput: unknown = JSON.parse(manifestBytes.toString('utf8'));
  const manifest = await readOfflineAssetManifest(manifestInput);
  for (const asset of manifest.assets) {
    const file = files.find(file => offlineAssetUrl(file.path) === asset.url);
    if (file === undefined) throw new Error(`Offline distribution asset missing: ${asset.url}`);
    expect(file.bytes.byteLength, asset.url).toBe(asset.transport?.byteLength ?? asset.byteLength);
    expect(sha256(file.bytes), asset.url).toBe(asset.transport?.sha256 ?? asset.sha256);
  }
  // APIRequestContext has its own storage: this verifies the server without priming
  // the measured browser profile's HTTP/code caches or inventing an offline cache.
  const request = await playwright.request.newContext();
  try {
    for (const [path, bytes] of [['web-build.json', buildBytes], ['offline-assets.json', manifestBytes]] as const) {
      const served = await request.get(new URL(path, url).href);
      expect(served.status(), path).toBe(200); expect(sha256(await served.body()), path).toBe(sha256(bytes));
    }
  } finally { await request.dispose(); }
  await info.attach('actual-distribution-identity', { body: JSON.stringify({ directory: folder, address: url.href, server: served.server,
    buildSha256: sha256(buildBytes), manifestSha256: sha256(manifestBytes), buildId: manifest.buildId,
    files: files.map(file => ({ path: file.path, bytes: file.bytes.byteLength, sha256: sha256(file.bytes) })) }), contentType: 'application/json' });
  return url.href;
}
function phase(value: unknown, stream: Phase['stream']): Phase {
  if (!isRecord(value) || typeof value.phase !== 'string' || typeof value.elapsedMs !== 'number' ||
      !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 || typeof value.atEpochMs !== 'number' || !Number.isFinite(value.atEpochMs) || value.atEpochMs <= 0 ||
      (value.instanceId !== undefined && typeof value.instanceId !== 'string') ||
      (value.owner !== undefined && typeof value.owner !== 'string') ||
      (value.timeOrigin !== undefined && typeof value.timeOrigin !== 'number') ||
      (value.generation !== undefined && typeof value.generation !== 'number') ||
      (value.sha256 !== undefined && typeof value.sha256 !== 'string') ||
      (value.byteLength !== undefined && typeof value.byteLength !== 'number')) throw new Error('Malformed actual OCCT observation');
  return { stream, phase: value.phase, elapsedMs: value.elapsedMs, atEpochMs: value.atEpochMs,
    ...(typeof value.instanceId === 'string' ? { instanceId: value.instanceId } : {}),
    ...(typeof value.owner === 'string' ? { owner: value.owner } : {}),
    ...(typeof value.timeOrigin === 'number' ? { timeOrigin: value.timeOrigin } : {}),
    ...(typeof value.generation === 'number' ? { generation: value.generation } : {}),
    ...(typeof value.sha256 === 'string' ? { sha256: value.sha256 } : {}),
    ...(typeof value.byteLength === 'number' ? { byteLength: value.byteLength } : {}) };
}
function observe(page: Page): Observation {
  const result: Observation = { phases: [], workers: [], network: [], errors: [], pending: [] };
  page.on('pageerror', error => { result.errors.push(error.message); });
  const workers = new Set<Worker>();
  const observeWorker = (worker: Worker): void => {
    if (workers.has(worker)) return;
    workers.add(worker);
    const life: WorkerLife = { url: worker.url(), observedAtEpochMs: Date.now() };
    result.workers.push(life);
    worker.on('close', () => { life.closedAtEpochMs = Date.now(); });
    // Definition-diff Workers may finish before evaluation. Keep their lifecycle raw,
    // but only the two OCCT kernel Workers belong to the measured identity population.
    if (!/kernel\.worker/u.test(life.url)) return;
    result.pending.push(worker.evaluate(() => performance.timeOrigin).then(origin => { life.timeOrigin = origin; })
      .catch(error => { result.errors.push(`Worker identity: ${String(error)}`); }));
  };
  page.on('worker', observeWorker);
  for (const worker of page.workers()) observeWorker(worker);
  const recordConsole = (message: ConsoleMessage): void => {
    const text = message.text();
    const prefix = text.startsWith('[pcad:occt-broker] ') ? '[pcad:occt-broker] '
      : text.startsWith('[pcad:kernel-startup] ') ? '[pcad:kernel-startup] ' : undefined;
    if (prefix === undefined) return;
    try { const decoded: unknown = JSON.parse(text.slice(prefix.length)); result.phases.push(phase(decoded, prefix.includes('broker') ? 'broker' : 'loader')); }
    catch (error) { result.errors.push(String(error)); }
  };
  // Electron's existing launcher returns after main-frame load. Recover actual
  // retained messages, with the listener already attached so the hand-off has no gap.
  let buffered: ConsoleMessage[] | undefined = [];
  page.on('console', message => { if (buffered === undefined) recordConsole(message); else buffered.push(message); });
  result.pending.push(page.consoleMessages({ filter: 'all' }).then(history => {
    if (history.length >= 200) throw new Error('Startup console history reached its retention limit');
    const retained = new Map<string, number>();
    const key = (message: ConsoleMessage) => JSON.stringify([message.timestamp(), message.text()]);
    for (const message of history) {
      recordConsole(message); const identity = key(message);
      retained.set(identity, (retained.get(identity) ?? 0) + 1);
    }
    for (const message of buffered ?? []) {
      const identity = key(message), copies = retained.get(identity) ?? 0;
      if (copies > 0) retained.set(identity, copies - 1); else recordConsole(message);
    }
    buffered = undefined;
  }).catch(error => {
    result.errors.push(`Startup history: ${String(error)}`);
    for (const message of buffered ?? []) recordConsole(message);
    buffered = undefined;
  }));
  page.on('response', response => {
    if (!/occt\/|opencascade|\.wasm(?:$|\?)/u.test(response.url())) return;
    result.pending.push(response.allHeaders().then(headers => {
      result.network.push({ url: response.url(), status: response.status(), headers, serviceWorker: response.fromServiceWorker() });
    }).catch(error => { result.errors.push(String(error)); }));
  });
  return result;
}

async function compareInSecondWorker(page: Page, info: TestInfo, mode: Mode, app?: ElectronApplication): Promise<void> {
  const empty = createEmptyPartDocument();
  const box: PrimitiveFeature = { ...createPrimitiveFeature(empty, 'box'), id: 'base', name: '台座',
    shape: { kind: 'box', sizeX: value(20), sizeY: value(20), sizeZ: value(20) } };
  const tool: PrimitiveFeature = { ...createPrimitiveFeature(empty, 'cylinder'), id: 'tool', name: '工具',
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, -11) },
    shape: { kind: 'cylinder', radius: value(3), height: value(22) } };
  const cut: BooleanFeature = { id: 'cut', name: '貫通穴', kind: 'boolean', suppressed: false,
    operation: 'subtract', targetFeatureId: box.id, toolFeatureId: tool.id };
  const paths = [info.outputPath(`${mode}-before.pcad`), info.outputPath(`${mode}-after.pcad`)] as const;
  await mkdir(info.outputDir, { recursive: true });
  await writeFile(paths[0], writePcadFile({ ...empty, solids: [box] }), { flag: 'wx' });
  await writeFile(paths[1], writePcadFile({ ...empty, solids: [box, tool, cut] }), { flag: 'wx' });
  await chooseToolMenuItem(page, 'ファイルのほかの操作', '2つの保存ファイルを比較');
  const dialog = page.getByRole('dialog', { name: '2つの保存ファイルを比較', exact: true });
  for (const [index, label] of ['変更前のファイルを選ぶ', '変更後のファイルを選ぶ'].entries()) {
    const path = paths[index]; if (path === undefined) throw new Error('Missing comparison fixture');
    const button = dialog.getByRole('button', { name: label, exact: true });
    if (app !== undefined) { await openTarget(app, path); await button.click(); }
    else { const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()]); await chooser.setFiles(path); }
  }
  await dialog.getByLabel('2つのファイルの関係', { exact: true }).selectOption('versions');
  await dialog.getByRole('button', { name: '変更を比較する', exact: true }).click();
  await expect(dialog.getByRole('region', { name: '比較結果', exact: true }).locator('[data-diff-status="added"]')).toHaveCount(2);
  const panel = dialog.getByRole('region', { name: '立体の形の比較', exact: true });
  await panel.getByRole('button', { name: '立体の形を比較する', exact: true }).click();
  const volume = (name: string) => panel.locator(`[data-material-volume="${name}"]`);
  await expect(volume('removed')).toBeVisible({ timeout: 90_000 });
  const removed = Math.PI * 3 ** 2 * 20;
  for (const [name, expected] of [['removed', removed], ['before', 8000], ['after', 8000 - removed], ['common', 8000 - removed], ['added', 0]] as const) {
    expect(Number(await volume(name).getAttribute('data-value'))).toBeCloseTo(expected, 6);
  }
  await expect(panel.getByLabel('追加・削除・共通部分の3D表示', { exact: true })).toHaveAttribute('data-material-ready', 'true');
  // runMaterialDiff disposes its Worker on success. Resource evidence uses its
  // actual lifetime overlap with the editing Worker, not the lifetime of this dialog.
}

function startSampler(): Sampler {
  // The normal E2E gate owns this test process. This is the whole descendant tree,
  // not a claim that CPU or RSS can be attributed to an individual Worker thread.
  if (process.platform === 'win32') return windowsSampler(process.pid, false);
  if (process.platform === 'linux') return linuxSampler(process.pid, false, async () => undefined);
  throw new Error('Actual OS process observation is unsupported on this platform');
}

function resourceSummary(frames: readonly RawFrame[], start: number, end: number) {
  for (const frame of frames) {
    if (!Number.isFinite(frame.readStartedAtEpochMs) || !Number.isFinite(frame.atEpochMs)
      || frame.readStartedAtEpochMs > frame.atEpochMs) throw new Error('Actual OS read boundaries missing or inconsistent');
  }
  const selected = frames.filter(frame => frame.readStartedAtEpochMs >= start && frame.atEpochMs <= end);
  const identities = new Map<string, { first: number; last: number }>();
  let peakWorkingSetBytes = 0, peakPrivateBytes = 0;
  const unavailable: string[] = [];
  for (const frame of selected) {
    if (frame.discoveryError !== null) unavailable.push(frame.discoveryError);
    if (frame.processes.length === 0) unavailable.push('Actual OS process tree is empty');
    let working = 0, privateBytes = 0;
    for (const row of frame.processes) {
      if (row.error !== null || row.workingSetBytes === null || row.privateBytes === null || row.cpuMilliseconds === null) {
        unavailable.push(`${row.pid}/${row.created}: ${row.error ?? 'missing resource value'}`); continue;
      }
      working += row.workingSetBytes; privateBytes += row.privateBytes;
      const key = `${row.pid}/${row.created}`, previous = identities.get(key);
      if (previous === undefined) identities.set(key, { first: row.cpuMilliseconds, last: row.cpuMilliseconds });
      else {
        if (row.cpuMilliseconds < previous.last) unavailable.push(`${key}: CPU clock went backwards`);
        previous.last = row.cpuMilliseconds;
      }
    }
    peakWorkingSetBytes = Math.max(peakWorkingSetBytes, working); peakPrivateBytes = Math.max(peakPrivateBytes, privateBytes);
  }
  return { frames: selected.length, peakWorkingSetBytes, peakPrivateBytes,
    cpuMilliseconds: [...identities.values()].reduce((sum, value) => sum + value.last - value.first, 0),
    identities: [...identities.keys()], unavailable,
    scope: 'OS descendant processes; shared renderer Worker threads are not individually attributed; CPU excludes work before first and after last PID sample' };
}

async function profileInventory(profile: string) {
  const files: { path: string; bytes: number; sha256: string }[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Profile contains a symbolic link');
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path);
        files.push({ path: relative(profile, path).replaceAll('\\', '/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
    }
  }
  await visit(profile); return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function cacheInventory(page: Page) {
  return page.evaluate(async () => {
    const entries: { cache: string; url: string; bytes: number; sha256: string }[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        if (response === undefined) throw new Error('Cache entry disappeared during observation');
        const bytes = await response.arrayBuffer();
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        entries.push({ cache: name, url: request.url, bytes: bytes.byteLength,
          sha256: [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('') });
      }
    }
    return { controller: navigator.serviceWorker?.controller?.scriptURL ?? null, entries };
  });
}

function completedStartup(observation: Observation, started: number) {
  const starts = observation.phases.filter(event => event.owner === 'worker' && event.phase === 'start');
  expect(starts).toHaveLength(2);
  expect(new Set(starts.map(event => event.instanceId)).size).toBe(2);
  const ready = observation.phases.filter(event => event.owner === 'worker' && event.phase === 'ready');
  expect(ready).toHaveLength(2);
  expect(new Set(ready.map(event => event.instanceId)).size).toBe(2);
  const first = ready[0]; if (first === undefined) throw new Error('First actual OCCT startup absent');
  const startupDuration = (end: Phase): number => {
    const matching = starts.filter(start => start.instanceId === end.instanceId);
    expect(matching).toHaveLength(1);
    const start = matching[0];
    if (start === undefined || start.instanceId === undefined || start.instanceId.length === 0
      || start.timeOrigin === undefined || !Number.isFinite(start.timeOrigin) || start.timeOrigin <= 0
      || start.timeOrigin !== end.timeOrigin || start.atEpochMs < started
      || end.atEpochMs < start.atEpochMs || end.elapsedMs <= start.elapsedMs) {
      throw new Error('Actual Worker start/ready pair missing or outside the OCCT measurement');
    }
    return end.elapsedMs - start.elapsedMs;
  };
  const compile = observation.phases.filter(event => event.stream === 'broker' && event.phase === 'compile-end');
  expect(compile).toHaveLength(1);
  const identity = compile[0]; if (identity?.sha256 === undefined) throw new Error('Verified asset identity missing');
  const parent = observation.phases.filter(event => event.owner === 'parent-fetch');
  for (const name of ['fetch-start', 'response-headers', 'downloaded', 'verify-start', 'verified']) {
    expect(parent.filter(event => event.phase === name), `actual parent ${name}`).toHaveLength(1);
  }
  const duration = (events: readonly Phase[], from: string, to: string) => {
    const start = events.find(event => event.phase === from), end = events.find(event => event.phase === to);
    if (start === undefined || end === undefined || end.elapsedMs < start.elapsedMs) throw new Error(`Actual phase boundary missing: ${from} -> ${to}`);
    return end.elapsedMs - start.elapsedMs;
  };
  const broker = observation.phases.filter(event => event.stream === 'broker');
  const stages = { fetchMs: duration(parent, 'fetch-start', 'downloaded'), verifyMs: duration(parent, 'verify-start', 'verified'),
    compileMs: duration(broker, 'compile-start', 'compile-end'),
    workers: ready.map(event => ({ instanceId: event.instanceId, startupMs: startupDuration(event),
      instantiateMs: duration(observation.phases.filter(phase => phase.instanceId === event.instanceId), 'native-instantiate-start', 'native-instantiate-end') })) };
  const deliveries = observation.phases.filter(event => event.stream === 'broker' && event.phase === 'module-delivered');
  expect(deliveries).toHaveLength(2);
  expect(new Set(deliveries.map(event => event.generation)).size).toBe(2);
  expect(observation.phases.filter(event => event.phase === 'instantiate-end')).toHaveLength(2);
  expect(observation.phases.filter(event => event.phase.includes('fallback'))).toHaveLength(0);
  const kernelWorkers = observation.workers.filter(worker => /kernel\.worker/u.test(worker.url));
  expect(kernelWorkers).toHaveLength(2);
  for (const event of ready) expect(kernelWorkers.some(worker => worker.timeOrigin === event.timeOrigin)).toBe(true);
  const origins = kernelWorkers.map(worker => {
    if (worker.timeOrigin === undefined) throw new Error('Actual Worker creation identity missing');
    return worker.timeOrigin;
  });
  const leases = broker.filter(event => event.phase === 'lease-open');
  expect(leases).toHaveLength(2);
  for (const lease of leases) {
    if (lease.generation === undefined || !Number.isSafeInteger(lease.generation) || lease.generation <= 0) {
      throw new Error('Actual broker lease identity missing');
    }
    expect(deliveries.filter(event => event.generation === lease.generation)).toHaveLength(1);
  }
  expect(new Set(leases.map(event => event.generation)).size).toBe(2);
  const closes = broker.filter(event => event.phase === 'lease-close');
  expect(closes).toHaveLength(1);
  const comparisonLease = leases[1], closed = closes[0];
  if (comparisonLease === undefined || closed === undefined) throw new Error('Actual comparison lease close missing');
  expect(closed.generation).toBe(comparisonLease.generation);
  expect(closed.atEpochMs).toBeGreaterThanOrEqual(comparisonLease.atEpochMs);
  // The parent records lease-close synchronously before native Worker.terminate().
  // Playwright's later close notification remains raw evidence, never the interval end.
  const overlap = { start: Math.max(...origins), end: closed.atEpochMs,
    endSource: 'broker-lease-close-before-native-terminate', generation: closed.generation };
  expect(overlap.end).toBeGreaterThan(overlap.start);
  return { startupMs: startupDuration(first), sha256: identity.sha256, byteLength: identity.byteLength, stages, overlap };
}

function assertOcctNotStarted(observation: Observation): void {
  // An empty UI owns a JS Worker/lease, but must not have begun loading OCCT.
  expect(observation.phases.filter(event => event.phase !== 'lease-open'),
    'No OCCT load/compile/instantiate phase before the fixed measurement boundary').toEqual([]);
  expect(observation.errors).toEqual([]);
}

async function prepareOcctMeasurement(page: Page, offline: boolean, observation: Observation): Promise<number> {
  await Promise.all(observation.pending);
  await waitForStartupReady(page);
  if (await page.locator('.pcad-restore').isVisible()) await page.locator('.pcad-restore').getByRole('button', { name: '破棄する', exact: true }).click();
  expect(await page.evaluate(() => navigator.onLine)).toBe(!offline);
  await Promise.all(observation.pending);
  assertOcctNotStarted(observation);
  return Date.now();
}

async function measure(page: Page, context: BrowserContext, info: TestInfo, mode: Mode, offline: boolean,
  observation: Observation, sampler: Sampler, started: number,
  preparation: { readonly launchStartedAtEpochMs: number; readonly uiReadyAtEpochMs: number }, app?: ElectronApplication) {
  // Start the sampler only after normal empty-UI preparation. Every acquired
  // frame is retained and checked; no failed frame is dropped to obtain a baseline.
  await expect.poll(() => sampler.frames.filter(frame => frame.discoveredAtEpochMs >= started && frame.processes.length > 0).length,
    { message: 'Two actual OS baseline frames before the first OCCT operation' }).toBeGreaterThan(1);
  const baselineReadyAtEpochMs = Date.now();
  const baseline = resourceSummary(sampler.frames, started, baselineReadyAtEpochMs);
  expect(baseline.frames).toBe(sampler.frames.length);
  expect(baseline.frames).toBeGreaterThan(1);
  expect(baseline.unavailable).toEqual([]); expect(sampler.failures).toEqual([]);
  expect(baseline.peakWorkingSetBytes).toBeGreaterThan(0); expect(baseline.peakPrivateBytes).toBeGreaterThan(0);
  await Promise.all(observation.pending);
  assertOcctNotStarted(observation);
  await info.attach(`${mode}-preparation-and-baseline`, { body: JSON.stringify({ ...preparation,
    measurementStartedAtEpochMs: started, baselineReadyAtEpochMs, baseline, frames: [...sampler.frames],
    preparationPhases: [...observation.phases], preparationWorkers: observation.workers.map(worker => ({ ...worker })),
    scope: 'UI preparation includes initial JS Worker/lease creation; OS sampling starts before any OCCT load, not before app launch' }), contentType: 'application/json' });
  assertOcctNotStarted(observation);
  const operationStartedAtEpochMs = Date.now();
  await chooseToolMenuItem(page, '作る', '箱');
  const token = await beginRecompute(page);
  await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter');
  await waitForRecompute(page, token);
  await compareInSecondWorker(page, info, mode, app);
  await Promise.all(observation.pending);
  await sampler.stop();
  const measuredThroughAtEpochMs = Date.now();
  const measured = completedStartup(observation, started);
  if (app !== undefined) {
    const parent = observation.phases.filter(event => event.owner === 'parent-fetch');
    expect(parent.filter(event => event.phase === 'transport-direct-port-unavailable'),
      'Port fallback preserves CAD but cannot satisfy W21 HTTP reuse').toHaveLength(0);
    expect(parent.filter(event => event.phase === 'transport-http'),
      'W21 Desktop must use the verified fixed HTTP transport').toHaveLength(1);
  }
  for (const phase of observation.phases.filter(event => event.phase !== 'lease-open')) {
    expect(phase.atEpochMs, `Actual ${phase.phase} starts within OS measurement`).toBeGreaterThanOrEqual(started);
    expect(phase.atEpochMs, `Actual ${phase.phase} ends within OS measurement`).toBeLessThanOrEqual(measuredThroughAtEpochMs);
  }
  expect(measured.overlap.start).toBeGreaterThanOrEqual(started);
  expect(measured.overlap.end).toBeLessThanOrEqual(measuredThroughAtEpochMs);
  const actualWasm = await readFile(join(root, 'packages/kernel/node_modules/opencascade.js/dist/opencascade.full.wasm'));
  expect(measured.sha256).toBe(sha256(actualWasm)); expect(measured.byteLength).toBe(actualWasm.byteLength);
  const resources = resourceSummary(sampler.frames, started, measuredThroughAtEpochMs);
  expect(resources.frames, 'Every acquired OS frame is in the declared measurement').toBe(sampler.frames.length);
  const twoWorkerResources = resourceSummary(sampler.frames, measured.overlap.start, measured.overlap.end);
  await info.attach(`${mode}-two-worker-window`, { body: JSON.stringify({ overlap: measured.overlap, twoWorkerResources }), contentType: 'application/json' });
  expect(twoWorkerResources.frames, 'Actual OS samples during the two UI Workers\' overlapping lifetimes').toBeGreaterThan(1);
  expect(twoWorkerResources.cpuMilliseconds).toBeGreaterThan(0);
  expect(twoWorkerResources.peakWorkingSetBytes).toBeGreaterThan(0); expect(twoWorkerResources.peakPrivateBytes).toBeGreaterThan(0);
  expect(twoWorkerResources.unavailable).toEqual([]);
  expect(resources.frames).toBeGreaterThan(1);
  expect(resources.peakWorkingSetBytes).toBeGreaterThan(0); expect(resources.peakPrivateBytes).toBeGreaterThan(0);
  expect(resources.cpuMilliseconds).toBeGreaterThan(0); expect(resources.unavailable).toEqual([]);
  expect(sampler.failures).toEqual([]);
  await Promise.all(observation.pending);
  expect(observation.errors).toEqual([]);
  const caches = app === undefined ? await cacheInventory(page) : { controller: null, entries: [] };
  if (offline && app === undefined) {
    expect(caches.controller).not.toBeNull();
    expect(caches.entries.some(entry => entry.sha256 === measured.sha256)).toBe(true);
  }
  await info.attach(`${mode}-occt-observation`, { body: JSON.stringify({ startedAtEpochMs: started, measuredThroughAtEpochMs,
    preparation: { ...preparation, baselineReadyAtEpochMs, operationStartedAtEpochMs,
      uiPreparationMs: preparation.uiReadyAtEpochMs - preparation.launchStartedAtEpochMs,
      baselineMs: baselineReadyAtEpochMs - started, operationThroughMeasurementStopMs: measuredThroughAtEpochMs - operationStartedAtEpochMs },
    measured, observation, resources, twoWorkerResources, frames: sampler.frames, caches,
    cacheSource: app === undefined ? 'CacheStorage and closed profile' : 'closed actual Electron profile',
    pageUrl: page.url(), offline, contextPages: context.pages().map(page => page.url()) }, null, 2), contentType: 'application/json' });
  return measured;
}

async function prepareOffline(page: Page, info: TestInfo): Promise<void> {
  await waitForStartupReady(page);
  const inventoryResponse = await page.request.get(new URL('offline-assets.json', page.url()).href);
  expect(inventoryResponse.status(), 'A real assembled offline distribution is required').toBe(200);
  const input: unknown = await inventoryResponse.json();
  const manifest = await readOfflineAssetManifest(input);
  expect(manifest.assets.length).toBeLessThanOrEqual(1000);
  for (const asset of manifest.assets) expect(asset.transport?.byteLength ?? asset.byteLength).toBeLessThanOrEqual(25 * 1024 * 1024);
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByRole('button', { name: '通信なしで使う準備', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'この端末で通信なしの利用を準備できました。' })).toBeVisible();
  const cache = await cacheInventory(page);
  for (const asset of manifest.assets) {
    expect(cache.entries.some(entry => entry.sha256 === asset.sha256 && entry.bytes === asset.byteLength), asset.url).toBe(true);
  }
  await info.attach('offline-prepared-real-assets', { body: JSON.stringify({ manifest, cache }), contentType: 'application/json' });
}

export async function browserOcctPair(playwright: Playwright, browserName: 'chromium' | 'firefox' | 'webkit',
  info: TestInfo, offline: boolean, index: number): Promise<OcctPair> {
  // An in-test server lives for the whole cold/warm pair, so both launches share one origin.
  const distribution = await actualWebDistribution(playwright, info);
  try { return await browserOcctPairOn(distribution.url, playwright, browserName, info, offline, index); }
  finally { await distribution.close(); }
}

async function browserOcctPairOn(baseURL: string, playwright: Playwright, browserName: 'chromium' | 'firefox' | 'webkit',
  info: TestInfo, offline: boolean, index: number): Promise<OcctPair> {
  const parent = join(root, 'scratchpad/temp/b'); await mkdir(parent, { recursive: true });
  const profile = await mkdtemp(join(parent, 'w'));
  expect(profile.length).toBeLessThanOrEqual(90);
  expect(await readdir(profile)).toEqual([]);
  const launch = async (networkOffline: boolean) => {
    const context = await playwright[browserName].launchPersistentContext(profile, {
      ...info.project.use.launchOptions, headless: true, viewport: { width: 1440, height: 900 }, baseURL,
      offline: networkOffline, acceptDownloads: true,
    });
    try {
      // Match document-diff.spec.ts before every navigation, including cold/warm reopen.
      await context.addInitScript(() => {
        for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
          Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
        }
      });
      return context;
    } catch (error) { await context.close(); throw error; }
  };
  if (offline) {
    const preparation = await launch(false);
    try {
      preparation.setDefaultTimeout(info.project.use.actionTimeout ?? 15_000);
      const page = preparation.pages()[0] ?? await preparation.newPage(), observation = observe(page);
      await page.goto(baseURL); await prepareOffline(page, info);
      expect(observation.phases.filter(event => event.phase === 'compile-start' || event.phase === 'ready')).toHaveLength(0);
      await info.attach('offline-preparation-no-compile', { body: JSON.stringify(observation), contentType: 'application/json' });
    } finally { await preparation.close(); }
    await info.attach('offline-prepared-profile', { body: JSON.stringify(await profileInventory(profile)), contentType: 'application/json' });
  }
  const run = async (mode: Mode) => {
    const launchStartedAtEpochMs = Date.now(); let sampler: Sampler | undefined, context: BrowserContext | undefined, observation: Observation | undefined;
    try {
      context = await launch(offline);
      context.setDefaultTimeout(info.project.use.actionTimeout ?? 15_000);
      const page = context.pages()[0] ?? await context.newPage(); observation = observe(page);
      await page.goto(baseURL);
      const uiReadyAtEpochMs = await prepareOcctMeasurement(page, offline, observation);
      const started = Date.now(); sampler = startSampler();
      return await measure(page, context, info, mode, offline, observation, sampler, started, { launchStartedAtEpochMs, uiReadyAtEpochMs });
    } catch (error) {
      const page = context?.pages()[0];
      if (page !== undefined && !page.isClosed()) await info.attach(`${mode}-failure`, { body: await page.screenshot(), contentType: 'image/png' });
      throw error;
    } finally {
      await sampler?.stop();
      try {
        await info.attach(`${mode}-raw-occt`, { body: JSON.stringify(observation ?? null), contentType: 'application/json' });
        await info.attach(`${mode}-raw-processes`, { body: JSON.stringify({ launchStartedAtEpochMs, samplingStarted: sampler !== undefined, frames: sampler?.frames ?? [], failures: sampler?.failures ?? [] }), contentType: 'application/json' });
      } finally { await context?.close(); }
      await info.attach(`${mode}-closed-profile`, { body: JSON.stringify(await profileInventory(profile)), contentType: 'application/json' });
    }
  };
  const cold = await run('cold'), warm = await run('warm');
  expect(warm.sha256).toBe(cold.sha256);
  return { index, offline, profile, cold, warm };
}

export async function electronOcctPair(playwright: Playwright, info: TestInfo, offline: boolean, index: number): Promise<OcctPair> {
  const profile = profileDirectoryFor(info);
  await mkdir(join(root, 'scratchpad/temp/e'), { recursive: true });
  await mkdir(profile);
  expect(await readdir(profile)).toEqual([]);
  const run = async (mode: Mode) => {
    const launchStartedAtEpochMs = Date.now(); let sampler: Sampler | undefined, app: ElectronApplication | undefined, observation: Observation | undefined;
    try {
      ({ app } = await launchDesktop(playwright, info, { waitForStartup: false }));
      app.context().setDefaultTimeout(info.project.use.actionTimeout ?? 15_000);
      const page = await app.firstWindow(); observation = observe(page);
      await app.context().setOffline(offline);
      expect(new URL(page.url()).protocol).toBe('app:');
      const uiReadyAtEpochMs = await prepareOcctMeasurement(page, offline, observation);
      const started = Date.now(); sampler = startSampler();
      return await measure(page, app.context(), info, mode, offline, observation, sampler, started, { launchStartedAtEpochMs, uiReadyAtEpochMs }, app);
    } catch (error) {
      const page = app?.windows()[0];
      if (page !== undefined && !page.isClosed()) await info.attach(`${mode}-failure`, { body: await page.screenshot(), contentType: 'image/png' });
      throw error;
    } finally {
      await sampler?.stop();
      try {
        await info.attach(`${mode}-raw-occt`, { body: JSON.stringify(observation ?? null), contentType: 'application/json' });
        await info.attach(`${mode}-raw-processes`, { body: JSON.stringify({ launchStartedAtEpochMs, samplingStarted: sampler !== undefined, frames: sampler?.frames ?? [], failures: sampler?.failures ?? [] }), contentType: 'application/json' });
      } finally { await app?.close(); }
      await info.attach(`${mode}-closed-profile`, { body: JSON.stringify(await profileInventory(profile)), contentType: 'application/json' });
    }
  };
  const cold = await run('cold'), warm = await run('warm'); expect(warm.sha256).toBe(cold.sha256);
  return { index, offline, profile, cold, warm };
}

export async function assertFiveOcctPairs(pairs: readonly OcctPair[], info: TestInfo): Promise<void> {
  const median = (values: number[]) => { const sorted = values.sort((a, b) => a - b); const value = sorted[2]; if (value === undefined) throw new Error('Five samples missing'); return value; };
  await info.attach('five-pair-raw-measurements', { body: JSON.stringify(pairs, null, 2), contentType: 'application/json' });
  expect(pairs).toHaveLength(5); expect(new Set(pairs.map(pair => pair.profile)).size).toBe(5);
  expect(pairs.map(pair => pair.index).sort()).toEqual([1, 2, 3, 4, 5]);
  const cold = median(pairs.map(pair => pair.cold.startupMs)), warm = median(pairs.map(pair => pair.warm.startupMs));
  await info.attach('five-pair-medians', { body: JSON.stringify({ cold, warm, ratio: warm / cold, requiredRatio: 0.8 }), contentType: 'application/json' });
  expect(cold).toBeGreaterThan(0); expect(warm).toBeLessThanOrEqual(cold * 0.8);
}
