/**
 * Responsiveness measurement of the surface reply decoder on the real client path. The original thirty conditions,
 * sizes and thresholds remain. Fixture generation and certification run on a distinct Node Worker heap; replies reach
 * the real FunctionSurfaceWorkerClient through the product encoder and transferable buffers. Since r2 the client
 * checks the envelope (kind, serial, identity) in the message task and then decodes and verifies the result with the
 * real beginFunctionSurfaceWorkReply steps in slices of at most CALCULATION_REPLY_SLICE_MS, yielding to the event loop.
 * So the one message task (`blockedMs`) is no longer the whole decode: every threshold check also uses `longestGapMs`,
 * the longest gap seen by a chained zero-delay timer from Worker construction through the final reply timer, covering
 * startup/preparation, transport/deserialization, every slice and receiver GC. No waiting time is subtracted.
 *
 * Mapping to the r1 records: same scenario names and fields, plus `totalMs` (reply delivery to completion). Changed exact
 * expectations, with reasons: 'fan-2826-cancel-during' now ends 'cancelled' (r1: 'result', because the synchronous
 * decode committed before the click); 'fan-2826-stale-same-identity' is now refused before its result is decoded (r1:
 * after the full certificate, about 898 ms in Root's run 20261011-025427).
 *
 * Thresholds, fixed before any run (docs/requirements.md §5.2):
 * - NFR-PF-4: computing must not freeze the UI and must stay cancellable.
 * - Current-release table, "時間だけを測る既存の性能検査": short processes have a 100 ms bound; "中止表示200ms→1秒".
 * - Current-release table, heavy drawing: minimum 10 fps, i.e. 100 ms per frame.
 * So: the longest synchronous span (one blocked task) <= 100 ms; a cancel click scheduled while the reply is queued is
 * delivered <= 1,000 ms after it was scheduled AND the request finishes as 'cancelled' (a click that arrives only after
 * the result was already applied does not count as cancelling). 16 ms / 33 ms / 200 ms are recorded as targets only.
 *
 * Node's event loop stands in for the browser main thread: a blocked task here blocks the same JavaScript there, but
 * rendering and real input delivery are only proved by the browser check proposed in the run proposal. Every record is
 * printed as `[pcad:surface-response] {json}` for Root's run log. Prior in-process failures remain in the archived run evidence.
 */
import { Worker, threadId } from 'node:worker_threads';
import { PerformanceObserver } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as surfaceReply from './functionSurfaceWorkReply.js';
import { createMathBackend } from './createMathBackend.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { decodeFunctionSurfaceWorkRequest, type FunctionSurfaceWorkRequest } from './functionSurfaceWorkRequest.js';
import { FunctionSurfaceWorkerClient } from './functionSurfaceWorkerClient.js';
import type { CalculationWorkerPort } from './boundedCalculationClient.js';
import { certifySplineAgainstMesh, certifySplineAgainstMeshSteps, FUNCTION_SURFACE_SPLINE_PAIR_LIMIT, type SurfaceMeshEvidence } from './smoothFunctionSurface.js';

const LONG_TASK_LIMIT_MS = 100;
const CANCEL_DELIVERY_LIMIT_MS = 1_000;
const TARGETS_MS = Object.freeze({ frame60: 16, frame30: 33, cancel: 200 });
/** The budget the product sends (model functionSurfaceRequest.ts: samples and triangles capped by the kernel's 100,000). */
const PRODUCT_BUDGET = Object.freeze({ maximumSamples: 100_000, maximumCells: 400_000, maximumTriangles: 100_000, maximumDepth: 24 });
/** Per-test wait, the §5.2 unit-test window (60 s). */
const RUN_LIMIT_MS = 60_000;

type Point = readonly [number, number, number];
type Triangle = readonly [number, number, number];
interface Vertex { readonly parameters: readonly [number, number]; readonly point: Point }
interface Scenario { readonly vertices: readonly Vertex[]; readonly triangles: readonly Triangle[]; readonly uKnots: readonly number[]; readonly vKnots: readonly number[] }
interface ResponseRecord {
  readonly scenario: string; readonly status: string; readonly blockedMs: number; readonly longestGapMs: number;
  readonly cancelDeliveryMs: number | null; readonly replyBytes: number; readonly heapBeforeBytes: number; readonly heapAfterBytes: number;
  readonly rssAfterBytes: number; readonly triangles: number; readonly cells: number; readonly work: number | null;
  /** Reply delivery to request completion (all slices); null when no reply was delivered. */
  readonly totalMs: number | null;
}

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const records = new Map<string, ResponseRecord>();
afterAll(() => { console.info('[pcad:surface-response]', JSON.stringify({ thresholds: { LONG_TASK_LIMIT_MS, CANCEL_DELIVERY_LIMIT_MS, TARGETS_MS }, records: [...records.values()] })); });

