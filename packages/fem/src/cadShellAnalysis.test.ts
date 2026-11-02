import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSubShapeReference, requestAnalysisBoundary, type AnalysisBoundary, type AnalysisBoundaryMesh,
  type AnalysisBoundarySource, type FaceSurfaceKind, type SolidBody, type SubShapeOrigin, type SubShapeRef } from '@pointercad/model';
import { createShellCadSavedInput, solidCadFaceKey, type ShellCadSavedInput } from '@pointercad/model/beam-analysis';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '../../test-utils/src/releasePerformance.js';
import { analyzeCadShell, CadShellAnalysisRefusal, decodeCadShellAnalysis, distributeShellEdgeLoad, prepareCadShellAnalysis,
  type CadShellAnalysisResult, type CadShellPrepared, type CadShellSettings } from './cadShellAnalysis.js';
import type { CadShellSurfaceOptions } from './cadShellSurfaceMesh.js';
import type { CadTetraContext } from './cadTetraMesh.js';
import { isLoader, isRuntime, type PyodideRuntime } from './runtime.js';
import type { ShellVector3 } from './shellAnalysisModel.js';
import type { ShellAnalysisPlan, ShellNodal6, ShellTensor6 } from './shellTranslation.js';

// CAD sheet -> explicit midsurface -> unchanged W08 TR_SHELL02 path -> results keyed by the CAD faces.
// The sheets below are independent topology/geometry fixtures with semantic origins, not a claim of actual OCCT output;
// the native answers are the bundled OOFEM (no network). N-mm-MPa-rad.
const assets = fileURLToPath(new URL('../runtime/assets/', import.meta.url));
const wheel = 'oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl';
const manifest: unknown = JSON.parse(readFileSync(new URL('../runtime/manifest.json', import.meta.url), 'utf8'));
function verified(name: string): Uint8Array {
  if (typeof manifest !== 'object' || manifest === null || !('files' in manifest)
    || typeof manifest.files !== 'object' || manifest.files === null) throw new Error('Invalid runtime manifest');
  const pin: unknown = Object.entries(manifest.files).find(([key]) => key === `assets/${name}`)?.[1];
  if (typeof pin !== 'object' || pin === null || !('sha256' in pin) || !('bytes' in pin)) throw new Error(`Unpinned ${name}`);
  const bytes = new Uint8Array(readFileSync(join(assets, name)));
  expect({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    .toEqual({ bytes: pin.bytes, sha256: pin.sha256 });
  return bytes;
}
let runtime: PyodideRuntime | undefined;
let denied = 0;
const originalFetch = globalThis.fetch;
const measured: Record<string, number> = {};
function record(name: string, value: number): number { measured[name] = Math.max(measured[name] ?? 0, value); return value; }
/** The fixed native wrapper (shellAnalysis.py, OOFEM TR_SHELL02) on the translated plan. */
function runNative(plan: ShellAnalysisPlan): unknown {
  if (runtime === undefined) throw new Error('No packaged Pyodide runtime');
  runtime.FS.writeFile('/pcad_fem/shell-input.json', JSON.stringify(plan));
  const encoded = runtime.runPython(`
from shellAnalysis import run_shell_analysis
run_shell_analysis()
`);
  if (typeof encoded !== 'string') throw new Error('No native shell result');
  const raw: unknown = JSON.parse(encoded);
  return raw;
}
beforeAll(async () => {
  for (const name of ['package.json', 'pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip',
    'pyodide-lock.json', 'numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl', wheel]) verified(name);
  globalThis.fetch = () => { denied += 1; return Promise.reject(new Error('cad-shell: offline request denied')); };
  const loader: unknown = await import(/* @vite-ignore */ pathToFileURL(join(assets, 'pyodide.mjs')).href);
  if (!isLoader(loader)) throw new Error('Invalid packaged Pyodide loader');
  const loaded = await loader.loadPyodide({ indexURL: assets + sep, packageBaseUrl: assets + sep, packageCacheDir: assets,
    lockFileContents: readFileSync(join(assets, 'pyodide-lock.json'), 'utf8'), stdLibURL: join(assets, 'python_stdlib.zip'),
    packages: ['numpy'], fullStdLib: false, stdout: () => undefined, stderr: () => undefined });
  if (!isRuntime(loaded)) throw new Error('Invalid packaged Pyodide runtime');
  runtime = loaded;
  await runtime.loadPackage(join(assets, wheel).split(sep).join('/'), { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/shellAnalysis.py', readFileSync(new URL('./shellAnalysis.py', import.meta.url)));
  runtime.runPython(`
import sys
sys.path.insert(0, '/pcad_fem')
`);
}, FUNCTIONAL_TEST_TIMEOUT_MS);
afterAll(() => {
  globalThis.fetch = originalFetch;
  process.stdout.write(`CAD_SHELL ${JSON.stringify(measured)}\n`);
});

type Triangle = [number, number, number];
type FaceRole = 'bottom' | 'top' | 'front' | 'back' | 'left' | 'right';
type EdgeRole = 'bottom-front' | 'bottom-back' | 'bottom-left' | 'bottom-right' | 'top-front' | 'top-back' | 'top-left'
  | 'top-right' | 'front-left' | 'front-right' | 'back-left' | 'back-right';
type VertexRole = 'bottom-front-left' | 'bottom-front-right' | 'bottom-back-left' | 'bottom-back-right' | 'top-front-left'
  | 'top-front-right' | 'top-back-left' | 'top-back-right';
const faceOrigin = (featureId: string, role: FaceRole): SubShapeOrigin =>
  ({ version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId, role } });
const edgeOrigin = (featureId: string, role: EdgeRole): SubShapeOrigin =>
  ({ version: 1, shapeKind: 'edge', identity: { kind: 'box-edge', featureId, role } });
const vertexOrigin = (featureId: string, role: VertexRole): SubShapeOrigin =>
  ({ version: 1, shapeKind: 'vertex', identity: { kind: 'box-vertex', featureId, role } });
interface Sheet {
  readonly featureId: string;
  readonly bodyKind: 'shell' | 'solid';
  readonly points: readonly ShellVector3[];
  readonly triangles: readonly Triangle[];
  readonly triangleFaces: readonly number[];
  readonly faces: readonly { readonly surfaceKind: FaceSurfaceKind; readonly origin: SubShapeOrigin }[];
  readonly edges: readonly { readonly origin: SubShapeOrigin; readonly nodes: readonly number[] }[];
  readonly vertices: readonly { readonly origin: SubShapeOrigin; readonly node: number }[];
}
const sub = (a: ShellVector3, b: ShellVector3): ShellVector3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: ShellVector3, b: ShellVector3): ShellVector3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: ShellVector3): number => Math.hypot(a[0], a[1], a[2]);

function bodyOf(sheet: Sheet): SolidBody {
  const p = sheet.points, area = ([a, b, c]: Triangle): number => norm(cross(sub(p[b], p[a]), sub(p[c], p[a]))) / 2;
  const faces = sheet.faces.map((face, index) => {
    const owned = sheet.triangles.filter((_, t) => sheet.triangleFaces[t] === index);
    const nodes = [...new Set(owned.flat())];
    const mean = (axis: number): number => nodes.reduce((sum, node) => sum + p[node][axis], 0) / nodes.length;
    const centroid: ShellVector3 = [mean(0), mean(1), mean(2)];
    const [a, b, c] = owned[0], normal = cross(sub(p[b], p[a]), sub(p[c], p[a])), size = norm(normal);
    const axis: ShellVector3 | null = face.surfaceKind === 'plane' ? [normal[0] / size, normal[1] / size, normal[2] / size] : null;
    return { index, surfaceKind: face.surfaceKind, area: owned.reduce((sum, t) => sum + area(t), 0), centroid, axis,
      radius: null, triangleOffset: 0, triangleCount: owned.length };
  });
  return { featureId: sheet.featureId, bodyKind: sheet.bodyKind, isValid: true, volume: sheet.bodyKind === 'solid' ? 1000 : 0,
    mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(),
      edgePositions: new Float32Array(), triangleCount: 0 }, threadMarks: [], faces,
    edges: sheet.edges.map((edge, index) => {
      const start = p[edge.nodes[0]], end = p[edge.nodes[edge.nodes.length - 1]], chord = sub(end, start);
      const length = edge.nodes.slice(1).reduce((sum, node, k) => sum + norm(sub(p[node], p[edge.nodes[k]])), 0);
      return { index, curveKind: 'line' as const, length, start, end, radius: null, segmentOffset: 0, segmentCount: 0,
        midpoint: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2] as const,
        axis: [chord[0] / norm(chord), chord[1] / norm(chord), chord[2] / norm(chord)] as const };
    }),
    vertices: sheet.vertices.map((vertex, index) => ({ index, position: p[vertex.node] })),
    origins: { version: 1, state: 'tracked', bindings: [
      ...sheet.faces.map((face, index) => ({ origin: face.origin, state: 'unique' as const, current: { kind: 'face' as const, index } })),
      ...sheet.edges.map((edge, index) => ({ origin: edge.origin, state: 'unique' as const, current: { kind: 'edge' as const, index } })),
      ...sheet.vertices.map((vertex, index) => ({ origin: vertex.origin, state: 'unique' as const,
        current: { kind: 'vertex' as const, index } }))] } };
}
function meshOf(sheet: Sheet): AnalysisBoundaryMesh {
  const vertexNodes = new Set(sheet.vertices.map(vertex => vertex.node)), edgeNodes = new Set(sheet.edges.flatMap(edge => edge.nodes));
  return { units: 'mm', boundary: 'open', coordinates: Float64Array.from(sheet.points.flat()),
    nodeKinds: Uint8Array.from(sheet.points.map((_, node) => vertexNodes.has(node) ? 0 : edgeNodes.has(node) ? 1 : 2)),
    triangles: Uint32Array.from(sheet.triangles.flat()), triangleFaces: Uint32Array.from(sheet.triangleFaces),
    nodeCount: sheet.points.length, triangleCount: sheet.triangles.length,
    faces: sheet.faces.map((_, index) => ({ index, triangleCount: sheet.triangleFaces.filter(face => face === index).length,
      reversed: false, seamEdges: 0, degeneratedEdges: 0, collapsedPoleTriangles: 0 })),
    edges: sheet.edges.map((edge, index) => ({ index, degenerated: false, uses: 1, nodes: [...edge.nodes] })),
    // Deliberately unrelated reported metrics: the preparer measures the actual buffers itself.
    metrics: { totalAreaMm2: 999, signedVolumeMm3: 0, minTriangleAreaMm2: 999, maxTriangleAreaMm2: 999,
      minAngleDeg: 60, maxAngleDeg: 60, maxBoundNodeOffsetMm: 0, freeEdges: 99, components: 99 },
    mesher: { done: true, status: 0 }, deflection: { linear: 0.05, angular: 0.2 } };
}
function contextOf(sheet: Sheet, change: (body: SolidBody) => SolidBody = body => body): CadTetraContext {
  const body = change(bodyOf(sheet));
  return { documentId: 'part', revision: 3, body, steps: [{ featureId: sheet.featureId, key: `${sheet.featureId}:3` }] };
}
function kernelOf(sheet: Sheet, calls: unknown[] = []): AnalysisBoundarySource {
  return { buildAnalysisSurfaceMesh: request => { calls.push(request); return Promise.resolve({ kind: 'mesh', bodyKey: request.bodyKey, mesh: meshOf(sheet) }); } };
}
async function boundaryOf(sheet: Sheet, context: CadTetraContext): Promise<AnalysisBoundary> {
  const result = await requestAnalysisBoundary(kernelOf(sheet), context.steps, context.body,
    { boundary: 'open', linearDeflection: 0.05, angularDeflection: 0.2 });
  if (result.kind !== 'ready') throw new Error(result.message);
  return result.boundary;
}
function ref(body: SolidBody, kind: 'face' | 'edge' | 'vertex', index: number): SubShapeRef {
  const reference = createSubShapeReference(body, kind, index);
  if (reference === null) throw new Error(`No persistent ${kind} ${index}`);
  return reference;
}

