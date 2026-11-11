import { watch, type FSWatcher } from 'node:fs';
import { setTimeout as scheduleTimeout, clearTimeout as clearScheduledTimeout } from 'node:timers';
import { createHash, randomUUID } from 'node:crypto';
import { open, realpath, stat, readFile, readdir, writeFile } from 'node:fs/promises';
import { hostname, platform, release } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { gpuPostTraceDelivery, gpuOwnedStopReceipt, gpuPostTraceWaitBudget, consumeGpuPostTrace, memoryWorkloadCapture, gpuEvidenceRecord, gpuEvidenceSha256, summarizeSampledProcessMemory, sampledMemoryCaseAcceptance, parseDrmClientMemory, processMemoryWithinBudget, combinedSampledMemoryBound, summarizeProcessMemory,
  type GpuMemorySample, type MemoryPhase, type ProcessMemoryFrame }
  from '../../packages/test-utils/src/processMemorySamples.js';
import { boxPartFile, twoBoxAssemblyFile, chooseToolMenuItem, readAssemblyStats } from './assemblyTestSupport.js';
import { openSaveFlowFile, saveFlowFile, saveCancelFlow, saveDocumentSwitchFlow } from './saveResponsivenessFlow.js';
import { beginRecompute, readRecomputeStats, waitForRecompute, waitForRecomputeOutcome } from './recompute.js';
import { readViewportRenderStats } from './viewportRenderStats.js';
import { waitForStartupHealth } from './startupHealth.js';
import { readDocumentBundle, readPcadFile, writePcadFile } from '../../packages/io/src/index.js';
import { absoluteCoordinate, appendSolid, createEmptyPartDocument, createPrimitiveFeature } from '../../packages/model/src/index.js';
import { openTarget } from './electronAppFlow.js';
import { fileAction } from './fileCaptureSupport.js';
import { parseUsageCensus, parseUsageWindow, qualifyDocumentedGpuUsage } from './documentedGpuUsage.js';

import { windowsSampler, linuxSampler, linuxProcess, INTERVAL_MS, DISCOVERY_INTERVAL_MS, type RawFrame } from './processResourceSampler.js';
const BUDGET_BYTES = 512 * 1024 * 1024;
const SOURCE_PATHS = ['e2e/tests/memoryHighwaterFlow.ts', 'e2e/tests/processResourceSampler.ts', 'e2e/tests/memory-highwater.spec.ts',
  'e2e/tests/electron-memory-highwater.spec.ts', 'packages/test-utils/src/processMemorySamples.ts',
  'packages/ui/src/viewport/createViewportScene.ts', 'packages/ui/src/viewport/ViewportCanvas.tsx',
  'packages/ui/src/viewport/viewportMeshObservation.ts', 'packages/ui/src/app/PointerCadApp.tsx',
  'packages/model/src/kernelBridge.ts', 'packages/model/src/kernelBridge/bridgeContracts.ts',
  'packages/kernel/src/worker/kernelApi.ts', 'packages/kernel/src/worker/runtimePhaseJournal.ts',
  'packages/kernel/src/index.ts',
  'e2e/tests/saveResponsivenessFlow.ts', 'e2e/tests/documentedGpuUsage.ts'] as const;

interface ViewportHostReservation {
  readonly displayCopyBytes: number;
  readonly gpuMeshBytes: number;
  readonly assemblySourceBackingBytes: number;
  readonly assemblyInstanceBytes: number;
  readonly uncovered: readonly string[];
}
declare global {
  interface Window { pcadViewportMemoryStats?: () => ViewportHostReservation | null }
}

interface PhaseBoundary { readonly atEpochMs: number; readonly phase: MemoryPhase; readonly observation: string }

interface ActualPhaseEvent {
  readonly stream: string; readonly sequence: number; readonly atEpochMs: number;
  readonly kind: string; readonly owner: string;
  readonly generation: number | null; readonly documentId: string | null;
  readonly hostDisplayCopyBytes?: number | null; readonly hostGpuAttributeBytes?: number | null;
}

/** Recheck the collected sequence, not a rolling snapshot whose starts may
 * already have been drained before ring eviction. Raw snapshot counters remain diagnostic. */
export function viewportCollectedCoverage(records: readonly unknown[]): readonly string[] {
  const problems: string[] = [];
  const owners = new Map<string, string>(), publications = new Set<string>();
  const starts = new Set<string>(), completed = new Set<string>();
  let previous = 0;
  for (const row of records) {
    if (!gpuEvidenceRecord(row) || !Number.isSafeInteger(row['sequence']) || row['sequence'] !== previous + 1) {
      problems.push('Viewport collected sequence gap'); continue;
    }
    previous = Number(row['sequence']);
    const kind = row['kind'], operation = row['operationId'], publication = row['publicationId'], resource = row['resourceOwnerId'];
    if (typeof kind !== 'string' || typeof operation !== 'string' || typeof publication !== 'string'
      || typeof resource !== 'string' || typeof row['documentId'] !== 'string'
      || !Number.isSafeInteger(row['generation']) || typeof row['preview'] !== 'boolean') {
      problems.push('Viewport collected owner metadata missing'); continue;
    }
    const metadata = JSON.stringify([row['documentId'], row['generation'], row['preview'], publication, resource]);
    const old = owners.get(operation);
    if (old !== undefined && old !== metadata) problems.push('Viewport collected owner conflict');
    owners.set(operation, metadata);
    if (kind === 'publication-retired') {
      if (!publications.delete(publication)) problems.push('Viewport collected publication start missing');
      continue;
    }
    if (kind === 'operation-aborted') {
      starts.delete(`${operation}:build`); starts.delete(`${operation}:publish`); continue;
    }
    const phase = kind.startsWith('publish') ? 'publish' : kind.startsWith('release') ? 'release'
      : kind.startsWith('candidate-return') ? 'return' : kind.startsWith('geometry-cancel') ? 'cancel' : 'build';
    const key = `${phase === 'release' ? resource : operation}:${phase}`;
    if (kind.endsWith('-start') || kind.endsWith('-request')) {
      if (starts.has(key)) problems.push('Viewport collected duplicate start');
      starts.add(key); completed.delete(key);
    } else {
      if (completed.has(key)) problems.push('Viewport collected duplicate terminal');
      else if (!starts.has(key)) problems.push('Viewport collected start missing');
      starts.delete(key); completed.add(key);
      if (kind === 'publish-complete') publications.add(publication);
    }
  }
  return problems;
}

/** Drain existing primitive observers at each UI checkpoint. Ring eviction is not
 * lost evidence when the evicted sequence was already collected here. Raw provider
 * status/reasons are retained, never rewritten to observed. */
