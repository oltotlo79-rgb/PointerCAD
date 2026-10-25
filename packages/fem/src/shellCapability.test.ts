import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '../../test-utils/src/releasePerformance.js';
import { isLoader, isRuntime, type PyodideRuntime } from './runtime.js';
import { readShellAnalysisInput, type ShellAnalysisInput } from './shellAnalysisModel.js';

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
let evidence: Record<string, unknown> | undefined;
let denied = 0;
const originalFetch = globalThis.fetch;
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Missing evidence record');
  return Object.fromEntries(Object.entries(value));
}
function rows(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Missing evidence list');
  return Array.from(value);
}
function numeric(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Nonfinite or missing evidence value');
  return value;
}
function numbers(value: unknown): number[] { return rows(value).map(numeric); }
function observed(): Record<string, unknown> {
  if (evidence === undefined) throw new Error('No native capability evidence');
  return evidence;
}
function specimens(): Record<string, unknown>[] { return rows(observed().specimens).map(record); }
beforeAll(async () => {
  for (const name of ['package.json', 'pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip',
    'pyodide-lock.json', 'numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl', wheel]) verified(name);
  globalThis.fetch = () => { denied += 1; return Promise.reject(new Error('shell-capability: offline request denied')); };
  const loader: unknown = await import(/* @vite-ignore */ pathToFileURL(join(assets, 'pyodide.mjs')).href);
  if (!isLoader(loader)) throw new Error('Invalid packaged Pyodide loader');
  const loaded = await loader.loadPyodide({ indexURL: assets + sep, packageBaseUrl: assets + sep, packageCacheDir: assets,
    lockFileContents: readFileSync(join(assets, 'pyodide-lock.json'), 'utf8'), stdLibURL: join(assets, 'python_stdlib.zip'),
    packages: ['numpy'], fullStdLib: false, stdout: () => undefined, stderr: () => undefined });
  if (!isRuntime(loaded)) throw new Error('Invalid packaged Pyodide runtime');
  runtime = loaded;
  await runtime.loadPackage(join(assets, wheel).split(sep).join('/'), { checkIntegrity: true });
  runtime.FS.mkdirTree('/pcad_fem');
  runtime.FS.writeFile('/pcad_fem/shellCapability.py', readFileSync(new URL('./shellCapability.py', import.meta.url)));
  const encoded = runtime.runPython(`
import sys
sys.path.insert(0, '/pcad_fem')
from shellCapability import probe_shell_capability
probe_shell_capability()
`);
  if (typeof encoded !== 'string') throw new Error('No shell capability evidence');
  const decoded: unknown = JSON.parse(encoded);
  evidence = record(decoded);
  process.stdout.write(`SHELL_CAPABILITY ${encoded}\n`);
}, FUNCTIONAL_TEST_TIMEOUT_MS);
afterAll(() => { globalThis.fetch = originalFetch; });

