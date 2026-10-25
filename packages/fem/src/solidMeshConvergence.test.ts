import { createHash } from 'node:crypto';
import { readFileSync, writeSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '../../test-utils/src/releasePerformance.js';
import { countTetraMeshVolumes } from './assemblyTetraMesh.js';
import { boundCurvedPlc, type CurvedSurface } from './curvedPlcBound.js';
import { analyzeSolid, isLoader, isRuntime, meshTetrahedra, type PyodideRuntime } from './runtime.js';
import type { SolidAnalysisInput, SolidAnalysisResult, SolidVector3 } from './solidAnalysisModel.js';
import { solidResultMatches } from './solidAnalysisResults.js';
import { solidInputSha256, solidTetGeometry, translateSolidAnalysis } from './solidAnalysisTranslation.js';
import { NETGEN_WHEEL, type TetraMeshInput, type TetraMeshResult } from './tetraMesh.js';

// Actual shipped Netgen -> tet4 -> OOFEM native Skyline/LDLT. Analytic PLC fixtures
// isolate discretization; CAD face identity is separately tested by W05. No mock
// mesh, replacement solver, network, changed native controls/limits or scratchpad dependency.
const assets = fileURLToPath(new URL('../runtime/assets/', import.meta.url));
const manifest: unknown = JSON.parse(readFileSync(new URL('../runtime/manifest.json', import.meta.url), 'utf8'));
const wheel = 'oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl';
function verified(name: string): Uint8Array {
  if (typeof manifest !== 'object' || manifest === null || !('files' in manifest)
    || typeof manifest.files !== 'object' || manifest.files === null) throw new Error('Missing asset manifest');
  const pin: unknown = Object.entries(manifest.files).find(([key]) => key === `assets/${name}`)?.[1];
  if (typeof pin !== 'object' || pin === null || !('sha256' in pin) || !('bytes' in pin)) throw new Error(`Missing pin: ${name}`);
  const bytes = new Uint8Array(readFileSync(join(assets, name)));
  expect({ bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') })
    .toEqual({ bytes: pin.bytes, sha256: pin.sha256 });
  return bytes;
}
let runtime: PyodideRuntime;
let deniedRequests = 0;
const originalFetch = globalThis.fetch;
beforeAll(async () => {
  globalThis.fetch = () => { deniedRequests++; return Promise.reject(new Error('offline-request-denied')); };
  for (const name of ['package.json', 'pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip',
    'pyodide-lock.json', 'numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl', wheel, NETGEN_WHEEL]) verified(name);
  const loader: unknown = await import(/* @vite-ignore */ pathToFileURL(join(assets, 'pyodide.mjs')).href);
  if (!isLoader(loader)) throw new Error('Invalid packaged Pyodide loader');
  const loaded = await loader.loadPyodide({ indexURL: assets + sep, packageBaseUrl: assets + sep, packageCacheDir: assets,
    lockFileContents: readFileSync(join(assets, 'pyodide-lock.json'), 'utf8'), stdLibURL: join(assets, 'python_stdlib.zip'),
    packages: ['numpy'], fullStdLib: false, stdout: () => undefined, stderr: () => undefined });
  if (!isRuntime(loaded)) throw new Error('Invalid packaged Pyodide runtime');
  runtime = loaded;
}, FUNCTIONAL_TEST_TIMEOUT_MS);
afterAll(() => { globalThis.fetch = originalFetch; });

type Shape = 'beam' | 'perforated-plate' | 'cylinder';
type Triangle = readonly [number, number, number];
const MATERIAL = { id: 'isotropic', youngMPa: 210000, poisson: 0.3 };
const FORCE_N = 4;
const levels = [1, 2, 3] as const;
function plc(shape: Shape, level: number, coordinates: number[], triangles: number[], tags: number[], tagCount: number): TetraMeshInput {
  const fields = { source: { documentId: `convergence-${shape}`, revision: 1, featureId: shape, bodyKey: `${shape}:1` },
    units: 'mm' as const, coordinates, triangles, tags, tagCount,
    meshing: { targetSizeMm: 1 / level, grading: 0.4, maximumOptimizationPasses: 2,
      quality: { minimumMeanRatio: 0.01, maximumEdgeRatio: 100 } } };
  return shape === 'perforated-plate'
    ? { schema: 'pointercad-plc/2', ...fields,
      shells: [{ role: 'outer', triangles: tags.map((_, index) => index) }] }
    : { schema: 'pointercad-convex-plc/1', ...fields };
}
/** Outward boundary of a Cartesian cell union; no volume elements are fabricated.
 * Beam: 12 x 2 x 2 mm. Plate: 8 x 4 x 1 mm, a 2 x 2 mm through-hole at its centre.
 */
function rectangularPlc(shape: Exclude<Shape, 'cylinder'>, level: number): TetraMeshInput {
  const beam = shape === 'beam';
  const dimensions = beam ? [6 * level, 2 * level, 2 * level] : [8 * level, 4 * level, level];
  const spacing = beam ? [2 / level, 1 / level, 1 / level] : [1 / level, 1 / level, 1 / level];
  const origin = beam ? [0, -1, -1] : [0, -2, 0];
  const coordinates: number[] = [], triangles: number[] = [], tags: number[] = [];
  const vertices = new Map<string, number>(), faces = new Map<string, number>();
  const active = (p: readonly number[]): boolean => p.every((value, axis) => value >= 0 && value < dimensions[axis])
    && (beam || !(p[0] >= 3 * level && p[0] < 5 * level && p[1] >= level && p[1] < 3 * level));
  const vertex = (p: readonly number[]): number => {
    const key = p.join(','), present = vertices.get(key);
    if (present !== undefined) return present;
    const index = coordinates.length / 3;
    coordinates.push(...p.map((value, axis) => origin[axis] + value * spacing[axis]));
    vertices.set(key, index); return index;
  };
  for (let x = 0; x < dimensions[0]; x++) for (let y = 0; y < dimensions[1]; y++) for (let z = 0; z < dimensions[2]; z++) {
    const cell = [x, y, z];
    if (!active(cell)) continue;
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      const neighbour = [...cell]; neighbour[axis] += sign;
      if (active(neighbour)) continue;
      const p = [...cell]; if (sign > 0) p[axis]++;
      const u = (axis + 1) % 3, v = (axis + 2) % 3;
      const q = [...p], r = [...p], s = [...p]; q[u]++; r[u]++; r[v]++; s[v]++;
      const corners = (sign > 0 ? [p, q, r, s] : [p, s, r, q]).map(vertex);
      triangles.push(corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]);
      const key = `${axis},${sign},${p[axis]}`, tag = faces.get(key) ?? faces.size;
      faces.set(key, tag); tags.push(tag, tag);
    }
  }
  return plc(shape, level, coordinates, triangles, tags, faces.size);
}
/** Cylinder along x, radius 1 mm, length 8 mm. Refine its analytic circle as well
 * as its caps/axial segments; keeping a frozen coarse polygon would hide geometric error.
 */
function cylindricalPlc(level: number): TetraMeshInput {
  const sides = 12 * level, axial = 2 * level, coordinates: number[] = [], triangles: number[] = [], tags: number[] = [];
  const at = (x: number, radius: number, i: number): number => {
    const index = coordinates.length / 3, angle = 2 * Math.PI * i / sides;
    coordinates.push(x, radius * Math.cos(angle), radius * Math.sin(angle)); return index;
  };
  const outer = Array.from({ length: axial + 1 }, (_, x) =>
    Array.from({ length: sides }, (_, i) => at(8 * x / axial, 1, i)));
  const triangle = (a: number, b: number, c: number, tag: number): void => { triangles.push(a, b, c); tags.push(tag); };
  for (let x = 0; x < axial; x++) for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    triangle(outer[x][i], outer[x][j], outer[x + 1][j], 2 + i);
    triangle(outer[x][i], outer[x + 1][j], outer[x + 1][i], 2 + i);
  }
  for (const end of [0, 1]) {
    const rings = Array.from({ length: level - 1 }, (_, r) =>
      Array.from({ length: sides }, (_, i) => at(end * 8, (r + 1) / level, i)));
    rings.push(outer[end * axial]);
    const center = at(end * 8, 0, 0);
    const cap = (a: number, b: number, c: number): void => end === 0 ? triangle(a, c, b, end) : triangle(a, b, c, end);
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      cap(center, rings[0][i], rings[0][j]);
      for (let r = 1; r < rings.length; r++) {
        cap(rings[r - 1][i], rings[r][i], rings[r][j]);
        cap(rings[r - 1][i], rings[r][j], rings[r - 1][j]);
      }
    }
  }
  const surfaces: CurvedSurface[] = [{ kind: 'plane' }, { kind: 'plane' }, ...Array.from({ length: sides }, (): CurvedSurface =>
    ({ kind: 'cylinder', origin: [0, 0, 0], axis: [1, 0, 0], radius: 1 }))];
  const bound = boundCurvedPlc(coordinates, triangles, tags, surfaces, 1e-10, () => undefined);
  expect(bound.maxChordDeviationBoundMm).toBeCloseTo(1 - Math.cos(Math.PI / sides), 12);
  expect(bound.estimateIsBound).toBe(false);
  return plc('cylinder', level, coordinates, triangles, tags, sides + 2);
}
const point = (mesh: TetraMeshResult, node: number): SolidVector3 =>
  [mesh.coordinates[3 * node], mesh.coordinates[3 * node + 1], mesh.coordinates[3 * node + 2]];