export function actualPhaseCollector(page: Page, nonce: string) {
  const snapshots: unknown[] = [], events: ActualPhaseEvent[] = [], problems: string[] = [];
  const sequences = new Map<string, number>();
  const ownerMetadata = new Map<string, string>();
  const collectedViewportRows = new Map<string, unknown[]>();
  let mainAcknowledge: number | null = null, workerAcknowledge: number | null = null;
  let initial = true;
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object';
  const append = (stream: string, rows: unknown, sequenceKey: string, timeKey: string,
    kindKey: string, ownerKey: string, offset = 0): void => {
    if (!Array.isArray(rows)) { problems.push(`${stream}: records unavailable`); return; }
    for (const value of rows) {
      const row: unknown = value;
      if (!object(row)) { problems.push(`${stream}: malformed record`); continue; }
      const sequence = row[sequenceKey], time = row[timeKey], kind = row[kindKey];
      const owner = stream.startsWith('viewport:') && typeof kind === 'string' && !kind.startsWith('release-')
        ? row.operationId : row[ownerKey];
      if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) {
        problems.push(`${stream}: invalid sequence`); continue;
      }
      const previous = sequences.get(stream) ?? 0;
      if (sequence <= previous) continue;
      if (stream.startsWith('viewport:')) {
        const collected = collectedViewportRows.get(stream) ?? [];
        collected.push(row); collectedViewportRows.set(stream, collected);
      }
      if (initial) { sequences.set(stream, sequence); continue; }
      if (sequence !== previous + 1) problems.push(`${stream}: missing sequences ${previous + 1}..${sequence - 1}`);
      sequences.set(stream, sequence);
      // Connection lifetime records have no dispatch owner; preserve them in raw
      // snapshots, but do not mislabel them as geometry-operation intervals.
      if (owner === null && typeof kind === 'string' && kind.startsWith('connection-')) continue;
      if (typeof time !== 'number' || !Number.isFinite(time) || typeof kind !== 'string'
        || typeof owner !== 'string' || owner.length === 0) {
        problems.push(`${stream}: missing sequence/clock/owner`); continue;
      }
      if (stream === 'main' && !Number.isSafeInteger(row.connectionEpoch)) {
        problems.push('Main connection epoch missing'); continue;
      }
      const scopedOwner = stream === 'main' ? `${String(row.connectionEpoch)}:${owner}`
        : stream.startsWith('worker:') ? `${stream.slice('worker:'.length)}:${owner}` : owner;
      if (stream === 'main' || stream.startsWith('worker:')) {
        if (typeof row.partId !== 'string' || typeof row.generation !== 'number'
          || !Number.isSafeInteger(row.generation) || (row.kind !== 'display' && row.kind !== 'hidden')) {
          problems.push(`${stream}: invalid dispatch identity`); continue;
        }
        const metadata = JSON.stringify([row.partId, row.generation, row.kind]);
        if (stream === 'main' && kind === 'dispatch') {
          if (!object(row.ui) || typeof row.ui.activeDocumentId !== 'string') problems.push('Dispatch document context missing');
          const previousOwner = ownerMetadata.get(scopedOwner);
          if (previousOwner !== undefined && previousOwner !== metadata) problems.push('Dispatch owner conflict');
          ownerMetadata.set(scopedOwner, metadata);
        } else if (ownerMetadata.get(scopedOwner) !== metadata) problems.push(`${stream}: unmatched captured dispatch owner`);
      }
      events.push({ stream, sequence, atEpochMs: time + offset, kind, owner: scopedOwner,
        ...(stream.startsWith('viewport:') ? {
          hostDisplayCopyBytes: typeof row.hostDisplayCopyBytes === 'number' ? row.hostDisplayCopyBytes : null,
          hostGpuAttributeBytes: typeof row.hostGpuAttributeBytes === 'number' ? row.hostGpuAttributeBytes : null,
        } : {}),
        generation: typeof row.generation === 'number' ? row.generation : null,
        documentId: typeof row.documentId === 'string' ? row.documentId
          : object(row.ui) && typeof row.ui.activeDocumentId === 'string' ? row.ui.activeDocumentId : null });
    }
  };
  const journal = (stream: string, value: unknown): number | null => {
    if (!object(value) || value.nonce !== nonce || value.dropped !== 0 || !Array.isArray(value.records)
      || typeof value.startedAfter !== 'number' || !Number.isSafeInteger(value.startedAfter)
      || typeof value.lastSeq !== 'number' || !Number.isSafeInteger(value.lastSeq)) {
      problems.push(`${stream}: phase journal incomplete`); return null;
    }
    if (!sequences.has(stream)) sequences.set(stream, value.startedAfter);
    append(stream, value.records, 'seq', 'epochMs', 'phase', 'dispatchId');
    if (sequences.get(stream) !== value.lastSeq) { problems.push(`${stream}: journal terminal sequence missing`); return null; }
    return value.lastSeq;
  };
  return { snapshots, events, problems,
    async begin(): Promise<void> {
      await page.evaluate(async nonce => {
        const control: unknown = Reflect.get(window, 'pcadRuntimePhaseCapture');
        if (control === null || typeof control !== 'object') throw new Error('Phase capture control unavailable');
        const begin: unknown = Reflect.get(control, 'beginRuntimePhaseCapture');
        if (typeof begin !== 'function') throw new Error('Phase capture begin unavailable');
        await begin(nonce);
      }, nonce);
    },
    async end(): Promise<void> {
      await page.evaluate(async nonce => {
        const control: unknown = Reflect.get(window, 'pcadRuntimePhaseCapture');
        if (control === null || typeof control !== 'object') throw new Error('Phase capture control unavailable');
        const end: unknown = Reflect.get(control, 'endRuntimePhaseCapture');
        if (typeof end !== 'function') throw new Error('Phase capture end unavailable');
        await end(nonce);
      }, nonce);
    },
    async collect(): Promise<void> {
    const snapshot = await page.evaluate(async ({ nonce, mainAcknowledge, workerAcknowledge, viewportAcknowledge }) => {
      const readRuntime: unknown = Reflect.get(window, 'pcadRuntimePhases');
      const readViewport: unknown = Reflect.get(window, 'pcadViewportMeshObservation');
      const control: unknown = Reflect.get(window, 'pcadRuntimePhaseCapture');
      if (control === null || typeof control !== 'object') throw new Error('Phase capture control unavailable');
      const readCapture: unknown = Reflect.get(control, 'readRuntimePhaseCapture');
      if (typeof readCapture !== 'function') throw new Error('Phase journal unavailable');
      const capture: unknown = await readCapture(nonce, mainAcknowledge, workerAcknowledge);
      const runtime: unknown = typeof readRuntime === 'function' ? await readRuntime() : null;
      let viewport: unknown = typeof readViewport === 'function' ? readViewport() : null;
      // Drain only already-validated sequences before RPC serialization. Preserve
      // all metadata and malformed rows so the existing validator still refuses them.
      if (viewport !== null && typeof viewport === 'object' && 'viewportOwnerId' in viewport
        && typeof viewport.viewportOwnerId === 'string' && 'events' in viewport && Array.isArray(viewport.events)) {
        const after = viewportAcknowledge[`viewport:${viewport.viewportOwnerId}`] ?? 0;
        viewport = { ...viewport, events: viewport.events.filter((row: unknown) => {
          if (row === null || typeof row !== 'object' || !('sequence' in row)
            || typeof row.sequence !== 'number' || !Number.isSafeInteger(row.sequence) || row.sequence < 1) return true;
          return row.sequence > after;
        }) };
      }
      return { readAtEpochMs: Date.now(), runtime, viewport, capture };
    }, { nonce, mainAcknowledge, workerAcknowledge,
      viewportAcknowledge: Object.fromEntries([...sequences].filter(([stream]) => stream.startsWith('viewport:'))) });
    snapshots.push(snapshot);
    const capture = snapshot.capture;
    if (!object(capture) || capture.nonce !== nonce || !Number.isSafeInteger(capture.connectionEpoch))
      problems.push('Runtime phase journal owner unavailable');
    else {
      mainAcknowledge = journal('main', capture.main);
      workerAcknowledge = journal(`worker:${String(capture.connectionEpoch)}`, capture.worker);
    }
    const runtime = snapshot.runtime;
    if (!object(runtime) || !Number.isSafeInteger(runtime.connectionEpoch) || !object(runtime.main)) {
      problems.push('Runtime phase provider unavailable');
    } else {
      const main = runtime.main, worker = runtime.worker;
      if (main.clockDiscontinuities !== 0 || main.missingContexts !== 0) problems.push('Main clock/context incomplete');
      if (!object(worker)) problems.push('Worker phase provider unavailable');
      else {
        if (worker.clockDiscontinuities !== 0 || worker.missingOwners !== 0 || worker.ownerConflicts !== 0)
          problems.push('Worker clock/owner incomplete');
      }
      if (runtime.reason !== null && runtime.reason !== 'metadata-incomplete' && runtime.reason !== 'no-worker-phases'
        && runtime.reason !== 'unmatched-worker-owner')
        problems.push(`Runtime provider: ${String(runtime.reason)}`);
    }
    const viewport = snapshot.viewport;
    if (!object(viewport) || typeof viewport.viewportOwnerId !== 'string'
      || typeof viewport.epochAnchorMs !== 'number' || typeof viewport.monotonicAnchorMs !== 'number'
      || !Number.isFinite(viewport.epochAnchorMs) || !Number.isFinite(viewport.monotonicAnchorMs)) {
      problems.push('Viewport phase provider unavailable');
    } else {
      append(`viewport:${viewport.viewportOwnerId}`, viewport.events, 'sequence', 'atMonotonicMs', 'kind',
        'resourceOwnerId', viewport.epochAnchorMs - viewport.monotonicAnchorMs);
      const collectedProblems = viewportCollectedCoverage(collectedViewportRows.get(`viewport:${viewport.viewportOwnerId}`) ?? []);
      // missingStarts in a rolling snapshot can refer to starts already collected.
      // Revalidate them against every drained record, keeping true gaps/metadata/clock failures fatal.
      if (viewport.clockDiscontinuity !== false || viewport.conflictingOwners !== 0
        || typeof viewport.missingRecords !== 'number' || typeof viewport.missingStarts !== 'number'
        || viewport.missingRecords !== viewport.missingStarts || viewport.duplicateTerminals !== 0
        || collectedProblems.length > 0) problems.push('Viewport clock/owner incomplete');
      problems.push(...collectedProblems);
    }
    initial = false;
  } };
}

/** Match actual operation owners, not nearby UI clicks. A phase with no process
 * sample in its real interval remains unknown, even if an outer UI phase had samples. */
function actualPhaseCoverage(events: readonly ActualPhaseEvent[], frames: readonly (ProcessMemoryFrame & { readonly readStartedAtEpochMs: number })[]) {
  const pairs = [
    ['build', 'native-build-start', 'native-build-return'],
    ['transfer', 'reply-preclone', 'raw-received'],
    ['publish', 'publish-start', 'publish-complete'],
    ['cancel', 'geometry-cancel-request', 'native-build-cancelled'],
  ] as const;
  return pairs.map(([phase, startKind, endKind]) => {
    const intervals = events.filter(event => event.kind === startKind).flatMap(start => {
      const end = events.find(event => event.kind === endKind && event.owner === start.owner
        && event.atEpochMs >= start.atEpochMs
        && (phase === 'transfer' || phase === 'cancel' || event.stream === start.stream));
      if (end === undefined) return [];
      const samples = frames.filter(frame => frame.readStartedAtEpochMs >= start.atEpochMs && frame.atEpochMs <= end.atEpochMs);
      return [{ owner: start.owner, startedAtEpochMs: start.atEpochMs, endedAtEpochMs: end.atEpochMs,
        sampleEpochMs: samples.map(sample => sample.atEpochMs) }];
    });
    return { phase, intervals, sampled: intervals.some(interval => interval.sampleEpochMs.length > 0) };
  });
}