describe('shell capability of the actual bundled OOFEM', () => {
  it('pins the native distribution and observes real registered candidates without network access', () => {
    expect(createHash('sha256').update(verified(wheel)).digest('hex'))
      .toBe('aaff729b15e1cec2ef90c9c0bb2d3594b3997b523d35344b18ba9f64d4d1a7e4');
    expect(observed()).toMatchObject({ oofemVersion: '3.1.dev5+g214b161ed', numpyVersion: '2.2.5', pyodideVersion: '0.29.3',
      registeredCandidates: ['dktplate', 'dktplate3d', 'cctplate', 'cctplate3d', 'qdktplate', 'quad1mindlin',
        'tr_shell01', 'tr_shell02', 'tr_shell11', 'rershell', 'mitc4shell', 'quad1mindlinshell3d', 'tr2shell7'] });
    expect(denied).toBe(0);
  });
  it('creates one TR_SHELL02 triangle with six actual DOFs and nonzero rotations under load', () => {
    expect(specimens()).toHaveLength(2);
    for (const row of specimens()) {
      expect(row).toMatchObject({ elementClass: 'TR_SHELL02', nodeDofs: [6, 6, 6],
        dofMasks: [[1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6]] });
      const displacement = rows(row.displacements).map(numbers);
      expect(displacement).toHaveLength(3);
      expect(displacement.slice(0, 2)).toEqual([Array(6).fill(0), Array(6).fill(0)]);
      expect(displacement[2]).toHaveLength(6);
      for (const rotation of displacement[2].slice(3)) expect(Math.abs(rotation)).toBeGreaterThan(0);
    }
  });
  it('verifies a nonzero native loaded energy against work and free-node equilibrium', () => {
    for (const row of specimens()) {
      const energy = numeric(row.loadedEnergyNmm), work = numeric(row.halfLoadWorkNmm);
      expect(energy).toBeGreaterThan(0);
      expect(work).toBeGreaterThan(0);
      expect(Math.abs(energy - work) / work).toBeLessThanOrEqual(1e-10);
      expect(numeric(row.freeEquilibriumRelative)).toBeLessThanOrEqual(1e-10);
      expect(numeric(row.stiffnessSymmetryRelative)).toBeLessThanOrEqual(1e-12);
    }
  });
  it('keeps all six linearized rigid motions below 1e-10 of the loaded energy', () => {
    for (const row of specimens()) {
      const energies = numbers(row.rigidEnergiesNmm), ratios = numbers(row.rigidEnergyRatios);
      const residuals = numbers(row.rigidResidualsRelative);
      expect(energies).toHaveLength(6);
      expect(ratios).toHaveLength(6);
      expect(residuals).toHaveLength(6);
      energies.forEach((energy, i) => {
        expect(ratios[i]).toBe(Math.abs(energy) / numeric(row.loadedEnergyNmm));
        expect(ratios[i]).toBeLessThanOrEqual(1e-10);
        // This independent normalization prevents a large applied load from
        // concealing a non-rigid stiffness response.
        expect(residuals[i]).toBeLessThanOrEqual(1e-12);
      });
    }
  });
  it('demonstrates native thickness input through the independent t and t-cubed stiffness laws', () => {
    expect(specimens().map(row => row.inputThicknessMm)).toEqual([1, 2]);
    const scaling = record(observed().thicknessScaling);
    for (const [name, factor] of [['membrane', 2], ['bending', 8]] as const) {
      const row = record(scaling[name]);
      expect(row.expectedFactor).toBe(factor);
      expect(numeric(row.measuredNormRatio)).toBeCloseTo(factor, 11);
      expect(numeric(row.relativeError)).toBeLessThanOrEqual(1e-12);
    }
  });
  it('reads every integration point and distinguishes shell resultants from physical stress', () => {
    for (const specimen of specimens()) {
      expect(specimen.integrationPointCount).toBe(4);
      const points = rows(specimen.integrationPoints).map(record);
      expect(points).toHaveLength(4);
      for (const point of points) {
        const coordinates = numbers(point.globalCoordinatesMm);
        expect(coordinates).toHaveLength(3);
        expect(coordinates[0]).toBeGreaterThan(0);
        expect(coordinates[1]).toBeGreaterThan(0);
        expect(coordinates[0] + coordinates[1]).toBeLessThan(10);
        expect(coordinates[2]).toBe(0);
        const values = record(point.values);
        const stress = numbers(values.IST_StressTensor), force = numbers(values.IST_ShellForceTensor);
        const moment = numbers(values.IST_ShellMomentTensor);
        expect(force).toHaveLength(6);
        expect(moment).toHaveLength(6);
        expect(numbers(values.IST_ShellStrainTensor)).toHaveLength(6);
        expect(numbers(values.IST_CurvatureTensor)).toHaveLength(6);
        expect(Math.max(...force.map(Math.abs))).toBeGreaterThan(0);
        expect(Math.max(...moment.map(Math.abs))).toBeGreaterThan(0);
        // TR_SHELL02 gives its plate integration rule. IST_StressTensor is the
        // plate's generalized resultants: not the shell's six Cauchy stresses
        // and not a top/bottom stress sample in MPa. Do not relabel these values.
        expect(stress).toHaveLength(8);
        expect(stress).toEqual([0, 0, 0, moment[0], moment[1], moment[5], 0, 0]);
        expect(numbers(values.IST_StressTensor_Reduced)).toEqual([moment[0], moment[1], moment[5], 0, 0]);
        expect(point.cauchyStressStatus).toBe(0);
        expect(point.cauchyStressValues).toEqual([]);
      }
    }
  });
  it('records the exact missing public bindings, with lookup failures rather than a skip', () => {
    const expected = ['CrossSection.give', 'CrossSectionProperty', 'CS_Thickness', 'Element.giveRotationMatrix',
      'GaussPoint.giveNaturalCoordinates', 'GaussPoint.giveWeight', 'GaussPoint.giveMaterialMode',
      'GaussPoint.giveSlaveGaussPoint', 'GaussPoint.giveSlaveGaussPoints'];
    for (const row of specimens()) {
      const missing = record(row.missingBindings);
      expect(Object.keys(missing)).toEqual(expected);
      for (const message of Object.values(missing)) expect(message).toEqual(expect.stringContaining('has no attribute'));
    }
  });
});

function input(): ShellAnalysisInput {
  return { schema: 'pointercad-shell-tri3/1', source: { documentId: 'shell-doc', revision: 1, meshKey: 'surface:1' },
    units: 'N-mm-MPa-rad', surface: 'explicit-reference-surface', nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0]],
    elements: [{ nodes: [0, 1, 2], materialId: 'steel', thicknessMm: 1, offsetMm: 0 }],
    materials: [{ id: 'steel', youngMPa: 205000, poisson: 0.3 }],
    constraints: [{ node: 0, fixed: [true, true, true, true, true, true] },
      { node: 1, fixed: [true, true, true, true, true, true] }],
    nodalLoads: [{ node: 2, forceN: [1, 0, -1], momentNmm: [0.1, 0.2, 0.3] }] };
}