const E = 210000, NU = 0.3, T = 2, M = 100, TWIST = 50, TOLERANCE = 1e-3;
const PLATE = { length: 40, width: 30, nx: 4, ny: 3 };
const MOVES: readonly (readonly [number, number])[] = [[0, 0], [1.2, -0.8], [-0.8, 1.2], [1, 0.6]];
const OPTIONS: CadShellSurfaceOptions = { linearDeflection: 0.05, angularDeflection: 0.2, maximumNodes: 1000,
  maximumTriangles: 2000, minimumTriangleAreaMm2: 1, minimumAngleDeg: 20, maximumAspectRatio: 4 };
/** 4 x 3 cells of 10 mm, two counter-clockwise triangles each (alternating diagonals): normal +Z, the top side. */
function grid(moved: boolean): { points: ShellVector3[]; triangles: Triangle[]; at: (i: number, j: number) => number } {
  const { length, width, nx, ny } = PLATE, at = (i: number, j: number): number => j * (nx + 1) + i;
  const points: ShellVector3[] = [];
  for (let j = 0; j <= ny; j += 1) for (let i = 0; i <= nx; i += 1) {
    const [dx, dy] = moved && i > 0 && i < nx && j > 0 && j < ny ? MOVES[i] : [0, 0];
    points.push([i * length / nx + dx, j * width / ny + dy, 0]);
  }
  const triangles: Triangle[] = [];
  for (let j = 0; j < ny; j += 1) for (let i = 0; i < nx; i += 1) {
    const [a, b, c, d] = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
    const pair: Triangle[] = (i + j) % 2 === 0 ? [[a, b, c], [a, c, d]] : [[a, b, d], [b, c, d]];
    triangles.push(...pair);
  }
  return { points, triangles, at };
}
const range = (from: number, to: number): number[] =>
  Array.from({ length: Math.abs(to - from) + 1 }, (_, k) => from + Math.sign(to - from) * k);
