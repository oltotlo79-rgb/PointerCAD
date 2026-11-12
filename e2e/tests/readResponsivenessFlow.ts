/// <reference lib="dom" />
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { PerformanceObserver } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { getPriority } from 'node:os';
import type { Profiler } from 'node:inspector';
import { expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { readPcadFile } from '../../packages/io/src/index.js';
import { openTarget } from './electronAppFlow.js';
import { fileAction } from './fileCaptureSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { waitForStartupHealth } from './startupHealth.js';
import { addImage, canvasRow, expectImage, samplePng } from './canvasAssetLifetimeFlow.js';
import { largeSaveFixture, openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { orphanReadFixture } from './readResponseFixture.js';
import { assertReadWorkerClosed, nativeReadWorkers, observeRead, readObservationSnapshot, READ_OBSERVATION_COST, writeReadEvidence } from './readResponseObservation.js';
import { startReadResidentSampler } from './readResidentSampler.js';
import { readCommandTimeline, readInputMetrics } from './readResponseMetrics.js';

/** Costs belong to this Playwright Node worker; browser/parent CPU is not included. */
function readFlowCosts() {
  const contextEnabled = process.env.PCAD_READ_CONTEXT_DIAGNOSTIC === '1';
  const profileRequested = contextEnabled && process.env.PCAD_READ_CONTEXT_PROFILE === '1';
  const profileState: { connectedAt: number | null; startedAt: number | null; readerEndedAt: number | null; stoppedAt: number | null;
    path: string | null; failure: string | null; threadCpuFailure: string | null;
    currentThreadCpu: { before: NodeJS.CpuUsage; after: NodeJS.CpuUsage; startAt: number; endAt: number;
      userMs: number; systemMs: number } | null } = { connectedAt: null, startedAt: null, readerEndedAt: null,
    stoppedAt: null, path: null, failure: null, threadCpuFailure: null, currentThreadCpu: null };
  const gc: { start: number; duration: number }[] = [];
  const snapshots: { phase: string; point: string; at: number; memory: ReturnType<typeof process.memoryUsage>;
    heap: ReturnType<typeof getHeapStatistics> }[] = [];
  let observer: PerformanceObserver | null = null;
  let contextFailure: string | null = null;
  const snapshot = (phase: string, point: string) => {
    if (contextEnabled && (phase === 'prepare-large-fixture' || phase.endsWith('-read-pcad-node'))) {
      snapshots.push({ phase, point, at: performance.now(), memory: process.memoryUsage(), heap: getHeapStatistics() });
    }
  };
  const collectGc = (entries: readonly { entryType: string; startTime: number; duration: number }[]) => {
    for (const entry of entries) if (entry.entryType === 'gc') gc.push({ start: entry.startTime, duration: entry.duration });
  };
  const beginContext = () => {
    if (!contextEnabled) return;
    try {
      observer = new PerformanceObserver(list => collectGc(list.getEntries()));
      observer.observe({ entryTypes: ['gc'] });
    } catch (error: unknown) { contextFailure = String(error); }
  };
  const endContext = async () => {
    if (!contextEnabled) return null;
    // Let queued observations arrive; never force GC or alter V8 flags. This time stays inside the flow.
    await new Promise<void>(resolve => setImmediate(resolve));
    if (observer !== null) { collectGc(observer.takeRecords()); observer.disconnect(); }
    const options = process.env.NODE_OPTIONS;
    const safeFlags = /^(?:(?:--(?:max-old-space-size|stack-size)=\d+|--(?:enable-source-maps|no-deprecation|jitless|no-opt|no-turbo))\s*)*$/u;
    const safeValue = (value: string) => safeFlags.test(value) ? { status: 'recorded-exact', value }
      : { status: 'unrecognized-options-not-exposed', bytes: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex') };
    const safeSelector = (value: string | undefined) => value === undefined ? null
      : /^(?:0|1|true|false)$/u.test(value) ? value : { status: 'unrecognized-value-not-exposed', sha256: createHash('sha256').update(value).digest('hex') };
    return { diagnosticOnly: true, forcedGc: false, inspectorAttachedByThisFlow: profileState.connectedAt !== null, contextFailure,
      profileRequested, profile: profileState,
      execArgv: process.execArgv.length === 0 ? [] : safeValue(process.execArgv.join(' ')),
      nodeOptions: options === undefined ? null : safeValue(options), priority: getPriority(),
      nodeV8CoveragePresent: process.env.NODE_V8_COVERAGE !== undefined,
      forceAsyncLoader: Boolean(process.env.PLAYWRIGHT_FORCE_ASYNC_LOADER), disableTsEsm: Boolean(process.env.PW_DISABLE_TS_ESM),
      loaderEnvironment: { forceAsync: safeSelector(process.env.PLAYWRIGHT_FORCE_ASYNC_LOADER), disableTsEsm: safeSelector(process.env.PW_DISABLE_TS_ESM) },
      readerFunctionSha256: createHash('sha256').update(readPcadFile.toString()).digest('hex'),
      snapshots, gc, gcCount: gc.length, gcObservedDurationMs: gc.reduce((sum, entry) => sum + entry.duration, 0),
      attribution: 'GC entries report observed elapsed durations, not CPU consumed by GC. Process CPU includes all Node threads; no parser-thread, frequency or scheduler attribution.' };
  };
  const stages: { phase: string; start: number; end: number; wallMs: number; cpuUserMs: number; cpuSystemMs: number;
    status: string; bytes?: number; sha256?: string }[] = [];
  const start = () => ({ at: performance.now(), cpu: process.cpuUsage() });
  const finish = (phase: string, began: ReturnType<typeof start>, status: string) => {
    const end = performance.now(), cpu = process.cpuUsage(began.cpu);
    const row = { phase, start: began.at, end, wallMs: end - began.at, cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000, status };
    stages.push(row); return row;
  };
  const threadUsage = (): NodeJS.CpuUsage | null => {
    try {
      if (typeof process.threadCpuUsage === 'function') return process.threadCpuUsage();
      profileState.threadCpuFailure = 'process.threadCpuUsage unavailable';
    } catch (error: unknown) { profileState.threadCpuFailure = String(error); }
    return null;
  };
  const sync = <T>(phase: string, action: () => T, measureCurrentThread = false): T => {
    snapshot(phase, 'before');
    const threadStartAt = measureCurrentThread ? performance.now() : null;
    const threadBefore = measureCurrentThread ? threadUsage() : null;
    const began = start(); let status = 'incomplete-or-failed';
    try { const result = action(); status = 'completed'; return result; }
    finally {
      finish(phase, began, status);
      if (measureCurrentThread) {
        const threadAfter = threadUsage(), threadEndAt = performance.now();
        if (threadStartAt !== null && threadBefore !== null && threadAfter !== null) {
          const userMs = (threadAfter.user - threadBefore.user) / 1000, systemMs = (threadAfter.system - threadBefore.system) / 1000;
          if (Number.isFinite(userMs) && Number.isFinite(systemMs) && userMs >= 0 && systemMs >= 0) {
            profileState.currentThreadCpu = { before: threadBefore, after: threadAfter, startAt: threadStartAt, endAt: threadEndAt, userMs, systemMs };
          } else profileState.threadCpuFailure = 'current-thread counters were invalid or non-monotonic';
        }
      }
      snapshot(phase, 'after');
    }
  };
  const run = async <T>(phase: string, action: () => Promise<T>): Promise<T> => {
    const began = start(); let status = 'incomplete-or-failed';
    try { const result = await action(); status = 'completed'; return result; } finally { finish(phase, began, status); }
  };
  const recordInput = (bytes: Uint8Array, phase: string) => {
    // Hash after parsing: do not touch all input bytes as a warmup before the real read.
    const sha256 = sync(`${phase}-source-sha256`, () => createHash('sha256').update(bytes).digest('hex'));
    stages.push({ phase: `${phase}-input`, start: performance.now(), end: performance.now(), wallMs: 0,
      cpuUserMs: 0, cpuSystemMs: 0, status: 'identity-only', bytes: bytes.byteLength, sha256 });
  };
  const read = (bytes: Uint8Array, phase: string) => {
    try { return sync(phase, () => readPcadFile(bytes)); } finally { recordInput(bytes, phase); }
  };
  const profilePrepared = async (bytes: Uint8Array, info: TestInfo, mib: 32 | 128) => {
    // Only this opt-in branch loads inspector; ordinary E04 never attaches it.
    const { Session } = await import('node:inspector');
    const session = new Session(); session.connect();
    profileState.connectedAt = performance.now();
    try {
      await new Promise<void>((resolve, reject) => session.post('Profiler.enable', error => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => session.post('Profiler.start', error => error ? reject(error) : resolve()));
      profileState.startedAt = performance.now();
      try { return sync('prepare-read-pcad-node', () => readPcadFile(bytes), true); }
      finally {
        profileState.readerEndedAt = performance.now();
        // Stop before source SHA, all-mesh SHA, UI work or another read enters the profile.
        const profile = await new Promise<Profiler.Profile>((resolve, reject) => session.post('Profiler.stop',
          (error, result) => error ? reject(error) : resolve(result.profile)));
        profileState.stoppedAt = performance.now();
        profileState.path = info.outputPath(`read-referenced-${mib}-prepare-node.cpuprofile`);
        await writeFile(profileState.path, JSON.stringify(profile));
        await info.attach(`read-referenced-${mib}-prepare-node-profile`, { contentType: 'application/json', path: profileState.path });
      }
    } catch (error: unknown) { profileState.failure = String(error); throw error; }
    finally { session.disconnect(); recordInput(bytes, 'prepare-read-pcad-node'); }
  };
  return { sync, run, read, stages, beginContext, endContext, profileRequested, profilePrepared };
}

/** Start the real ordinary UI open without awaiting parse/recompute completion. */
async function startReadOpen(page: Page, path: string, app?: ElectronApplication) {
  if (app !== undefined) await openTarget(app, path);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : null;
  const token = await beginRecompute(page);
  await fileAction(page, '開く').click();
  if (chooser !== null) await (await chooser).setFiles(path);
  return async () => {
    await waitForRecompute(page, token);
    await expect(page.locator('.pcad-statusbar__file')).toHaveText(basename(path));
  };
}

/** Original E04: independent ZIP, orphan is deliberately NOT decoded or saved. */
export async function readOrphanIntegrityFlow(page: Page, info: TestInfo, mib: 32 | 128, app?: ElectronApplication): Promise<void> {
  await waitForStartupHealth(page, info);
  const fixture = orphanReadFixture(mib), path = info.outputPath(`orphan-${mib}.pcad`);
  await writeFile(path, fixture.bytes);
  const observed = await observeRead(page, true, app), workers = nativeReadWorkers(page);
  let completed = false;
  try {
  await (await startReadOpen(page, path, app))();
  await assertReadWorkerClosed(workers);
  const identity = await page.evaluate(async () => {
    const audit = window.pcadReadObservation;
    if (audit?.borrowed === null || audit?.borrowed === undefined || audit.source === null || audit.orphan === null) throw new Error('Missing real input/reply bytes');
    const digest = async (bytes: Uint8Array) => ({ length: bytes.byteLength,
      sha: [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice()))].map(byte => byte.toString(16).padStart(2, '0')).join('') });
    return { borrowed: await digest(audit.borrowed), source: await digest(audit.source), orphan: await digest(audit.orphan),
      sent: audit.sent, replied: audit.replied, terminated: audit.terminated };
  });
  await writeReadEvidence(info, `orphan-${mib}-identity`, { expected: fixture.expected, identity, workers, routed: observed.routed(), assets: observed.sourceAssets });
  expect(identity.borrowed).toEqual({ length: fixture.expected.sourceBytes, sha: fixture.expected.sourceSha });
  expect(identity.source).toEqual(identity.borrowed);
  expect(identity.orphan).toEqual({ length: fixture.expected.attachmentBytes, sha: fixture.expected.attachmentSha });
  expect(identity.sent).toBe(1); expect(identity.replied).toBe(1); expect(identity.terminated).toBe(1);
  expect(observed.routed()).toBe(1);
  expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(fixture.expected.sourceSha);
  completed = true;
  } finally {
    await writeReadEvidence(info, `orphan-${mib}-observation`, { status: completed ? 'passed-integrity' : 'incomplete-or-failed',
      expected: fixture.expected, workers, audit: await readObservationSnapshot(page), routed: observed.routed(),
      assets: observed.sourceAssets, observationCost: READ_OBSERVATION_COST });
  }
}

/** Preparation reuses exactly the existing 32/128MiB referenced mesh and real image UI. */
async function referencedReadPath(page: Page, info: TestInfo, mib: 32 | 128, costs: ReturnType<typeof readFlowCosts>, app?: ElectronApplication) {
  const fixture = costs.sync('prepare-large-fixture', () => largeSaveFixture(mib)), meshPath = info.outputPath(`mesh-${mib}.pcad`);
  await costs.run('prepare-write-mesh', () => writeFile(meshPath, fixture.bytes));
  await costs.run('prepare-open-mesh-ui', () => openSaveFlowFile(page, meshPath, app));
  const png = await samplePng(page, 'rgb(240, 80, 20)', 128);
  await addImage(page, 'read-reference.png', png); await expectImage(page, 'A');
  const path = info.outputPath(`referenced-${mib}.pcad`), bytes = await costs.run('prepare-save-ui-and-read-file', () => saveFlowFile(page, path, app));
  const result = costs.profileRequested ? await costs.profilePrepared(bytes, info, mib) : costs.read(bytes, 'prepare-read-pcad-node');
  costs.sync('prepare-check-all-mesh-bytes', () => fixture.checkedMesh(result));
  if (!result.ok) throw new Error('Referenced fixture refused');
  expect(result.document.canvases).toHaveLength(1);
  const canvas = result.document.canvases[0], sourceHash = createHash('sha256').update(png).digest('hex');
  const check = async (savedBytes: Uint8Array, phase: string, collision: boolean, incomingImageId = canvas.imageId): Promise<string> => {
    const read = costs.read(savedBytes, `${phase}-read-pcad-node`); costs.sync(`${phase}-check-all-mesh-bytes`, () => fixture.checkedMesh(read));
    if (!read.ok) throw new Error('Referenced roundtrip refused');
    expect(read.document.canvases).toHaveLength(1);
    const savedCanvas = read.document.canvases[0], savedImageId = savedCanvas.imageId;
    const savedImage = read.attachments.canvases.get(savedImageId);
    const savedSha = createHash('sha256').update(savedImage ?? new Uint8Array()).digest('hex');
    await writeReadEvidence(info, `read-referenced-${mib}-${phase}-image-map`, {
      source: 'loadedCanvasImages.ts: retained.has(id); partFile.ts: opensDocument; partFile.test.ts: A/B and reopen ownership',
      collision, mapping: [{ canvasId: canvas.id, incomingImageId, savedImageId, sourceSha: sourceHash, savedSha }],
      expectedCanvas: canvas, savedCanvas, canvasCount: read.document.canvases.length, imageCount: read.attachments.canvases.size,
    });
    if (collision) {
      expect(savedImageId).not.toBe(incomingImageId);
      expect(savedImageId).toMatch(/^canvas-asset-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    } else expect(savedImageId).toBe(incomingImageId);
    // Compare every field, including ID, placement, dimensions and their source expressions.
    expect(read.document.canvases).toEqual([{ ...canvas, imageId: savedImageId }]);
    expect(savedSha).toBe(sourceHash); expect(savedImage?.byteLength).toBe(png.byteLength);
    expect(read.attachments.canvases.size).toBe(1);
    return savedImageId;
  };
  return { path, check, rawBytes: fixture.rawBytes, meshHash: fixture.originalHash, imageSha: sourceHash };
}

type ReadSnapshot = Awaited<ReturnType<typeof readObservationSnapshot>>;

/**
 * One attempt's rows: spans/resets of reads not owned by an earlier attempt, inputs and round trips
 * from attempt.inputStart. Earlier rows are already in their own attempt files and every row stays in
 * the final read-<kind>-<mib>(-observation).json, so per-attempt files grow linearly with the reads.
 * sent/replied/terminated/workerUrls remain the cumulative counters.
 */
function attemptEvidence<T>(snapshot: ReadSnapshot, trips: readonly T[], inputStart: number, earlierReadIds: ReadonlySet<string>) {
  const roundTrips = trips.slice(inputStart);
  if (snapshot === null || !('spans' in snapshot)) return { audit: snapshot, roundTrips, rows: null };
  const rows = { spans: snapshot.spans.filter(span => !earlierReadIds.has(span.id)), inputs: snapshot.inputs.slice(inputStart),
    resets: snapshot.resets.filter(reset => !earlierReadIds.has(reset.readId)) };
  return { audit: { ...snapshot, ...rows,
    scope: 'this attempt: spans/resets/inputs and roundTrips start at attempt.inputStart; sent/replied/terminated/workerUrls are cumulative' },
  roundTrips, rows };
}

/** One CI log line per real read, so a CI-only shortfall is readable without the artifact. Returns this read's accepted count. */
function logReadAttempt(label: { kind: string; mib: number; attempt: number; readId: string | null },
  rows: ReturnType<typeof attemptEvidence>['rows'],
  trips: readonly { readonly start: number; readonly end: number; readonly ms: number; readonly readId: string | null }[],
  offset: { readonly lower: number; readonly upper: number } | null, acceptedBefore: number): number {
  const round = (value: number) => Math.round(value * 10) / 10;
  const span = rows?.spans.find(candidate => candidate.id === label.readId);
  // Decisions depend only on each input, its trip, its own span and that span's resets: all are in this slice.
  const decisions = rows === null || offset === null ? []
    : readInputMetrics(undefined, rows.inputs, trips, offset, rows.spans, rows.resets).decisions.filter(row => row.readId === label.readId);
  const counts = new Map<string, number>();
  for (const decision of decisions) counts.set(decision.reason, (counts.get(decision.reason) ?? 0) + 1);
  const accepted = counts.get('accepted') ?? 0;
  counts.delete('accepted');
  const own = trips.filter(trip => trip.readId === label.readId).map(trip => trip.ms).sort((a, b) => a - b);
  console.log(`[読込応答] ${JSON.stringify({ kind: label.kind, mib: label.mib, attempt: label.attempt, readId: label.readId,
    workerMs: span === undefined || span.end === null ? null : round(span.end - span.start), typed: own.length,
    accepted, excluded: decisions.length - accepted, reasons: Object.fromEntries(counts), total: acceptedBefore + accepted,
    tripMedianMs: own.length === 0 ? null : round(own[Math.floor(own.length / 2)]),
    clockOffsetWidthMs: offset === null ? null : round(offset.upper - offset.lower) })}`);
  return accepted;
}

/** Fixed collection over ordinary reads; never delay real Worker execution. */
export async function readResponsivenessFlow(page: Page, info: TestInfo, mib: 32 | 128,
  kind: 'orphan' | 'referenced', app?: ElectronApplication): Promise<void> {
  // maximumReads only stops a runaway loop; the deadline minus the reserve still bounds the collection.
  // One 32MiB orphan read admitted 8.0 inputs on Linux CI (run 43102593955: 96 after 12 reads) and 14-15 locally.
  const policy = { minimumInputs: 100, maximumReads: 40, maximumInputsPerRead: 100,
    reserveForEvidenceAndSaveMs: 30_000, maximumFlowMs: Math.min(120_000, info.timeout), timeoutMs: info.timeout,
    stopRule: 'finish current read then use ALL valid samples once at least 100 exist' };
  const attempts: { attempt: number; start: number; end: number | null; readId: string | null; inputStart: number; inputEnd: number | null }[] = [];
  const roundTrips: { start: number; end: number; ms: number; readId: string | null }[] = [];
  let memory: Awaited<ReturnType<typeof startReadResidentSampler>> | undefined;
  let observed: Awaited<ReturnType<typeof observeRead>> | undefined;
  let workers: ReturnType<typeof nativeReadWorkers> = [];
  const notifications = new EventEmitter(), endedReads = new Set<string>();
  const spanNotifications: { phase: 'start' | 'end'; id: string; at: number; receivedAt: number }[] = [];
  let offset: { lower: number; upper: number } | null = null;
  let completed = false, startedAt: number | null = null, releasedAt: number | null = null;
  let failure: string | null = null, acceptedSoFar = 0;
  const memoryFailures: string[] = [];
  const costs = readFlowCosts(), flowStart = performance.now();
  // Native Playwright's unchanged total test deadline remains authoritative.
  const deadline = performance.now() + policy.maximumFlowMs;
  try {
    costs.beginContext();
    await page.setViewportSize({ width: 1440, height: 900 }); await waitForStartupHealth(page, info);
    const fixture = kind === 'orphan' ? orphanReadFixture(mib) : await referencedReadPath(page, info, mib, costs, app);
    const path = 'path' in fixture ? fixture.path : info.outputPath(`timing-orphan-${mib}.pcad`);
    if ('bytes' in fixture) await writeFile(path, fixture.bytes);
    const command = page.locator('#pcad-command-line-input'); await command.fill('');
    observed = await observeRead(page, false, app, event => {
      spanNotifications.push({ ...event, receivedAt: performance.timeOrigin + performance.now() });
      if (event.phase === 'start') notifications.emit('start', event.id);
      else endedReads.add(event.id);
    }); workers = nativeReadWorkers(page);
    try {
      memory = await startReadResidentSampler(info, app?.process().pid ?? process.pid);
      await memory.waitAfter(-Infinity);
    } catch (error: unknown) { memoryFailures.push(String(error)); }
    const clockStart = performance.timeOrigin + performance.now();
    const browserClock = await page.evaluate(() => performance.timeOrigin + performance.now());
    const clockEnd = performance.timeOrigin + performance.now();
    offset = { lower: browserClock - clockEnd, upper: browserClock - clockStart };
    startedAt = performance.now();
    for (let attempt = 0; attempt < policy.maximumReads; attempt += 1) {
      if (performance.now() >= deadline - policy.reserveForEvidenceAndSaveMs) break;
      await command.press('Escape'); await command.focus();
      const inputStart = await page.evaluate(() => window.pcadReadObservation?.inputs.length ?? 0);
      const row = { attempt: attempt + 1, start: performance.now(), end: null as number | null,
        readId: null as string | null, inputStart, inputEnd: null as number | null };
      attempts.push(row);
      try {
        // Subscribe before opening: receiving the notification never defines the measured active window.
        const startAbort = new AbortController();
        const remaining = Math.max(0, Math.floor(deadline - performance.now() - policy.reserveForEvidenceAndSaveMs));
        const started = once(notifications, 'start', { signal: AbortSignal.any([startAbort.signal, AbortSignal.timeout(remaining)]) });
        // A failed open can abort this pending event before it is awaited.
        void started.catch(() => undefined);
        let finish: () => Promise<void>;
        let readId: unknown;
        try {
          finish = await startReadOpen(page, path, app);
          await command.focus();
          [readId] = await started;
        } finally { startAbort.abort(); }
        if (typeof readId !== 'string') throw new Error('Actual Worker start missing');
        row.readId = readId;
        let typed = 0;
        for (; typed < policy.maximumInputsPerRead; typed += 1) {
          // Late end notifications can schedule one extra key; the original Worker timestamps
          // in readInputMetrics still reject every key that actually starts outside the window.
          if (endedReads.has(readId) || performance.now() >= deadline - policy.reserveForEvidenceAndSaveMs) break;
          const start = performance.timeOrigin + performance.now();
          await page.keyboard.press('a');
          const end = performance.timeOrigin + performance.now();
          roundTrips[inputStart + typed] = { start, end, ms: end - start, readId: row.readId };
        }
        // Each key's pre-reset value is observed in the actual input event, not after open.
        await finish(); await assertReadWorkerClosed(workers);
        await expect.poll(() => page.evaluate(() => window.pcadReadObservation?.inputs.every(input => input.paintedAt !== null))).toBe(true);
        const audit = await readObservationSnapshot(page);
        if (audit === null || !('spans' in audit)) throw new Error('Read observation unavailable');
        const completedSpan = audit.spans.find(candidate => candidate.id === row.readId);
        if (completedSpan === undefined) throw new Error('Completed Worker span missing');
        const terminal = readCommandTimeline(completedSpan, audit.inputs, audit.resets);
        await writeReadEvidence(info, `read-${kind}-${mib}-terminal-${attempt + 1}`, terminal);
        expect(terminal.failures, 'each key/input/reset/paint must follow the observed document timeline').toEqual([]);
        await expect(command).toHaveValue(terminal.expectedFinalValue);
        const metrics = readInputMetrics(undefined, audit.inputs, roundTrips, offset, audit.spans, audit.resets);
        expect(audit.inputs.length - inputStart, 'every pressed key has an observation, including missing input events').toBe(typed);
        expect(metrics.incomplete, 'trusted value changes and paint evidence cannot be dropped from the sample set').toEqual([]);
        if (metrics.samples.length >= policy.minimumInputs) break;
      } finally {
        row.end = performance.now(); row.inputEnd = await page.evaluate(() => window.pcadReadObservation?.inputs.length ?? null).catch(() => null);
        const evidence = attemptEvidence(await readObservationSnapshot(page), roundTrips, row.inputStart,
          new Set(attempts.flatMap(earlier => earlier !== row && earlier.readId !== null ? [earlier.readId] : [])));
        await writeReadEvidence(info, `read-${kind}-${mib}-attempt-${attempt + 1}`, { policy, attempt: row,
          audit: evidence.audit, roundTrips: evidence.roundTrips, clockOffset: offset, workers });
        acceptedSoFar += logReadAttempt({ kind, mib, attempt: row.attempt, readId: row.readId }, evidence.rows, evidence.roundTrips, offset, acceptedSoFar);
      }
    }
    releasedAt = performance.now();
    if (memory !== undefined) {
      try { await memory.waitAfter(releasedAt); } catch (error: unknown) { memoryFailures.push(String(error)); }
    }
    const resident = await memory?.stop() ?? [];
    const audit = await readObservationSnapshot(page);
    if (audit === null || !('spans' in audit)) throw new Error('Read observation unavailable');
    const metrics = readInputMetrics(undefined, audit.inputs, roundTrips, offset, audit.spans, audit.resets);
    const before = resident.filter(sample => sample.at < (startedAt ?? -Infinity));
    const during = resident.filter(sample => sample.at >= (startedAt ?? Infinity) && sample.at <= (releasedAt ?? -Infinity));
    const after = resident.filter(sample => sample.at > (releasedAt ?? Infinity));
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;
    const extraPeak = { workingSet: Math.max(...during.map(sample => sample.workingSet)) - median(before.map(sample => sample.workingSet)),
      secondaryBytes: Math.max(...during.map(sample => sample.secondaryBytes)) - median(before.map(sample => sample.secondaryBytes)) };
    const extraReleased = { workingSet: median(after.map(sample => sample.workingSet)) - median(before.map(sample => sample.workingSet)),
      secondaryBytes: median(after.map(sample => sample.secondaryBytes)) - median(before.map(sample => sample.secondaryBytes)) };
    const memoryBudget = 512 * 1024 * 1024;
    await writeReadEvidence(info, `read-${kind}-${mib}`, { policy, attempts, ...metrics, audit, roundTrips, spanNotifications,
      clockOffset: offset, workers, routed: observed.routed(), assets: observed.sourceAssets,
      inputCondition: metrics.incomplete.length ? 'incomplete-input-evidence'
        : metrics.p95 === null ? 'insufficient-valid-inputs' : metrics.p95 < 100 ? 'passed' : 'failed-latency',
      memory: { ...memory?.coverage, errors: [...memoryFailures, ...(memory?.errors ?? [])], rootPid: memory?.root ?? null,
        measurementStatus: memoryFailures.length || memory === undefined || memory.errors.length
          || before.length < 3 || during.length < 3 || after.length < 3 ? 'unavailable-or-incomplete' : 'measured-partial-set',
        startedAt, releasedAt, extraPeak, extraReleased, samples: resident,
        counts: { before: before.length, during: during.length, after: after.length }, extraPeakBudgetBytes: memoryBudget,
        full512MiBCondition: 'not proven: partial PID set and missing GPU measurement' } });
    await command.press('Escape');
    // These counters describe the timed reads. The save/reopen proof below starts another real reader.
    expect(audit.sent).toBe(attempts.length); expect(audit.replied).toBe(attempts.length); expect(audit.terminated).toBe(attempts.length);
    expect(observed.routed()).toBe(attempts.length); expect(workers).toHaveLength(attempts.length);
    // A read with no valid inputs has already failed; keep that cause before further saves consume the deadline.
    expect(metrics.incomplete, 'all input values and paint observations are required').toEqual([]);
    expect(metrics.active.length, '100 trusted input starts during actual reads; include slow completion across Worker end').toBeGreaterThanOrEqual(100);
    expect(metrics.p95).not.toBeNull(); expect(metrics.p95).toBeLessThan(100);
    if ('check' in fixture) {
      await expect(canvasRow(page, 'read-reference.png')).toBeVisible(); await expectImage(page, 'A');
      const savedPath = info.outputPath(`read-resaved-${mib}.pcad`);
      // The prepared image is retained before the first read: that read collides.
      // opensDocument prunes the old owner and clears history, so repeated original input
      // alternates collision / unchanged ID (loadedCanvasImages.test.ts; partFile.test.ts).
      const savedImageId = await fixture.check(await costs.run('resaved-save-ui-and-read-file', () => saveFlowFile(page, savedPath, app)), 'resaved', attempts.length % 2 === 1);
      await costs.run('resaved-reopen-ui', () => openSaveFlowFile(page, savedPath, app));
      await expectImage(page, 'A');
      await fixture.check(await costs.run('reopened-save-ui-and-read-file', () => saveFlowFile(page, info.outputPath(`read-reopened-${mib}.pcad`), app)), 'reopened', true, savedImageId);
      await assertReadWorkerClosed(workers);
      expect(observed.routed()).toBe(attempts.length + 1); expect(workers).toHaveLength(attempts.length + 1);
      await writeReadEvidence(info, `read-${kind}-${mib}-save-reopen`, { phase: 'save-reopen-integrity',
        audit: await readObservationSnapshot(page), workers, routed: observed.routed(), assets: observed.sourceAssets });
    }
    expect([...memoryFailures, ...(memory?.errors ?? ['memory sampler unavailable'])], 'missing OS samples cannot certify memory').toEqual([]);
    expect(before.length).toBeGreaterThanOrEqual(3); expect(during.length).toBeGreaterThanOrEqual(3); expect(after.length).toBeGreaterThanOrEqual(3);
    expect(extraPeak.workingSet).toBeLessThan(memoryBudget); expect(extraPeak.secondaryBytes).toBeLessThan(memoryBudget);
    expect(extraReleased.workingSet).toBeLessThan(memoryBudget); expect(extraReleased.secondaryBytes).toBeLessThan(memoryBudget);
    completed = true;
  } catch (error: unknown) {
    failure = String(error); throw error;
  } finally {
    try {
      if (memory === undefined) await writeReadEvidence(info, 'read-resident-raw', { rootPid: app?.process().pid ?? process.pid,
        measurementStatus: 'unavailable-or-incomplete', failures: [failure ?? 'measurement preparation did not start sampler'],
        frames: [], samples: [], full512MiBCondition: 'not proven: no sampler and missing GPU measurement' });
      else await memory.stop();
    } finally {
      const context = await costs.endContext();
      await writeReadEvidence(info, `read-${kind}-${mib}-stage-costs`, { at: new Date().toISOString(),
        status: completed ? 'completed' : 'incomplete-or-failed', pid: process.pid, parentPid: process.ppid,
        node: process.version, arch: process.arch, execPath: process.execPath,
        cpuScope: 'process.cpuUsage of this Playwright Node worker only; excludes parent runner and browser processes',
        profileScope: 'Node inspector sample weights are elapsed-time attribution, not process CPU consumption',
        flowStart, deadline, evidenceAt: performance.now(), policy, stages: costs.stages, context });
      const audit = await readObservationSnapshot(page);
      const metrics = audit !== null && 'spans' in audit && offset !== null
        ? readInputMetrics(undefined, audit.inputs, roundTrips, offset, audit.spans, audit.resets) : null;
      await writeReadEvidence(info, `read-${kind}-${mib}-observation`, { status: completed ? 'passed-partial-measurements' : 'incomplete-or-failed',
        policy, attempts, failure, audit, roundTrips, spanNotifications, clockOffset: offset, decisions: metrics?.decisions ?? [],
        activeInputs: metrics?.samples.length ?? null, p95: metrics?.p95 ?? null,
        inputCondition: metrics !== null && metrics.incomplete.length ? 'incomplete-input-evidence'
          : metrics?.p95 === null || metrics === null ? 'unmeasured-or-insufficient-inputs' : metrics.p95 < 100 ? 'passed' : 'failed-latency',
        workers, routed: observed?.routed() ?? null, assets: observed?.sourceAssets ?? [], observationCost: READ_OBSERVATION_COST,
        memory: { ...memory?.coverage, errors: [...memoryFailures, ...(memory?.errors ?? [])],
          rawPath: info.outputPath('read-resident-raw.json'),
          measurementStatus: memory === undefined || memoryFailures.length || memory.errors.length ? 'unavailable-or-incomplete' : 'measured-partial-set',
          full512MiBCondition: 'not proven: partial PID set and missing GPU measurement' } });
    }
  }
}