describe('shell input contract (validation only)', () => {
  it('preserves explicit dimensions, rotations, offsets and moments without modifying the input', () => {
    const original = input();
    const json = JSON.stringify(original);
    const parsed = readShellAnalysisInput(original);
    expect(parsed).toEqual(original);
    expect(parsed.nodes).not.toBe(original.nodes);
    expect(JSON.stringify(original)).toBe(json);
    for (const offsetMm of [-2, 0, 2]) {
      expect(readShellAnalysisInput({ ...original, elements: [{ ...original.elements[0], offsetMm }] })
        .elements[0].offsetMm).toBe(offsetMm);
    }
  });
  it.each([0, -1, NaN, Infinity, -Infinity, '1', undefined, null])('rejects invalid thickness %s', thicknessMm => {
    const original = input();
    expect(() => readShellAnalysisInput({ ...original, elements: [{ ...original.elements[0], thicknessMm }] }))
      .toThrow('shell-input: element.thicknessMm');
  });
  it.each(['N-mm-MPa', 'N-m-Pa-rad', 'N-mm-MPa-deg', '', undefined])('rejects unrecognized units %s', units => {
    expect(() => readShellAnalysisInput({ ...input(), units })).toThrow('shell-input: units');
  });
  it.each(['schema', 'source', 'units', 'surface', 'nodes', 'elements', 'materials', 'constraints', 'nodalLoads'])(
    'rejects missing %s', key => {
      const missing = Object.fromEntries(Object.entries(input()).filter(([name]) => name !== key));
      expect(() => readShellAnalysisInput(missing)).toThrow('shell-input: fields');
    });
  it('rejects missing thickness and offset instead of supplying defaults', () => {
    const original = input();
    for (const missing of ['thicknessMm', 'offsetMm']) {
      const element = Object.fromEntries(Object.entries(original.elements[0]).filter(([key]) => key !== missing));
      expect(() => readShellAnalysisInput({ ...original, elements: [element] })).toThrow('shell-input: element');
    }
  });
  it.each([
    { constraints: [{ node: 0, fixed: [true, true, true] }] },
    { constraints: [{ node: 0, fixed: [true, true, true, 0, 0, 0] }] },
    { nodalLoads: [{ node: 2, forceN: [1, 0, -1] }] },
    { nodalLoads: [{ node: 2, forceN: [1, 0, -1], momentNmm: [0, NaN, 0] }] },
    { nodes: [[0, 0], [10, 0, 0], [0, 10, 0]] },
    { nodes: [[0, 0, Infinity], [10, 0, 0], [0, 10, 0]] },
    { nodes: Array(3) },
    { source: { documentId: '', revision: 1, meshKey: 'mesh' } },
    { source: { documentId: 'doc', revision: -1, meshKey: 'mesh' } },
    { source: { documentId: 'doc', revision: 1 } },
    { surface: 'automatic-midsurface' },
    { surfaceLoads: [] },
  ])('rejects incomplete or ambiguous data %#', patch => {
    expect(() => readShellAnalysisInput({ ...input(), ...patch })).toThrow('shell-input:');
  });
  it.each([
    { nodes: [0, 1, 3] }, { nodes: [0, 1, 1] }, { nodes: [0, 1, 1.5] }, { nodes: [-1, 1, 2] },
    { nodes: [0, 1, 2, 3] }, { materialId: 'missing' }, { offsetMm: NaN },
  ])('rejects invalid triangle input %#', patch => {
    const original = input();
    expect(() => readShellAnalysisInput({ ...original, elements: [{ ...original.elements[0], ...patch }] }))
      .toThrow('shell-input:');
  });
  it.each([{ youngMPa: 0 }, { youngMPa: Infinity }, { poisson: -1 }, { poisson: 0.5 }, { poisson: NaN }, { id: '' }])(
    'rejects invalid material %#', patch => {
      const original = input();
      expect(() => readShellAnalysisInput({ ...original, materials: [{ ...original.materials[0], ...patch }] }))
        .toThrow('shell-input:');
    });
  it('rejects duplicate assignments, reversed duplicate triangles and unused nodes', () => {
    const original = input();
    const patches = [
      { materials: [...original.materials, ...original.materials] },
      { constraints: [...original.constraints, original.constraints[0]] },
      { nodalLoads: [...original.nodalLoads, ...original.nodalLoads] },
      { elements: [...original.elements, { ...original.elements[0], nodes: [2, 1, 0] }] },
      { nodes: [...original.nodes, [0, 0, 10]] },
      { constraints: [{ ...original.constraints[0], node: 3 }] },
      { nodalLoads: [{ ...original.nodalLoads[0], node: -1 }] },
    ];
    for (const patch of patches) expect(() => readShellAnalysisInput({ ...original, ...patch })).toThrow('shell-input:');
  });
  it('does not treat a geometry-only surface mesh as analysis input', () => {
    expect(() => readShellAnalysisInput({ schema: 'pointercad-cad-shell-surface/1', units: 'mm', physicsValidated: false }))
      .toThrow('shell-input: fields');
  });
});