/** One planar face, edges 0 (y=0), 1 (x=L), 2 (y=W), 3 (x=0); vertices 0 (0,0), 1 (L,0), 2 (L,W), 3 (0,W). */
function singlePlate(featureId = 'plate-sheet'): Sheet {
  const { points, triangles, at } = grid(true), { nx, ny } = PLATE;
  return { featureId, bodyKind: 'shell', points, triangles, triangleFaces: triangles.map(() => 0),
    faces: [{ surfaceKind: 'plane', origin: faceOrigin(featureId, 'top') }],
    edges: [{ origin: edgeOrigin(featureId, 'top-front'), nodes: range(0, nx).map(i => at(i, 0)) },
      { origin: edgeOrigin(featureId, 'top-right'), nodes: range(0, ny).map(j => at(nx, j)) },
      { origin: edgeOrigin(featureId, 'top-back'), nodes: range(nx, 0).map(i => at(i, ny)) },
      { origin: edgeOrigin(featureId, 'top-left'), nodes: range(ny, 0).map(j => at(0, j)) }],
    vertices: [{ origin: vertexOrigin(featureId, 'top-front-left'), node: at(0, 0) },
      { origin: vertexOrigin(featureId, 'top-front-right'), node: at(nx, 0) },
      { origin: vertexOrigin(featureId, 'top-back-right'), node: at(nx, ny) },
      { origin: vertexOrigin(featureId, 'top-back-left'), node: at(0, ny) }] };
}
/** Two planar faces split at x = 20 (cells i < 2 and i >= 2); face 1 optionally folded up by `foldDeg` about x = 20.
 * Edges 0/1 (y=0), 2 (x=L), 3/4 (y=W), 5 (x=0), 6 (x=20, shared); vertices 0 (0,0), 1 (20,0), 2 (L,0), 3 (L,W), 4 (20,W), 5 (0,W). */
