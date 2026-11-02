import { describe, expect, it } from 'vitest';
import type { SolidAnalysisInput } from './solidAnalysisModel.js';
import { decodeSolidAnalysis, solidResultMatches } from './solidAnalysisResults.js';
import { solidInputSha256 } from './solidAnalysisTranslation.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll } from 'vitest';
import type { SolidVector3 } from './solidAnalysisModel.js';
import { isSolidAnalysisResult } from './solidAnalysisResults.js';
import { translateSolidAnalysis } from './solidAnalysisTranslation.js';
import { analyzeSolid, isLoader, isRuntime, type PyodideRuntime } from './runtime.js';
import { FUNCTIONAL_TEST_TIMEOUT_MS } from '../../test-utils/src/releasePerformance.js';

describe('W12 optional native reactions', () => {
  it('preserves absent reactions and owns and validates supplied nodal reactions', () => {
    const input = fixture(), raw = native(input), legacy = decodeSolidAnalysis(raw, input, digest);
    expect(Object.hasOwn(legacy, 'reactionsN')).toBe(false);
    const reactionsN = legacy.reactionN.map(row => [...row]);
    const result = decodeSolidAnalysis({ ...raw, reactionsN }, input, digest);
    expect(result.reactionsN).toEqual(legacy.reactionN);
    expect(result.reactionsN).not.toBe(reactionsN);
    expect(result.reactionsN?.[0]).not.toBe(reactionsN[0]);
    expect(isSolidAnalysisResult(result)).toBe(true);
    expect(solidResultMatches(result, input, digest)).toBe(true);
    reactionsN[0][0] = 100;
    expect(result.reactionsN?.[0][0]).toBe(-1);
    expect(solidResultMatches({ ...result, reactionsN }, input, digest)).toBe(false);
    expect(() => decodeSolidAnalysis({ ...raw, reactionsN }, input, digest)).toThrow('native reaction differs');
    expect(() => decodeSolidAnalysis({ ...raw, reactionsN: [[-1, 0, 0], [1e-20, 0, 0], [0, 0, 0], [0, 0, 0]] }, input, digest))
      .toThrow('unrestrained axis');
  });
  it.each([undefined, [], new Array<unknown>(4), [[0, 0, 0]], [[NaN, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]]
    .map(reactionsN => ({ reactionsN })))(
    'rejects malformed optional reactions $reactionsN', ({ reactionsN }) => {
      const input = fixture(), raw = native(input), result = decodeSolidAnalysis(raw, input, digest);
      expect(() => decodeSolidAnalysis({ ...raw, reactionsN }, input, digest)).toThrow();
      expect(isSolidAnalysisResult({ ...result, reactionsN })).toBe(false);
      expect(solidResultMatches({ ...result, reactionsN }, input, digest)).toBe(false);
    });
  it('requires exact prescribed displacement and includes support work in the energy identity', () => {
    const base = fixture(), raw = native(base), delta = raw.displacementMm[1][0];
    const input: SolidAnalysisInput = { ...base, nodalLoads: [], constraints: base.constraints.map(row => row.node === 1
      ? { node: 1, fixed: [true, true, true], prescribedMm: [delta, 0, 0] } : row) };
    const reactionsN = [[-1, 0, 0], [1, 0, 0], [0, 0, 0], [0, 0, 0]];
    const result = decodeSolidAnalysis({ ...raw, reactionsN }, input, digest);
    expect(result.displacementMm[1][0]).toBe(delta);
    expect(result.strainEnergyNmm).toBeCloseTo(delta / 2, 15);
    expect(solidResultMatches(result, input, digest)).toBe(true);
    expect(() => decodeSolidAnalysis({ ...raw, reactionsN, displacementMm: raw.displacementMm.map((row, node) => node === 1
      ? [delta * (1 + 1e-12), 0, 0] : row) }, input, digest)).toThrow('prescribed value');
  });
});

// Rectangular 100 x 10 x 20 mm bar; each cell is six positively oriented
// tetrahedra. Analytical volume and end area do not use solidTetGeometry.
function gravityBar(segments = 1): SolidAnalysisInput {
  const nodes: [number, number, number][] = [], elements: SolidAnalysisInput['elements'][number][] = [];
  for (let i = 0; i <= segments; i += 1) for (const y of [0, 10]) for (const z of [0, 20]) nodes.push([100 * i / segments, y, z]);
  const pattern = [[0, 4, 6, 7], [0, 6, 2, 7], [0, 2, 3, 7], [0, 3, 1, 7], [0, 1, 5, 7], [0, 5, 4, 7]] as const;
  for (let i = 0; i < segments; i += 1) for (const tet of pattern) elements.push({ materialId: 'm',
    nodes: [tet[0] + 4 * i, tet[1] + 4 * i, tet[2] + 4 * i, tet[3] + 4 * i] });
  return { schema: 'pointercad-solid-tet4/1', source: { documentId: 'W12-bar', revision: 1, meshKey: `bar-${segments}` },
    units: 'N-mm-MPa', numericBudgetBytes: 16 * 1024 * 1024, nodes, elements,
    materials: [{ id: 'm', youngMPa: 210000, poisson: 0 }],
    constraints: [0, 1, 2, 3].map(node => ({ node, fixed: [true, true, true] })), nodalLoads: [], surfaceLoads: [] };
}
function resultant(vectors: readonly SolidVector3[]): [number, number, number] {
  return vectors.reduce<[number, number, number]>((sum, row) => [sum[0] + row[0], sum[1] + row[1], sum[2] + row[2]], [0, 0, 0]);
}
function relativeVectorError(actual: SolidVector3, expected: SolidVector3): number {
  return Math.hypot(...actual.map((v, axis) => v - expected[axis])) / Math.hypot(...expected);
}
function reportBoundaryEvidence(value: Record<string, unknown>): void {
  process.stdout.write(`W12 evidence ${JSON.stringify(value)}${String.fromCharCode(10)}`);
}

describe('W12 source wrapper with packaged offline OOFEM', () => {
  const assets = fileURLToPath(new URL('../runtime/assets/', import.meta.url));
  const manifest: unknown = JSON.parse(readFileSync(new URL('../runtime/manifest.json', import.meta.url), 'utf8'));
  const wheel = 'oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl';
  // Asset publishing is a separate step: exercise this source change without
  // rewriting the immutable runtime assets or their integrity manifest.
  const wrapper = new Uint8Array(readFileSync(new URL('./solidAnalysis.py', import.meta.url)));
  const programs = { wrapper, wheelLocation: join(assets, wheel).split(sep).join('/') };
  const originalFetch = globalThis.fetch;
  let runtime: PyodideRuntime, deniedRequests = 0;
  beforeAll(async () => {
    globalThis.fetch = () => { deniedRequests++; return Promise.reject(new Error('offline-request-denied')); };
    if (typeof manifest !== 'object' || manifest === null || !('files' in manifest)
      || typeof manifest.files !== 'object' || manifest.files === null) throw new Error('Missing manifest');
    for (const name of ['package.json', 'pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip',
      'pyodide-lock.json', 'numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl', wheel]) {
      const pin: unknown = Object.entries(manifest.files).find(([key]) => key === `assets/${name}`)?.[1];
      if (typeof pin !== 'object' || pin === null || !('sha256' in pin) || !('bytes' in pin)) throw new Error('Missing asset pin');
      const bytes = readFileSync(join(assets, name));
      expect({ bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') })
        .toEqual({ bytes: pin.bytes, sha256: pin.sha256 });
    }
    const loader: unknown = await import(/* @vite-ignore */ pathToFileURL(join(assets, 'pyodide.mjs')).href);
    if (!isLoader(loader)) throw new Error('Invalid packaged loader');
    const loaded = await loader.loadPyodide({ indexURL: assets + sep, packageBaseUrl: assets + sep, packageCacheDir: assets,
      lockFileContents: readFileSync(join(assets, 'pyodide-lock.json'), 'utf8'), stdLibURL: join(assets, 'python_stdlib.zip'),
      packages: ['numpy'], fullStdLib: false, stdout: () => undefined, stderr: () => undefined });
    if (!isRuntime(loaded)) throw new Error('Invalid packaged runtime');
    runtime = loaded;
    runtime.FS.mkdirTree('/pcad_fem');
    runtime.FS.writeFile('/pcad_fem/solid_analysis.py', wrapper);
    await runtime.loadPackage(programs.wheelLocation, { checkIntegrity: true });
    runtime.runPython(`import sys
sys.path.insert(0, '/pcad_fem')
import solid_analysis as boundary
`);
  }, FUNCTIONAL_TEST_TIMEOUT_MS);
  afterAll(() => { globalThis.fetch = originalFetch; expect(deniedRequests).toBe(0); });

  it('solves the minimum six scalar restraints with distinct x-only, y-only and z-only nodes', async () => {
    const input: SolidAnalysisInput = { ...gravityBar(), constraints: [
      ...[0, 1, 2].map(node => ({ node, fixed: [true, false, false] as const })),
      ...[4, 5].map(node => ({ node, fixed: [false, true, false] as const })),
      { node: 6, fixed: [false, false, true] }], nodalLoads: [{ node: 7, forceN: [12, -7, -9] }] };
    const before = structuredClone(input), result = await analyzeSolid(runtime, input, programs, () => undefined);
    expect(result.reactionsN).toBeDefined();
    if (result.reactionsN === undefined) throw new Error('Missing native reactions');
    const actual = resultant(result.reactionsN), expected: SolidVector3 = [-12, 7, 9];
    const relative = relativeVectorError(actual, expected);
    expect(relative).toBeLessThanOrEqual(1e-8);
    expect(result.maximumRelativeEquilibriumResidual).toBeLessThanOrEqual(1e-8);
    expect(solidResultMatches(result, input, await solidInputSha256(input))).toBe(true);
    expect(input).toEqual(before);
    // Removing any one scalar support leaves one rigid mode free.
    for (let i = 0; i < input.constraints.length; i += 1) expect(() => translateSolidAnalysis({ ...input,
      constraints: input.constraints.filter((_, j) => j !== i) })).toThrow('rigid-body');
    reportBoundaryEvidence({ example: 'independent-axes', expected, actual, relative });
  }, FUNCTIONAL_TEST_TIMEOUT_MS);

  it('prescribes 0.1 mm exactly and solves the free middle section against E*A*delta/L', async () => {
    const base = gravityBar(2), delta = 0.1;
    const input: SolidAnalysisInput = { ...base, constraints: [...base.constraints,
      ...[8, 9, 10, 11].map(node => ({ node, fixed: [true, false, false] as const, prescribedMm: [delta, 0, 0] as const }))] };
    const before = structuredClone(input), result = await analyzeSolid(runtime, input, programs, () => undefined);
    if (result.reactionsN === undefined) throw new Error('Missing native reactions');
    for (const node of [8, 9, 10, 11]) {
      expect(result.displacementMm[node][0]).toBe(delta);
      expect(new Uint8Array(new Float64Array([result.displacementMm[node][0]]).buffer))
        .toEqual(new Uint8Array(new Float64Array([delta]).buffer));
    }
    for (const node of [4, 5, 6, 7]) expect(Math.abs(result.displacementMm[node][0] - delta / 2) / delta).toBeLessThanOrEqual(1e-6);
    const expected = 210000 * (10 * 20) * delta / 100;
    const actual = resultant(result.reactionsN.slice(8))[0], relative = Math.abs(actual - expected) / expected;
    expect(relative).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(resultant(result.reactionsN)[0]) / expected).toBeLessThanOrEqual(1e-8);
    expect(Math.abs(result.strainEnergyNmm - expected * delta / 2) / (expected * delta / 2)).toBeLessThanOrEqual(1e-6);
    expect(solidResultMatches(result, input, await solidInputSha256(input))).toBe(true);
    expect(input).toEqual(before);
    const deck = runtime.runPython("open('/pcad_fem/solid.in', encoding='utf-8').read()");
    expect(typeof deck).toBe('string');
    expect(deck).toContain('nbc 2');
    expect(deck).toContain('BoundaryCondition 2 loadTimeFunction 1 prescribedValue 0.1');
    reportBoundaryEvidence({ example: 'prescribed-bar', expected, actual, relative,
      displacementMm: result.displacementMm[8][0], middleMm: result.displacementMm[4][0], strainEnergyNmm: result.strainEnergyNmm });
  }, FUNCTIONAL_TEST_TIMEOUT_MS);

  it('balances gravity against rectangular volume times density and acceleration', async () => {
    const input: SolidAnalysisInput = { ...gravityBar(), gravity: { accelerationMps2: [0, 0, -9.80665],
      densities: [{ materialId: 'm', densityKgM3: 7850 }] } };
    const massKg = 100 * 10 * 20 * 1e-9 * 7850, expected: SolidVector3 = [0, 0, massKg * 9.80665];
    const before = structuredClone(input), force = resultant(translateSolidAnalysis(input).plan.forcesN);
    const loadRelative = relativeVectorError(force, [0, 0, -expected[2]]);
    expect(loadRelative).toBeLessThanOrEqual(1e-9);
    const result = await analyzeSolid(runtime, input, programs, () => undefined);
    if (result.reactionsN === undefined) throw new Error('Missing native reactions');
    const actual = resultant(result.reactionsN), relative = relativeVectorError(actual, expected);
    expect(relative).toBeLessThanOrEqual(1e-8);
    expect(solidResultMatches(result, input, await solidInputSha256(input))).toBe(true);
    expect(input).toEqual(before);
    reportBoundaryEvidence({ example: 'gravity', massKg, expected, actual, relative, force, loadRelative });
  }, FUNCTIONAL_TEST_TIMEOUT_MS);

  it('retains loads on constrained nodes in reactions and superposes gravity with external forces', async () => {
    const input: SolidAnalysisInput = { ...gravityBar(), gravity: { accelerationMps2: [3, -4, -5],
      densities: [{ materialId: 'm', densityKgM3: 7850 }] }, nodalLoads: [{ node: 0, forceN: [2, 3, 4] }, { node: 7, forceN: [1, 2, 3] }],
    surfaceLoads: [{ nodes: [4, 6, 7], tractionMPa: [0.01, -0.02, 0.03] }] };
    const result = await analyzeSolid(runtime, input, programs, () => undefined);
    if (result.reactionsN === undefined) throw new Error('Missing native reactions');
    // Triangle area 100 mm^2, whole bar mass .157 kg, nodal resultant [3,5,7].
    const expected: SolidVector3 = [-(3 + 1 + 0.157 * 3), -(5 - 2 - 0.157 * 4), -(7 + 3 - 0.157 * 5)];
    expect(relativeVectorError(resultant(result.reactionsN), expected)).toBeLessThanOrEqual(1e-8);
  }, FUNCTIONAL_TEST_TIMEOUT_MS);

  it('handles a nonzero prescribed translation when every degree of freedom is fixed', async () => {
    const base = fixture(), input: SolidAnalysisInput = { ...base, nodalLoads: [], constraints: base.constraints.map(row => row.node === 1
      ? { node: 1, fixed: [true, true, true], prescribedMm: [-0.1, 0, 0] } : row) };
    const result = await analyzeSolid(runtime, input, programs, () => undefined);
    expect(result.displacementMm[1][0]).toBe(-0.1);
    expect(result.reactionsN?.[1][0]).toBeCloseTo(-3500, 8);
    expect(result.minimumScaledPivot).toBe(1);
    expect(solidResultMatches(result, input, await solidInputSha256(input))).toBe(true);
  }, FUNCTIONAL_TEST_TIMEOUT_MS);

  it('keeps signed boundary values associated with original nodes under a permutation', () => {
    const output = runtime.runPython(`import json
p = {'input': {'nodes': [[0,0,0],[1,0,0],[0,1,0],[0,0,1]],
    'elements': [{'nodes': [0,1,2,3], 'materialId': 'm'}],
    'materials': [{'id': 'm', 'youngMPa': 210000, 'poisson': 0}]},
    'fixed': [[True]*3 for _ in range(4)],
    'prescribedMm': [[0.1,-0.2,0.3], [0,0,0], [0.1,0,0], [0,0,0]]}
order, inverse = [3,2,1,0], [4,3,2,1]
deck = boundary._deck(p, order, inverse)
conditions, nodes = {}, {}
for line in deck.splitlines():
    t = line.split()
    if t and t[0] == 'BoundaryCondition': conditions[int(t[1])] = float(t[-1])
    if t and t[0] == 'node': nodes[int(t[1])] = [conditions_id for conditions_id in map(int, t[9:12])]
assert len(conditions) == 4
for original, number in enumerate(inverse):
    assert [conditions[i] for i in nodes[number]] == p['prescribedMm'][original]
legacy = {key: value for key, value in p.items() if key != 'prescribedMm'}
assert boundary._node_order(p) == boundary._node_order(legacy)
assert 'nbc 1' in boundary._deck(legacy, order, inverse)
assert 'prescribedValue 0.0' in boundary._deck(legacy, order, inverse)
p['fixed'][0][0] = False
try:
    boundary._prescribed(p)
    raise AssertionError('unrestrained prescription accepted')
except ValueError as error:
    assert 'unrestrained' in str(error)
json.dumps({'checks': 'passed'})
`);
    expect(output).toBe('{"checks": "passed"}');
  });
});

function fixture(length = 1, youngMPa = 210000, force = 1): SolidAnalysisInput {
  return { schema: 'pointercad-solid-tet4/1', source: { documentId: 'tet', revision: 1, meshKey: 'tet:1' },
    units: 'N-mm-MPa', numericBudgetBytes: 16 * 1024 * 1024,
    nodes: [[0, 0, 0], [length, 0, 0], [0, length, 0], [0, 0, length]],
    elements: [{ nodes: [0, 1, 2, 3], materialId: 'm' }], materials: [{ id: 'm', youngMPa, poisson: 0 }],
    constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, true, true] },
      { node: 2, fixed: [true, true, true] }, { node: 3, fixed: [true, true, true] }],
    nodalLoads: [{ node: 1, forceN: [force, 0, 0] }], surfaceLoads: [] };
}
const digest = '1'.repeat(64);
function native(input: SolidAnalysisInput) {
  const length = input.nodes[1][0], force = input.nodalLoads[0].forceN[0], e = input.materials[0].youngMPa;
  // Independent single free DOF: stiffness E*L/6; the tetra volume is L^3/6.
  return { schema: 'pointercad-solid-tet4-native/1', source: input.source,
    displacementMm: [[0, 0, 0], [6 * force / (e * length), 0, 0], [0, 0, 0], [0, 0, 0]],
    elementForcesN: [[-force, 0, 0, force, 0, 0, 0, 0, 0, 0, 0, 0]],
    reservedNumericBytes: 50000, minimumScaledPivot: 1 };
}

