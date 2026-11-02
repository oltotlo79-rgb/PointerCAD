import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '../../test-utils/src/releasePerformance.js';
import { isLoader, isRuntime, type PyodideRuntime } from './runtime.js';
import type { ShellAnalysisInput } from './shellAnalysisModel.js';
import { plateCase, SCORDELIS_LO, scordelisLoCase, triangleArea, type BenchmarkCase, type PlateSpec,
  type PlateSupport } from './shellBenchmark.testSupport.js';
import { decodeShellAnalysis, translateShellAnalysis, type ShellAnalysisResult } from './shellTranslation.js';

// Benchmarks of the unchanged W08 path (translateShellAnalysis -> shellAnalysis.py, the bundled OOFEM TR_SHELL02 =
// DKT plate + Allman membrane -> decodeShellAnalysis) against published thin-plate and curved-shell solutions.
// Everything is fixed below: versions of the references, dimensions, supports, meshes and the stress position.
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
interface Solved { readonly result: ShellAnalysisResult; readonly seconds: number }
const solved = new Map<string, Solved>();
const evidence: Record<string, unknown> = {};
/** Translate, run the native wrapper and decode; seconds cover all three. Cached by mesh key. */
function solve(input: ShellAnalysisInput): Solved {
  const key = input.source.meshKey, cached = solved.get(key);
  if (cached !== undefined) return cached;
  if (runtime === undefined) throw new Error('No packaged Pyodide runtime');
  const started = performance.now();
  const { plan } = translateShellAnalysis(input);
  runtime.FS.writeFile('/pcad_fem/shell-input.json', JSON.stringify(plan));
  const encoded = runtime.runPython(`
from shellAnalysis import run_shell_analysis
run_shell_analysis()
`);
  if (typeof encoded !== 'string') throw new Error('No native shell result');
  const raw: unknown = JSON.parse(encoded);
  const entry = { result: decodeShellAnalysis(raw, plan), seconds: (performance.now() - started) / 1000 };
  solved.set(key, entry);
  return entry;
}
beforeAll(async () => {
  for (const name of ['package.json', 'pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip',
    'pyodide-lock.json', 'numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl', wheel]) verified(name);
  globalThis.fetch = () => { denied += 1; return Promise.reject(new Error('shell-benchmark: offline request denied')); };
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
  process.stdout.write(`SHELL_BENCHMARK ${JSON.stringify(evidence)}\n`);
});

/** Square steel plate a = 1000 mm, E = 210000 MPa, nu = 0.3, uniform q = 0.01 MPa in +Z. */
const PLATE = { sideMm: 1000, youngMPa: 210000, poisson: 0.3, pressureMPa: 0.01 } as const;
/** t/a = 1/100 carries the acceptance; t/a = 1/1000 on the same meshes is the locking record. */
const THICKNESS = { moderate: 10, thin: 1 } as const;
/** Cells per side of the modelled quarter (plate and roof). For the plate these are the full-plate union-jack meshes
 * 8x8, 16x16 and 32x32 (two triangles per cell) restricted to one quarter by symmetry; see the equivalence test. */
const LEVELS = [4, 8, 16] as const;
const LIMITS = { plateDeflection: 0.02, plateStress: 0.05, shellDeflection: 0.05 } as const;
/**
 * Timoshenko & Woinowsky-Krieger, Theory of Plates and Shells, 2nd ed. (McGraw-Hill, 1959), square plate, nu = 0.3,
 * uniform load q, D = E t^3 / (12 (1 - nu^2)):
 * - Table 8, simply supported: w_max = 0.00406 q a^4 / D; centre Mx = My = 0.0479 q a^2, so the surface stress at the
 *   centre is 6 M / t^2 = 0.287 q a^2 / t^2;
 * - Table 35, built-in edges: w_max = 0.00126 q a^4 / D; centre Mx = My = 0.0231 q a^2, 6 M / t^2 = 0.1386 q a^2 / t^2.
 * Stress position (fixed): nodal recovery of the product (result.recovery, area-weighted element-centroid moments)
 * at the centre node, top face (+Z, the element normal), components xx and yy.
 */
const PUBLISHED: Readonly<Record<PlateSupport, { readonly deflection: number; readonly stress: number }>> = {
  'simply-supported': { deflection: 0.00406, stress: 0.287 },
  clamped: { deflection: 0.00126, stress: 6 * 0.0231 },
};