/** Exercise the existing visible geometry-cancel button, with real distinct
 * features and no debug delay. A machine that finishes before the button appears
 * must report missing cancellation, never substitute save-worker cancellation. */
async function cancelGeometry(page: Page, info: TestInfo, app?: ElectronApplication) {
  let part = { ...createEmptyPartDocument(), name: '高水位の実幾何取消' };
  for (let index = 0; index < 100; index++) {
    part = appendSolid(part, createPrimitiveFeature(part, 'box', {
      kind: 'coordinate', value: absoluteCoordinate(index % 10 * 30, Math.floor(index / 10) * 30, index),
    }));
  }
  const path = info.outputPath('geometry-cancel-100.pcad');
  const bytes = writePcadFile(part, { savedAt: '2026-10-09T00:00:00.000Z' });
  await writeFile(path, bytes);
  const before = await beginRecompute(page);
  if (app !== undefined) await openTarget(app, path);
  const [pressed] = await Promise.all([
    page.evaluate(() => new Promise<{ label: string; atEpochMs: number; completed: string | null; total: string | null }>((resolve, reject) => {
      const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Actual geometry cancel button did not appear')); }, 30_000);
      const check = (): void => {
        const button = document.querySelector('.pcad-statusbar__progress .pcad-statusbar__cancel');
        if (!(button instanceof HTMLButtonElement) || button.disabled || button.getClientRects().length === 0) return;
        const progress = document.querySelector('.pcad-statusbar__progress [role="progressbar"]');
        const result = { label: button.textContent ?? '', atEpochMs: Date.now(),
          completed: progress?.getAttribute('aria-valuenow') ?? null, total: progress?.getAttribute('aria-valuemax') ?? null };
        observer.disconnect(); clearTimeout(timer); button.click(); resolve(result);
      };
      const observer = new MutationObserver(check);
      observer.observe(document, { subtree: true, childList: true, attributes: true });
      check();
    })),
    (async () => {
      const chooser = app === undefined ? page.waitForEvent('filechooser') : null;
      await fileAction(page, '開く').click();
      if (chooser !== null) await (await chooser).setFiles(path);
    })(),
  ]);
  expect(pressed.label).toBe('中止');
  expect(pressed.total).toBe('100');
  if (pressed.completed === null || !/^\d+$/u.test(pressed.completed)) throw new Error('Actual cancelled progress count unavailable');
  expect(Number(pressed.completed)).toBeLessThan(100);
  await waitForRecomputeOutcome(page, before, 'cancelled');
  const cancelledViewport: unknown = await page.evaluate(() => {
    const read: unknown = Reflect.get(window, 'pcadViewportFramedBodies');
    const value: unknown = typeof read === 'function' ? read() : null;
    return value;
  });
  expect(Array.isArray(cancelledViewport) && cancelledViewport.length === 0,
    'Cancelled first geometry must not publish a partial viewport').toBe(true);
  return { pressed, terminal: await readRecomputeStats(page), inputPath: path,
    inputSha256: createHash('sha256').update(bytes).digest('hex'), features: part.solids.length, cancelledViewport };
}

/** 実fdinfoを読むprovider。共有clientはidentityで一回、共有bufferは未知を保持する。 */
export async function readLinuxGpuMemory(frame: ProcessMemoryFrame): Promise<{
  sample: GpuMemorySample; raw: readonly string[]; readStartedAtEpochMs: number; readEndedAtEpochMs: number;
}> {
  const readStartedAtEpochMs = Date.now();
  const raw: string[] = [], unknown: string[] = [];
  const clients = new Map<string, ReturnType<typeof parseDrmClientMemory>>();
  for (const process of frame.processes) {
    try {
      if ((await linuxProcess(process.pid)).created !== process.created) throw new Error('PID reused before GPU read');
      for (const fd of await readdir(`/proc/${process.pid}/fdinfo`)) {
        const text = await readFile(`/proc/${process.pid}/fdinfo/${fd}`, 'utf8');
        if (!/^drm-driver:/m.test(text)) continue;
        raw.push(`pid=${process.pid} created=${process.created} fd=${fd}\n${text}`);
        const client = parseDrmClientMemory(text);
        unknown.push(...client.problems);
        if (client.identity !== null) {
          const previous = clients.get(client.identity);
          if (previous !== undefined && (previous.residentBytes !== client.residentBytes || previous.allocatedBytes !== client.allocatedBytes)) {
            unknown.push(`DRM duplicate changed during read: ${client.identity}`);
          }
          clients.set(client.identity, client);
        }
      }
      if ((await linuxProcess(process.pid)).created !== process.created) throw new Error('PID reused during GPU read');
    } catch (error: unknown) { unknown.push(`${process.pid}: fdinfo read failed: ${String(error)}`); }
  }
  if (clients.size === 0) unknown.push('No DRM memory clients reported; software renderer is not measured GPU zero');
  const sum = (key: 'residentBytes' | 'allocatedBytes'): number | null => {
    const values = [...clients.values()].map(client => client[key]);
    return values.length === 0 || values.some(value => value === null) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0);
  };
  return { sample: { atEpochMs: readStartedAtEpochMs, phase: frame.phase,
    actualBytes: unknown.length === 0 ? sum('residentBytes') : null, allocatedBytes: sum('allocatedBytes'), reservedBytes: null,
    provider: 'linux-drm-fdinfo', scope: [...clients.keys()].join(','), evidence: raw.length === 0 ? null : 'gpu-fdinfo.json', unknown }, raw,
    readStartedAtEpochMs, readEndedAtEpochMs: Date.now() };
}

export type GpuReading = Awaited<ReturnType<typeof readLinuxGpuMemory>>;
export interface SerialGpuReader {
  readonly readings: GpuReading[];
  readonly failures: string[];
  /** Hands one CPU frame over without waiting for its GPU read; starts no second read while one is in flight. */
  readonly observe: (frame: RawFrame) => Promise<void>;
  /** Accepts no further frame and waits for the read in flight. */
  readonly stop: () => Promise<void>;
  readonly pending: () => number;
}

/**
 * Linux GPU reads on their own serial chain, outside the 100ms CPU sample loop. linuxSampler adds the
 * awaited observe time to the next frame interval: in run 42358862597 the awaited fdinfo read was 65-83%
 * of the time of the CPU sample gaps over 2x100ms in all six Linux cases. One read at a time; a frame that
 * arrives during a read starts no duplicate. A read whose start and end fall in different phases keeps
 * actualBytes null, an unknown value is never 0, and a failed read is kept as a failure.
 */
export function serialGpuReader(read: (frame: ProcessMemoryFrame) => Promise<GpuReading>,
  phaseAt: (atEpochMs: number) => MemoryPhase): SerialGpuReader {
  const readings: GpuReading[] = [], failures: string[] = [];
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  const readOne = async (frame: RawFrame): Promise<void> => {
    try {
      const reading = await read({ ...frame, phase: phaseAt(Date.now()) });
      const phase = phaseAt(reading.readStartedAtEpochMs);
      const crossed = phase !== phaseAt(reading.readEndedAtEpochMs);
      readings.push({ ...reading, sample: { ...reading.sample, phase,
        actualBytes: crossed ? null : reading.sample.actualBytes,
        unknown: [...reading.sample.unknown, ...(crossed ? ['GPU read crossed a phase boundary'] : [])] } });
    } catch (error: unknown) { failures.push(`GPU read failed: ${String(error)}`); }
  };
  return {
    readings, failures,
    observe: frame => {
      if (stopped || inFlight !== null) return Promise.resolve();
      // The then callback runs after this assignment, even when read rejects synchronously.
      inFlight = readOne(frame).then(() => { inFlight = null; });
      return Promise.resolve();
    },
    stop: async () => { stopped = true; if (inFlight !== null) await inFlight; },
    pending: () => (inFlight === null ? 0 : 1),
  };
}

function phaseFor(atEpochMs: number, boundaries: readonly PhaseBoundary[]): MemoryPhase {
  return [...boundaries].reverse().find(boundary => boundary.atEpochMs <= atEpochMs)?.phase ?? 'baseline';
}

