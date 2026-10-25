import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '../../test-utils/src/releasePerformance.js';
import { isLoader, isRuntime, type PyodideRuntime } from './runtime.js';
import type { ShellAnalysisInput, ShellFixed6, ShellVector3 } from './shellAnalysisModel.js';
import { decodeShellAnalysis, recoverPlanarShell, recoverShellTransverseShear, SHELL_NATIVE_ELEMENT, shellElementFrame, shellSurfaceStress,
  shellTransverseShearStress, translateShellAnalysis, type ShellAnalysisResult, type ShellElementResult, type ShellTensor6 } from './shellTranslation.js';

// Patch tests of the native TR_SHELL02 path against thin-plate (Kirchhoff) solutions, N-mm-MPa-rad.
// Top side = the side of the element normal e3 = (N2-N1) x (N3-N1). The meshes below are wound so that e3 = +Z.
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
const solved = new Map<string, { result: ShellAnalysisResult; deck: string; raw: unknown }>();
const measured: Record<string, number> = {};
const observations: Record<string, { at: string; exact: number; actual: number; relative: number }> = {};
function solve(input: ShellAnalysisInput): { result: ShellAnalysisResult; deck: string; raw: unknown } {
  const key = input.source.meshKey, cached = solved.get(key);
  if (cached !== undefined) return cached;
  if (runtime === undefined) throw new Error('No packaged Pyodide runtime');
  const { plan } = translateShellAnalysis(input);
  runtime.FS.writeFile('/pcad_fem/shell-input.json', JSON.stringify(plan));
  const encoded = runtime.runPython(`
from shellAnalysis import run_shell_analysis
run_shell_analysis()
`);
  const deck = runtime.runPython(`
with open('/pcad_fem/shell.in', encoding='utf-8') as stream:
    text = stream.read()
text
`);
  if (typeof encoded !== 'string' || typeof deck !== 'string') throw new Error('No native shell result');
  const raw: unknown = JSON.parse(encoded);
  const entry = { result: decodeShellAnalysis(raw, plan), deck, raw };
  solved.set(key, entry);
  return entry;
}
beforeAll(async () => {
  for (const name of ['package.json', 'pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip',
    'pyodide-lock.json', 'numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl', wheel]) verified(name);
  globalThis.fetch = () => { denied += 1; return Promise.reject(new Error('shell-patch: offline request denied')); };
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
  process.stdout.write(`SHELL_PATCH ${JSON.stringify(measured)}\n`);
  process.stdout.write(`SHELL_OBSERVATIONS ${JSON.stringify(observations)}\n`);
});

type Element = ShellAnalysisInput['elements'][number];
type Triangle = [number, number, number];
interface Mesh { readonly nodes: ShellVector3[]; readonly elements: Element[]; readonly at: (i: number, j: number) => number }
const MOVES: readonly (readonly [number, number])[] = [[0, 0], [3, -2], [-2, 3], [2.5, 1.5]];
/** nx x ny cells, two counter-clockwise triangles each (alternating diagonals); interior nodes may be moved. */
function mesh(length: number, width: number, nx: number, ny: number, moved: boolean): Mesh {
  const at = (i: number, j: number): number => j * (nx + 1) + i;
  const nodes: ShellVector3[] = [];
  for (let j = 0; j <= ny; j += 1) {
    for (let i = 0; i <= nx; i += 1) {
      const [dx, dy] = moved && i > 0 && i < nx && j > 0 && j < ny ? MOVES[i] : [0, 0];
      nodes.push([i * length / nx + dx, j * width / ny + dy, 0]);
    }
  }
  const elements: Element[] = [];
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const [a, b, c, d] = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      const pair: Triangle[] = (i + j) % 2 === 0 ? [[a, b, c], [a, c, d]] : [[a, b, d], [b, c, d]];
      for (const nodesOf of pair) elements.push({ nodes: nodesOf, materialId: 'steel', thicknessMm: T, offsetMm: 0 });
    }
  }
  return { nodes, elements, at };
}
function build(meshKey: string, grid: Mesh, poisson: number, fixed: Map<number, ShellFixed6>,
  loads: Map<number, number[]>): ShellAnalysisInput {
  return { schema: 'pointercad-shell-tri3/1', source: { documentId: 'shell-patch', revision: 1, meshKey }, units: 'N-mm-MPa-rad',
    surface: 'explicit-reference-surface', nodes: grid.nodes, elements: grid.elements,
    materials: [{ id: 'steel', youngMPa: E, poisson }],
    constraints: [...fixed].map(([node, flags]) => ({ node, fixed: flags })),
    nodalLoads: [...loads].map(([node, v]) => ({ node, forceN: [v[0], v[1], v[2]], momentNmm: [v[3], v[4], v[5]] })) };
}
function add(loads: Map<number, number[]>, node: number, axis: number, value: number): void {
  const row = loads.get(node) ?? [0, 0, 0, 0, 0, 0];
  row[axis] += value;
  loads.set(node, row);
}
/** max |measured - exact| / scale, with scale the largest exact magnitude unless given. */
function relative(pairs: readonly (readonly [number, number])[], scale = Math.max(...pairs.map(([, exact]) => Math.abs(exact)))): number {
  expect(scale).toBeGreaterThan(0);
  return Math.max(...pairs.map(([value, exact]) => Math.abs(value - exact))) / scale;
}
/** Keeps the largest measured relative error per quantity for the evidence line printed after the run. */
function record(name: string, value: number): number { measured[name] = Math.max(measured[name] ?? 0, value); return value; }
function observe(name: string, at: string, actual: number, exact: number, scale = Math.abs(exact)): void {
  observations[name] = { at, exact, actual, relative: Math.abs(actual - exact) / scale };
}
function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function rotate(rotation: readonly ShellVector3[], v: readonly number[]): ShellVector3 {
  return [rotation[0][0] * v[0] + rotation[0][1] * v[1] + rotation[0][2] * v[2],
    rotation[1][0] * v[0] + rotation[1][1] * v[1] + rotation[1][2] * v[2],
    rotation[2][0] * v[0] + rotation[2][1] * v[1] + rotation[2][2] * v[2]];
}
/** R T R^T for a symmetric tensor in OOFEM order xx, yy, zz, yz, xz, xy. */
function rotateTensor(rotation: readonly ShellVector3[], t: ShellTensor6): ShellTensor6 {
  const m = [[t[0], t[5], t[4]], [t[5], t[1], t[3]], [t[4], t[3], t[2]]];
  const r = (a: number, b: number): number => [0, 1, 2].reduce((sum, i) => sum + [0, 1, 2].reduce(
    (inner, j) => inner + rotation[a][i] * m[i][j] * rotation[b][j], 0), 0);
  return [r(0, 0), r(1, 1), r(2, 2), r(1, 2), r(0, 2), r(0, 1)];
}