function area(nodes: readonly SolidVector3[]): number {
  const u = nodes[1].map((v, i) => v - nodes[0][i]), v = nodes[2].map((n, i) => n - nodes[0][i]);
  return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
}
function solidInput(shape: Shape, mesh: TetraMeshResult): SolidAnalysisInput {
  const length = shape === 'beam' ? 12 : 8;
  const nodes = Array.from({ length: mesh.coordinates.length / 3 }, (_, index) => point(mesh, index));
  const loaded: Triangle[] = [];
  for (let i = 0; i < mesh.boundaryTriangles.length; i += 3) {
    const face: Triangle = [mesh.boundaryTriangles[i], mesh.boundaryTriangles[i + 1], mesh.boundaryTriangles[i + 2]];
    if (face.every(node => nodes[node][0] === length)) loaded.push(face);
  }
  const loadedArea = loaded.reduce((sum, face) => sum + area(face.map(node => nodes[node])), 0);
  const expectedArea = shape === 'cylinder' ? mesh.input.tagCount - 2 : 0;
  expect(loadedArea).toBeCloseTo(shape === 'cylinder'
    ? expectedArea * Math.sin(2 * Math.PI / expectedArea) / 2 : 4, 11);
  const input: SolidAnalysisInput = { schema: 'pointercad-solid-tet4/1', units: 'N-mm-MPa',
    source: { documentId: mesh.input.source.documentId, revision: 1, meshKey: mesh.inputSha256 }, numericBudgetBytes: 128 * 1024 * 1024,
    nodes, elements: Array.from({ length: mesh.tetrahedra.length / 4 }, (_, i) => ({ materialId: MATERIAL.id,
      nodes: [mesh.tetrahedra[4 * i], mesh.tetrahedra[4 * i + 1], mesh.tetrahedra[4 * i + 2], mesh.tetrahedra[4 * i + 3]] })),
    materials: [MATERIAL], constraints: nodes.flatMap((p, node) => p[0] === 0 ? [{ node, fixed: [true, true, true] as const }] : []),
    nodalLoads: [], surfaceLoads: loaded.map(face => ({ nodes: face, tractionMPa: [FORCE_N / loadedArea, 0, 0] })) };
  const plan = translateSolidAnalysis(input).plan;
  expect(plan.forcesN.reduce((sum, force) => sum + force[0], 0)).toBeCloseTo(FORCE_N, 11);
  expect(plan.forcesN.reduce((sum, force) => sum + force[1] + force[2], 0)).toBe(0);
  return input;
}
/** Same physical point for every level; tet4 interpolation for displacement,
 * elementwise constant sigma_xx for stress. Average only if exactly on a shared face.
 */
