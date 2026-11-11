/** Node-only response fixture: generated and certified on a distinct Worker heap, then structured-cloned. */
import { parentPort, threadId, workerData } from 'node:worker_threads';
import { certifySplineAgainstMesh, type SurfaceMeshEvidence } from './smoothFunctionSurface.js';
import { executeFunctionSurfaceWorkRequest, type FunctionSurfaceWorkReply } from './functionSurfaceWorkExecution.js';
import { createMathBackend } from './createMathBackend.js';
import { createFunctionSurfaceWorkEnvelope, type FunctionSurfaceWorkRequest } from './functionSurfaceWorkRequest.js';
import { packFunctionSurfaceWorkReply } from './publicWorker.js';
type Point = readonly [number, number, number];
type Triangle = readonly [number, number, number];
interface Vertex { readonly parameters: readonly [number, number]; readonly point: Point }
interface Scenario { readonly vertices: readonly Vertex[]; readonly triangles: readonly Triangle[]; readonly uKnots: readonly number[]; readonly vKnots: readonly number[] }
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
function reply(scenario: Scenario, input: FunctionSurfaceWorkRequest, serial: number, identity = input.identity): FunctionSurfaceWorkReply {
  const poles = identityPoles(scenario.uKnots, scenario.vKnots);
  const certificate = certifySplineAgainstMesh({ uKnots: scenario.uKnots, vKnots: scenario.vKnots, poles }, evidence(scenario), input);
  const errorBound = certificate.status === 'certified' ? certificate.splineToMesh : input.tolerance;
  return { kind: 'function-surface-result', serial, identity, result: { status: 'ready', vertices: scenario.vertices, triangles: scenario.triangles,
    maximumInterpolationErrorBound: 0, stats: { samples: scenario.vertices.length, cells: 1, triangles: scenario.triangles.length },
    spline: { uKnots: scenario.uKnots, vKnots: scenario.vKnots, poles, errorBound } } };
}


const data = workerData as { readonly scenario: string; readonly input: FunctionSurfaceWorkRequest };
if (parentPort === null) throw new Error('Response fixture must run inside a Worker');
const port = parentPort, started = performance.now();
let prepared: FunctionSurfaceWorkReply;
if (data.scenario === 'worker-sin8') {
  prepared = executeFunctionSurfaceWorkRequest(createFunctionSurfaceWorkEnvelope(1, data.input), createMathBackend());
} else {
  let scenario: Scenario;
  if (data.scenario === 'grid-222-legitimate') scenario = grid(222);
  else if (data.scenario === 'grid-128-slivers-239') scenario = withDiagonalSlivers(grid(128), 128, 239);
  else if (data.scenario === 'grid-128-slivers-240') scenario = withDiagonalSlivers(grid(128), 128, 240);
  else if (data.scenario === 'fan-2827-over-budget') scenario = fan(2827);
  else if (data.scenario === 'fan-2825-duplicate') { const base = fan(2825); scenario = { ...base, triangles: [...base.triangles, base.triangles[0]] }; }
  else if (data.scenario === 'fan-2826-hole') { const base = fan(2826); scenario = { ...base, triangles: base.triangles.slice(0, -1) }; }
  else if (data.scenario.startsWith('fan-2826')) scenario = fan(2826);
  else throw new Error('Unknown response scenario: ' + data.scenario);
  prepared = reply(scenario, data.input, 1);
}
const light = data.scenario === 'fan-2826-stale-same-identity' ? reply(fan(4), data.input, 1) : undefined;
if (data.scenario === 'fan-2826-stale-other-identity') prepared = { ...prepared, identity: { ...prepared.identity, documentVersion: 2 } };
const result = prepared.result;
const certificate = result.status === 'ready' && 'spline' in result && result.spline !== undefined
  ? certifySplineAgainstMesh(result.spline, { vertices: result.vertices, triangles: result.triangles,
    bound: result.maximumInterpolationErrorBound }, data.input) : null;
port.postMessage({ kind: 'fixture-ready', threadId, certificate, preparationMs: performance.now() - started,
  replyBytes: JSON.stringify(prepared).length,
  uKnots: result.status === 'ready' && result.spline !== undefined ? result.spline.uKnots : [],
  vKnots: result.status === 'ready' && result.spline !== undefined ? result.spline.vKnots : [],
  triangles: result.status === 'ready' ? result.triangles.length : 0,
  vertices: result.status === 'ready' ? result.vertices.length : 0,
  cells: result.status === 'ready' && 'spline' in result && result.spline !== undefined
    ? (result.spline.uKnots.length - 1) * (result.spline.vKnots.length - 1) : 0 });
port.on('message', (value: unknown) => {
  if (typeof value !== 'object' || value === null || !('serial' in value) || typeof value.serial !== 'number') throw new Error('Invalid fixture envelope');
  const packed = packFunctionSurfaceWorkReply(light === undefined ? { ...prepared, serial: value.serial } : value.serial === 1 ? light : prepared);
  port.postMessage(packed.message, packed.transfer);
});