const E = 210000, T = 2, TOLERANCE = 1e-3;
const MEMBRANE = { length: 100, width: 40, nx: 4, ny: 2, stress: 50, poisson: 0.3 };
/** Uniform tension p on x = L; consistent Allman edge loads: p t h/2 per end plus drilling -/+ p t h^2/12.
 * Support: ux = rz = 0 on x = 0, uy = 0 at the origin, plate DOFs w, rx, ry = 0 (decoupled for a flat plate). */
function membraneInput(): ShellAnalysisInput {
  const { length, width, nx, ny, stress, poisson } = MEMBRANE;
  const grid = mesh(length, width, nx, ny, true);
  const fixed = new Map<number, ShellFixed6>(), loads = new Map<number, number[]>();
  grid.nodes.forEach((point, node) => {
    const edge = point[0] === 0;
    fixed.set(node, [edge, node === grid.at(0, 0), true, true, true, edge]);
  });
  const h = width / ny, traction = stress * T;
  for (let j = 0; j < ny; j += 1) {
    const lower = grid.at(nx, j), upper = grid.at(nx, j + 1);
    add(loads, lower, 0, traction * h / 2); add(loads, upper, 0, traction * h / 2);
    add(loads, lower, 5, -traction * h * h / 12); add(loads, upper, 5, traction * h * h / 12);
  }
  return build('membrane', grid, poisson, fixed, loads);
}
const BENDING = { length: 100, width: 40, nx: 4, ny: 2, moment: 100, poisson: 0.3 };
/** Uniform Mxx = m from edge moments (+m about +y on x = L, -m on x = 0, m h/2 per end), three-point support. */
function bendingInput(reversed = false): ShellAnalysisInput {
  const { length, width, nx, ny, moment, poisson } = BENDING;
  const grid = mesh(length, width, nx, ny, true);
  const fixed = new Map<number, ShellFixed6>([[grid.at(0, 0), [true, true, true, false, false, false]],
    [grid.at(0, ny), [true, false, true, false, false, false]], [grid.at(nx, 0), [false, false, true, false, false, false]]]);
  const loads = new Map<number, number[]>(), h = width / ny;
  for (let j = 0; j < ny; j += 1) {
    for (const node of [grid.at(nx, j), grid.at(nx, j + 1)]) add(loads, node, 4, moment * h / 2);
    for (const node of [grid.at(0, j), grid.at(0, j + 1)]) add(loads, node, 4, -moment * h / 2);
  }
  const elements = reversed ? grid.elements.map(element => {
    const nodes: Triangle = [element.nodes[0], element.nodes[2], element.nodes[1]];
    return { ...element, nodes };
  }) : grid.elements;
  return build(reversed ? 'bending-reversed' : 'bending', { ...grid, elements }, poisson, fixed, loads);
}
const SHEAR = { length: 100, width: 10, nx: 16, ny: 2, line: 0.5 };
/** Cantilever strip (nu = 0: exactly a beam), clamped at x = 0, line load q in +z on x = L with the consistent
 * DKT edge loads q h/2 and the Hermite end moments +/- q h^2/12 about x. */
function shearInput(rotation?: readonly ShellVector3[]): ShellAnalysisInput {
  const { length, width, nx, ny, line } = SHEAR;
  const grid = mesh(length, width, nx, ny, false);
  const fixed = new Map<number, ShellFixed6>(), loads = new Map<number, number[]>(), h = width / ny;
  for (let j = 0; j <= ny; j += 1) fixed.set(grid.at(0, j), [true, true, true, true, true, true]);
  for (let j = 0; j < ny; j += 1) {
    add(loads, grid.at(nx, j), 2, line * h / 2); add(loads, grid.at(nx, j + 1), 2, line * h / 2);
    add(loads, grid.at(nx, j), 3, line * h * h / 12); add(loads, grid.at(nx, j + 1), 3, -line * h * h / 12);
  }
  if (rotation === undefined) return build('shear', grid, 0, fixed, loads);
  const turned = new Map([...loads].map(([node, v]) => [node, [...rotate(rotation, v.slice(0, 3)), ...rotate(rotation, v.slice(3))]]));
  return build('shear-rotated', { ...grid, nodes: grid.nodes.map(point => rotate(rotation, point)) }, 0, fixed, turned);
}
const D_BEAM = E * T ** 3 / 12;
const exactShear = {
  w: (x: number): number => SHEAR.line * x * x * (3 * SHEAR.length - x) / (6 * D_BEAM),
  ry: (x: number): number => -SHEAR.line * x * (2 * SHEAR.length - x) / (2 * D_BEAM),
  mxx: (x: number): number => -SHEAR.line * (SHEAR.length - x),
};
const CYLINDER = { length: 100, width: 40, nx: 16, ny: 4, line: 0.5, poisson: 0 };
/** Approved diagnostic specimen: cylindrical bending, rx=0 on both long edges. This suppresses
 * the free-edge twisting field; success here does not qualify a general free-edge plate.
 * D=Et^3/[12(1-nu^2)], w=qx^2(3L-x)/(6D), ry=-qx(2L-x)/(2D),
 * Mxx=-q(L-x), Myy=nu*Mxx, Qx=q. nu=0 matches the previously diagnosed 128-element specimen. */