/** assembly.spec.tsの実UI矛盾合致と同じ入力。モデル注入で失敗を作らない。 */
async function addOriginMate(page: Page, kind: '一致' | '距離', expected: 'success' | 'failed'): Promise<void> {
  await chooseToolMenuItem(page, '合わせる', kind);
  const dialog = page.getByRole('dialog', { name: '合致を作る' });
  await expect(dialog).toBeVisible();
  const rows = page.locator('.pcad-tree__sections > li').filter({
    has: page.locator('.pcad-tree__section .pcad-tree__label', { hasText: '部品' }) })
    .locator(':scope > .pcad-tree__children > li > .pcad-tree__row .pcad-tree__select');
  for (const index of [0, 1]) {
    await rows.nth(index).click();
    await dialog.getByRole('button', { name: '選択部品の原点', exact: true }).click();
  }
  if (kind === '距離') await dialog.locator('input.pcad-field__input').fill('10');
  const token = await beginRecompute(page);
  await dialog.getByRole('button', { name: '合致を作る', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await waitForRecomputeOutcome(page, token, expected);
}

/** Actual PrimitiveSection fields are accessible textboxes outside property-list. */
export function memorySolidDimensionField(page: Page) {
  return page.locator('.pcad-panel--right').getByRole('textbox', { name: 'X の長さ', exact: true });
}

/** AppShell exposes the active kind; StatusBar and the window title expose the
 * content-based unsaved flag. Callers also compare UI values with saved bytes. */
async function expectMemoryDocumentState(page: Page, kind: 'solid' | 'assembly', unsaved: boolean): Promise<void> {
  await expect(page.locator('.pcad-shell')).toHaveAttribute('data-document-kind', kind === 'solid' ? 'part' : 'assembly');
  const file = page.locator('.pcad-statusbar__file');
  await expect(file).toBeVisible();
  if (unsaved) {
    await expect(file).toContainText('*');
    await expect(page).toHaveTitle(/\*/u);
  } else {
    await expect(file).not.toContainText('*');
    await expect(page).not.toHaveTitle(/\*/u);
  }
}

/** newPart delegates active assemblies to newAssembly. FeatureTree renders only
 * its empty message when rowCount/folders are zero; AssemblyTree keeps sections.
 * Empty tree text alone does not prove geometry release. */
export async function expectMemoryEmptyDocument(page: Page, kind: 'solid' | 'assembly'): Promise<void> {
  await expectMemoryDocumentState(page, kind, false);
  const tree = page.locator('.pcad-panel--left');
  await expect(tree.locator('.pcad-tree__select')).toHaveCount(0);
  if (kind === 'assembly') {
    for (const label of ['部品', '合致', 'ジョイント', '分解ステップ'])
      await expect(tree.getByRole('button', { name: `${label} 0`, exact: true })).toBeVisible();
    const stats = await readAssemblyStats(page);
    expect(stats.components).toEqual([]); expect(stats.mateIds).toEqual([]);
    expect(stats.jointIds).toEqual([]); expect(stats.stepIds).toEqual([]);
  } else {
    await expect(tree.locator('.pcad-panel__empty-text')).toHaveText('まだ何もありません。');
    await expect(tree.locator('.pcad-tree__sections')).toHaveCount(0);
  }
  await expect.poll(() => page.evaluate(() => window.pcadViewportFramedBodies?.() ?? null)).toEqual([]);
}

async function discardToNewDocument(page: Page, kind: 'solid' | 'assembly', unsaved: boolean): Promise<void> {
  await expectMemoryDocumentState(page, kind, unsaved);
  const confirm = page.getByRole('alertdialog', { name: '保存していない変更があります' });
  await expect(confirm).toHaveCount(0);
  await page.getByRole('group', { name: 'ファイル' }).getByRole('button', { name: '新規', exact: true }).click();
  if (unsaved) {
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: '保存せずに続ける', exact: true }).click();
  }
  await expect(confirm).toHaveCount(0);
  await expectMemoryEmptyDocument(page, kind);
}

async function documentedUsageForCase(info: TestInfo, frames: readonly ProcessMemoryFrame[],
  boundaries: readonly PhaseBoundary[], endedAtEpochMs: number) {
  if (process.env['PCAD_GPU_DOCUMENTED_USAGE'] === undefined) return null;
  const problems: string[] = [];
  let qualification: ReturnType<typeof qualifyDocumentedGpuUsage> | null = null;
  let rawSha256: string | null = null;
  try {
    if (process.env['PCAD_GPU_DOCUMENTED_USAGE'] !== '1') throw new Error('Explicit documented usage mode required');
    const nonce = process.env['PCAD_GPU_RUN_NONCE'];
    const runSha256 = process.env['PCAD_GPU_USAGE_RUN_SHA256'];
    const sourceSha256 = process.env['PCAD_GPU_USAGE_SOURCE_SHA256'];
    const censusName = process.env['PCAD_GPU_USAGE_CENSUS'];
    const windowsName = process.env['PCAD_GPU_USAGE_WINDOWS'];
    const censusPin = process.env['PCAD_GPU_USAGE_CENSUS_SHA256'];
    if (nonce === undefined || runSha256 === undefined || sourceSha256 === undefined
        || censusName === undefined || windowsName === undefined || censusPin === undefined) {
      throw new Error('Root-owned same-run documented usage inputs unavailable');
    }
    const inspectionRoot = await realpath(resolve('scratchpad/claude/inspections'));
    const censusPath = await realpath(censusName), windowsPath = await realpath(windowsName);
    for (const path of [censusPath, windowsPath]) {
      const local = relative(inspectionRoot, path);
      if (isAbsolute(local) || local === '..' || local.startsWith('../') || local.startsWith('..\\')) {
        throw new Error('Documented evidence escaped Root inspections');
      }
    }
    if (dirname(censusPath) !== dirname(windowsPath)) throw new Error('Different census/query run directories');
    if ((await stat(censusPath)).size > 4 * 1024 * 1024 || (await stat(windowsPath)).size > 128 * 1024 * 1024) {
      throw new Error('Finite documented evidence byte bound exceeded');
    }
    const censusRaw = await readFile(censusPath);
    if (createHash('sha256').update(censusRaw).digest('hex') !== censusPin) throw new Error('Starting census bytes changed');
    const censusValue: unknown = JSON.parse(censusRaw.toString('utf8'));
    const census = parseUsageCensus(censusValue);
    const raw = await readFile(windowsPath);
    if (raw.byteLength > 128 * 1024 * 1024) throw new Error('Actual usage journal exceeds byte bound');
    rawSha256 = createHash('sha256').update(raw).digest('hex');
    // Preserve the exact concurrent read, including a possible in-progress final
    // append. Only complete newline-terminated records are eligible for sampling.
    await writeFile(info.outputPath('documented-usage-read.bin'), raw, { flag: 'wx' });
    await writeFile(info.outputPath('documented-census.json'), censusRaw, { flag: 'wx' });
    const text = raw.toString('utf8');
    const complete = text.slice(0, text.lastIndexOf('\n') + 1);
    const windows = complete.split('\n').filter(line => line.length > 0).map(line => {
      const value: unknown = JSON.parse(line); return parseUsageWindow(value);
    });
    qualification = qualifyDocumentedGpuUsage({ nonce, runSha256, sourceSha256, census, windows,
      boundaries, endedAtEpochMs });
    const observed = new Set(windows.filter(window => window.startedAtEpochMs >= (boundaries[0]?.atEpochMs ?? Infinity)
      && window.endedAtEpochMs <= endedAtEpochMs).flatMap(window => window.rows.filter(row => row.valid)
      .map(row => `${row.pid}:${row.birth}`)));
    // Win32 sampler identities are .NET UTC ticks; native retained handles use
    // FILETIME. Preserve 100ns identity precision using BigInt, never JSON Number.
    const missing = new Set<string>();
    for (const frame of frames) for (const process of frame.processes) {
      if (!/^[0-9]+$/u.test(process.created)) { missing.add(`invalid:${process.pid}`); continue; }
      const birth = BigInt(process.created) - 504911232000000000n;
      const key = `${process.pid}:${birth}`;
      if (birth <= 0n || !observed.has(key)) missing.add(key);
    }
    if (missing.size > 0) problems.push(`CPU-sampled PID/birth missing from native GPU queries: ${[...missing].join(',')}`);
  } catch (error: unknown) { problems.push(String(error)); }
  return { scope: 'this case sampled conservative bound; whole-run acceptance remains pending',
    qualification, problems, rawSha256, caseAcceptanceComplete: false,
    wholeRunAcceptanceComplete: false,
    pending: ['same-run terminal segment census and driver comparison', 'actual final build seal', 'all cases and three environments'] };
}