/** Navier's double series of the simply supported square plate at its centre (Timoshenko & Woinowsky-Krieger art. 30,
 * the series behind Table 8), odd m, n <= 2001: w = 16 q a^4/(pi^6 D) sum s / (m n (m^2+n^2)^2) and
 * Mx = 16 q a^2/pi^4 sum s (m^2 + nu n^2) / (m n (m^2+n^2)^2) with s = (-1)^((m+n)/2-1). */
function navierCentre(poisson: number): { readonly deflection: number; readonly moment: number } {
  let deflection = 0, moment = 0;
  for (let m = 1; m <= 2001; m += 2) {
    for (let n = 1; n <= 2001; n += 2) {
      const sign = ((m + n) / 2 - 1) % 2 === 0 ? 1 : -1, base = m * n * (m * m + n * n) ** 2;
      deflection += sign / base;
      moment += sign * (m * m + poisson * n * n) / base;
    }
  }
  return { deflection: 16 * deflection / Math.PI ** 6, moment: 16 * moment / Math.PI ** 4 };
}

function plateSpec(support: PlateSupport, cells: number, thicknessMm: number, region: PlateSpec['region'] = 'quarter'): PlateSpec {
  return { support, region, cells, sideMm: PLATE.sideMm, thicknessMm, youngMPa: PLATE.youngMPa, poisson: PLATE.poisson,
    pressureMPa: PLATE.pressureMPa };
}
function rigidity(thicknessMm: number): number { return PLATE.youngMPa * thicknessMm ** 3 / (12 * (1 - PLATE.poisson ** 2)); }
function sum(rows: readonly (readonly number[])[], axis: number): number { return rows.reduce((total, row) => total + row[axis], 0); }

interface PlateRow {
  readonly cells: number; readonly fullCells: number; readonly nodes: number; readonly elements: number;
  readonly wMm: number; readonly wCoefficient: number; readonly wReference: number; readonly wRelative: number;
  readonly sigmaXxMPa: number; readonly sigmaYyMPa: number; readonly sigmaCoefficient: number; readonly sigmaReference: number;
  readonly sigmaRelative: number; readonly seconds: number;
}
/** One quarter plate: centre deflection and centre top stress against the published coefficients. */
function plateRow(support: PlateSupport, cells: number, thicknessMm: number): { row: PlateRow; benchmark: BenchmarkCase; result: ShellAnalysisResult } {
  const benchmark = plateCase(plateSpec(support, cells, thicknessMm)), { result, seconds } = solve(benchmark.input);
  const { sideMm: a, pressureMPa: q } = PLATE, reference = PUBLISHED[support];
  const wMm = result.displacement[benchmark.probe][2], wCoefficient = wMm * rigidity(thicknessMm) / (q * a ** 4);
  const recovery = result.recovery;
  if (recovery.status !== 'available') throw new Error(recovery.reason);
  const centre = recovery.nodes[benchmark.probe], scale = q * a ** 2 / thicknessMm ** 2;
  const [sigmaXxMPa, sigmaYyMPa] = [centre.surface.topMPa[0], centre.surface.topMPa[1]];
  const sigmaRelative = Math.max(...[sigmaXxMPa, sigmaYyMPa].map(value => Math.abs(value / scale - reference.stress))) / reference.stress;
  return { benchmark, result, row: { cells, fullCells: 2 * cells, nodes: benchmark.input.nodes.length, elements: benchmark.input.elements.length,
    wMm, wCoefficient, wReference: reference.deflection, wRelative: Math.abs(wCoefficient - reference.deflection) / reference.deflection,
    sigmaXxMPa, sigmaYyMPa, sigmaCoefficient: sigmaXxMPa / scale, sigmaReference: reference.stress, sigmaRelative, seconds } };
}
/** Statics of a quarter plate: the edge reactions carry q (a/2)^2 and the restrained membrane rows carry nothing. */
function expectPlateStatics(result: ShellAnalysisResult): void {
  const total = PLATE.pressureMPa * (PLATE.sideMm / 2) ** 2;
  expect(Math.abs(sum(result.reactions, 2) + total) / total).toBeLessThanOrEqual(1e-8);
  const membrane = Math.max(...result.reactions.map(row => Math.max(Math.abs(row[0]), Math.abs(row[1]), Math.abs(row[5]) / PLATE.sideMm)));
  expect(membrane / total).toBeLessThanOrEqual(1e-9);
}
/** Solves the three levels, records them under `name` (before any assertion, so a failure keeps the table), then
 * checks the statics of every level. */