function request(lower: readonly [number, number], upper: readonly [number, number], z = '0', documentVersion = 1): FunctionSurfaceWorkRequest {
  const source = (text: string) => createFunctionMathSource(text, 'text', 'radian', { axes: [], parameters: ['U', 'V'], coefficients: [] }, backend);
  return decodeFunctionSurfaceWorkRequest({ identity: { documentId: 'response', documentVersion, editorId: 'surface', inputRevision: 1 },
    independent: ['U', 'V'], outputs: [source('U'), source('V'), source(z)], lower, upper,
    minimum: [-1_000, -1_000, -1_000], maximum: [1_000, 1_000, 1_000], tolerance: 0.01, coefficients: [], budget: PRODUCT_BUDGET });
}

/** Poles reproducing x = u, y = v, z = 0 exactly in the double-knot layout (independent of the production builder). */
function identityPoles(uKnots: readonly number[], vKnots: readonly number[]): Point[] {
  const position = (knots: readonly number[], index: number) => {
    if (index === 0) return knots[0];
    if (index === 2 * knots.length - 1) return knots[knots.length - 1];
    const span = Math.floor((index - 1) / 2), width = knots[span + 1] - knots[span];
    return index % 2 === 1 ? knots[span] + width / 3 : knots[span + 1] - width / 3;
  };
  const poles: Point[] = [];
  for (let p = 0; p < 2 * uKnots.length; p++) for (let q = 0; q < 2 * vKnots.length; q++) poles.push([position(uKnots, p), position(vKnots, q), 0]);
  return poles;
}
const flat = (u: number, v: number): Vertex => ({ parameters: [u, v], point: [u, v, 0] });

/** The unit square as one cell, tiled by a fan of m triangles from (0,0) to the right then top edge (legitimate slivers). */
function fan(m: number): Scenario {
  const right = Math.ceil(m / 2), top = m - right, vertices: Vertex[] = [flat(0, 0)];
  for (let j = 0; j <= right; j++) vertices.push(flat(1, j / right));
  for (let j = 1; j <= top; j++) vertices.push(flat(1 - j / top, 1));
  const triangles: Triangle[] = [];
  for (let index = 0; index < m; index++) triangles.push([0, index + 1, index + 2]);
  return { vertices, triangles, uKnots: [0, 1], vKnots: [0, 1] };
}
/** Exact certificate work of a single-cell fan: m clips in the first pass, m member clips, m(m-1)/2 overlap tests. */
const fanWork = (m: number) => 2 * m + m * (m - 1) / 2;

describe('clipping workspace ownership and analytic planar coverage', () => {
  it('keeps retained clips and separate suspended certificates independent, in either winding', () => {
    const base = fan(12), uKnots = [0, 0.2, 0.7, 1], vKnots = [0, 0.3, 0.9, 1];
    const forward = { ...base, uKnots, vKnots };
    const backward = { ...forward, triangles: base.triangles.map(([a, b, c]): Triangle => [c, b, a]) };
    const snapshots = structuredClone([forward, backward]);
    const input = request([0, 0], [1, 1]);
    const steps = [forward, backward].map(scenario => certifySplineAgainstMeshSteps({ uKnots, vKnots,
      poles: identityPoles(uKnots, vKnots) }, evidence(scenario), input));
    // Interleave generators: a shared scratch area, or a retained clip aliasing it, corrupts the proof.
    let first = steps[0].next(), second = steps[1].next();
    while (!first.done || !second.done) {
      if (!first.done) first = steps[0].next();
      if (!second.done) second = steps[1].next();
    }
    for (const result of [first.value, second.value]) {
      expect(result).toMatchObject({ status: 'certified', coveredCells: 9, outsideCells: 0, curved: false });
      // Independent formula S(u,v)=(u,v,0): exact geometric error is zero (only conservative rounding remains).
      if (result.status === 'certified') expect(result.splineToMesh).toBeLessThanOrEqual(1e-10);
    }
    expect([forward, backward]).toEqual(snapshots);
  });

  it('rejects equal-area overlap plus a hole after reusing the clipping buffers', () => {
    const base = fan(4), triangles = [base.triangles[0], base.triangles[0], ...base.triangles.slice(2)];
    const input = request([0, 0], [1, 1]);
    // Four quarter-square triangles still sum to one; their union has area 3/4 and overlap 1/4.
    const result = certifySplineAgainstMesh({ uKnots: [0, 1], vKnots: [0, 1], poles: identityPoles([0, 1], [0, 1]) },
      evidence({ ...base, triangles }), input);
    expect(result).toMatchObject({ status: 'rejected', reason: 'overlap' });
  });
});