function splitPlate(foldDeg = 0, featureId = 'split-sheet'): Sheet {
  const { points: flat, triangles, at } = grid(false), { nx, ny } = PLATE, angle = foldDeg * Math.PI / 180;
  const points = flat.map(([x, y]): ShellVector3 => x <= 20 ? [x, y, 0] : [20 + (x - 20) * Math.cos(angle), y, (x - 20) * Math.sin(angle)]);
  const triangleFaces = triangles.map((_, t) => (Math.floor(t / 2) % nx < 2 ? 0 : 1));
  return { featureId, bodyKind: 'shell', points, triangles, triangleFaces,
    faces: [{ surfaceKind: 'plane', origin: faceOrigin(featureId, 'top') }, { surfaceKind: 'plane', origin: faceOrigin(featureId, 'bottom') }],
    edges: [{ origin: edgeOrigin(featureId, 'top-front'), nodes: range(0, 2).map(i => at(i, 0)) },
      { origin: edgeOrigin(featureId, 'bottom-front'), nodes: range(2, nx).map(i => at(i, 0)) },
      { origin: edgeOrigin(featureId, 'top-right'), nodes: range(0, ny).map(j => at(nx, j)) },
      { origin: edgeOrigin(featureId, 'top-back'), nodes: range(nx, 2).map(i => at(i, ny)) },
      { origin: edgeOrigin(featureId, 'bottom-back'), nodes: range(2, 0).map(i => at(i, ny)) },
      { origin: edgeOrigin(featureId, 'top-left'), nodes: range(ny, 0).map(j => at(0, j)) },
      { origin: edgeOrigin(featureId, 'front-left'), nodes: range(0, ny).map(j => at(2, j)) }],
    vertices: [{ origin: vertexOrigin(featureId, 'top-front-left'), node: at(0, 0) },
      { origin: vertexOrigin(featureId, 'bottom-front-left'), node: at(2, 0) },
      { origin: vertexOrigin(featureId, 'top-front-right'), node: at(nx, 0) },
      { origin: vertexOrigin(featureId, 'top-back-right'), node: at(nx, ny) },
      { origin: vertexOrigin(featureId, 'bottom-back-left'), node: at(2, ny) },
      { origin: vertexOrigin(featureId, 'top-back-left'), node: at(0, ny) }] };
}
/** A closed 10 mm box solid (faces bottom, top, front, back, left, right): never a midsurface. */
function boxSolid(): Sheet {
  const points: ShellVector3[] = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
  const triangles: Triangle[] = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2],
    [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]];
  const roles: FaceRole[] = ['bottom', 'top', 'front', 'back', 'left', 'right'];
  return { featureId: 'box', bodyKind: 'solid', points, triangles, triangleFaces: triangles.map((_, t) => Math.floor(t / 2)),
    faces: roles.map(role => ({ surfaceKind: 'plane' as const, origin: faceOrigin('box', role) })), edges: [], vertices: [] };
}
function savedFor(context: CadTetraContext, faces: readonly number[], offsetMm = 0): ShellCadSavedInput {
  return createShellCadSavedInput({ documentId: context.documentId, bodyFeatureId: context.body.featureId,
    faces: faces.map(index => ref(context.body, 'face', index)), thicknessMm: T, offsetMm });
}
/** W08's pure-bending loads on the CAD edges: +m about +y on x = L, -m about y on x = 0, three-point support. */
function bendingSettings(body: SolidBody, saved: ShellCadSavedInput, at: { right: number; left: number;
  origin: number; far: number; corner: number }): CadShellSettings {
  return { saved, material: { id: 'steel', youngMPa: E, poisson: NU }, surface: OPTIONS,
    supports: [{ kind: 'vertex', vertex: ref(body, 'vertex', at.origin), fixed: [true, true, true, false, false, false] },
      { kind: 'vertex', vertex: ref(body, 'vertex', at.far), fixed: [true, false, true, false, false, false] },
      { kind: 'vertex', vertex: ref(body, 'vertex', at.corner), fixed: [false, false, true, false, false, false] }],
    edgeLoads: [{ edge: ref(body, 'edge', at.right), forceNPerMm: [0, 0, 0], momentNmmPerMm: [0, M, 0] },
      { edge: ref(body, 'edge', at.left), forceNPerMm: [0, 0, 0], momentNmmPerMm: [0, -M, 0] }] };
}
const SINGLE = { right: 1, left: 3, origin: 0, far: 3, corner: 1 };
const SPLIT = { right: 2, left: 5, origin: 0, far: 5, corner: 2 };
function relative(pairs: readonly (readonly [number, number])[], scale: number): number {
  expect(scale).toBeGreaterThan(0);
  return Math.max(...pairs.map(([value, exact]) => Math.abs(value - exact))) / scale;
}
const tensorPairs = (actual: ShellTensor6, exact: ShellTensor6): [number, number][] => actual.map((v, i): [number, number] => [v, exact[i]]);
function snapshot(...values: unknown[]): string { return JSON.stringify(values); }
function refusal(run: () => unknown): CadShellAnalysisRefusal {
  try {
    run();
  } catch (error) {
    if (error instanceof CadShellAnalysisRefusal) return error;
    throw error;
  }
  throw new Error('Expected a CAD shell refusal');
}
async function solved(sheet: Sheet, context: CadTetraContext, settings: CadShellSettings):
  Promise<{ prepared: CadShellPrepared; result: CadShellAnalysisResult }> {
  const prepared = prepareCadShellAnalysis(await boundaryOf(sheet, context), context, settings);
  return { prepared, result: decodeCadShellAnalysis(prepared, runNative(prepared.plan)) };
}
/** Independent expectation of the face of every element and node, from the fixture's own triangle -> face table. */
function expectFaceBinding(sheet: Sheet, context: CadTetraContext, result: CadShellAnalysisResult): void {
  const keys = sheet.faces.map((_, index) => solidCadFaceKey(ref(context.body, 'face', index)));
  expect(result.elements).toHaveLength(sheet.triangles.length);
  result.elements.forEach((element, index) => {
    expect(element.element).toBe(index);
    expect(element.faceKey).toBe(keys[sheet.triangleFaces[index]]);
    expect(element.nodes).toEqual(sheet.triangles[index]);
    expect(element.points).toHaveLength(4);
    element.nodes.forEach((node, k) => expect(element.displacement[k]).toEqual(result.shell.displacement[node]));
  });
  expect(new Set(result.elements.map(element => element.faceKey))).toEqual(new Set(result.saved.midsurfaceFaces));
  expect(new Set(result.faces.map(face => face.faceKey))).toEqual(new Set(keys));
  for (const face of result.faces) {
    const index = keys.indexOf(face.faceKey);
    expect(face.elements).toEqual(sheet.triangleFaces.flatMap((owner, t) => owner === index ? [t] : []));
  }
  expect(result.faces.flatMap(face => face.elements).sort((a, b) => a - b)).toEqual(sheet.triangles.map((_, t) => t));
  result.nodes.forEach((node, index) => {
    const owners = [...new Set(sheet.triangles.flatMap((triangle, t) => triangle.includes(index) ? [keys[sheet.triangleFaces[t]]] : []))].sort();
    expect(node.faceKeys).toEqual(owners);
    expect(node.displacement).toEqual(result.shell.displacement[index]);
  });
}