function sample(input: SolidAnalysisInput, result: SolidAnalysisResult, at: SolidVector3): { displacementMm: number; stressMPa: number } {
  let displacementMm = 0, stressMPa = 0, hits = 0;
  input.elements.forEach((element, index) => {
    const nodes = element.nodes.map(node => input.nodes[node]), { gradients } = solidTetGeometry(nodes);
    const offset = at.map((value, axis) => value - nodes[0][axis]);
    const weights = gradients.map((gradient, i) => (i === 0 ? 1 : 0) + gradient.reduce((sum, v, axis) => sum + v * offset[axis], 0));
    if (weights.some(weight => weight < -1e-10 || weight > 1 + 1e-10)) return;
    displacementMm += weights.reduce((sum, weight, i) => sum + weight * result.displacementMm[element.nodes[i]][0], 0);
    stressMPa += result.elements[index].stressMPa[0]; hits++;
  });
  expect(hits, `fixed probe outside mesh: ${at.join(',')}`).toBeGreaterThan(0);
  return { displacementMm: displacementMm / hits, stressMPa: stressMPa / hits };
}
interface Observation {
  readonly elements: number;
  readonly displacementMm: number;
  readonly energyNmm: number;
  readonly stressMPa: number;
}
function difference(previous: Observation, current: Observation) {
  const relative = (a: number, b: number): number => {
    if (![a, b].every(Number.isFinite) || b === 0) throw new Error('Nonzero finite convergence reference required');
    return Math.abs(b - a) / Math.abs(b);
  };
  const displacement = relative(previous.displacementMm, current.displacementMm);
  const energy = relative(previous.energyNmm, current.energyNmm), stress = relative(previous.stressMPa, current.stressMPa);
  const refined = current.elements >= 2 * previous.elements;
  return { displacement, energy, stress, refined,
    status: refined && displacement <= 0.01 && energy <= 0.01 && stress <= 0.05 ? '収束' : '未収束' };
}
describe('fixed convergence criteria', () => {
  const previous: Observation = { elements: 10, displacementMm: 100, energyNmm: 100, stressMPa: 100 };
  const fine: Observation = { ...previous, elements: 20 };
  it('accepts simultaneous limits and explicitly reports every over-limit or insufficient refinement as unconverged', () => {
    expect(difference({ ...previous, displacementMm: 99, energyNmm: 99, stressMPa: 95 }, fine))
      .toEqual({ displacement: 0.01, energy: 0.01, stress: 0.05, refined: true, status: '収束' });
    for (const changed of [{ ...previous, displacementMm: 98.9999 }, { ...previous, energyNmm: 98.9999 },
      { ...previous, stressMPa: 94.9999 }, { ...previous, elements: 11 }]) expect(difference(changed, fine).status).toBe('未収束');
    for (const value of [0, NaN, Infinity]) expect(() => difference(previous, { ...fine, energyNmm: value })).toThrow();
  });
  it('uses the finer value as denominator and absolute magnitude for signed stress', () => {
    expect(difference({ ...previous, stressMPa: -95 }, { ...fine, stressMPa: -100 }).stress).toBe(0.05);
    expect(difference(previous, { ...fine, displacementMm: 50 }).displacement).toBe(1);
    expect(() => difference({ ...previous, stressMPa: NaN }, fine)).toThrow();
  });
});