function evidence(scenario: Scenario): SurfaceMeshEvidence {
  return { vertices: scenario.vertices, triangles: scenario.triangles, bound: 0 };
}
/** Passive diagnosis inherited from the prior probe; original thirty checks and geometry stay unchanged. */
function createReplyTimingProbe(scenario: string) {
  const windowStart = performance.now();
  let maximumNextMs = 0, maximumNextStart = 0, maximumNextEnd = 0, nextCount = 0;
  let maximumGapMs = 0, maximumGapStart = 0, maximumGapEnd = 0, maximumGapCpuMs = 0;
  let intervalNextMs = 0, intervalNextCount = 0, intervalMaximumNextMs = 0, intervalMaximumNextStart = 0, intervalMaximumNextEnd = 0;
  let maximumGapNextMs = 0, maximumGapNextCount = 0, maximumGapMaximumNextMs = 0, maximumGapNextStart = 0, maximumGapNextEnd = 0;
  let previousCpu = process.cpuUsage(), finished = false;
  const gc: { start: number; duration: number }[] = [];
  const capture = (entries: ReturnType<PerformanceObserver['takeRecords']>) => {
    for (const entry of entries) gc.push({ start: entry.startTime, duration: entry.duration });
  };
  const observer = new PerformanceObserver(list => capture(list.getEntries()));
  observer.observe({ entryTypes: ['gc'] });
  const originalBegin = surfaceReply.beginFunctionSurfaceWorkReply;
  const spy = vi.spyOn(surfaceReply, 'beginFunctionSurfaceWorkReply').mockImplementation((value, input) => {
    const begun = originalBegin(value, input), next = begun.steps.next.bind(begun.steps);
    // Keep the original iterator/yields/results. Only accumulate scalar timing evidence.
    begun.steps.next = () => {
      const start = performance.now();
      try { return next(); }
      finally {
        const end = performance.now(), duration = end - start;
        nextCount++; intervalNextCount++; intervalNextMs += duration;
        if (duration > maximumNextMs) { maximumNextMs = duration; maximumNextStart = start; maximumNextEnd = end; }
        if (duration > intervalMaximumNextMs) {
          intervalMaximumNextMs = duration; intervalMaximumNextStart = start; intervalMaximumNextEnd = end;
        }
      }
    };
    return begun;
  });
  return {
    gap: (start: number, end: number) => {
      const cpu = process.cpuUsage(), duration = end - start;
      if (duration > maximumGapMs) {
        maximumGapMs = duration; maximumGapStart = start; maximumGapEnd = end;
        maximumGapCpuMs = (cpu.user - previousCpu.user + cpu.system - previousCpu.system) / 1000;
        maximumGapNextMs = intervalNextMs; maximumGapNextCount = intervalNextCount;
        maximumGapMaximumNextMs = intervalMaximumNextMs;
        maximumGapNextStart = intervalMaximumNextStart; maximumGapNextEnd = intervalMaximumNextEnd;
      }
      previousCpu = cpu; intervalNextMs = 0; intervalNextCount = 0; intervalMaximumNextMs = 0;
      intervalMaximumNextStart = 0; intervalMaximumNextEnd = 0;
    },
    finish: () => {
      if (finished) return;
      const windowEnd = performance.now();
      finished = true; capture(observer.takeRecords()); observer.disconnect(); spy.mockRestore();
      const overlappingGc = gc.filter(entry => entry.start < maximumGapEnd && entry.start + entry.duration > maximumGapStart);
      // Direct stdout retains the raw evidence even when the test runner suppresses console diagnostics.
      process.stdout.write('[pcad:surface-response-diagnostic] ' + JSON.stringify({ scenario,
        timeOrigin: performance.timeOrigin, windowStart, windowEnd,
        maximumNextMs, maximumNextStart, maximumNextEnd, nextCount,
        maximumGapMs, maximumGapStart, maximumGapEnd, maximumGapCpuMs,
        maximumGapNextMs, maximumGapNextCount, maximumGapMaximumNextMs, maximumGapNextStart, maximumGapNextEnd,
        maximumGapUnattributedWallMs: Math.max(0, maximumGapMs - maximumGapNextMs),
        overlappingGc, gc,
        limitations: 'Instrumentation overhead is present. next duration includes GC/off-CPU time; process CPU includes V8 and fixture Worker threads, not just the receiver. Unattributed wall time can include other JS, timer/OS wait or unobserved GC. Missing GC entries do not prove no GC. This diagnostic pass cannot erase the original failures.' }) + String.fromCharCode(10));
    },
  };
}

/** Chained zero-delay timers: the largest gap between consecutive deliveries is the longest blocked span seen. */
function eventLoopMonitor(probe?: ReturnType<typeof createReplyTimingProbe>) {
  let last = performance.now(), longest = 0, running = true;
  const tick = () => {
    const now = performance.now(); probe?.gap(last, now); longest = Math.max(longest, now - last); last = now;
    if (running) setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
  return { stop: () => { running = false; return longest; } };
}

interface FixtureMetadata {
  readonly kind: 'fixture-ready'; readonly threadId: number;
  readonly certificate: ReturnType<typeof certifySplineAgainstMesh> | null;
  readonly triangles: number; readonly vertices: number; readonly cells: number;
  readonly uKnots: readonly number[]; readonly vKnots: readonly number[];
  readonly replyBytes: number; readonly preparationMs: number;
}
let responseWorkerCode: string;
beforeAll(async () => {
  const { build } = await import('vite');
  const { fileURLToPath } = await import('node:url');
  const output = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false,
    lib: { entry: fileURLToPath(new URL('./functionSurfaceResponseFixture.node.ts', import.meta.url)), formats: ['cjs'] },
    rollupOptions: { external: ['node:worker_threads'], output: { inlineDynamicImports: true } } } });
  const outputs = Array.isArray(output) ? output : [output];
  const chunks = outputs.flatMap(value => 'output' in value ? value.output : []).filter(value => value.type === 'chunk');
  if (chunks.length !== 1) throw new Error('Expected one fixture Worker bundle');
  responseWorkerCode = chunks[0].code;
}, RUN_LIMIT_MS);