describe('CAD sheet -> explicit midsurface -> native TR_SHELL02 -> results keyed by the CAD faces', () => {
  it('40 x 30 plate, t = 2, W08 pure bending: top/bottom = +/-6m/t^2 within 1e-3 and every element on its CAD face', async () => {
    const sheet = singlePlate(), context = contextOf(sheet), saved = savedFor(context, [0]);
    const settings = bendingSettings(context.body, saved, SINGLE), boundary = await boundaryOf(sheet, context);
    const before = snapshot(boundary, context, settings);
    const prepared = prepareCadShellAnalysis(boundary, context, settings);
    expect(snapshot(boundary, context, settings)).toBe(before);
    expect(prepared.input.elements.every(element => element.thicknessMm === T && element.offsetMm === 0)).toBe(true);
    expect(prepared.input.constraints).toEqual([{ node: 0, fixed: [true, true, true, false, false, false] },
      { node: 4, fixed: [false, false, true, false, false, false] }, { node: 15, fixed: [true, false, true, false, false, false] }]);
    const result = decodeCadShellAnalysis(prepared, runNative(prepared.plan));
    expect(denied).toBe(0);
    expect(result.shell.element).toEqual({ record: 'tr_shell02', className: 'TR_SHELL02', crossSection: 'SimpleCrossSection' });
    expectFaceBinding(sheet, context, result);
    const surface = 6 * M / T ** 2;
    for (const element of result.elements) for (const point of element.points) {
      expect(record('bendingTop', relative(tensorPairs(point.topMPa, [surface, 0, 0, 0, 0, 0]), surface))).toBeLessThanOrEqual(TOLERANCE);
      expect(record('bendingBottom', relative(tensorPairs(point.bottomMPa, [-surface, 0, 0, 0, 0, 0]), surface))).toBeLessThanOrEqual(TOLERANCE);
      expect(point.referenceXyzMm).toEqual(point.xyzMm);
    }
    const k = 12 * M / (E * T ** 3), { length, width } = PLATE;
    const w = (x: number, y: number): number => -k * x * (x - length) / 2 + NU * k * y * (y - width) / 2;
    expect(record('bendingW', relative(result.nodes.map((node): [number, number] =>
      [node.displacement[2], w(node.xyzMm[0], node.xyzMm[1])]), Math.max(...result.nodes.map(node => Math.abs(w(node.xyzMm[0], node.xyzMm[1]))))))).toBeLessThanOrEqual(TOLERANCE);
    measured.bendingTopSample = result.elements[0].points[0].topMPa[0];
    measured.bendingExactSurface = surface;
  });

  it('places the midsurface explicitly at the face + offset * normal: positions shift by the offset, the answer does not', async () => {
    const sheet = singlePlate(), context = contextOf(sheet);
    const flat = await solved(sheet, context, bendingSettings(context.body, savedFor(context, [0]), SINGLE));
    const offset = await solved(sheet, context, bendingSettings(context.body, savedFor(context, [0], 1.5), SINGLE));
    expect(offset.prepared.midsurface).toEqual({ offsetMm: 1.5, shiftMm: [0, 0, 1.5] });
    expect(offset.result.midsurface).toEqual({ offsetMm: 1.5, shiftMm: [0, 0, 1.5] });
    expect(offset.prepared.input.elements.every(element => element.offsetMm === 0)).toBe(true);
    offset.result.nodes.forEach((node, index) => {
      expect(node.referenceXyzMm).toEqual(sheet.points[index]);
      expect(node.xyzMm).toEqual([sheet.points[index][0], sheet.points[index][1], sheet.points[index][2] + 1.5]);
    });
    offset.result.elements.forEach((element, index) => element.points.forEach((point, p) => {
      const reference = flat.result.elements[index].points[p];
      expect(relative(point.xyzMm.map((v, i): [number, number] => [v, reference.xyzMm[i] + (i === 2 ? 1.5 : 0)]), PLATE.length))
        .toBeLessThanOrEqual(1e-12);
      expect(relative(point.referenceXyzMm.map((v, i): [number, number] => [v, reference.xyzMm[i]]), PLATE.length))
        .toBeLessThanOrEqual(1e-12);
      expect(relative([...tensorPairs(point.topMPa, reference.topMPa), ...tensorPairs(point.bottomMPa, reference.bottomMPa)],
        6 * M / T ** 2)).toBeLessThanOrEqual(1e-9);
    }));
    const scale = Math.max(...flat.result.nodes.map(node => Math.abs(node.displacement[2])));
    expect(record('offsetDisplacementDifference', relative(offset.result.nodes.flatMap((node, index) =>
      node.displacement.slice(0, 3).map((v, i): [number, number] => [v, flat.result.nodes[index].displacement[i]])), scale)))
      .toBeLessThanOrEqual(1e-9);
    expectFaceBinding(sheet, context, offset.result);
    const below = prepareCadShellAnalysis(await boundaryOf(sheet, context), context,
      bendingSettings(context.body, savedFor(context, [0], -1), SINGLE));
    expect(below.midsurface.shiftMm).toEqual([0, 0, -1]);
    expect(below.input.nodes[7]).toEqual([sheet.points[7][0], sheet.points[7][1], -1]);
  });

  it('keys a two-face sheet element by element: nodes on the shared edge carry both faces, none is missing or extra', async () => {
    const sheet = splitPlate(), context = contextOf(sheet), saved = savedFor(context, [1, 0]);
    const { result } = await solved(sheet, context, bendingSettings(context.body, saved, SPLIT));
    expectFaceBinding(sheet, context, result);
    expect(result.faces.map(face => face.faceKey)).toEqual(saved.midsurfaceFaces);
    expect(result.faces.map(face => face.areaMm2)).toEqual([600, 600]);
    const shared = result.nodes.filter(node => node.faceKeys.length === 2).map(node => node.node);
    expect(shared).toEqual(range(0, PLATE.ny).map(j => j * (PLATE.nx + 1) + 2));
    const surface = 6 * M / T ** 2;
    for (const element of result.elements) for (const point of element.points) {
      expect(record('splitTop', relative(tensorPairs(point.topMPa, [surface, 0, 0, 0, 0, 0]), surface))).toBeLessThanOrEqual(TOLERANCE);
    }
  });

  it('distributes CAD edge twisting moments into Kirchhoff corner forces: constant twist w = c x y, top sigma_xy = 6 Mxy/t^2', async () => {
    const sheet = singlePlate(), context = contextOf(sheet), body = context.body;
    // Edge moment vector of a uniform twist Mxy: x = L (-Mxy, 0, 0), x = 0 (Mxy, 0, 0), y = W (0, Mxy, 0), y = 0 (0, -Mxy, 0).
    const settings: CadShellSettings = { ...bendingSettings(body, savedFor(context, [0]), SINGLE),
      edgeLoads: [{ edge: ref(body, 'edge', 1), forceNPerMm: [0, 0, 0], momentNmmPerMm: [-TWIST, 0, 0] },
        { edge: ref(body, 'edge', 3), forceNPerMm: [0, 0, 0], momentNmmPerMm: [TWIST, 0, 0] },
        { edge: ref(body, 'edge', 2), forceNPerMm: [0, 0, 0], momentNmmPerMm: [0, TWIST, 0] },
        { edge: ref(body, 'edge', 0), forceNPerMm: [0, 0, 0], momentNmmPerMm: [0, -TWIST, 0] }] };
    const { prepared, result } = await solved(sheet, context, settings);
    // Only the four corners are loaded: +/-2 Mxy, alternating; every edge-interior node cancels.
    expect(prepared.input.nodalLoads.map(load => [load.node, load.forceN[2]])).toEqual([[0, -2 * TWIST], [4, 2 * TWIST],
      [15, 2 * TWIST], [19, -2 * TWIST]]);
    const d = E * T ** 3 / (12 * (1 - NU ** 2)), c = -TWIST / (d * (1 - NU));
    const w = (x: number, y: number): number => c * x * y;
    expect(record('twistW', relative(result.nodes.map((node): [number, number] => [node.displacement[2], w(node.xyzMm[0], node.xyzMm[1])]),
      Math.abs(w(PLATE.length, PLATE.width))))).toBeLessThanOrEqual(TOLERANCE);
    const surface = 6 * TWIST / T ** 2;
    for (const element of result.elements) for (const point of element.points) {
      expect(record('twistTop', relative(tensorPairs(point.topMPa, [0, 0, 0, 0, 0, surface]), surface))).toBeLessThanOrEqual(TOLERANCE);
      expect(record('twistBottom', relative(tensorPairs(point.bottomMPa, [0, 0, 0, 0, 0, -surface]), surface))).toBeLessThanOrEqual(TOLERANCE);
    }
    expectFaceBinding(sheet, context, result);
  });

  it('runs the asynchronous path on the actual open boundary request and refuses a CAD change during the native run', async () => {
    const sheet = singlePlate(), context = contextOf(sheet), calls: unknown[] = [];
    const settings = bendingSettings(context.body, savedFor(context, [0]), SINGLE);
    const outcome = await analyzeCadShell(kernelOf(sheet, calls), () => context, settings, plan => Promise.resolve(runNative(plan)));
    expect(calls).toEqual([{ bodyKey: 'plate-sheet:3', boundary: 'open', linearDeflection: 0.05, angularDeflection: 0.2 }]);
    if (outcome.kind !== 'result') throw new Error(outcome.kind === 'failed' ? outcome.message : 'cancelled');
    expectFaceBinding(sheet, context, outcome.result);
    const direct = await solved(sheet, context, settings);
    expect(JSON.stringify(outcome.result)).toBe(JSON.stringify(direct.result));
    let current = context;
    const stale = await analyzeCadShell(kernelOf(sheet), () => current, settings, plan => {
      current = { ...context, revision: 4 };
      return Promise.resolve(runNative(plan));
    });
    expect(stale).toMatchObject({ kind: 'failed', code: 'stale' });
    const controller = new AbortController(); controller.abort();
    const idle: unknown[] = [];
    expect(await analyzeCadShell(kernelOf(sheet, idle), () => context, settings, () => Promise.reject(new Error('not run')),
      controller.signal)).toEqual({ kind: 'cancelled' });
    expect(idle).toHaveLength(0);
  });
});