function cylindricalInput(): ShellAnalysisInput {
  const { length, width, nx, ny, line, poisson } = CYLINDER;
  const grid = mesh(length, width, nx, ny, false);
  const fixed = new Map<number, ShellFixed6>(), loads = new Map<number, number[]>(), h = width / ny;
  for (let j = 0; j <= ny; j += 1) fixed.set(grid.at(0, j), [true, true, true, true, true, true]);
  for (let i = 1; i <= nx; i += 1) for (const j of [0, ny]) fixed.set(grid.at(i, j), [false, false, false, true, false, false]);
  for (let j = 0; j < ny; j += 1) {
    add(loads, grid.at(nx, j), 2, line * h / 2); add(loads, grid.at(nx, j + 1), 2, line * h / 2);
    add(loads, grid.at(nx, j), 3, line * h * h / 12); add(loads, grid.at(nx, j + 1), 3, -line * h * h / 12);
  }
  return build('cylindrical-shear', grid, poisson, fixed, loads);
}
function inCylindricalBand(point: ShellVector3): boolean {
  return point[0] >= CYLINDER.length / 4 && point[0] <= 3 * CYLINDER.length / 4
    && point[1] >= CYLINDER.width / 4 && point[1] <= 3 * CYLINDER.width / 4;
}
/** Elements whose centroid is between L/4 and 3L/4: away from the clamp and the loaded edge. */
function representative(result: ShellAnalysisResult): number[] {
  return result.elements.flatMap((element, index) => {
    const x = element.points.reduce((sum, point) => sum + point.xyzMm[0], 0) / element.points.length;
    return x >= SHEAR.length / 4 && x <= 3 * SHEAR.length / 4 ? [index] : [];
  });
}