/** Read real UI operations and existing internal phase hooks in the same sampled run. */
export async function memoryHighwaterFlow(page: Page, info: TestInfo, kind: 'solid' | 'assembly', app?: ElectronApplication): Promise<void> {
  const flowStartedAtEpochMs = Date.now();
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);
  const includeRoot = app !== undefined;
  const rootPid = app?.process().pid ?? process.pid;
  if (rootPid === undefined) throw new Error('Memory root PID unavailable');
  const issuedNonce = process.env['PCAD_GPU_RUN_NONCE'];
  const runNonce = issuedNonce ?? randomUUID();
  const sourceAtStart = Object.fromEntries(await Promise.all(SOURCE_PATHS.map(async path =>
    [path, createHash('sha256').update(await readFile(new URL(`../../${path}`, import.meta.url))).digest('hex')])));
  // A locally generated nonce preserves CPU collection; it cannot qualify a Root-owned trace.
  const rootIssuedNonce = issuedNonce !== undefined && /^[a-zA-Z0-9_-]{16,128}$/u.test(issuedNonce);
  const boundaries: PhaseBoundary[] = [];
  // The 100ms CPU loop only hands each frame to the serial GPU reader; it never waits for the fdinfo read.
  const gpuReader = serialGpuReader(readLinuxGpuMemory, atEpochMs => phaseFor(atEpochMs, boundaries));
  const gpuReadings = gpuReader.readings;
  const sampler = platform() === 'win32' ? windowsSampler(rootPid, includeRoot) :
    platform() === 'linux' ? linuxSampler(rootPid, includeRoot, gpuReader.observe) : null;
  if (sampler === null) throw new Error(`Unsupported process memory OS: ${platform()}`);
  const mark = (phase: MemoryPhase, observation: string): void => { boundaries.push({ atEpochMs: Date.now(), phase, observation }); };
  const displaySnapshots: { atEpochMs: number; phase: MemoryPhase; hostAttributeReserved: unknown;
    driverAllocatedBytes: null; driverActualBytes: null }[] = [];
  const actualPhases = actualPhaseCollector(page, runNonce);
  const observeDisplay = async (): Promise<void> => {
    await actualPhases.collect();
    const value = await page.evaluate(() => window.pcadViewportMemoryStats?.() ?? null);
    const atEpochMs = Date.now();
    displaySnapshots.push({ atEpochMs, phase: phaseFor(atEpochMs, boundaries), hostAttributeReserved: value,
      driverAllocatedBytes: null, driverActualBytes: null });
  };
  const waitSamples = async (): Promise<void> => {
    const boundary = boundaries.at(-1)?.atEpochMs ?? 0;
    await expect.poll(() => sampler.frames.filter(frame => frame.atEpochMs >= boundary).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(5);
  };
  const inputPath = info.outputPath(kind === 'solid' ? 'solid.pcad' : 'assembly.pcada');
  const fixture = kind === 'solid' ? boxPartFile('高水位の箱') : await twoBoxAssemblyFile();
  await writeFile(inputPath, fixture);
  let updates = 0;
  let failureRecovered = false;
  let geometryCancellation: Awaited<ReturnType<typeof cancelGeometry>> | null = null;
  let geometryRelease: unknown = null;
  let scenarioError: string | null = null;
  try {
    await actualPhases.begin();
    mark('baseline', 'before real file open'); await waitSamples(); await observeDisplay();
    mark('transfer', 'UI file open requested; internal transfer unobserved');
    await openSaveFlowFile(page, inputPath, app);
    await expectMemoryDocumentState(page, kind, false);
    mark('publish', 'recompute settled after open; internal publication unobserved'); await waitSamples(); await observeDisplay();
    if (kind === 'solid') {
      const saved = readPcadFile(await readFile(inputPath));
      if (!saved.ok) throw new Error(saved.error.message);
      expect(saved.document.solids).toHaveLength(1);
      const box = saved.document.solids[0];
      if (box?.kind !== 'primitive' || box.shape.kind !== 'box') throw new Error('Saved highwater box unavailable');
      expect([box.shape.sizeX.value, box.shape.sizeY.value, box.shape.sizeZ.value]).toEqual([20, 20, 20]);
      const selected = page.locator('.pcad-tree__select').filter({ hasText: /^箱1$/u });
      await expect(selected).toHaveCount(1);
      await selected.click(); await expect(selected).toHaveAttribute('aria-pressed', 'true');
      const field = memorySolidDimensionField(page);
      await expect(field).toBeVisible();
      await expect(field).toHaveValue(String(box.shape.sizeX.value));
      for (let index = 0; index < 100; index++) {
        const token = await beginRecompute(page); mark('build', `solid update ${index + 1} requested`);
        await field.fill(String(index % 2 === 0 ? 21 : 20)); await field.press('Tab');
        await waitForRecompute(page, token); updates++;
        await expect(field).toHaveValue(String(index % 2 === 0 ? 21 : 20));
        await expect.poll(async () => Number.parseFloat(await page.locator('.pcad-panel--right dt.pcad-properties__key')
          .filter({ hasText: /^体積$/u }).locator('xpath=following-sibling::dd[1]').innerText())).toBe((index % 2 === 0 ? 21 : 20) * 400);
        mark('publish', `solid update ${updates} settled`);
        await observeDisplay();
        await readViewportRenderStats(page);
      }
      // All 100 edits return to the saved 20mm box. Prove clean UI BEFORE a real
      // save, then compare the entire saved document independently of that flag.
      await expectMemoryDocumentState(page, 'solid', false);
      const returned = readPcadFile(await saveFlowFile(page, info.outputPath('solid-returned.pcad'), app));
      if (!returned.ok) throw new Error(returned.error.message);
      expect(returned.document).toEqual(saved.document);
    } else {
      const saved = await readDocumentBundle(await readFile(inputPath), 'assembly');
      if (!saved.ok) throw new Error(saved.error.message);
      if (saved.bundle.kind !== 'assembly') throw new Error('Saved highwater assembly unavailable');
      expect(saved.bundle.document.components).toHaveLength(2);
      const rows = page.locator('.pcad-tree__sections > li').filter({
        has: page.locator('.pcad-tree__section .pcad-tree__label', { hasText: '部品' }) })
        .locator(':scope > .pcad-tree__children > li > .pcad-tree__row');
      await rows.nth(1).locator('.pcad-tree__more').click();
      const token = await beginRecompute(page);
      mark('build', 'remove component');
      await page.locator('.pcad-tree__menu').getByRole('menuitem', { name: '削除する', exact: true }).click();
      await waitForRecompute(page, token);
      for (let index = 0; index < 100; index++) {
        const undo = index % 2 === 0;
        const token = await beginRecompute(page); mark('build', `assembly update ${index + 1} requested`);
        await page.getByRole('button', { name: undo ? '元に戻す' : 'やり直す', exact: true }).click();
        await waitForRecompute(page, token); updates++;
        mark('publish', `assembly update ${updates} settled`);
        await rows.first().locator('.pcad-tree__select').click();
        await expect(rows.first().locator('.pcad-tree__select')).toHaveAttribute('aria-pressed', 'true');
        await observeDisplay();
        expect((await readAssemblyStats(page)).components).toHaveLength(undo ? 2 : 1);
      }
      expect((await readAssemblyStats(page)).components.map(component => component.id))
        .toEqual(saved.bundle.document.components.slice(0, 1).map(component => component.id));
    }
    mark('released', 'discard updated document through real confirmation'); await discardToNewDocument(page, kind, kind === 'assembly'); await waitSamples(); await observeDisplay();
    const failureInput = info.outputPath('conflicting-assembly.pcada');
    await writeFile(failureInput, await twoBoxAssemblyFile(40));
    mark('transfer', 'real assembly input for failure recovery'); await openSaveFlowFile(page, failureInput, app);
    await observeDisplay();
    mark('build', 'origin coincidence'); await addOriginMate(page, '一致', 'success'); await observeDisplay();
    mark('build', 'contradictory 10mm origin distance must fail'); await addOriginMate(page, '距離', 'failed'); await observeDisplay();
    expect((await readAssemblyStats(page)).diagnosis?.converged).toBe(false);
    const recovery = await beginRecompute(page); mark('build', 'undo conflicting mate and retry');
    await page.getByRole('button', { name: '元に戻す', exact: true }).click();
    await waitForRecompute(page, recovery);
    failureRecovered = true; mark('publish', 'failure recovery settled'); await observeDisplay();
    const savedRecovery = await readDocumentBundle(await readFile(failureInput), 'assembly');
    if (!savedRecovery.ok) throw new Error(savedRecovery.error.message);
    if (savedRecovery.bundle.kind !== 'assembly') throw new Error('Saved recovery assembly unavailable');
    expect(savedRecovery.bundle.document.mates).toEqual([]);
    expect((await readAssemblyStats(page)).mateIds).toHaveLength(1);
    mark('released', 'discard recovered assembly before save cancellation scenario'); await discardToNewDocument(page, 'assembly', true); await waitSamples(); await observeDisplay();
    mark('cancel', 'cancel actual 100-feature geometry through its visible progress button');
    geometryCancellation = await cancelGeometry(page, info, app); await observeDisplay();
    // Opening the cancellation .pcad replaces the empty assembly with a part.
    await expectMemoryDocumentState(page, 'solid', false);
    const savedGeometry = readPcadFile(await readFile(geometryCancellation.inputPath));
    if (!savedGeometry.ok) throw new Error(savedGeometry.error.message);
    expect(savedGeometry.document.solids).toHaveLength(100);
    const savedFirst = savedGeometry.document.solids[0];
    if (savedFirst?.kind !== 'primitive' || savedFirst.shape.kind !== 'box') throw new Error('Saved cancellation box unavailable');
    expect(savedFirst.shape.sizeX.value).toBe(20);
    const retryBox = page.locator('.pcad-tree__select').filter({ hasText: /^箱1$/u });
    await expect(retryBox).toHaveCount(1);
    await retryBox.click(); await expect(retryBox).toHaveAttribute('aria-pressed', 'true');
    const retryField = memorySolidDimensionField(page);
    await expect(retryField).toHaveValue(String(savedFirst.shape.sizeX.value));
    const retry = await beginRecompute(page); mark('build', 'retry cancelled geometry by real property edit');
    await retryField.fill('21'); await retryField.press('Tab'); await waitForRecompute(page, retry);
    await expect(retryField).toHaveValue('21');
    mark('publish', 'geometry retry published'); await observeDisplay();
    mark('released', 'discard retried geometry'); await discardToNewDocument(page, 'solid', true); await waitSamples(); await observeDisplay();
    geometryRelease = await page.evaluate(() => {
      const read: unknown = Reflect.get(window, 'pcadViewportRetiredCleanups');
      const retired: unknown = typeof read === 'function' ? read() : null;
      return { atEpochMs: Date.now(), retired, memory: window.pcadViewportMemoryStats?.() ?? null };
    });
    expect(gpuEvidenceRecord(geometryRelease) && gpuEvidenceRecord(geometryRelease['retired'])
      && geometryRelease['retired']['pendingCount'] === 0 && geometryRelease['retired']['ownerCount'] === 0
      && geometryRelease['retired']['waitingCount'] === 0 && geometryRelease['retired']['sharedGpuPoolReservedBytes'] === 0
      && gpuEvidenceRecord(geometryRelease['memory']) && geometryRelease['memory']['displayCopyBytes'] === 0
      && geometryRelease['memory']['gpuMeshBytes'] === 0, 'Discarded geometry host references/reservations must be released').toBe(true);
    // 既存の実取消・再試行/文書切替台本を同じ全PID観測区間に通す。
    mark('cancel', 'real save worker cancellation and retry'); await saveCancelFlow(page, info, app); await observeDisplay();
    mark('transfer', 'real document switch cancels old worker'); await saveDocumentSwitchFlow(page, info, app);
    mark('released', 'document switched and previous worker closed'); await waitSamples(); await observeDisplay();
  } catch (error: unknown) { scenarioError = String(error); }
  finally {
    try { await actualPhases.end(); }
    catch (error: unknown) { actualPhases.problems.push(`Phase capture cleanup failed: ${String(error)}`); }
    await sampler.stop();
    // Keep GPU read failures as diagnostics; they do not change CPU sampler evidence.
    // No GPU read outlives collection.
    await gpuReader.stop();
  }
  const frames = sampler.frames.map(frame => ({ ...frame, phase: phaseFor(frame.atEpochMs, boundaries) }));
  const summary = summarizeProcessMemory(frames, { intervalMs: INTERVAL_MS, discoveryIntervalMs: DISCOVERY_INTERVAL_MS,
    requiredPhases: ['baseline', 'transfer', 'build', 'publish', 'cancel', 'released'] });
  const phaseCoverage = actualPhaseCoverage(actualPhases.events, frames);
  const sampledObservation = summarizeSampledProcessMemory(frames, { intervalMs: INTERVAL_MS, discoveryIntervalMs: DISCOVERY_INTERVAL_MS,
    requiredPhases: ['baseline', 'build', 'released'], rootPid, includeRoot, scope: 'stress-observation',
    windows: [
      { phase: 'baseline', startedAtEpochMs: Math.min(frames[0]?.readStartedAtEpochMs ?? NaN, boundaries[0]?.atEpochMs ?? NaN),
        endedAtEpochMs: boundaries[0]?.atEpochMs ?? NaN },
      ...boundaries.flatMap((boundary, index) => boundary.phase === 'baseline' || boundary.phase === 'released' ? [{ phase: boundary.phase,
        startedAtEpochMs: boundary.atEpochMs, endedAtEpochMs: boundaries[index + 1]?.atEpochMs ?? frames.at(-1)?.atEpochMs ?? NaN }] : []),
      ...phaseCoverage.flatMap(coverage => coverage.intervals.map(interval => ({ phase: coverage.phase,
        startedAtEpochMs: interval.startedAtEpochMs, endedAtEpochMs: interval.endedAtEpochMs }))),
    ] });
  const cancellationEvidence = geometryCancellation === null ? undefined : {
    pressedAtEpochMs: geometryCancellation.pressed.atEpochMs,
    requestedGeneration: geometryCancellation.terminal.requestedGeneration, events: actualPhases.events,
  };
  // Short native interval containment stays diagnostic; actual build observation
  // is required by sampledObservation. Other provider errors remain mandatory.
  const operationEnvelopesComplete = scenarioError === null && actualPhases.problems.length === 0 && geometryCancellation !== null
    && geometryRelease !== null && phaseCoverage.every(phase => phase.intervals.length > 0);
  let gpu: GpuMemorySample[] = gpuReadings.length > 0 ? gpuReadings.map(reading => reading.sample) : [{
    atEpochMs: Date.now(), phase: 'released', actualBytes: null, allocatedBytes: null, reservedBytes: null,
    provider: 'unknown', scope: '', evidence: null, unknown: ['Windows GPU resident actual requires DxgKrnl ETW provider; not acquired'] }];
  const sourceSha = Object.fromEntries(await Promise.all(SOURCE_PATHS.map(async path =>
    [path, createHash('sha256').update(await readFile(new URL(`../../${path}`, import.meta.url))).digest('hex')])));
  const renderer = await page.locator('canvas.pcad-viewport__canvas').evaluate((canvas: HTMLCanvasElement) => {
    const gl = canvas.getContext('webgl2'); if (gl === null) return null;
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(extension === null ? gl.RENDERER : extension.UNMASKED_RENDERER_WEBGL));
  });
  const sourceStable = Object.entries(sourceAtStart).every(([path, digest]) => sourceSha[path] === digest);
  const acceptanceComplete = sampledMemoryCaseAcceptance({ observation: sampledObservation, budgetBytes: BUDGET_BYTES, scenarioError,
    updates, failureRecovered, samplerFailures: sampler.failures, operationEnvelopesComplete, sourceStable, cancellationEvidence });
  const record = { kind, updates, failureRecovered, inputBytes: fixture.byteLength, inputSha: createHash('sha256').update(fixture).digest('hex'), sourceSha,
    environment: { node: process.version, os: platform(), release: release(), hostname: hostname(), renderer,
      priorityRequested: process.env['PCAD_DIAG_NORMAL_PRIORITY'] ?? null, rootPid, includeRoot,
      rootScope: includeRoot ? 'Electron main and descendants' : 'Playwright worker descendants; worker fixture heap excluded' },
    method: platform() === 'win32' ? 'Win32_Process tree / CreationDate / Get-Process WorkingSet64 PrivateMemorySize64' :
      '/proc/stat identity and parent tree / status VmRSS RssAnon (RssAnon is not Windows PrivateBytes)',
    intervalMs: INTERVAL_MS, discoveryIntervalMs: platform() === 'win32' ? DISCOVERY_INTERVAL_MS : INTERVAL_MS,
    limitations: ['Sampled highwater is a lower bound between samples; short-lived processes between discovery may be missed',
      'Working-set sum can count shared pages more than once; native/WASM/JS/IPC are contained, not added again',
      'Actual hook envelopes are recorded separately from UI phases; native subcalls/exact serialization/driver upload are not inferred',
      'Scene gpuMeshBytes is host BufferAttribute reservation, not driver allocated or actual',
      'Save cancellation does not substitute for an observed geometry cancellation; unsampled actual intervals remain unknown'],
    budgetDiagnostic: { limitBytes: BUDGET_BYTES, requiredForAcceptance: false,
      withinLimit: sampledObservation.observationValid && [sampledObservation.workingSet, sampledObservation.privateMemory]
        .every(metric => metric.extraPeak !== null && metric.extraAfterRelease !== null
          && metric.extraPeak < BUDGET_BYTES && metric.extraAfterRelease < BUDGET_BYTES) },
    boundaries, frames, summary, sampledObservation, gpu, displaySnapshots, geometryCancellation, geometryRelease,
    actualPhases: { snapshots: actualPhases.snapshots, events: actualPhases.events,
      problems: actualPhases.problems, phaseCoverage,
        cancellationEvidence: cancellationEvidence === undefined ? null : { pressedAtEpochMs: cancellationEvidence.pressedAtEpochMs,
          requestedGeneration: cancellationEvidence.requestedGeneration, verification: 'exact dispatch reply and known-empty viewport checked by sampledMemoryCaseAcceptance' },
        operationEnvelopesComplete }, samplerFailures: sampler.failures, scenarioError,
    budgetBytes: BUDGET_BYTES, acceptanceComplete, sourceStable,
    acceptanceScope: {
      case: 'stress-observation: before/during actual build/final release, 100 updates, failure recovery, exact cancellation and stable sources',
      memoryBudget: '512MiB comparison is diagnostic for this stress workload; R06 save/restore budget is unchanged',
      shortIntervals: 'Native transfer/publish/cancel containment is diagnostic; unobserved intervals remain unknown',
      r06: 'Save-specific responsiveness/content/detach conditions are covered by saveResponsivenessFlow separately',
      r07: 'Ownership/100-lifetime acceptance belongs to the existing lifecycle suites; this case does not measure it',
      physicalGpu: 'Diagnostic only; unknown bytes remain unknown and are not certified by this case',
    }, gpuSamplerFailures: [...gpuReader.failures] };
  const workload = { schema: 'pcad-memory-workload-v1', runNonce, rootIssuedNonce, kind, rootPid,
    rootCreated: frames[0]?.rootCreated ?? null, includeRoot, sourceSha: sourceAtStart,
    phaseSha256: createHash('sha256').update(JSON.stringify(boundaries)).digest('hex'), boundaries, frames,
    intervalMs: INTERVAL_MS, discoveryIntervalMs: platform() === 'win32' ? DISCOVERY_INTERVAL_MS : INTERVAL_MS,
    budgetBytes: BUDGET_BYTES, acceptanceComplete: false,
    stage: 'collected-unqualified', cpuSummary: summary, samplerFailures: sampler.failures, scenarioError, updates, failureRecovered,
    sourceStable };
  // Preserve structural workload evidence before this case's CPU/functional/phase/source assertions.
  const workloadPath = info.outputPath('gpu-workload.json');
  const workloadBytes = JSON.stringify(workload, null, 2);
  await writeFile(workloadPath, workloadBytes, { flag: 'wx' });
  // The original RUN is still running. Only Root stops its trace; this Flow
  // optionally records that evidence as diagnostics, without claiming physical GPU acceptance.
  const documentedUsage = await documentedUsageForCase(info, frames, boundaries, Date.now());
  // Optional historical GPU diagnostic: sampled CPU increment plus a documented GPU bound.
  // It is not a physical/continuous bound and no longer determines this CPU/UI case's result.
  const combinedBound = documentedUsage === null ? null
    : combinedSampledMemoryBound(summary, documentedUsage.qualification?.peakUpperBoundBytes ?? null, BUDGET_BYTES);
  if (documentedUsage !== null) {
    documentedUsage.caseAcceptanceComplete = documentedUsage.problems.length === 0
      && documentedUsage.qualification?.within512MiB === true && combinedBound?.withinLimit === true && scenarioError === null
      && updates === 100 && failureRecovered && sampler.failures.length === 0
      && summary.complete && processMemoryWithinBudget(summary, BUDGET_BYTES)
      && operationEnvelopesComplete && workload.sourceStable;
  }
  const postTrace = documentedUsage === null && platform() === 'win32' ? await coordinateSameRunGpu(page, info, workloadPath,
    createHash('sha256').update(workloadBytes).digest('hex'), workload, flowStartedAtEpochMs) : null;
  if (postTrace !== null) {
    gpu = postTrace.gpu.length > 0 ? [...postTrace.gpu] : [{ atEpochMs: Date.now(), phase: 'released',
      actualBytes: null, allocatedBytes: null, reservedBytes: null, provider: 'unknown',
      scope: '', evidence: null, unknown: [...postTrace.problems] }];
    record.gpu = gpu;
  }
  const serialized = JSON.stringify({ ...record, postTrace, documentedUsage, combinedBound }, null, 2);
  await writeFile(info.outputPath('memory-highwater.json'), serialized);
  await writeFile(info.outputPath('gpu-fdinfo.json'), JSON.stringify(gpuReadings, null, 2));
  await info.attach('memory-highwater', { body: serialized, contentType: 'application/json' });
  expect(scenarioError, '実UI台本のエラー').toBeNull();
  expect(updates).toBe(100);
  expect(failureRecovered).toBe(true);
  expect(sampler.failures).toEqual([]);
  expect(sampledObservation.observationValid, sampledObservation.problems.join('\n')).toBe(true);
  for (const metric of [sampledObservation.workingSet, sampledObservation.privateMemory]) {
    expect(metric.extraPeak).not.toBeNull(); expect(metric.extraAfterRelease).not.toBeNull();
  }
  // GPU diagnostics retain raw null/unknown/failures; no physical-GPU assertion
  // belongs to this CPU/UI case under Root's original R06/R07 scope decision.
  expect(operationEnvelopesComplete, [...actualPhases.problems,
    ...phaseCoverage.filter(phase => phase.intervals.length === 0).map(phase => `Actual ${phase.phase} interval unavailable`)].join('\n')).toBe(true);
  expect(sourceStable, 'Case source hashes changed during observation').toBe(true);
  expect(record.acceptanceComplete, 'This case CPU/UI/runtime-phase/source conditions; separate R07 ownership suite').toBe(true);
}

