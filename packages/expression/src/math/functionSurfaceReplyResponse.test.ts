/**
 * Responsiveness measurement of the surface reply decoder on the real client path (UNEXECUTED candidate
 * surface-response-r2; the same scenarios, sizes and thresholds as surface-response-r1 8b32f37a…). Requests are decoded by
 * the real FunctionSurfaceWorkerClient and replies arrive as separate tasks from an in-process port. Since r2 the client
 * checks the envelope (kind, serial, identity) in the message task and then decodes and verifies the result with the
 * real beginFunctionSurfaceWorkReply steps in slices of at most CALCULATION_REPLY_SLICE_MS, yielding to the event loop.
 * So the one message task (`blockedMs`) is no longer the whole decode: every threshold check also uses `longestGapMs`,
 * the longest gap seen by a chained zero-delay timer over the whole request, which covers every slice.
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
 * printed as `[pcad:surface-response] {json}` for Root's run log; no number below is a measurement until Root runs it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { decodeFunctionSurfaceWorkRequest, createFunctionSurfaceWorkEnvelope, type FunctionSurfaceWorkRequest } from './functionSurfaceWorkRequest.js';
import { executeFunctionSurfaceWorkRequest } from './functionSurfaceWorkExecution.js';
import { FunctionSurfaceWorkerClient } from './functionSurfaceWorkerClient.js';
import type { CalculationWorkerPort } from './boundedCalculationClient.js';
import { certifySplineAgainstMesh, FUNCTION_SURFACE_SPLINE_PAIR_LIMIT, type SurfaceMeshEvidence } from './smoothFunctionSurface.js';

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

/** An n x n grid of unit cells on [0, n]^2, each split along its own diagonal (legitimate, 2 n^2 triangles). */
function grid(n: number): Scenario {
  const vertices: Vertex[] = [], triangles: Triangle[] = [], at = (i: number, j: number) => i * (n + 1) + j;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) vertices.push(flat(i, j));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) triangles.push([at(i, j), at(i + 1, j), at(i + 1, j + 1)], [at(i, j), at(i + 1, j + 1), at(i, j + 1)]);
  const knots = Array.from({ length: n + 1 }, (_, index) => index);
  return { vertices, triangles, uKnots: knots, vKnots: knots };
}
/** k zero-area triangles along the main diagonal, each with a bounding box over every cell (malicious work amplification). */
function withDiagonalSlivers(base: Scenario, n: number, k: number): Scenario {
  const vertices = [...base.vertices], triangles = [...base.triangles];
  for (let index = 0; index < k; index++) {
    const first = vertices.length;
    vertices.push(flat(0, 0), flat(n, n), flat(n, n));
    triangles.push([first, first + 1, first + 2]);
  }
  return { ...base, vertices, triangles };
}

function evidence(scenario: Scenario): SurfaceMeshEvidence {
  return { vertices: scenario.vertices, triangles: scenario.triangles, bound: 0 };
}
/** The envelope a Worker would post, with the honest recomputed claim so that only the certificate decides. */
function reply(scenario: Scenario, input: FunctionSurfaceWorkRequest, serial: number, identity = input.identity) {
  const poles = identityPoles(scenario.uKnots, scenario.vKnots);
  const certificate = certifySplineAgainstMesh({ uKnots: scenario.uKnots, vKnots: scenario.vKnots, poles }, evidence(scenario), input);
  const errorBound = certificate.status === 'certified' ? certificate.splineToMesh : input.tolerance;
  return { kind: 'function-surface-result', serial, identity, result: { status: 'ready', vertices: scenario.vertices, triangles: scenario.triangles,
    maximumInterpolationErrorBound: 0, stats: { samples: scenario.vertices.length, cells: 1, triangles: scenario.triangles.length },
    spline: { uKnots: scenario.uKnots, vKnots: scenario.vKnots, poles, errorBound } } };
}