describe('independent solid native result acceptance', () => {
  it.each([[1, 210000, 1], [1, 420000, -2], [1000, 210000, 1000]] as const)(
    'preserves coherent mm/MPa, signed loading and material scaling L=%s E=%s F=%s', (length, young, force) => {
      const input = fixture(length, young, force), result = decodeSolidAnalysis(native(input), input, digest);
      expect(result.displacementMm[1][0]).toBeCloseTo(6 * force / (young * length), 12);
      expect(result.elements[0].strain[0]).toBeCloseTo(6 * force / (young * length * length), 12);
      expect(result.elements[0].stressMPa[0]).toBeCloseTo(6 * force / (length * length), 12);
      expect(result.reactionN[0]).toEqual([-force, 0, 0]);
      expect(result.strainEnergyNmm).toBeCloseTo(3 * force * force / (young * length), 12);
      expect(solidResultMatches(result, input, digest)).toBe(true);
    });
  it('rotates the geometry and load together instead of treating global y as x', () => {
    const base = fixture(), input: SolidAnalysisInput = { ...base,
      nodes: base.nodes.map(([x, y, z]) => [-y, x, z]),
      constraints: base.constraints.map(row => ({ ...row, fixed: [row.fixed[1], row.fixed[0], row.fixed[2]] })),
      nodalLoads: [{ node: 1, forceN: [0, 1, 0] }] };
    const raw = native(base);
    const result = decodeSolidAnalysis({ ...raw,
      displacementMm: raw.displacementMm.map(([x, y, z]) => [-y, x, z]),
      elementForcesN: [[0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]] }, input, digest);
    expect(result.elements[0].stressMPa).toEqual([0, 6, 0, 0, 0, 0]);
    expect(result.reactionN[0]).toEqual([0, -1, 0]);
  });
  it('validates pure shear against independent G gamma and boundary reactions', () => {
    const base = fixture(), shearForce = 1.6 / 6;
    const input: SolidAnalysisInput = { ...base, materials: [{ id: 'm', youngMPa: 200, poisson: 0.25 }],
      constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [true, true, true] },
        { node: 2, fixed: [false, true, true] }, { node: 3, fixed: [true, true, true] }],
      nodalLoads: [{ node: 2, forceN: [shearForce, 0, 0] }] };
    const result = decodeSolidAnalysis({ ...native(base),
      displacementMm: [[0, 0, 0], [0, 0, 0], [0.02, 0, 0], [0, 0, 0]],
      elementForcesN: [[-shearForce, -shearForce, 0, 0, shearForce, 0, shearForce, 0, 0, 0, 0, 0]] }, input, digest);
    expect(result.elements[0].strain[5]).toBe(0.02);
    expect(result.elements[0].stressMPa[5]).toBe(1.6);
    expect(result.strainEnergyNmm).toBeCloseTo(1.6 * 0.02 / 12, 14);
  });
  it('binds every constraint/material/load/source value into the digest and rejects stale or forged values', async () => {
    const input = fixture(), hash = await solidInputSha256(input), result = decodeSolidAnalysis(native(input), input, hash);
    expect(solidResultMatches(result, input, hash)).toBe(true);
    expect(await solidInputSha256({ ...input, source: { ...input.source, revision: 2 } })).not.toBe(hash);
    expect(solidResultMatches({ ...result, reactionN: [[0, 0, 0], ...result.reactionN.slice(1)] }, input, hash)).toBe(false);
    expect(solidResultMatches({ ...result, elements: [{ strain: result.elements[0].strain, stressMPa: [60, 0, 0, 0, 0, 0] }] }, input, hash)).toBe(false);
    expect(solidResultMatches(result, { ...input, source: { ...input.source, revision: 2 } }, hash)).toBe(false);
  });
  it.each([0, -1, Number.NaN, 1e-16])('rejects invalid or unresolved native factor pivot %s', minimumScaledPivot => {
    const input = fixture();
    expect(() => decodeSolidAnalysis({ ...native(input), minimumScaledPivot }, input, digest)).toThrow();
  });
  it('rejects sparse arrays, zero displacement under load, changed action and excessive allocation', () => {
    const input = fixture(), raw = native(input);
    expect(() => decodeSolidAnalysis({ ...raw, displacementMm: new Array<unknown>(4) }, input, digest)).toThrow();
    expect(() => decodeSolidAnalysis({ ...raw, displacementMm: input.nodes.map(() => [0, 0, 0]) }, input, digest)).toThrow();
    expect(() => decodeSolidAnalysis({ ...raw, elementForcesN: [[-2, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]] }, input, digest)).toThrow();
    expect(() => decodeSolidAnalysis({ ...raw, reservedNumericBytes: input.numericBudgetBytes + 1 }, input, digest)).toThrow();
  });
});