describe('native TR_SHELL02 path (bundled OOFEM, no network)', () => {
  it('calls the existing native element by name: tr_shell02 deck records, TR_SHELL02 and SimpleCrossSection classes', () => {
    const { result, deck } = solve(membraneInput());
    expect(createHash('sha256').update(verified(wheel)).digest('hex'))
      .toBe('aaff729b15e1cec2ef90c9c0bb2d3594b3997b523d35344b18ba9f64d4d1a7e4');
    const records = deck.split('\n').filter(line => /^[a-z_0-9]+ \d+ nodes 3 /i.test(line));
    expect(records).toHaveLength(membraneInput().elements.length);
    for (const line of records) expect(line).toMatch(/^tr_shell02 \d+ nodes 3 \d+ \d+ \d+ mat 1 crosssect 1 nip 4$/);
    expect(deck).toContain('domain 3dshell');
    expect(deck).toMatch(/^SimpleCS 1 thick 2\.0 material 1$/m);
    expect(result.element).toEqual({ record: 'tr_shell02', className: 'TR_SHELL02', crossSection: 'SimpleCrossSection' });
    expect(result.elements.map(element => element.nativeClass)).toEqual(Array(16).fill(SHELL_NATIVE_ELEMENT.className));
    expect(result.elements.every(element => element.points.length === 4)).toBe(true);
    expect(denied).toBe(0);
  });

  it('membrane patch: uniform tension gives u = px/E, v = -nu py/E, N = pt and top = bottom = p on a distorted mesh', () => {
    const { stress, poisson } = MEMBRANE;
    const input = membraneInput(), { result } = solve(input);
    const u = input.nodes.flatMap((point, node): [number, number][] => [[result.displacement[node][0], stress * point[0] / E],
      [result.displacement[node][1], -poisson * stress * point[1] / E], [result.displacement[node][2], 0]]);
    expect(record('membraneDisplacement', relative(u))).toBeLessThanOrEqual(TOLERANCE);
    const rotations = result.displacement.flatMap(row => row.slice(3).map((v): [number, number] => [v, 0]));
    expect(record('membraneRotation', relative(rotations, stress / E))).toBeLessThanOrEqual(TOLERANCE);
    const tip = input.nodes.findIndex(point => point[0] === MEMBRANE.length && point[1] === 0);
    observe('membraneU', 'node (100,0,0)', result.displacement[tip][0], stress * MEMBRANE.length / E);
    observe('membraneRz', 'node (100,0,0); scale=p/E', result.displacement[tip][5], 0, stress / E);
    const sample = result.elements[0].points[0];
    observe('membraneNxx', 'element 0 centroid', sample.membraneForceNPerMm[0], stress * T);
    observe('membraneTop', 'element 0 centroid', sample.surface.topMPa[0], stress);
    observe('membraneBottom', 'element 0 centroid', sample.surface.bottomMPa[0], stress);
    for (const element of result.elements) {
      for (const point of element.points) {
        const expected: ShellTensor6 = [stress, 0, 0, 0, 0, 0];
        expect(record('membraneRawStress', relative(point.membraneStressMPa.map((v, i): [number, number] => [v, expected[i]]), stress)))
          .toBeLessThanOrEqual(TOLERANCE);
        // Native IST_ShellForceTensor carries MPa (trplanestressrotallman3d.C:238); the path multiplies by t once.
        expect(point.membraneForceNPerMm).toEqual(point.membraneStressMPa.map(v => v * T));
        expect(relative(point.membraneForceNPerMm.map((v, i): [number, number] => [v, expected[i] * T]), stress * T))
          .toBeLessThanOrEqual(TOLERANCE);
        for (const side of [point.surface.topMPa, point.surface.bottomMPa]) {
          expect(record('membraneSurface', relative(side.map((v, i): [number, number] => [v, expected[i]]), stress)))
            .toBeLessThanOrEqual(TOLERANCE);
        }
        expect(Math.max(...point.momentNmmPerMm.map(v => 6 * Math.abs(v) / T ** 2)) / stress).toBeLessThanOrEqual(TOLERANCE);
      }
    }
  });

  it('pure bending patch: uniform Mxx = m gives anticlastic w, rotations, curvature and top/bottom = +/-6m/t^2', () => {
    const { moment, poisson, length, width } = BENDING;
    const input = bendingInput(), { result } = solve(input);
    const k = 12 * moment / (E * T ** 3);
    const w = (x: number, y: number): number => -k * x * (x - length) / 2 + poisson * k * y * (y - width) / 2;
    const pairs = (axis: number, exact: (x: number, y: number) => number): [number, number][] =>
      input.nodes.map((point, node) => [result.displacement[node][axis], exact(point[0], point[1])]);
    expect(record('bendingW', relative(pairs(2, w)))).toBeLessThanOrEqual(TOLERANCE);
    expect(record('bendingRx', relative(pairs(3, (_, y) => poisson * k * (2 * y - width) / 2)))).toBeLessThanOrEqual(TOLERANCE);
    expect(record('bendingRy', relative(pairs(4, x => k * (2 * x - length) / 2)))).toBeLessThanOrEqual(TOLERANCE);
    const wScale = k * length * length / 8;
    expect(relative([...pairs(0, () => 0), ...pairs(1, () => 0)], wScale)).toBeLessThanOrEqual(TOLERANCE);
    expect(relative(pairs(5, () => 0), k * length / 2)).toBeLessThanOrEqual(TOLERANCE);
    const surface = 6 * moment / T ** 2;
    const peak = input.nodes.reduce((best, point, node) => w(point[0], point[1]) > w(input.nodes[best][0], input.nodes[best][1]) ? node : best, 0);
    observe('bendingW', `node (${input.nodes[peak].join(',')})`, result.displacement[peak][2], w(input.nodes[peak][0], input.nodes[peak][1]));
    observe('bendingRx', 'node (0,0,0)', result.displacement[0][3], -poisson * k * width / 2);
    observe('bendingRy', 'node (0,0,0)', result.displacement[0][4], -k * length / 2);
    const sample = result.elements[0].points[0];
    observe('bendingMxx', 'element 0 centroid', sample.momentNmmPerMm[0], moment);
    observe('bendingCurvature', 'element 0 centroid', sample.curvaturePerMm[0], k);
    observe('bendingTop', 'element 0 centroid', sample.surface.topMPa[0], surface);
    observe('bendingBottom', 'element 0 centroid', sample.surface.bottomMPa[0], -surface);
    for (const element of result.elements) {
      for (const point of element.points) {
        expect(record('bendingMoment', relative(point.momentNmmPerMm.map((v, i): [number, number] => [v, i === 0 ? moment : 0]), moment)))
          .toBeLessThanOrEqual(TOLERANCE);
        expect(relative(point.curvaturePerMm.map((v, i): [number, number] => [v, i === 0 ? k : i === 1 ? -poisson * k : 0]), k))
          .toBeLessThanOrEqual(TOLERANCE);
        expect(record('bendingSurface', Math.max(relative(point.surface.topMPa.map((v, i): [number, number] => [v, i === 0 ? surface : 0]), surface),
          relative(point.surface.bottomMPa.map((v, i): [number, number] => [v, i === 0 ? -surface : 0]), surface)))).toBeLessThanOrEqual(TOLERANCE);
        expect(Math.max(...point.membraneForceNPerMm.map(Math.abs)) / T / surface).toBeLessThanOrEqual(TOLERANCE);
      }
    }
  });

  it('transverse shear patch: cylindrical cantilever w, rotation, nodal moments/surface stresses and recovered Q/tau within 1e-3', () => {
    const { length, line, poisson } = CYLINDER;
    const input = cylindricalInput(), { result } = solve(input);
    const recovery = result.recovery;
    expect(input.elements).toHaveLength(128);
    expect(recovery.status).toBe('available');
    if (recovery.status !== 'available') throw new Error(recovery.reason);
    expect(recovery).toMatchObject({ source: 'area-weighted-element-centroid', scope: 'coplanar-uniform-section' });
    const d = E * T ** 3 / (12 * (1 - poisson ** 2));
    const w = (x: number): number => line * x ** 2 * (3 * length - x) / (6 * d);
    const ry = (x: number): number => -line * x * (2 * length - x) / (2 * d);
    const tip = input.nodes.flatMap((point, node) => (point[0] === length ? [node] : []));
    expect(tip).toHaveLength(CYLINDER.ny + 1);
    expect(record('shearTipW', relative(tip.map((node): [number, number] => [result.displacement[node][2], w(length)]))))
      .toBeLessThanOrEqual(TOLERANCE);
    expect(record('shearTipRy', relative(tip.map((node): [number, number] => [result.displacement[node][4], ry(length)]))))
      .toBeLessThanOrEqual(TOLERANCE);
    expect(record('shearAllW', relative(input.nodes.map((point, node): [number, number] => [result.displacement[node][2],
      w(point[0])])))).toBeLessThanOrEqual(TOLERANCE);
    expect(record('shearAllRy', relative(input.nodes.map((point, node): [number, number] => [result.displacement[node][4], ry(point[0])]))))
      .toBeLessThanOrEqual(TOLERANCE);
    expect(relative(result.displacement.map((row): [number, number] => [row[3], 0]), -ry(length))).toBeLessThanOrEqual(TOLERANCE);
    const chosen = result.elements.flatMap((element, index) => inCylindricalBand(element.points[0].xyzMm) ? [index] : []);
    expect(chosen).toHaveLength(32);
    for (const index of chosen) {
      const shear = recovery.transverseShear[index];
      expect(shear.source).toBe('nodal-average-moment-gradient');
      expect(record('shearQ', relative(shear.globalNPerMm.map((v, i): [number, number] => [v, i === 0 ? line : 0]), line)))
        .toBeLessThanOrEqual(TOLERANCE);
      expect(record('shearTau', relative(shear.representativeMPa.map((v, i): [number, number] =>
        [v, i === 0 ? 1.5 * line / T : 0]), 1.5 * line / T))).toBeLessThanOrEqual(TOLERANCE);
      record('cylinderRawQ', relative(result.elements[index].transverseShear.globalNPerMm.map((v, i): [number, number] => [v, i === 0 ? line : 0]), line));
    }
    const nodes = recovery.nodes.filter(point => inCylindricalBand(point.xyzMm));
    expect(nodes).toHaveLength(27);
    for (const point of nodes) {
      expect(point.boundary).toBe(false);
      const mxx = -line * (length - point.xyzMm[0]);
      const expected: ShellTensor6 = [mxx, poisson * mxx, 0, 0, 0, 0];
      expect(record('shearMoment', relative(point.momentNmmPerMm.map((v, i): [number, number] => [v, expected[i]]), Math.abs(mxx))))
        .toBeLessThanOrEqual(TOLERANCE);
      for (const [side, sign] of [[point.surface.topMPa, 1], [point.surface.bottomMPa, -1]] as const) {
        expect(record('shearSurface', relative(side.map((v, i): [number, number] => [v, sign * 6 * expected[i] / T ** 2]), 6 * Math.abs(mxx) / T ** 2)))
          .toBeLessThanOrEqual(TOLERANCE);
      }
    }
    measured.shearTipExactW = w(length); measured.shearTipMeasuredW = result.displacement[tip[0]][2];
    measured.shearTipExactRy = ry(length); measured.shearTipMeasuredRy = result.displacement[tip[0]][4];
    observe('shearTipW', 'node (100,0,0)', result.displacement[tip[0]][2], w(length));
    observe('shearTipRy', 'node (100,0,0)', result.displacement[tip[0]][4], ry(length));
    const center = nodes.find(point => point.xyzMm[0] === length / 2 && point.xyzMm[1] === CYLINDER.width / 2);
    if (center === undefined) throw new Error('No center recovery node');
    const centerMoment = -line * length / 2;
    observe('shearMxx', 'recovered node (50,20,0)', center.momentNmmPerMm[0], centerMoment);
    observe('shearTop', 'recovered node (50,20,0)', center.surface.topMPa[0], 6 * centerMoment / T ** 2);
    observe('shearBottom', 'recovered node (50,20,0)', center.surface.bottomMPa[0], -6 * centerMoment / T ** 2);
    observe('shearQx', `recovered element ${chosen[0]}`, recovery.transverseShear[chosen[0]].globalNPerMm[0], line);
    observe('shearTau', `recovered element ${chosen[0]}`, recovery.transverseShear[chosen[0]].representativeMPa[0], 1.5 * line / T);
  });

  it('retains the original free-edge failure: raw element moment gradients are not a 1e-3 transverse-shear result', () => {
    const { result } = solve(shearInput());
    const error = Math.max(...representative(result).map(index => relative(result.elements[index].transverseShear.globalNPerMm
      .map((v, i): [number, number] => [v, i === 0 ? SHEAR.line : 0]), SHEAR.line)));
    // Original RUN 20261025-062909: 0.268. Keep the failing method visible, not a relaxed accuracy acceptance.
    expect(record('freeEdgeRawQFailure', error)).toBeGreaterThan(0.2);
    expect(error).toBeLessThan(0.3);
    expect(result.elements.every(element => element.transverseShear.source === 'moment-gradient-equilibrium')).toBe(true);
    expect(record('freeEdgeTipW', relative(shearInput().nodes.flatMap((point, node): [number, number][] =>
      point[0] === SHEAR.length ? [[result.displacement[node][2], exactShear.w(SHEAR.length)]] : [])))).toBeLessThanOrEqual(TOLERANCE);
  });

  it('checks every answer natively: free-DOF equilibrium, overall balance, scaled LDL pivots and refactorized displacements', () => {
    const { result } = solve(cylindricalInput());
    expect(result.checks.freeResidualRelative).toBeLessThanOrEqual(1e-8);
    expect(result.checks.balanceRelative).toBeLessThanOrEqual(1e-8);
    expect(result.checks.minimumScaledPivot).toBeGreaterThan(1e-12);
    expect(result.checks.refactorizationDifferenceRelative).toBeLessThanOrEqual(1e-8);
    const total = CYLINDER.line * CYLINDER.width;
    const sum = (axis: number): number => result.reactions.reduce((value, row) => value + row[axis], 0);
    expect(Math.abs(sum(2) + total) / total).toBeLessThanOrEqual(1e-9);
    // The clamp carries the load's moment about y: sum of reaction moments (all at x = 0, so r x F has no y part) = qBL.
    expect(Math.abs(sum(4) - total * CYLINDER.length) / (total * CYLINDER.length)).toBeLessThanOrEqual(1e-9);
    observe('reactionFz', 'cylinder total', sum(2), -total);
    observe('reactionMy', 'cylinder total', sum(4), total * CYLINDER.length);
    measured.freeResidualRelative = result.checks.freeResidualRelative;
    measured.balanceRelative = result.checks.balanceRelative;
    measured.minimumScaledPivot = result.checks.minimumScaledPivot;
    measured.refactorizationDifferenceRelative = result.checks.refactorizationDifferenceRelative;
    for (const name of ['membrane', 'bending']) {
      const checked = solve(name === 'membrane' ? membraneInput() : bendingInput()).result.checks;
      expect(checked.freeResidualRelative).toBeLessThanOrEqual(1e-8);
      expect(checked.minimumScaledPivot).toBeGreaterThan(1e-12);
    }
  });

  it('is frame independent: the cantilever turned in 3D gives the turned displacements, moments and shear', () => {
    const axis: ShellVector3 = [1 / Math.sqrt(14), 2 / Math.sqrt(14), 3 / Math.sqrt(14)], angle = 35 * Math.PI / 180;
    const c = Math.cos(angle), s = Math.sin(angle), [x, y, z] = axis;
    const rotation: ShellVector3[] = [[c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
      [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
      [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)]];
    const flat = solve(shearInput()).result, turned = solve(shearInput(rotation)).result;
    const scale = { u: exactShear.w(SHEAR.length), r: -exactShear.ry(SHEAR.length), m: SHEAR.line * SHEAR.length };
    const u = flat.displacement.flatMap((row, node) => {
      const expected = [...rotate(rotation, row.slice(0, 3)), ...rotate(rotation, row.slice(3))];
      return turned.displacement[node].map((v, i) => Math.abs(v - expected[i]) / (i < 3 ? scale.u : scale.r));
    });
    expect(record('turnedDisplacement', Math.max(...u))).toBeLessThanOrEqual(1e-8);
    const m = flat.elements.flatMap((element, index) => element.points.flatMap((point, p) => {
      const expected = rotateTensor(rotation, point.momentNmmPerMm);
      return turned.elements[index].points[p].momentNmmPerMm.map((v, i) => Math.abs(v - expected[i]) / scale.m);
    }));
    expect(record('turnedMoment', Math.max(...m))).toBeLessThanOrEqual(1e-8);
    for (const index of representative(flat)) {
      const expected = rotate(rotation, flat.elements[index].transverseShear.globalNPerMm);
      expect(relative(turned.elements[index].transverseShear.globalNPerMm.map((v, i): [number, number] => [v, expected[i]]), SHEAR.line))
        .toBeLessThanOrEqual(1e-8);
    }
    if (flat.recovery.status !== 'available' || turned.recovery.status !== 'available') throw new Error('Planar recovery missing');
    for (const [node, value] of flat.recovery.nodes.entries()) {
      const expected = rotateTensor(rotation, value.momentNmmPerMm);
      expect(relative(turned.recovery.nodes[node].momentNmmPerMm.map((v, i): [number, number] => [v, expected[i]]), scale.m))
        .toBeLessThanOrEqual(1e-8);
      const stress = rotateTensor(rotation, value.surface.topMPa);
      expect(relative(turned.recovery.nodes[node].surface.topMPa.map((v, i): [number, number] => [v, stress[i]]), 6 * scale.m / T ** 2))
        .toBeLessThanOrEqual(1e-8);
    }
    for (const index of representative(flat)) {
      const expected = rotate(rotation, flat.recovery.transverseShear[index].globalNPerMm);
      expect(relative(turned.recovery.transverseShear[index].globalNPerMm.map((v, i): [number, number] => [v, expected[i]]), SHEAR.line))
        .toBeLessThanOrEqual(1e-8);
    }
  });

  it('defines the top side by the node order: a fully reversed mesh is accepted and its top (-Z) face is in compression', () => {
    const normal = solve(bendingInput()).result, reversed = solve(bendingInput(true)).result;
    const surface = 6 * BENDING.moment / T ** 2;
    for (const [index, element] of reversed.elements.entries()) {
      expect(element.frame.e3[2]).toBeCloseTo(-1, 12);
      expect(normal.elements[index].frame.e3[2]).toBeCloseTo(1, 12);
      for (const point of element.points) {
        expect(relative([[point.surface.topMPa[0], -surface], [point.surface.bottomMPa[0], surface]])).toBeLessThanOrEqual(TOLERANCE);
      }
    }
    expect(relative(reversed.displacement.map((row, node): [number, number] => [row[2], normal.displacement[node][2]])))
      .toBeLessThanOrEqual(1e-8);
    if (reversed.recovery.status !== 'available') throw new Error(reversed.recovery.reason);
    for (const node of reversed.recovery.nodes) {
      expect(relative([[node.surface.topMPa[0], -surface], [node.surface.bottomMPa[0], surface]])).toBeLessThanOrEqual(TOLERANCE);
    }
  });
});

describe('refusals with reasons (input unchanged, no native call)', () => {
  it.each([0, -2, -0])('refuses thickness %s with the reason and leaves the input unchanged', thicknessMm => {
    const original = membraneInput();
    const input = frozen({ ...original, elements: original.elements.map((element, index) => (index === 3 ? { ...element, thicknessMm } : element)) });
    const before = JSON.stringify(input);
    expect(() => translateShellAnalysis(input)).toThrow(/^shell-thickness: element 3 has thicknessMm (0|-2);/);
    expect(() => translateShellAnalysis(input)).toThrow('a shell needs a finite thickness greater than 0 mm');
    expect(JSON.stringify(input)).toBe(before);
  });
  it('refuses a reversed element in a consistently wound mesh, naming both elements and the shared edge', () => {
    const original = membraneInput();
    const flipped: Triangle = [original.elements[5].nodes[0], original.elements[5].nodes[2], original.elements[5].nodes[1]];
    const input = frozen({ ...original, elements: original.elements.map((element, index) => (index === 5 ? { ...element, nodes: flipped } : element)) });
    const before = JSON.stringify(input);
    expect(() => translateShellAnalysis(input))
      .toThrow(/^shell-orientation: elements (\d+ and 5|5 and \d+) traverse their shared edge \d+-\d+ in the same direction/);
    expect(() => translateShellAnalysis(input)).toThrow('normals point to opposite sides and top and bottom would swap');
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each<[string, (input: ShellAnalysisInput) => ShellAnalysisInput]>([
    ['shell-offset: element 0 has offsetMm 1', input => ({ ...input, elements: input.elements.map((element, index) =>
      (index === 0 ? { ...element, offsetMm: 1 } : element)) })],
    ['shell-mechanism: the connected surface containing node 0 restrains 3 of its 6', input => ({ ...input,
      constraints: input.constraints.slice(1) })],
    // A third triangle on the interior diagonal of element 0 (nodes 0 and 6): top and bottom are undefined there.
    ['shell-orientation: edge 0-6 is shared by elements 0, 1, 16', input => ({ ...input, nodes: [...input.nodes, [50, 20, 30]],
      elements: [...input.elements, { ...input.elements[0], nodes: [input.elements[0].nodes[2], input.elements[0].nodes[0], input.nodes.length] }] })],
    ['shell-geometry: element 16 is degenerate', input => ({ ...input, nodes: [...input.nodes, [200, 0, 0]],
      elements: [...input.elements, { ...input.elements[0], nodes: [0, 4, input.nodes.length] }] })],
  ])('refuses %s', (code, change) => {
    const input = frozen(change(code.startsWith('shell-mechanism') ? bendingInput() : membraneInput()));
    const before = JSON.stringify(input);
    expect(() => translateShellAnalysis(input)).toThrow(code);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('surface stress and transverse shear derivation (pure)', () => {
  it('sigma_top = N/t + 6M/t^2 and sigma_bottom = N/t - 6M/t^2 on the normal side, tau = 1.5Q/t', () => {
    const stress = shellSurfaceStress([10, -4, 0, 0, 0, 2], [3, -1, 0, 0, 0, 0.5], 2);
    expect(stress.topMPa).toEqual([9.5, -3.5, 0, 0, 0, 1.75]);
    expect(stress.bottomMPa).toEqual([0.5, -0.5, 0, 0, 0, 0.25]);
    expect(shellTransverseShearStress([4, -2, 0], 2)).toEqual([3, -1.5, 0]);
    for (const thickness of [0, -1, Number.NaN]) {
      expect(() => shellSurfaceStress([1, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0], thickness)).toThrow('shell-thickness');
      expect(() => shellTransverseShearStress([1, 0, 0], thickness)).toThrow('shell-thickness');
    }
  });
  it('recovers Q = (dMxx/dx + dMxy/dy, dMxy/dx + dMyy/dy) from a linear moment field in a tilted element frame', () => {
    const corners: [ShellVector3, ShellVector3, ShellVector3] = [[1, 2, 3], [11, 4, 2], [3, 12, 7]];
    const frame = shellElementFrame(corners);
    const field = (x: number, y: number): [number, number, number] => [5 + 0.3 * x - 0.2 * y, -2 + 0.1 * x + 0.4 * y, 1 - 0.05 * x + 0.7 * y];
    const outer = (a: ShellVector3, b: ShellVector3): number[] => [a[0] * b[0], a[1] * b[1], a[2] * b[2], (a[1] * b[2] + a[2] * b[1]) / 2,
      (a[0] * b[2] + a[2] * b[0]) / 2, (a[0] * b[1] + a[1] * b[0]) / 2];
    const points = [[2, 1], [5, 3], [1, 4], [3, 2]].map(([x, y]) => {
      const [mxx, myy, mxy] = field(x, y);
      const tensor = [outer(frame.e1, frame.e1), outer(frame.e2, frame.e2), outer(frame.e1, frame.e2)]
        .reduce((sum, part, i) => sum.map((v, j) => v + [mxx, myy, 2 * mxy][i] * part[j]), [0, 0, 0, 0, 0, 0]);
      const at = (i: number): number => corners[0][i] + x * frame.e1[i] + y * frame.e2[i];
      const xyzMm: ShellVector3 = [at(0), at(1), at(2)];
      const momentNmmPerMm: ShellTensor6 = [tensor[0], tensor[1], tensor[2], tensor[3], tensor[4], tensor[5]];
      return { xyzMm, momentNmmPerMm };
    });
    const shear = recoverShellTransverseShear(frame, corners[0], points, 2);
    expect(shear.localNPerMm[0]).toBeCloseTo(0.3 + 0.7, 12);
    expect(shear.localNPerMm[1]).toBeCloseTo(-0.05 + 0.4, 12);
    expect(shear.fitResidualNmmPerMm).toBeLessThanOrEqual(1e-12);
    expect(shear.representativeMPa.map((v, i) => v - 1.5 * shear.globalNPerMm[i] / 2).every(v => Math.abs(v) <= 1e-15)).toBe(true);
  });
});

describe('planar recovery scope and ownership', () => {
  it('keeps the successful input, raw points and decoded fields unchanged while producing independent recovery arrays', () => {
    const input = frozen(membraneInput()), before = JSON.stringify(input);
    const { input: copy, plan } = translateShellAnalysis(input);
    expect(copy).toEqual(input); expect(copy).not.toBe(input); expect(copy.nodes).not.toBe(input.nodes);
    const { raw } = solve(input), rawBefore = JSON.stringify(raw);
    const result = decodeShellAnalysis(frozen(raw), plan);
    const elementsBefore = JSON.stringify(result.elements);
    const recovery = recoverPlanarShell(input, frozen(result.elements));
    expect(recovery).toEqual(result.recovery);
    expect(JSON.stringify(input)).toBe(before); expect(JSON.stringify(raw)).toBe(rawBefore);
    expect(JSON.stringify(result.elements)).toBe(elementsBefore);
    if (recovery.status !== 'available') throw new Error(recovery.reason);
    expect(recovery.nodes[0].xyzMm).not.toBe(input.nodes[0]);
    for (const node of recovery.nodes) {
      expect(node.momentNmmPerMm).not.toBe(result.elements[node.contributingElements[0]].points[0].momentNmmPerMm);
      expect(relative(node.surface.topMPa.map((v, i): [number, number] => [v, i === 0 ? MEMBRANE.stress : 0]), MEMBRANE.stress))
        .toBeLessThanOrEqual(TOLERANCE);
    }
  });

  it('uses area weights on unequal triangles and flags the one-sided boundary samples', () => {
    const nodes: ShellVector3[] = [[0, 0, 0], [4, 0, 0], [0, 1, 0], [0, -3, 0]];
    const triangles: Triangle[] = [[0, 1, 2], [1, 0, 3]];
    const input: ShellAnalysisInput = { ...membraneInput(), nodes, elements: triangles.map(indices =>
      ({ nodes: indices, materialId: 'steel', thicknessMm: T, offsetMm: 0 })), constraints: [], nodalLoads: [] };
    const elements = triangles.map((indices, index): ShellElementResult => {
      const frame = shellElementFrame([nodes[indices[0]], nodes[indices[1]], nodes[indices[2]]]);
      const n: ShellTensor6 = [index === 0 ? 10 : 40, 0, 0, 0, 0, 0];
      const m: ShellTensor6 = [index === 0 ? 2 : 6, 0, 0, 0, 0, 0];
      const xyzMm: ShellVector3 = [4 / 3, index === 0 ? 1 / 3 : -1, 0];
      const zero: ShellTensor6 = [0, 0, 0, 0, 0, 0];
      return { nativeClass: 'TR_SHELL02', thicknessMm: T, frame,
        points: [{ xyzMm, membraneStressMPa: [n[0] / T, 0, 0, 0, 0, 0], membraneForceNPerMm: n, momentNmmPerMm: m,
          curvaturePerMm: zero, membraneStrain: zero, surface: shellSurfaceStress(n, m, T) }],
        transverseShear: { source: 'moment-gradient-equilibrium', localNPerMm: [0, 0], globalNPerMm: [0, 0, 0],
          representativeMPa: [0, 0, 0], fitResidualNmmPerMm: 0 } };
    });
    const recovery = recoverPlanarShell(frozen(input), frozen(elements));
    if (recovery.status !== 'available') throw new Error(recovery.reason);
    // Areas 2 and 6: N=(2*10+6*40)/8=32.5, M=(2*2+6*6)/8=5.
    for (const node of [0, 1]) {
      expect(recovery.nodes[node]).toMatchObject({ contributingElements: [0, 1], boundary: true,
        membraneForceNPerMm: [32.5, 0, 0, 0, 0, 0], momentNmmPerMm: [5, 0, 0, 0, 0, 0],
        surface: { topMPa: [23.75, 0, 0, 0, 0, 0], bottomMPa: [8.75, 0, 0, 0, 0, 0] } });
    }
    expect(recovery.nodes[2].membraneForceNPerMm[0]).toBe(10);
    expect(recovery.nodes[3].membraneForceNPerMm[0]).toBe(40);
  });

  it.each(['nonplanar', 'nonuniform-section'] as const)('returns %s without smoothing and retains the real native raw answer', code => {
    const original = bendingInput();
    const input = frozen({ ...original, source: { ...original.source, meshKey: code },
      nodes: original.nodes.map((point): ShellVector3 => [point[0], point[1], code === 'nonplanar' ? point[0] ** 2 / 1000 : point[2]]),
      elements: original.elements.map((element, i) => ({ ...element, thicknessMm: code === 'nonuniform-section' && i === 0 ? 2 * T : T })) });
    const before = JSON.stringify(input), { result } = solve(input);
    expect(result.recovery).toMatchObject({ status: 'unavailable', code });
    if (result.recovery.status !== 'unavailable') throw new Error('Unsupported smoothing was accepted');
    expect(result.recovery.reason).toContain('Raw native integration-point results are retained');
    expect(result.elements).toHaveLength(original.elements.length);
    for (const element of result.elements) {
      expect(element.points).toHaveLength(4);
      for (const point of element.points) {
        expect(point.membraneForceNPerMm).toEqual(point.membraneStressMPa.map(v => v * element.thicknessMm));
        expect(point.surface).toEqual(shellSurfaceStress(point.membraneForceNPerMm, point.momentNmmPerMm, element.thicknessMm));
      }
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it('refuses a reordered native quadrature point instead of silently averaging a non-centroid value', () => {
    const input = bendingInput(), { result } = solve(input);
    const changed = result.elements.map((element, index) => index === 0
      ? { ...element, points: [element.points[1], element.points[0], ...element.points.slice(2)] } : element);
    const before = JSON.stringify(changed);
    expect(() => recoverPlanarShell(input, frozen(changed))).toThrow('first integration point is not its centroid');
    expect(JSON.stringify(changed)).toBe(before);
  });

  it('rejects another source and false native class claims while retaining the raw result', () => {
    const input = membraneInput(), { raw } = solve(input), { plan } = translateShellAnalysis(input);
    if (typeof raw !== 'object' || raw === null) throw new Error('Missing native raw result');
    const before = JSON.stringify(raw);
    expect(() => decodeShellAnalysis({ ...raw, source: { ...input.source, revision: 2 } }, plan)).toThrow('result belongs to another source');
    expect(() => decodeShellAnalysis({ ...raw, elementClasses: input.elements.map(() => 'Truss') }, plan))
      .toThrow('not the native TR_SHELL02');
    expect(JSON.stringify(raw)).toBe(before);
  });
});