const observations = new Map<Shape, Observation[]>();
describe('real offline solid mesh convergence (unconverged is reported, never relabelled as a pass)', () => {
  for (const shape of ['beam', 'perforated-plate', 'cylinder'] as const) {
    it.each(levels)(`${shape}: refinement %i`, async level => {
      const start = performance.now(), input = shape === 'cylinder' ? cylindricalPlc(level) : rectangularPlc(shape, level);
      const mesh = await meshTetrahedra(runtime, input, { wrapper: verified('netgenMesher.py'),
        wheelLocation: join(assets, NETGEN_WHEEL).split(sep).join('/') }, () => undefined);
      const quality = countTetraMeshVolumes(mesh);
      expect(quality).toEqual({ total: mesh.tetrahedra.length / 4, positive: mesh.tetrahedra.length / 4,
        inverted: 0, zero: 0, allPositive: true });
      const expectedVolume = shape === 'beam' ? 48 : shape === 'perforated-plate' ? 28
        : 4 * (input.tagCount - 2) * Math.sin(2 * Math.PI / (input.tagCount - 2));
      expect(Math.abs(mesh.volumeMm3 - expectedVolume) / expectedVolume).toBeLessThanOrEqual(1e-10);
      const solid = solidInput(shape, mesh);
      const before = JSON.stringify(solid);
      const result = await analyzeSolid(runtime, solid, { wrapper: verified('solidAnalysis.py'),
        wheelLocation: join(assets, wheel).split(sep).join('/') }, () => undefined);
      expect(JSON.stringify(solid)).toBe(before);
      expect(solidResultMatches(result, solid, await solidInputSha256(solid))).toBe(true);
      expect(result.method).toBe('oofem-ltrspace-isole-native-ldlt/1');
      expect(result.reactionN.reduce((sum, force) => sum + force[0], 0)).toBeCloseTo(-FORCE_N, 7);
      const externalWork = translateSolidAnalysis(solid).plan.forcesN.reduce((sum, force, node) =>
        sum + force.reduce((work, component, axis) => work + component * result.displacementMm[node][axis], 0), 0);
      expect(Math.abs(result.strainEnergyNmm - externalWork / 2) / result.strainEnergyNmm).toBeLessThanOrEqual(1e-8);
      const tip: SolidVector3 = shape === 'beam' ? [12, 0, 0] : shape === 'cylinder' ? [8, 0, 0] : [8, 0, 0.5];
      const probe: SolidVector3 = shape === 'beam' ? [6.17, 0.21, 0.13]
        : shape === 'cylinder' ? [4.17, 0.21, 0.13] : [6.37, 1.42, 0.43];
      const row: Observation = { elements: quality.total, displacementMm: sample(solid, result, tip).displacementMm,
        energyNmm: result.strainEnergyNmm, stressMPa: sample(solid, result, probe).stressMPa };
      for (const value of [row.displacementMm, row.energyNmm, row.stressMPa]) expect(value).toBeGreaterThan(0);
      const rows = observations.get(shape) ?? [];
      expect(rows).toHaveLength(level - 1);
      const change = rows.length > 0 ? difference(rows[rows.length - 1], row) : null;
      // Write the evidence to the RUN stream even when the reporter hides console output from passing tests.
      writeSync(1, 'SOLID_MESH_CONVERGENCE ' + JSON.stringify({ shape, level, nodes: solid.nodes.length, ...quality, ...row,
        change, final: level === 3, elapsedMs: performance.now() - start }) + String.fromCharCode(10));
      if (change !== null) expect(change.refined, 'at least twice as many elements at each level').toBe(true);
      rows.push(row); observations.set(shape, rows);
      expect(deniedRequests).toBe(0);
      // Numerical thresholds are fixed above. A successful reporting test does NOT
      // claim all three geometries converged; the final printed status is authoritative.
    }, FUNCTIONAL_TEST_TIMEOUT_MS);
  }
});