describe('two-tetrahedron affine axial patch', () => {
  // E=200 MPa, nu=0, u_x=.03*x gives sigma_xx=6 MPa everywhere.
  // Volumes are 1/6 and 1/3 mm^3; analytical assembled x forces are
  // [-1,2,-1,-1,1] N, and total energy is 6*.03*(1/2)/2=.045 N mm.
  const input: SolidAnalysisInput = { schema: 'pointercad-solid-tet4/1',
    source: { documentId: 'two-tet-patch', revision: 1, meshKey: 'two-tet-patch' },
    units: 'N-mm-MPa', numericBudgetBytes: 16 * 1024 * 1024,
    nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]],
    elements: [{ nodes: [0, 1, 2, 3], materialId: 'm' }, { nodes: [1, 2, 3, 4], materialId: 'm' }],
    materials: [{ id: 'm', youngMPa: 200, poisson: 0 }],
    constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, true, true] },
      { node: 2, fixed: [true, true, true] }, { node: 3, fixed: [true, true, true] },
      { node: 4, fixed: [false, true, true] }],
    nodalLoads: [{ node: 1, forceN: [2, 0, 0] }, { node: 4, forceN: [1, 0, 0] }], surfaceLoads: [] };
  const raw = { schema: 'pointercad-solid-tet4-native/1', source: input.source,
    displacementMm: [[0, 0, 0], [.03, 0, 0], [0, 0, 0], [0, 0, 0], [.03, 0, 0]],
    elementForcesN: [[-1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0],
      [1, 0, 0, -1, 0, 0, -1, 0, 0, 1, 0, 0]],
    reservedNumericBytes: 50000, minimumScaledPivot: 1 };
  it('refuses a wrong shared-node element action even if supplied forces balance', () => {
    const corrupted = { ...raw, elementForcesN: [[-1.1, 0, 0, 1.1, 0, 0, 0, 0, 0, 0, 0, 0],
      [.9, 0, 0, -1, 0, 0, -1, 0, 0, 1.1, 0, 0]] };
    expect(() => decodeSolidAnalysis(corrupted, input, digest)).toThrow('native action differs');
  });
  it('recovers identical strain and stress, assembled reactions and independent energy', () => {
    const result = decodeSolidAnalysis(raw, input, digest);
    for (const element of result.elements) {
      expect(element.strain[0]).toBeCloseTo(.03, 14);
      expect(element.stressMPa[0]).toBeCloseTo(6, 12);
      expect(element.stressMPa.slice(1)).toEqual([0, 0, 0, 0, 0]);
    }
    expect(result.reactionN).toEqual([[-1, 0, 0], [0, 0, 0], [-1, 0, 0], [-1, 0, 0], [0, 0, 0]]);
    expect(result.strainEnergyNmm).toBeCloseTo(.045, 14);
    expect(result.maximumRelativeEquilibriumResidual).toBeLessThanOrEqual(1e-8);
  });
});