function plateSeries(name: string, support: PlateSupport, thicknessMm: number): PlateRow[] {
  const levels = LEVELS.map(cells => plateRow(support, cells, thicknessMm));
  const rows = levels.map(level => level.row);
  evidence[name] = rows;
  for (const level of levels) expectPlateStatics(level.result);
  return rows;
}
function expectConverged(rows: readonly PlateRow[]): void {
  const errors = rows.map(row => row.wRelative);
  for (let level = 1; level < errors.length; level += 1) expect(errors[level]).toBeLessThan(errors[level - 1]);
  expect(errors[errors.length - 1]).toBeLessThanOrEqual(LIMITS.plateDeflection);
  expect(rows[rows.length - 1].sigmaRelative).toBeLessThanOrEqual(LIMITS.plateStress);
}

describe('published references and equivalent loads (pure)', () => {
  it('the Table 8 coefficients are Navier series values rounded to their printed digits', () => {
    const navier = navierCentre(PLATE.poisson);
    evidence.navier = { deflection: navier.deflection, moment: navier.moment, stress: 6 * navier.moment };
    expect(Math.abs(PUBLISHED['simply-supported'].deflection - navier.deflection)).toBeLessThanOrEqual(0.5e-5);
    expect(Math.abs(0.0479 - navier.moment)).toBeLessThanOrEqual(0.5e-4);
    expect(Math.abs(PUBLISHED['simply-supported'].stress - 6 * navier.moment)).toBeLessThanOrEqual(0.5e-3);
  });

  it('lumped p A/3 loads keep the resultant force and its moment of the uniform load on plate and roof', () => {
    const plate = plateCase(plateSpec('simply-supported', LEVELS[0], THICKNESS.moderate)), half = PLATE.sideMm / 2;
    const loads = plate.input.nodalLoads, total = PLATE.pressureMPa * half * half;
    expect(Math.abs(loads.reduce((value, load) => value + load.forceN[2], 0) - total) / total).toBeLessThanOrEqual(1e-12);
    // Lumped vertex loads are statically equivalent on flat triangles: sum F_i x_i = q * integral of x dA = q (a/2)^2 a/4.
    for (const axis of [0, 1]) {
      const moment = loads.reduce((value, load) => value + load.forceN[2] * plate.input.nodes[load.node][axis], 0);
      expect(Math.abs(moment - total * half / 2) / (total * half / 2)).toBeLessThanOrEqual(1e-12);
    }
    expect(loads.every(load => load.forceN[0] === 0 && load.forceN[1] === 0 && load.momentNmm.every(value => value === 0))).toBe(true);
    const roof = scordelisLoCase(LEVELS[0]), { radiusMm, lengthMm, halfAngleRad, weightMPa } = SCORDELIS_LO;
    const faceted = roof.mesh.triangles.reduce((value, [a, b, c]) => value + triangleArea(roof.mesh.nodes[a], roof.mesh.nodes[b], roof.mesh.nodes[c]), 0);
    const weight = roof.input.nodalLoads.reduce((value, load) => value + load.forceN[2], 0);
    expect(Math.abs(weight + weightMPa * faceted) / (weightMPa * faceted)).toBeLessThanOrEqual(1e-12);
    // Faceting shortens the arc by the chord ratio sin(d/2)/(d/2), d = 10 degrees on the coarsest roof.
    const chord = Math.sin(halfAngleRad / LEVELS[0] / 2) / (halfAngleRad / LEVELS[0] / 2);
    expect(Math.abs(faceted - radiusMm * halfAngleRad * lengthMm / 2 * chord) / faceted).toBeLessThanOrEqual(1e-12);
  });
});