/** Real asynchronous transport: preparation and sender-side serialization have their own Worker heap. */
class ResponseFixturePort implements CalculationWorkerPort {
  onmessage: CalculationWorkerPort['onmessage'] = null;
  onerror: CalculationWorkerPort['onerror'] = null;
  onmessageerror: CalculationWorkerPort['onmessageerror'] = null;
  readonly ready: Promise<FixtureMetadata>;
  private readonly worker: Worker;
  private closed: Promise<number> | null = null;
  blockedMs = 0;
  deliveredAt: number | null = null;
  constructor(name: string, input: FunctionSurfaceWorkRequest, beforeDelivery: () => void = () => undefined) {
    this.worker = new Worker(responseWorkerCode, { eval: true, workerData: { scenario: name, input } });
    let resolveReady: (value: FixtureMetadata) => void = () => undefined;
    let rejectReady: (error: Error) => void = () => undefined;
    this.ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    this.worker.on('error', error => { rejectReady(error); this.onerror?.({ preventDefault: () => undefined }); });
    this.worker.on('messageerror', () => this.onmessageerror?.());
    this.worker.on('message', (data: FixtureMetadata) => {
      if (data.kind === 'fixture-ready') { resolveReady(data); return; }
      const handler = this.onmessage;
      if (handler === null) return;
      beforeDelivery();
      const start = performance.now(); this.deliveredAt = start;
      handler({ data }); this.blockedMs = performance.now() - start;
    });
  }
  postMessage(value: unknown): void { this.worker.postMessage(value); }
  terminate(): void {
    this.onmessage = null; this.onerror = null; this.onmessageerror = null;
    this.closed ??= this.worker.terminate();
  }
  async close(): Promise<void> { this.terminate(); await this.closed; }
}

async function measure(name: string, input: FunctionSurfaceWorkRequest, options: { readonly cancel?: 'during' | 'before' } = {}) {
  let cancelScheduledAt = 0, cancelDeliveredAt: number | null = null;
  const abort = new AbortController();
  let deliveredClick: Promise<void> | undefined;
  const click = () => {
    cancelScheduledAt = performance.now();
    deliveredClick = new Promise(resolve => setTimeout(() => { cancelDeliveredAt = performance.now(); abort.abort(); resolve(); }, 0));
  };
  const diagnostic = createReplyTimingProbe(name), monitor = eventLoopMonitor(diagnostic);
  const heapBefore = process.memoryUsage().heapUsed;
  // The complete window includes Worker startup, fixture preparation, all message transport and receiver GC.
  const port = new ResponseFixturePort(name, input, () => { if (options.cancel === 'during') click(); });
  const client = new FunctionSurfaceWorkerClient({ createWorker: () => port });
  let receiving: ReturnType<typeof eventLoopMonitor> | undefined;
  try {
    const metadata = await port.ready;
    expect(metadata.threadId).not.toBe(threadId);
    // Before-delivery control: deliver the queued click before dispatch, independent of cross-thread task ordering.
    if (options.cancel === 'before') { click(); await deliveredClick; }
    receiving = eventLoopMonitor();
    const completion = await client.evaluate(input, 30_000, abort.signal), completedAt = performance.now();
    await new Promise(resolve => setTimeout(resolve, 0));
    const receivingGapMs = receiving.stop(), longestGap = monitor.stop(), memory = process.memoryUsage();
    diagnostic.finish();
    const record: ResponseRecord = { scenario: name,
      status: completion.status === 'result' ? `result:${completion.result.status}:${'spline' in completion.result ? 'spline' : 'mesh'}` : completion.status,
      blockedMs: port.blockedMs, longestGapMs: longestGap,
      cancelDeliveryMs: cancelDeliveredAt === null ? null : cancelDeliveredAt - cancelScheduledAt,
      replyBytes: metadata.replyBytes, heapBeforeBytes: heapBefore, heapAfterBytes: memory.heapUsed, rssAfterBytes: memory.rss,
      triangles: metadata.triangles, cells: metadata.cells, work: metadata.certificate?.status === 'certified' ? metadata.certificate.work : null,
      totalMs: port.deliveredAt === null ? null : completedAt - port.deliveredAt };
    process.stdout.write('[pcad:worker-boundary] ' + JSON.stringify({ scenario: name, receivingGapMs, wholeGapMs: longestGap,
      workerThreadId: metadata.threadId, parentThreadId: threadId, preparationMs: metadata.preparationMs,
      windows: 'whole before Worker constructor through final reply timer; receiving before evaluate through final reply timer; no GC/OS subtraction' }) + String.fromCharCode(10));
    records.set(name, record);
    const scenario = { triangles: { length: metadata.triangles }, vertices: { length: metadata.vertices }, uKnots: metadata.uKnots, vKnots: metadata.vKnots };
    return { completion, record, certificate: metadata.certificate, scenario };
  } finally { receiving?.stop(); monitor.stop(); diagnostic.finish(); client.dispose(); await port.close(); }
}