export async function prepareMemoryHighwaterBrowser(page: Page): Promise<void> {
  await page.addInitScript(() => {
    for (const key of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, key, { configurable: true, value: undefined });
    }
  });
  await page.goto('/');
}

/** Root calls only after its owned stop and independent resident/TDH review.
 * This does not turn the deliberately incomplete collection E2E into PASS. */
export async function consumeMemoryHighwaterPostTrace(input: {
  readonly workloadPath: string; readonly workloadSha256: string;
  readonly bundlePath: string; readonly bundleSha256: string;
  readonly runNonce: string; readonly outputPath: string; readonly signal?: AbortSignal;
}): Promise<ReturnType<typeof consumeGpuPostTrace>> {
  const unknown = (reason: string): ReturnType<typeof consumeGpuPostTrace> => ({ status: 'unknown', gpu: [],
    problems: [reason], cpuWithinBudget: false, verificationScope: 'post-trace-structure-only',
    canOverrideOriginalRun: false, acceptanceComplete: false });
  let result: ReturnType<typeof consumeGpuPostTrace>;
  try {
    if (!gpuEvidenceSha256(input.workloadSha256) || !gpuEvidenceSha256(input.bundleSha256)) throw new Error('Root final digests missing');
    const workloadBytes = await readGpuMetadata(dirname(input.workloadPath), input.workloadPath, input.signal), bundleBytes = await readGpuMetadata(dirname(input.bundlePath), input.bundlePath, input.signal);
    if (createHash('sha256').update(workloadBytes).digest('hex') !== input.workloadSha256 ||
      createHash('sha256').update(bundleBytes).digest('hex') !== input.bundleSha256) throw new Error('Post-trace immutable input digest differs');
    const workload: unknown = JSON.parse(workloadBytes.toString('utf8'));
    const bundle: unknown = JSON.parse(bundleBytes.toString('utf8'));
    if (!memoryWorkloadCapture(workload) || !gpuEvidenceRecord(bundle) || !Array.isArray(bundle['artifacts'])) {
      throw new Error('Post-trace workload or artifact schema invalid');
    }
    const phaseSha256 = createHash('sha256').update(JSON.stringify(workload.boundaries)).digest('hex');
    if (phaseSha256 !== workload.phaseSha256) throw new Error('Full phase digest differs');
    for (const path of SOURCE_PATHS) {
      const digest = createHash('sha256').update(await readFile(new URL(`../../${path}`, import.meta.url), { signal: input.signal })).digest('hex');
      if (workload.sourceSha[path] !== digest) throw new Error(`Post-trace source changed: ${path}`);
    }
    const verifiedArtifactRoles: string[] = [];
    const seenRoles = new Set<string>();
    for (const artifact of bundle['artifacts']) {
      if (!gpuEvidenceRecord(artifact) || typeof artifact['path'] !== 'string' || !gpuEvidenceSha256(artifact['sha256']) ||
        (artifact['role'] !== 'trace' && artifact['role'] !== 'decoded' && artifact['role'] !== 'schema' && artifact['role'] !== 'decoder')) {
        throw new Error('Post-trace raw artifact receipt invalid');
      }
      const path = resolve(dirname(input.bundlePath), artifact['path']);
      const within = relative(resolve(dirname(input.bundlePath)), path);
      if (isAbsolute(artifact['path']) || isAbsolute(within) || within === '..' || within.startsWith('../') || within.startsWith('..\\')) {
        throw new Error('Post-trace raw artifact outside bundle');
      }
      if ((await readGpuEvidence(dirname(input.bundlePath), path, input.signal, false)).sha256 !== artifact['sha256']) throw new Error('Post-trace raw artifact bytes differ');
      if (seenRoles.has(artifact['role'])) throw new Error('Post-trace role has multiple ambiguous raw files');
      seenRoles.add(artifact['role']);
      const key = `${artifact['role']}:${artifact['sha256']}`;
      if (verifiedArtifactRoles.includes(key)) throw new Error('Post-trace raw artifact duplicate');
      verifiedArtifactRoles.push(key);
    }
    if (seenRoles.size !== 4) throw new Error('Post-trace mandatory raw roles missing');
    result = consumeGpuPostTrace(workload, bundle, { runNonce: input.runNonce, workloadSha256: input.workloadSha256,
      bundleSha256: input.bundleSha256, phaseSha256, verifiedArtifactRoles });
  } catch (error: unknown) { result = unknown(`Post-trace read/qualification failed: ${String(error)}`); }
  // Exclusive final output preserves every old failure and allows no overwritten PASS.
  await writeFile(input.outputPath, JSON.stringify({ schema: 'pcad-memory-posttrace-result-v1', input: { workloadPath: input.workloadPath, workloadSha256: input.workloadSha256,
    bundlePath: input.bundlePath, bundleSha256: input.bundleSha256, runNonce: input.runNonce, outputPath: input.outputPath },
    result, originalRunDisposition: 'not-reclassified-by-consumer', evaluatedAt: new Date().toISOString(), limitations: ['Structural bindings are not independent OS provenance',
      'Continuous GPU highwater/internal phase completion and three cold environments remain separate unqualified gates'] }, null, 2), { flag: 'wx', signal: input.signal });
  return result;
}