/** In-process Worker side: each posted envelope is answered as a separate task by `answer`. */
class ScriptedPort implements CalculationWorkerPort {
  onmessage: CalculationWorkerPort['onmessage'] = null;
  onerror: CalculationWorkerPort['onerror'] = null;
  onmessageerror: CalculationWorkerPort['onmessageerror'] = null;
  blockedMs = 0; delivered = false; deliveredAt: number | null = null;
  private readonly answer: (serial: number) => unknown;
  private readonly beforeDelivery: () => void;
  constructor(answer: (serial: number) => unknown, beforeDelivery: () => void = () => undefined) {
    this.answer = answer; this.beforeDelivery = beforeDelivery;
  }
  postMessage(value: unknown): void {
    const serial = typeof value === 'object' && value !== null && 'serial' in value && typeof value.serial === 'number' ? value.serial : 0;
    const data = this.answer(serial);
    setTimeout(() => {
      const handler = this.onmessage;
      if (handler === null) return;
      this.beforeDelivery();
      const start = performance.now();
      this.deliveredAt = start;
      handler({ data });
      // Only the work done inside this one message task (since r2: the envelope check and the first slice).
      this.blockedMs = performance.now() - start; this.delivered = true;
    }, 0);
  }
  terminate(): void { this.onmessage = null; }
}