describe('shell benchmarks on the bundled native TR_SHELL02 (no network)', () => {
  it('the quarter plate with symmetry rows reproduces the full 8x8 union-jack plate', () => {
    const quarter = plateCase(plateSpec('simply-supported', LEVELS[0], THICKNESS.moderate));
    const full = plateCase(plateSpec('simply-supported', 2 * LEVELS[0], THICKNESS.moderate, 'full'));
    const part = solve(quarter.input), whole = solve(full.input);
    const deflection = Math.max(...part.result.displacement.map(row => Math.abs(row[2])));
    const rotation = Math.max(...part.result.displacement.map(row => Math.max(Math.abs(row[3]), Math.abs(row[4]))));
    let difference = 0;
    for (let j = 0; j <= LEVELS[0]; j += 1) {
      for (let i = 0; i <= LEVELS[0]; i += 1) {
        const a = part.result.displacement[quarter.mesh.at(i, j)], b = whole.result.displacement[full.mesh.at(i, j)];
        expect(quarter.input.nodes[quarter.mesh.at(i, j)]).toEqual(full.input.nodes[full.mesh.at(i, j)]);
        difference = Math.max(difference, Math.abs(a[2] - b[2]) / deflection, Math.abs(a[3] - b[3]) / rotation, Math.abs(a[4] - b[4]) / rotation);
      }
    }
    if (part.result.recovery.status !== 'available' || whole.result.recovery.status !== 'available') throw new Error('Planar recovery missing');
    // The centre of the quarter is a corner (2 triangles, one-sided) but, by the mesh symmetry, its xx/yy averages equal
    // the 8-triangle average at the interior centre node of the full plate.
    const corner = part.result.recovery.nodes[quarter.probe], centre = whole.result.recovery.nodes[full.probe];
    const stress = Math.abs(centre.surface.topMPa[0]);
    const stressDifference = Math.max(...[0, 1].map(axis => Math.abs(corner.surface.topMPa[axis] - centre.surface.topMPa[axis]) / stress));
    evidence.equivalence = { displacementRelative: difference, stressRelative: stressDifference, quarterSeconds: part.seconds,
      fullSeconds: whole.seconds, fullNodes: full.input.nodes.length, fullElements: full.input.elements.length };
    expect(difference).toBeLessThanOrEqual(1e-8);
    expect(corner.contributingElements).toHaveLength(2);
    expect(centre.contributingElements).toHaveLength(8);
    expect(stressDifference).toBeLessThanOrEqual(1e-8);
    expect(denied).toBe(0);
  });

  it('simply supported square plate, t/a = 1/100: centre w within 2% of 0.00406 qa^4/D (monotone) and stress within 5% of 0.287 qa^2/t^2', () => {
    expectConverged(plateSeries('simplySupported', 'simply-supported', THICKNESS.moderate));
    expect(denied).toBe(0);
  });

  it('clamped square plate, t/a = 1/100: centre w within 2% of 0.00126 qa^4/D (monotone) and stress within 5% of 0.1386 qa^2/t^2', () => {
    expectConverged(plateSeries('clamped', 'clamped', THICKNESS.moderate));
    expect(denied).toBe(0);
  });

  it('records locking: the simply supported meshes at t/a = 1/1000 (record only; the acceptance stays at t/a = 1/100)', () => {
    const rows = plateSeries('locking', 'simply-supported', THICKNESS.thin);
    expect(rows.every(row => Number.isFinite(row.wRelative) && Number.isFinite(row.sigmaRelative))).toBe(true);
    expect(denied).toBe(0);
  });

  it('Scordelis-Lo roof: free-edge midpoint uz within 5% of -0.3024 at the finest of three meshes', () => {
    const levels = LEVELS.map(cells => {
      const roof = scordelisLoCase(cells), { result, seconds } = solve(roof.input);
      const uzMm = result.displacement[roof.probe][2];
      const faceted = roof.mesh.triangles.reduce((value, [a, b, c]) => value + triangleArea(roof.mesh.nodes[a], roof.mesh.nodes[b], roof.mesh.nodes[c]), 0);
      return { result, weight: SCORDELIS_LO.weightMPa * faceted, row: { cells, nodes: roof.input.nodes.length, elements: roof.input.elements.length,
        uzMm, referenceMm: SCORDELIS_LO.referenceUzMm, relative: Math.abs(uzMm - SCORDELIS_LO.referenceUzMm) / Math.abs(SCORDELIS_LO.referenceUzMm),
        facetedAreaMm2: faceted, seconds } };
    });
    evidence.scordelisLo = levels.map(level => level.row);
    for (const { result, weight } of levels) {
      expect(Math.abs(sum(result.reactions, 2) - weight) / weight).toBeLessThanOrEqual(1e-8);
      // Curved (faceted) shells have no product stress recovery: the planar nodal averaging refuses with a reason.
      expect(result.recovery).toMatchObject({ status: 'unavailable', code: 'nonplanar' });
    }
    expect(levels[levels.length - 1].row.relative).toBeLessThanOrEqual(LIMITS.shellDeflection);
    expect(denied).toBe(0);
  });
});