async function coordinateSameRunGpu(page: Page, info: TestInfo, workloadPath: string, workloadSha256: string,
  workload: unknown, flowStartedAtEpochMs: number): Promise<ReturnType<typeof consumeGpuPostTrace>> {
  const unknown = (reason: string): ReturnType<typeof consumeGpuPostTrace> => ({ status: 'unknown', gpu: [], problems: [reason],
    cpuWithinBudget: false, verificationScope: 'post-trace-structure-only', canOverrideOriginalRun: false, acceptanceComplete: false });
  const deliveryPath = process.env['PCAD_GPU_POSTTRACE_DELIVERY'];
  const sessionName = process.env['PCAD_GPU_TRACE_SESSION_NAME'];
  const deadline = Number(process.env['PCAD_GPU_POSTTRACE_DEADLINE_EPOCH_MS']);
  const remaining = gpuPostTraceWaitBudget(Date.now(), flowStartedAtEpochMs, info.timeout, deadline);
  if (!memoryWorkloadCapture(workload) || deliveryPath === undefined || sessionName === undefined || sessionName.length === 0 || remaining === null) {
    return unknown('Same-RUN Root delivery/nonce/workload/finite original case deadline unavailable');
  }
  const root = resolve(dirname(deliveryPath));
  const ownedPath = (name: string): string => {
    const path = resolve(root, name), within = relative(root, path);
    if (isAbsolute(name) || isAbsolute(within) || within === '..' || within.startsWith('../') || within.startsWith('..\\')) {
      throw new Error('Same-RUN artifact outside Root-owned delivery directory');
    }
    return path;
  };
  const controller = new AbortController();
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof scheduleTimeout> | undefined;
  let settled = false;
  let checking = false;
  let dirty = false;
  let finish: ((result: ReturnType<typeof consumeGpuPostTrace>) => void) | undefined;
  const onPageClosed = (): void => { finish?.(unknown('Same-RUN page closed before qualified handoff')); };
  try {
    return await new Promise<ReturnType<typeof consumeGpuPostTrace>>(resolveResult => {
      finish = (result): void => { if (!settled) { settled = true; resolveResult(result); } };
      timer = scheduleTimeout(() => { finish?.(unknown('Same-RUN owned-stop handoff exceeded original case deadline')); }, remaining);
      const check = async (): Promise<void> => {
        if (settled) return;
        if (checking) { dirty = true; return; }
        checking = true;
        try {
          do {
            dirty = false;
            let bytes: Buffer;
            try { bytes = await readGpuMetadata(root, deliveryPath, controller.signal); }
            catch (error: unknown) {
              if (gpuEvidenceRecord(error) && error['code'] === 'ENOENT') continue;
              throw error;
            }
            if (settled) return;
            const value: unknown = JSON.parse(bytes.toString('utf8'));
            const delivery = gpuPostTraceDelivery(value, { runNonce: workload.runNonce, workloadSha256,
              phaseSha256: workload.phaseSha256, rootPid: workload.rootPid, rootCreated: workload.rootCreated, sessionName });
            if (delivery === null) throw new Error('Same-RUN delivery binding/stopped receipt invalid');
            const bundlePath = ownedPath(delivery.bundlePath), stopReceiptPath = ownedPath(delivery.stopReceiptPath);
            const stopBytes = await readGpuMetadata(root, stopReceiptPath, controller.signal);
            const bundleBytes = await readGpuMetadata(root, bundlePath, controller.signal);
            if (createHash('sha256').update(stopBytes).digest('hex') !== delivery.stopReceiptSha256 ||
              createHash('sha256').update(bundleBytes).digest('hex') !== delivery.bundleSha256) throw new Error('Same-RUN stop/bundle actual bytes changed');
            const stop: unknown = JSON.parse(stopBytes.toString('utf8')), bundle: unknown = JSON.parse(bundleBytes.toString('utf8'));
            const ownership = gpuEvidenceRecord(bundle) ? bundle['traceOwnership'] : undefined;
            if (!gpuEvidenceRecord(ownership) || ownership['sessionName'] !== sessionName || !gpuEvidenceSha256(ownership['traceSha256']) ||
              !gpuOwnedStopReceipt(stop, sessionName, ownership['traceSha256'])) throw new Error('Same-RUN actual owned stop/raw ETL receipt unqualified');
            const result = await consumeMemoryHighwaterPostTrace({ workloadPath, workloadSha256, bundlePath,
              bundleSha256: delivery.bundleSha256, runNonce: workload.runNonce,
              outputPath: info.outputPath('memory-posttrace-same-run.json'), signal: controller.signal });
            finish?.(result);
          } while (dirty && !settled);
        } catch (error: unknown) { finish?.(unknown(`Same-RUN handoff failed: ${String(error)}`)); }
        finally { checking = false; }
      };
      // Subscribe BEFORE initial read; delivery already published is read, events
      // while that read is active set dirty and force a second read. No polling delay.
      try {
        watcher = watch(root, { persistent: false }, () => { void check(); });
        watcher.on('error', error => { finish?.(unknown(`Same-RUN delivery watch failed: ${String(error)}`)); });
        page.once('close', onPageClosed);
        if (page.isClosed()) onPageClosed();
        else { void check(); }
      } catch (error: unknown) { finish?.(unknown(`Same-RUN delivery admission failed: ${String(error)}`)); }
    });
  } finally {
    settled = true;
    controller.abort();
    if (timer !== undefined) clearScheduledTimeout(timer);
    try { watcher?.close(); }
    finally { page.off('close', onPageClosed); }
  }
}