describe('曲面の返信の検査が画面の応答を奪わないかの測定（未実行の候補）', () => {
  it('正当な1区画の扇（細い三角形2,826枚）は検査の仕事量3,997,377で通り、4M直前の最大の受理例になる', async () => {
    expect(fanWork(2826)).toBe(3_997_377); expect(fanWork(2826)).toBeLessThanOrEqual(FUNCTION_SURFACE_SPLINE_PAIR_LIMIT);
    const { completion, certificate } = await measure('fan-2826-accepted', request([0, 0], [1, 1]));
    expect(certificate).toMatchObject({ status: 'certified', work: 3_997_377, coveredCells: 1 });
    expect(completion).toMatchObject({ status: 'result', result: { status: 'ready', spline: { uKnots: [0, 1] } } });
  }, RUN_LIMIT_MS);

  it('2,827枚の扇は仕事量4,000,205となり上限を超えるので、返信全体を拒否する', async () => {
    expect(fanWork(2827)).toBe(4_000_205);
    const { completion, certificate } = await measure('fan-2827-over-budget', request([0, 0], [1, 1]));
    expect(certificate).toMatchObject({ status: 'rejected', reason: 'budget' });
    expect(completion.status).toBe('worker-error');
  }, RUN_LIMIT_MS);

  it('正当な細分割（222×222区画・三角形98,568枚、製品の予算内）は仕事量246,420で通る', async () => {
    const { completion, certificate, scenario } = await measure('grid-222-legitimate', request([0, 0], [222, 222]));
    expect(scenario.triangles.length).toBe(98_568); expect(scenario.vertices.length).toBe(49_729);
    expect(4 * scenario.uKnots.length * scenario.vKnots.length).toBe(198_916);
    // Each triangle meets only its own cell: 98,568 first-pass clips + 98,568 member clips + 49,284 overlap tests.
    expect(certificate).toMatchObject({ status: 'certified', work: 246_420, coveredCells: 49_284 });
    expect(completion).toMatchObject({ status: 'result', result: { status: 'ready' } });
  }, RUN_LIMIT_MS);

  // A 128 x 128 grid keeps every clip of the diagonal slivers exact (dyadic coordinates), so their clips have area 0
  // exactly and they are never members: each costs exactly its 16,384 first-pass units and nothing else.
  it('面積0の対角の三角形239枚で仕事量を3,997,696まで膨らませた悪意の返信は、上限内なので受理され、その費用を記録する', async () => {
    const { completion, certificate, scenario } = await measure('grid-128-slivers-239', request([0, 0], [128, 128]));
    expect(scenario.triangles.length).toBe(32_768 + 239);
    // (5 + 239) * 16,384: the legitimate grid costs 5 units per cell, each sliver one unit per cell.
    expect(certificate).toMatchObject({ status: 'certified', work: 3_997_696, coveredCells: 16_384 });
    expect(completion).toMatchObject({ status: 'result', result: { status: 'ready' } });
  }, RUN_LIMIT_MS);

  it('240枚では仕事量が4,014,080となり、上限で拒否する', async () => {
    const { completion, certificate } = await measure('grid-128-slivers-240', request([0, 0], [128, 128]));
    expect(certificate).toMatchObject({ status: 'rejected', reason: 'budget' });
    expect(completion.status).toBe('worker-error');
  }, RUN_LIMIT_MS);

  it('重複・穴のある悪意の返信は、全ての組を調べ終えてから拒否する（拒否までの費用を記録）', async () => {
    // 2,825 fan triangles plus a copy of the first: 2,826 triangles, the same 3,997,377 units, then 'overlap'.
    const overlap = await measure('fan-2825-duplicate', request([0, 0], [1, 1]));
    expect(overlap.certificate).toMatchObject({ status: 'rejected', reason: 'overlap' });
    expect(overlap.completion.status).toBe('worker-error');
    // 2,826 fan triangles without the last: 2,825 triangles, 2 * 2,825 + 2,825 * 2,824 / 2 = 3,994,550 units, then 'coverage'.
    const missing = await measure('fan-2826-hole', request([0, 0], [1, 1]));
    expect(missing.certificate).toMatchObject({ status: 'rejected', reason: 'coverage' });
    expect(missing.completion.status).toBe('worker-error');
  }, 2 * RUN_LIMIT_MS);

  it('返信の検査中に押した中止は、次の区切りで配送され、結果を出さずに中止で終わる', async () => {
    const { completion, record } = await measure('fan-2826-cancel-during', request([0, 0], [1, 1]), { cancel: 'during' });
    // The click task is queued inside the reply task, before the envelope check and the first slice. It runs when that
    // task ends, ahead of the client's next slice, so the verification is abandoned and nothing partial is applied
    // (exact expectation; r1 recorded 'result' because the whole decode ran inside that one task).
    expect(record.cancelDeliveryMs).not.toBeNull();
    expect(record.cancelDeliveryMs ?? 0).toBeGreaterThanOrEqual(record.blockedMs);
    expect(completion.status).toBe('cancelled');
  }, RUN_LIMIT_MS);

  it('返信が届く前に押した中止は、検査を始めずに中止として終わる（対照）', async () => {
    const { completion, record } = await measure('fan-2826-cancel-before', request([0, 0], [1, 1]), { cancel: 'before' });
    expect(completion.status).toBe('cancelled');
    // The port was terminated before its reply task: no decode ran.
    expect(record.blockedMs).toBe(0);
  }, RUN_LIMIT_MS);

  it('同じ編集状態の古い返信も、別の編集状態の返信も、結果を読む前に捨てる', async () => {
    const input = request([0, 0], [1, 1]);
    // First request (serial 1) gets a small honest reply; the second (serial 2) is answered with a heavy serial-1 reply
    // of the same identity. Since r2 the client compares the envelope's serial before any step of the result decode, so
    // the stale reply costs only the envelope check (r1: the full certificate first, about 898 ms in Root's run).
    const stalePort = new ResponseFixturePort('fan-2826-stale-same-identity', input);
    const stale = new FunctionSurfaceWorkerClient({ createWorker: () => stalePort });
    try {
      await stalePort.ready;
      expect((await stale.evaluate(input, 30_000)).status).toBe('result');
      const monitor = eventLoopMonitor();
      expect((await stale.evaluate(input, 30_000)).status).toBe('worker-error');
      records.set('fan-2826-stale-same-identity', { ...emptyRecord('fan-2826-stale-same-identity', 'worker-error'), blockedMs: stalePort.blockedMs,
        longestGapMs: monitor.stop(), triangles: 2826, cells: 1 });
    } finally { stale.dispose(); await stalePort.close(); }
    const otherPort = new ResponseFixturePort('fan-2826-stale-other-identity', input);
    const other = new FunctionSurfaceWorkerClient({ createWorker: () => otherPort });
    try {
      await otherPort.ready;
      expect((await other.evaluate(input, 30_000)).status).toBe('worker-error');
      records.set('fan-2826-stale-other-identity', { ...emptyRecord('fan-2826-stale-other-identity', 'worker-error'), blockedMs: otherPort.blockedMs, triangles: 2826, cells: 1 });
    } finally { other.dispose(); await otherPort.close(); }
  }, 2 * RUN_LIMIT_MS);

  it('実Workerの細かい曲面（製品の予算）を本物の依頼・実行・返信・検査で通し、結果と費用を記録する', async () => {
    const input = request([-1, -1], [1, 1], 'sin(8*U)*sin(8*V)/8');
    const { completion } = await measure('worker-sin8', input);
    // A genuine Worker reply must never be rejected by its own decoder.
    expect(completion.status).toBe('result');
  }, RUN_LIMIT_MS);

  // Threshold checks, separate from the correctness checks above so that each threshold reports on its own.
  it.each(['fan-2826-accepted', 'fan-2827-over-budget', 'grid-222-legitimate', 'grid-128-slivers-239', 'grid-128-slivers-240',
    'fan-2825-duplicate', 'fan-2826-hole', 'fan-2826-stale-same-identity', 'worker-sin8'])(
    '%s: 1回の同期処理（受信の1タスク）は100ms以内（§5.2の短い処理の境界）', name => {
      const record = records.get(name);
      expect(record).toBeDefined();
      expect(record?.blockedMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(LONG_TASK_LIMIT_MS);
    });

  // Since r2 the decode spans many tasks: the longest event-loop gap over the whole request is held to the same bound.
  it.each(['fan-2826-accepted', 'fan-2827-over-budget', 'grid-222-legitimate', 'grid-128-slivers-239', 'grid-128-slivers-240',
    'fan-2825-duplicate', 'fan-2826-hole', 'fan-2826-cancel-during', 'fan-2826-stale-same-identity', 'worker-sin8'])(
    '%s: 依頼の全体を通してイベントループの最長の停止も100ms以内（§5.2の短い処理の境界）', name => {
      const record = records.get(name);
      expect(record).toBeDefined();
      expect(record?.longestGapMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(LONG_TASK_LIMIT_MS);
    });

  it('検査中に押した中止の配送は1秒以内で、中止として終わる（§5.2の中止表示の境界）', () => {
    const record = records.get('fan-2826-cancel-during');
    expect(record?.cancelDeliveryMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(CANCEL_DELIVERY_LIMIT_MS);
    expect(record?.status).toBe('cancelled');
  });
});

function emptyRecord(scenario: string, status: string): ResponseRecord {
  return { scenario, status, blockedMs: 0, longestGapMs: 0, cancelDeliveryMs: null, replyBytes: 0, heapBeforeBytes: 0, heapAfterBytes: 0,
    rssAfterBytes: 0, triangles: 0, cells: 0, work: null, totalMs: null };
}

function wireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected wire object');
  return value as Record<string, unknown>;
}
function codecFixture() {
  const scenario = fan(4), input = request([0, 0], [1, 1]);
  const poles = identityPoles(scenario.uKnots, scenario.vKnots);
  const certificate = certifySplineAgainstMesh({ ...scenario, poles }, evidence(scenario), input);
  if (certificate.status !== 'certified') throw new Error('Analytic unit square must be covered');
  return { input, reply: { kind: 'function-surface-result', serial: 7, identity: input.identity,
    result: { status: 'ready', vertices: scenario.vertices, triangles: scenario.triangles,
      maximumInterpolationErrorBound: 0, stats: { samples: scenario.vertices.length, cells: 1, triangles: scenario.triangles.length },
      spline: { uKnots: scenario.uKnots, vKnots: scenario.vKnots, poles, errorBound: certificate.splineToMesh } } } };
}

describe('surface transferable wire compatibility and ownership', () => {
  it('round trips the legacy mesh and independently certified spline without changing precision, work or ownership', () => {
    const { input, reply } = codecFixture(), snapshot = structuredClone(reply);
    const legacy = surfaceReply.decodeFunctionSurfaceWorkReply(reply, input);
    const packed = surfaceReply.packFunctionSurfaceWorkReply(reply);
    expect(packed.transfer).toHaveLength(3);
    expect(new Set(packed.transfer).size).toBe(3);
    const delivered: unknown = structuredClone(packed.message, { transfer: packed.transfer });
    expect(packed.transfer.every(buffer => buffer.byteLength === 0)).toBe(true);
    expect(reply).toEqual(snapshot);
    const decoded = surfaceReply.decodeFunctionSurfaceWorkReply(delivered, input);
    expect(decoded).toEqual(legacy);
    expect(decoded).toMatchObject({ serial: 7, identity: input.identity });
    if (decoded.result.status !== 'ready' || decoded.result.spline === undefined) throw new Error('Expected spline');
    expect(certifySplineAgainstMesh(decoded.result.spline, { ...decoded.result, bound: 0 }, input))
      .toEqual(certifySplineAgainstMesh(reply.result.spline, { ...reply.result, bound: 0 }, input));
    const deliveredResult = wireRecord(wireRecord(delivered).result);
    if (!(deliveredResult.vertices instanceof ArrayBuffer)) throw new Error('Expected owned buffer');
    new Float64Array(deliveredResult.vertices).fill(99);
    expect(decoded).toEqual(legacy); // Frozen result must not retain mutable transport storage.
    const repeated = surfaceReply.packFunctionSurfaceWorkReply(reply);
    expect(surfaceReply.decodeFunctionSurfaceWorkReply(repeated.message, input)).toEqual(legacy);
    expect(reply).toEqual(snapshot); // A cached source can be sent again after the first buffers detached.
  });

  it('preserves finite double values and signed zero in a mesh-only reply', () => {
    const { input, reply } = codecFixture();
    const result = { status: 'ready', vertices: reply.result.vertices.map((vertex, index) => ({ ...vertex,
      point: [index === 0 ? -0 : Number.MIN_VALUE, 1 + Number.EPSILON, -Number.MAX_VALUE] })),
      triangles: reply.result.triangles, stats: reply.result.stats, maximumInterpolationErrorBound: 0, splineDeclined: 'bound' };
    const raw = { ...reply, result }, packed = surfaceReply.packFunctionSurfaceWorkReply(raw);
    const decoded = surfaceReply.decodeFunctionSurfaceWorkReply(structuredClone(packed.message, { transfer: packed.transfer }), input);
    expect(decoded).toEqual(surfaceReply.decodeFunctionSurfaceWorkReply(raw, input));
    if (decoded.result.status !== 'ready') throw new Error('Expected mesh');
    expect(Object.is(decoded.result.vertices[0].point[0], -0)).toBe(true);
  });

  it.each([-1, 0.5, 2 ** 32, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects index %s before Uint32 conversion can hide it', invalid => {
      const { reply } = codecFixture();
      const malformed = { ...reply, result: { ...reply.result, triangles: [[invalid, 1, 2], ...reply.result.triangles.slice(1)] } };
      expect(() => surfaceReply.packFunctionSurfaceWorkReply(malformed)).toThrow();
    });

  it.each(['parameter', 'position', 'pole'])( 'rejects a nonfinite %s before encoding', field => {
    const { reply } = codecFixture();
    const result = structuredClone(reply.result);
    if (field === 'pole') result.spline.poles[0] = [0, 0, Number.NaN];
    else result.vertices = [{ parameters: field === 'parameter' ? [Number.NaN, 0] : [0, 0],
      point: field === 'position' ? [0, 0, Number.POSITIVE_INFINITY] : [0, 0, 0] }, ...result.vertices.slice(1)];
    expect(() => surfaceReply.packFunctionSurfaceWorkReply({ ...reply, result })).toThrow();
  });

  it.each(['unknown-version', 'missing-buffer', 'short-buffer', 'partial-row', 'typed-view', 'shared-buffer', 'duplicate-buffer',
    'nonfinite-coordinate', 'out-of-domain', 'bad-index', 'repeated-index', 'missing-poles', 'short-poles', 'nonfinite-pole', 'false-claim'])(
    'rejects malformed packed data (%s) without a legacy fallback', problem => {
      const { input, reply } = codecFixture(), packed = surfaceReply.packFunctionSurfaceWorkReply(reply);
      const result = wireRecord(wireRecord(packed.message).result), spline = wireRecord(result.spline);
      const vertices = result.vertices, triangles = result.triangles, poles = spline.poles;
      if (!(vertices instanceof ArrayBuffer) || !(triangles instanceof ArrayBuffer) || !(poles instanceof ArrayBuffer)) throw new Error('Expected buffers');
      if (problem === 'unknown-version') result.wireVersion = 2;
      if (problem === 'missing-buffer') result.vertices = undefined;
      if (problem === 'short-buffer') result.vertices = new ArrayBuffer(0);
      if (problem === 'partial-row') result.vertices = new ArrayBuffer(vertices.byteLength - 1);
      if (problem === 'typed-view') result.vertices = new Float64Array(vertices);
      if (problem === 'shared-buffer') result.vertices = new SharedArrayBuffer(vertices.byteLength);
      if (problem === 'duplicate-buffer') result.triangles = vertices;
      if (problem === 'nonfinite-coordinate') new Float64Array(vertices)[2] = Number.NaN;
      if (problem === 'out-of-domain') new Float64Array(vertices)[0] = -1;
      if (problem === 'bad-index') new Uint32Array(triangles)[0] = reply.result.vertices.length;
      if (problem === 'repeated-index') new Uint32Array(triangles)[0] = 1;
      if (problem === 'missing-poles') spline.poles = undefined;
      if (problem === 'short-poles') spline.poles = new ArrayBuffer(poles.byteLength - 24);
      if (problem === 'nonfinite-pole') new Float64Array(poles)[0] = Number.POSITIVE_INFINITY;
      if (problem === 'false-claim') spline.errorBound = 0;
      expect(() => surfaceReply.decodeFunctionSurfaceWorkReply(packed.message, input)).toThrow();
    });

  it('does not inspect a stale identity result, and leaves other kinds and non-ready statuses on their existing wire', () => {
    const { input, reply } = codecFixture();
    const stale = { ...reply, identity: { ...input.identity, documentVersion: 2 }, get result(): never { throw new Error('Result inspected'); } };
    expect(() => surfaceReply.beginFunctionSurfaceWorkReply(stale, input)).toThrow('別の編集状態');
    for (const message of [{ kind: 'math-result', buffer: new ArrayBuffer(16) },
      { ...reply, result: { status: 'invalid', message: 'invalid input' } },
      { ...reply, result: { status: 'stopped', reason: 'cancelled', stats: reply.result.stats } }]) {
      const packed = surfaceReply.packFunctionSurfaceWorkReply(message);
      expect(packed.message).toBe(message);
      expect(packed.transfer).toEqual([]);
    }
  });
});

// Same full grid as WB3's failing legacy transport-only control; now the actual product encoder owns the wire.
it('worker boundary packed transport-only grid222 keeps delivery responsive without decoder calls', async () => {
  const input = request([0, 0], [222, 222]);
  const diagnostic = createReplyTimingProbe('packed-transport-only-grid-222');
  const whole = eventLoopMonitor();
  const port = new ResponseFixturePort('grid-222-legitimate', input);
  let receiving: ReturnType<typeof eventLoopMonitor> | undefined;
  let deliveredAt = 0;
  try {
    const metadata = await port.ready;
    receiving = eventLoopMonitor(diagnostic);
    const dispatchedAt = performance.now();
    const payload = await new Promise<unknown>(resolve => {
      port.onmessage = event => { deliveredAt = performance.now(); resolve(event.data); };
      port.postMessage({ serial: 1 });
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    const receivingGapMs = receiving.stop(), wholeGapMs = whole.stop();
    diagnostic.finish();
    process.stdout.write('[pcad:worker-boundary-transport] ' + JSON.stringify({ metadata, dispatchedAt, deliveredAt,
      receivingGapMs, wholeGapMs, handlerMs: port.blockedMs, note: 'Real full packed reply; zero decoder calls; no GC or wait subtraction' }) + String.fromCharCode(10));
    expect(payload).toHaveProperty('result.wireVersion', 1);
    expect(payload).toHaveProperty('result.vertices.byteLength', 49_729 * 5 * 8);
    expect(payload).toHaveProperty('result.triangles.byteLength', 98_568 * 3 * 4);
    expect(payload).toHaveProperty('result.spline.poles.byteLength', 198_916 * 3 * 8);
    expect(receivingGapMs).toBeLessThanOrEqual(LONG_TASK_LIMIT_MS);
    expect(wholeGapMs).toBeLessThanOrEqual(LONG_TASK_LIMIT_MS);
  } finally { receiving?.stop(); whole.stop(); diagnostic.finish(); await port.close(); }
}, RUN_LIMIT_MS);