describe('no inferred midsurface: refusals with reasons, input unchanged', () => {
  it('refuses a side face of a solid before any boundary request, and never treats a solid as a midsurface', async () => {
    const box = boxSolid(), context = contextOf(box), calls: unknown[] = [];
    const saved = savedFor(context, [2]);
    const settings: CadShellSettings = { saved, material: { id: 'steel', youngMPa: E, poisson: NU }, surface: OPTIONS, supports: [], edgeLoads: [] };
    const boundary = await boundaryOf(box, context), before = snapshot(boundary, context, settings);
    const refused = refusal(() => prepareCadShellAnalysis(boundary, context, settings));
    expect(refused.code).toBe('midsurface-solid-face');
    expect(refused.message).toContain("face 2 is a boundary face of a solid body; a solid's midsurface is never inferred");
    expect(snapshot(boundary, context, settings)).toBe(before);
    const outcome = await analyzeCadShell(kernelOf(box, calls), () => context, settings, () => Promise.reject(new Error('not run')));
    expect(outcome).toMatchObject({ kind: 'failed', code: 'midsurface-solid-face' });
    expect(calls).toHaveLength(0);
    expect(snapshot(boundary, context, settings)).toBe(before);
  });

  it.each([
    ['a cylindrical CAD face', 'midsurface-nonplanar', 'is a cylinder face',
      (sheet: Sheet): Sheet => ({ ...sheet, faces: [{ ...sheet.faces[0], surfaceKind: 'cylinder' }] })],
    ['a plane face whose triangles are not coplanar', 'midsurface-nonplanar', 'is not one plane',
      (sheet: Sheet): Sheet => ({ ...sheet, points: sheet.points.map((point, node): ShellVector3 => node === 7 ? [point[0], point[1], 0.5] : point) })],
  ] as const)('refuses %s without flattening it', async (_label, code, reason, change) => {
    const sheet = change(singlePlate()), context = contextOf(sheet);
    const settings = bendingSettings(context.body, savedFor(context, [0]), SINGLE), boundary = await boundaryOf(sheet, context);
    const before = snapshot(boundary, context, settings);
    const refused = refusal(() => prepareCadShellAnalysis(boundary, context, settings));
    expect(refused.code).toBe(code);
    expect(refused.message).toContain(reason);
    expect(snapshot(boundary, context, settings)).toBe(before);
  });

  it('refuses a saved face that does not resolve: missing origin, another document, a split origin', async () => {
    const sheet = singlePlate(), context = contextOf(sheet), boundary = await boundaryOf(sheet, context);
    const good = savedFor(context, [0]);
    const missing: ShellCadSavedInput = { ...good, midsurfaceFaces: [solidCadFaceKey({ ...ref(context.body, 'face', 0),
      origin: faceOrigin('plate-sheet', 'bottom') })] };
    const other: ShellCadSavedInput = { ...good, source: { documentId: 'other-part' } };
    for (const saved of [missing, other]) {
      const settings = bendingSettings(context.body, saved, SINGLE), before = snapshot(boundary, context, settings);
      const refused = refusal(() => prepareCadShellAnalysis(boundary, context, settings));
      expect(refused.code).toBe('midsurface-unresolved');
      expect(snapshot(boundary, context, settings)).toBe(before);
    }
    const split = contextOf(sheet, body => ({ ...body, origins: body.origins?.state !== 'tracked' ? body.origins : { ...body.origins,
      bindings: body.origins.bindings.map(binding => binding.origin.shapeKind === 'face'
        ? { origin: binding.origin, state: 'split' as const, candidates: [{ kind: 'face' as const, index: 0 }, { kind: 'face' as const, index: 0 }] as const }
        : binding) } }));
    const settings = bendingSettings(context.body, good, SINGLE), before = snapshot(boundary, split, settings);
    expect(refusal(() => prepareCadShellAnalysis(boundary, split, settings)).message)
      .toContain('has no unique current counterpart (deleted, split, merged or untracked)');
    expect(snapshot(boundary, split, settings)).toBe(before);
  });

  it('refuses a sheet face without an explicit midsurface entry instead of giving it a thickness or dropping it', async () => {
    const sheet = splitPlate(), context = contextOf(sheet), boundary = await boundaryOf(sheet, context);
    const settings = bendingSettings(context.body, savedFor(context, [0]), SPLIT), before = snapshot(boundary, context, settings);
    const refused = refusal(() => prepareCadShellAnalysis(boundary, context, settings));
    expect(refused.code).toBe('midsurface-incomplete');
    expect(refused.message).toContain('face 1 of the sheet has no explicit midsurface entry');
    expect(snapshot(boundary, context, settings)).toBe(before);
  });

  it('accepts a folded sheet at offset 0 but refuses a nonzero offset of a fold and a line load on the fold line', async () => {
    const sheet = splitPlate(30), context = contextOf(sheet), boundary = await boundaryOf(sheet, context), body = context.body;
    const clamp = { kind: 'edge' as const, edge: ref(body, 'edge', 5), fixed: [true, true, true, true, true, true] as const };
    const base: CadShellSettings = { saved: savedFor(context, [0, 1]), material: { id: 'steel', youngMPa: E, poisson: NU },
      surface: OPTIONS, supports: [clamp], edgeLoads: [{ edge: ref(body, 'edge', 2), forceNPerMm: [0, 0, 1], momentNmmPerMm: [0, 0, 0] }] };
    const accepted = prepareCadShellAnalysis(boundary, context, base);
    expect(accepted.faces[0].normal).toEqual([0, 0, 1]);
    expect(accepted.faces[1].normal[0]).toBeCloseTo(-Math.sin(Math.PI / 6), 12);
    expect(accepted.faces[1].normal[2]).toBeCloseTo(Math.cos(Math.PI / 6), 12);
    expect(accepted.input.constraints.map(row => row.node)).toEqual(range(0, PLATE.ny).map(j => j * (PLATE.nx + 1)));
    for (const [settings, code] of [[{ ...base, saved: savedFor(context, [0, 1], 1) }, 'midsurface-offset-fold'],
      [{ ...base, edgeLoads: [{ edge: ref(body, 'edge', 6), forceNPerMm: [0, 0, 1], momentNmmPerMm: [0, 0, 0] }] }, 'edge-load-fold']] as const) {
      const before = snapshot(boundary, context, settings);
      expect(refusal(() => prepareCadShellAnalysis(boundary, context, settings)).code).toBe(code);
      expect(snapshot(boundary, context, settings)).toBe(before);
    }
  });

  it('refuses unresolved supports and loads and a distributed drilling moment', async () => {
    const sheet = singlePlate(), context = contextOf(sheet), boundary = await boundaryOf(sheet, context), body = context.body;
    const base = bendingSettings(body, savedFor(context, [0]), SINGLE);
    const foreign = { ...ref(body, 'vertex', 0), bodyFeatureId: 'other-sheet' };
    const cases: readonly [CadShellSettings, string][] = [
      [{ ...base, supports: [{ kind: 'vertex', vertex: foreign, fixed: [true, true, true, false, false, false] }, ...base.supports.slice(1)] },
        'support-unresolved'],
      [{ ...base, edgeLoads: [{ edge: ref(body, 'vertex', 1), forceNPerMm: [0, 0, 0], momentNmmPerMm: [0, M, 0] }] }, 'load-unresolved'],
      [{ ...base, edgeLoads: [{ edge: ref(body, 'edge', 1), forceNPerMm: [0, 0, 0], momentNmmPerMm: [0, M, 5] }] }, 'edge-load-drilling'],
      [{ ...base, supports: [{ kind: 'vertex', vertex: ref(body, 'vertex', 0), fixed: [false, false, false, false, false, false] }] },
        'invalid-settings'],
    ];
    for (const [settings, code] of cases) {
      const before = snapshot(boundary, context, settings);
      expect(refusal(() => prepareCadShellAnalysis(boundary, context, settings)).code).toBe(code);
      expect(snapshot(boundary, context, settings)).toBe(before);
    }
  });
});