const GPU_METADATA_MAX_BYTES = 16 * 1024 * 1024;
async function boundGpuEvidence(root: string, path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const canonicalRoot = await realpath(root), lexical = resolve(path), actual = await realpath(path);
  const within = relative(canonicalRoot, actual);
  if (actual !== lexical || within === '' || isAbsolute(within) || within === '..' || within.startsWith('../') || within.startsWith('..\\')) {
    throw new Error('GPU raw symlink/realpath containment unavailable');
  }
  signal?.throwIfAborted();
  return actual;
}

/** Hash/read the same regular-file handle, bounded by its initial actual size.
 * Canonical path and file identity are checked again before accepting bytes.
 * No openat-style atomic directory proof is claimed for hostile path mutation. */
async function readGpuEvidence(root: string, path: string, signal: AbortSignal | undefined,
  retainBytes: boolean): Promise<{ readonly sha256: string; readonly bytes: Buffer | null }> {
  const actual = await boundGpuEvidence(root, path, signal);
  const handle = await open(actual, 'r');
  try {
    signal?.throwIfAborted();
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.dev < 0n || before.ino <= 0n || before.size < 0n ||
      (retainBytes && before.size > BigInt(GPU_METADATA_MAX_BYTES))) throw new Error('GPU evidence size/type exceeds bounded metadata contract');
    const hash = createHash('sha256'), chunks: Buffer[] = [];
    let offset = 0n;
    const chunk = Buffer.alloc(1024 * 1024);
    while (offset < before.size) {
      signal?.throwIfAborted();
      const remaining = before.size - offset;
      const count = remaining < BigInt(chunk.length) ? Number(remaining) : chunk.length;
      const read = await handle.read(chunk, 0, count, null);
      if (read.bytesRead === 0) throw new Error('GPU evidence truncated while reading');
      const bytes = chunk.subarray(0, read.bytesRead);
      hash.update(bytes);
      if (retainBytes) chunks.push(Buffer.from(bytes));
      offset += BigInt(read.bytesRead);
    }
    signal?.throwIfAborted();
    const after = await handle.stat({ bigint: true }), named = await stat(actual, { bigint: true });
    if (await boundGpuEvidence(root, path, signal) !== actual || !named.isFile() ||
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
      after.dev !== named.dev || after.ino !== named.ino || after.size !== named.size || after.mtimeNs !== named.mtimeNs || after.ctimeNs !== named.ctimeNs) {
      throw new Error('GPU evidence canonical path/handle identity changed');
    }
    return { sha256: hash.digest('hex'), bytes: retainBytes ? Buffer.concat(chunks, Number(offset)) : null };
  } finally { await handle.close(); }
}

async function readGpuMetadata(root: string, path: string, signal?: AbortSignal): Promise<Buffer> {
  const result = await readGpuEvidence(root, path, signal, true);
  if (result.bytes === null) throw new Error('GPU metadata bytes unavailable');
  return result.bytes;
}