/** Chained zero-delay timers: the largest gap between consecutive deliveries is the longest blocked span seen. */
function eventLoopMonitor() {
  let last = performance.now(), longest = 0, running = true;
  const tick = () => {
    const now = performance.now(); longest = Math.max(longest, now - last); last = now;
    if (running) setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
  return { stop: () => { running = false; return longest; } };
}

async function measure(name: string, scenario: Scenario, input: FunctionSurfaceWorkRequest, options: { readonly cancel?: 'during' | 'before' } = {}) {
  // Built before the measured window: the harness's own certificate for the honest claim must not be timed.
  const prepared = reply(scenario, input, 1), payload = (serial: number) => ({ ...prepared, serial });
  let cancelScheduledAt = 0, cancelDeliveredAt: number | null = null;
  const abort = new AbortController();
  const click = () => {
    cancelScheduledAt = performance.now();
    setTimeout(() => { cancelDeliveredAt = performance.now(); abort.abort(); }, 0);
  };
  // 'during': a click queued at the start of the reply task, delivered only when the event loop is free again.
  const port = new ScriptedPort(payload, () => { if (options.cancel === 'during') click(); });
  const client = new FunctionSurfaceWorkerClient({ createWorker: () => port });
  const heapBefore = process.memoryUsage().heapUsed, monitor = eventLoopMonitor();
  // 'before': the click is queued ahead of the reply task the port will queue.
  if (options.cancel === 'before') click();
  try {
    const completion = await client.evaluate(input, 30_000, abort.signal), completedAt = performance.now();
    // Let the queued click (if any) run before reading its delivery time.
    await new Promise(resolve => setTimeout(resolve, 0));
    const longestGap = monitor.stop(), memory = process.memoryUsage();
    const certificate = certifySplineAgainstMesh({ uKnots: scenario.uKnots, vKnots: scenario.vKnots, poles: identityPoles(scenario.uKnots, scenario.vKnots) },
      evidence(scenario), input);
    const record: ResponseRecord = { scenario: name,
      status: completion.status === 'result' ? `result:${completion.result.status}:${'spline' in completion.result ? 'spline' : 'mesh'}` : completion.status,
      blockedMs: port.blockedMs, longestGapMs: longestGap,
      cancelDeliveryMs: cancelDeliveredAt === null ? null : cancelDeliveredAt - cancelScheduledAt,
      replyBytes: JSON.stringify(payload(1)).length, heapBeforeBytes: heapBefore, heapAfterBytes: memory.heapUsed, rssAfterBytes: memory.rss,
      triangles: scenario.triangles.length, cells: (scenario.uKnots.length - 1) * (scenario.vKnots.length - 1),
      work: certificate.status === 'certified' ? certificate.work : null,
      totalMs: port.deliveredAt === null ? null : completedAt - port.deliveredAt };
    records.set(name, record);
    return { completion, record, certificate };
  } finally { monitor.stop(); client.dispose(); }
}

describe('曲面の返信の検査が画面の応答を奪わないかの測定（未実行の候補）', () => {
  it('正当な1区画の扇（細い三角形2,826枚）は検査の仕事量3,997,377で通り、4M直前の最大の受理例になる', async () => {
    expect(fanWork(2826)).toBe(3_997_377); expect(fanWork(2826)).toBeLessThanOrEqual(FUNCTION_SURFACE_SPLINE_PAIR_LIMIT);
    const { completion, certificate } = await measure('fan-2826-accepted', fan(2826), request([0, 0], [1, 1]));
    expect(certificate).toMatchObject({ status: 'certified', work: 3_997_377, coveredCells: 1 });
    expect(completion).toMatchObject({ status: 'result', result: { status: 'ready', spline: { uKnots: [0, 1] } } });
  }, RUN_LIMIT_MS);

  it('2,827枚の扇は仕事量4,000,205となり上限を超えるので、返信全体を拒否する', async () => {
    expect(fanWork(2827)).toBe(4_000_205);
    const { completion, certificate } = await measure('fan-2827-over-budget', fan(2827), request([0, 0], [1, 1]));
    expect(certificate).toMatchObject({ status: 'rejected', reason: 'budget' });
    expect(completion.status).toBe('worker-error');
  }, RUN_LIMIT_MS);

  it('正当な細分割（222×222区画・三角形98,568枚、製品の予算内）は仕事量246,420で通る', async () => {
    const scenario = grid(222);
    expect(scenario.triangles.length).toBe(98_568); expect(scenario.vertices.length).toBe(49_729);
    expect(4 * scenario.uKnots.length * scenario.vKnots.length).toBe(198_916);
    const { completion, certificate } = await measure('grid-222-legitimate', scenario, request([0, 0], [222, 222]));
    // Each triangle meets only its own cell: 98,568 first-pass clips + 98,568 member clips + 49,284 overlap tests.
    expect(certificate).toMatchObject({ status: 'certified', work: 246_420, coveredCells: 49_284 });
    expect(completion).toMatchObject({ status: 'result', result: { status: 'ready' } });
  }, RUN_LIMIT_MS);

  // A 128 x 128 grid keeps every clip of the diagonal slivers exact (dyadic coordinates), so their clips have area 0
  // exactly and they are never members: each costs exactly its 16,384 first-pass units and nothing else.
  it('面積0の対角の三角形239枚で仕事量を3,997,696まで膨らませた悪意の返信は、上限内なので受理され、その費用を記録する', async () => {
    const scenario = withDiagonalSlivers(grid(128), 128, 239);
    expect(scenario.triangles.length).toBe(32_768 + 239);
    const { completion, certificate } = await measure('grid-128-slivers-239', scenario, request([0, 0], [128, 128]));
    // (5 + 239) * 16,384: the legitimate grid costs 5 units per cell, each sliver one unit per cell.
    expect(certificate).toMatchObject({ status: 'certified', work: 3_997_696, coveredCells: 16_384 });
    expect(completion).toMatchObject({ status: 'result', result: { status: 'ready' } });
  }, RUN_LIMIT_MS);

  it('240枚では仕事量が4,014,080となり、上限で拒否する', async () => {
    const { completion, certificate } = await measure('grid-128-slivers-240', withDiagonalSlivers(grid(128), 128, 240), request([0, 0], [128, 128]));
    expect(certificate).toMatchObject({ status: 'rejected', reason: 'budget' });
    expect(completion.status).toBe('worker-error');
  }, RUN_LIMIT_MS);

  it('重複・穴のある悪意の返信は、全ての組を調べ終えてから拒否する（拒否までの費用を記録）', async () => {
    // 2,825 fan triangles plus a copy of the first: 2,826 triangles, the same 3,997,377 units, then 'overlap'.
    const base = fan(2825), duplicate = { ...base, triangles: [...base.triangles, base.triangles[0]] };
    const overlap = await measure('fan-2825-duplicate', duplicate, request([0, 0], [1, 1]));
    expect(overlap.certificate).toMatchObject({ status: 'rejected', reason: 'overlap' });
    expect(overlap.completion.status).toBe('worker-error');
    // 2,826 fan triangles without the last: 2,825 triangles, 2 * 2,825 + 2,825 * 2,824 / 2 = 3,994,550 units, then 'coverage'.
    const full = fan(2826), hole = { ...full, triangles: full.triangles.slice(0, -1) };
    const missing = await measure('fan-2826-hole', hole, request([0, 0], [1, 1]));
    expect(missing.certificate).toMatchObject({ status: 'rejected', reason: 'coverage' });
    expect(missing.completion.status).toBe('worker-error');
  }, 2 * RUN_LIMIT_MS);

  it('返信の検査中に押した中止は、次の区切りで配送され、結果を出さずに中止で終わる', async () => {
    const { completion, record } = await measure('fan-2826-cancel-during', fan(2826), request([0, 0], [1, 1]), { cancel: 'during' });
    // The click task is queued inside the reply task, before the envelope check and the first slice. It runs when that
    // task ends, ahead of the client's next slice, so the verification is abandoned and nothing partial is applied
    // (exact expectation; r1 recorded 'result' because the whole decode ran inside that one task).
    expect(record.cancelDeliveryMs).not.toBeNull();
    expect(record.cancelDeliveryMs ?? 0).toBeGreaterThanOrEqual(record.blockedMs);
    expect(completion.status).toBe('cancelled');
  }, RUN_LIMIT_MS);

  it('返信が届く前に押した中止は、検査を始めずに中止として終わる（対照）', async () => {
    const { completion, record } = await measure('fan-2826-cancel-before', fan(2826), request([0, 0], [1, 1]), { cancel: 'before' });
    expect(completion.status).toBe('cancelled');
    // The port was terminated before its reply task: no decode ran.
    expect(record.blockedMs).toBe(0);
  }, RUN_LIMIT_MS);

  it('同じ編集状態の古い返信も、別の編集状態の返信も、結果を読む前に捨てる', async () => {
    const input = request([0, 0], [1, 1]), heavy = fan(2826);
    // First request (serial 1) gets a small honest reply; the second (serial 2) is answered with a heavy serial-1 reply
    // of the same identity. Since r2 the client compares the envelope's serial before any step of the result decode, so
    // the stale reply costs only the envelope check (r1: the full certificate first, about 898 ms in Root's run).
    const light = reply(fan(4), input, 1), heavyStale = reply(heavy, input, 1);
    const stalePort = new ScriptedPort(serial => serial === 1 ? light : heavyStale);
    const stale = new FunctionSurfaceWorkerClient({ createWorker: () => stalePort });
    try {
      expect((await stale.evaluate(input, 30_000)).status).toBe('result');
      const monitor = eventLoopMonitor();
      expect((await stale.evaluate(input, 30_000)).status).toBe('worker-error');
      records.set('fan-2826-stale-same-identity', { ...emptyRecord('fan-2826-stale-same-identity', 'worker-error'), blockedMs: stalePort.blockedMs,
        longestGapMs: monitor.stop(), triangles: 2826, cells: 1 });
    } finally { stale.dispose(); }
    const foreign = reply(heavy, input, 1, { ...input.identity, documentVersion: 2 });
    const otherPort = new ScriptedPort(serial => ({ ...foreign, serial }));
    const other = new FunctionSurfaceWorkerClient({ createWorker: () => otherPort });
    try {
      expect((await other.evaluate(input, 30_000)).status).toBe('worker-error');
      records.set('fan-2826-stale-other-identity', { ...emptyRecord('fan-2826-stale-other-identity', 'worker-error'), blockedMs: otherPort.blockedMs, triangles: 2826, cells: 1 });
    } finally { other.dispose(); }
  }, 2 * RUN_LIMIT_MS);

  it('実Workerの細かい曲面（製品の予算）を本物の依頼・実行・返信・検査で通し、結果と費用を記録する', async () => {
    const input = request([-1, -1], [1, 1], 'sin(8*U)*sin(8*V)/8');
    const executionStart = performance.now();
    const executed = executeFunctionSurfaceWorkRequest(createFunctionSurfaceWorkEnvelope(1, input), backend);
    const executionMs = performance.now() - executionStart;
    const port = new ScriptedPort(serial => ({ ...executed, serial }));
    const client = new FunctionSurfaceWorkerClient({ createWorker: () => port }), monitor = eventLoopMonitor();
    try {
      const completion = await client.evaluate(input, 30_000);
      const result = executed.result;
      const work = result.status === 'ready' && result.spline !== undefined
        ? certifySplineAgainstMesh(result.spline, { vertices: result.vertices, triangles: result.triangles, bound: result.maximumInterpolationErrorBound }, input)
        : null;
      records.set('worker-sin8', { ...emptyRecord('worker-sin8', completion.status === 'result'
        ? `result:${completion.result.status}:${'spline' in completion.result ? 'spline' : 'splineDeclined' in completion.result ? `declined-${String(completion.result.splineDeclined)}` : 'mesh'}; workerExecutionMs=${executionMs}`
        : completion.status), blockedMs: port.blockedMs, longestGapMs: monitor.stop(), replyBytes: JSON.stringify(executed).length,
        triangles: result.status === 'ready' ? result.triangles.length : 0,
        cells: result.status === 'ready' && result.spline !== undefined ? (result.spline.uKnots.length - 1) * (result.spline.vKnots.length - 1) : 0,
        work: work !== null && work.status === 'certified' ? work.work : null });
      // A genuine Worker reply must never be rejected by its own decoder.
      expect(completion.status).toBe('result');
    } finally { monitor.stop(); client.dispose(); }
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