describe('work-equivalent CAD edge loads (pure)', () => {
  const chain = (x: number, width: number, segments: number): ShellVector3[] => range(0, segments).map(j => [x, j * width / segments, 0]);
  const up: ShellVector3 = [0, 0, 1];
  /** W08's hand-written consistent edge loads (shellPatch.test.ts membraneInput/bendingInput/shearInput) on one edge. */
  function w08(points: readonly ShellVector3[], add: (lower: number[], upper: number[], h: number) => void): number[][] {
    const rows = points.map(() => [0, 0, 0, 0, 0, 0]);
    for (let j = 0; j + 1 < points.length; j += 1) add(rows[j], rows[j + 1], points[j + 1][1] - points[j][1]);
    return rows;
  }
  function close(actual: readonly ShellNodal6[], expected: readonly (readonly number[])[]): void {
    const scale = Math.max(...expected.flat().map(Math.abs));
    expect(relative(actual.flatMap((row, node) => row.map((v, i): [number, number] => [v, expected[node][i]])), scale)).toBeLessThanOrEqual(1e-12);
  }
  it('reproduces the W08 membrane, pure-bending and transverse-shear nodal loads exactly', () => {
    const membrane = chain(100, 40, 2), traction = 50 * 2;
    close(distributeShellEdgeLoad(membrane, [up, up], [traction, 0, 0], [0, 0, 0]), w08(membrane, (lower, upper, h) => {
      lower[0] += traction * h / 2; upper[0] += traction * h / 2; lower[5] -= traction * h * h / 12; upper[5] += traction * h * h / 12;
    }));
    close(distributeShellEdgeLoad(membrane, [up, up], [0, 0, 0], [0, M, 0]), w08(membrane, (lower, upper, h) => {
      lower[4] += M * h / 2; upper[4] += M * h / 2;
    }));
    const shear = chain(100, 10, 2), line = 0.5;
    close(distributeShellEdgeLoad(shear, [up, up], [0, 0, line], [0, 0, 0]), w08(shear, (lower, upper, h) => {
      lower[2] += line * h / 2; upper[2] += line * h / 2; lower[3] += line * h * h / 12; upper[3] -= line * h * h / 12;
    }));
  });
  it('does not depend on the chain direction, the sign of the normal or the global frame', () => {
    const points = chain(100, 40, 3), force: ShellVector3 = [3, -2, 0.5], moment: ShellVector3 = [1.5, 4, 0];
    const forward = distributeShellEdgeLoad(points, [up, up, up], force, moment);
    close(distributeShellEdgeLoad([...points].reverse(), [up, up, up], force, moment), [...forward].reverse());
    close(distributeShellEdgeLoad(points, [[0, 0, -1], [0, 0, -1], [0, 0, -1]], force, moment), forward);
    const c = Math.cos(0.7), s = Math.sin(0.7);
    const turn = (v: readonly number[]): ShellVector3 => [c * v[0] - s * v[2], v[1], s * v[0] + c * v[2]];
    const turned = distributeShellEdgeLoad(points.map(turn), [turn(up), turn(up), turn(up)], turn(force), turn(moment));
    close(turned, forward.map(row => [...turn(row.slice(0, 3)), ...turn(row.slice(3))]));
    const total = forward.reduce<number[]>((sum, row) => sum.map((v, i) => v + row[i]), [0, 0, 0, 0, 0, 0]);
    expect(relative(total.slice(0, 3).map((v, i): [number, number] => [v, force[i] * 40]), 40 * norm(force))).toBeLessThanOrEqual(1e-12);
  });
  it('refuses a distributed moment about the shell normal and malformed chains', () => {
    const points = chain(100, 40, 2);
    expect(() => distributeShellEdgeLoad(points, [up, up], [0, 0, 0], [0, 1, 1e-3])).toThrow('edge-load-drilling');
    expect(() => distributeShellEdgeLoad(points, [up], [0, 0, 0], [0, 1, 0])).toThrow('invalid-settings');
    expect(() => distributeShellEdgeLoad([points[0], points[0]], [up], [1, 0, 0], [0, 0, 0])).toThrow('invalid-settings');
    expect(() => distributeShellEdgeLoad(points, [up, up], [Number.NaN, 0, 0], [0, 0, 0])).toThrow('invalid-settings');
  });
});
