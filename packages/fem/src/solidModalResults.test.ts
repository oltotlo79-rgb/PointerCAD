import { describe, expect, it } from 'vitest';
import type { SolidVector3 } from './solidAnalysisModel.js';
import type { SolidModalInput } from './solidModalModel.js';
import { decodeSolidModal } from './solidModalResults.js';
import { solidModalInputSha256, translateSolidModal } from './solidModalTranslation.js';

// 7850 kg/m^3 written directly in t/mm^3, independent of the translation's conversion.
const RHO = 7.85e-9;
// (14 * 12^2 + 160 * 12 + 4096) * 8 for four nodes, written out.
const RESERVED_FOUR_NODES = 64256;
const digest = 'a'.repeat(64);
const source = { documentId: 'doc', revision: 3, meshKey: 'tet:3' };

/** Unit tet, nu = 0: only node 1 x (N1 = x/L) and node 2 x (N2 = y/L) are free. Independently:
 * K = diag(E L / 6, E L / 12) (axial and shear), M = rho V / 20 [[2, 1], [1, 2]], V = L^3 / 6. */
function supported(length = 10): SolidModalInput {
  return { schema: 'pointercad-solid-tet4-modal/1', source, units: 'N-mm-MPa', numericBudgetBytes: 16 * 1024 * 1024,
    nodes: [[0, 0, 0], [length, 0, 0], [0, length, 0], [0, 0, length]],
    elements: [{ nodes: [0, 1, 2, 3], materialId: 'steel' }],
    materials: [{ id: 'steel', youngMPa: 205000, poisson: 0, densityKgM3: 7850 }],
    constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, true, true] },
      { node: 2, fixed: [false, true, true] }, { node: 3, fixed: [true, true, true] }],
    modeCount: 2 };
}
function coupledModes(length = 10): { lambda: number; shape: [number, number] }[] {
  const volume = length ** 3 / 6, k1 = 205000 * length / 6, k2 = 205000 * length / 12;
  const d = RHO * volume / 10, o = RHO * volume / 20;
  // det(K - lambda M) = (d^2 - o^2) lambda^2 - d (k1 + k2) lambda + k1 k2 = 0, stable roots.
  const a = d * d - o * o, b = d * (k1 + k2), root = Math.sqrt(b * b - 4 * a * k1 * k2);
  const larger = (b + root) / (2 * a), smaller = k1 * k2 / (a * larger);
  return [smaller, larger].map(lambda => {
    const v: [number, number] = [lambda * o, k1 - lambda * d];
    const norm = Math.sqrt(d * v[0] * v[0] + 2 * o * v[0] * v[1] + d * v[1] * v[1]);
    return { lambda, shape: [v[0] / norm, v[1] / norm] };
  });
}
function native(input: SolidModalInput, modes: readonly { lambda: number; shape: readonly SolidVector3[] }[], rigid: 0 | 6, freeDofs: number, massT: number) {
  return { schema: 'pointercad-solid-tet4-modal-native/2', source: input.source, massMatrix: 'consistent', units: 'N-mm-MPa-t-s',
    modes: modes.map((mode, index) => ({ number: index + 1, eigenvaluePerSecondSquared: mode.lambda,
      frequencyHz: Math.sqrt(mode.lambda) / (2 * Math.PI), normalizedResidual: 1e-15, massNormalizedShapePerSqrtT: mode.shape })),
    totalMassT: massT, rigidBodyModes: rigid, freeDofs, maximumMassOrthogonalityError: 1e-15,
    maximumRigidMotionResidual: rigid === 6 ? 1e-15 : 0, maximumElementMassError: 1e-15, reservedNumericBytes: RESERVED_FOUR_NODES };
}
function supportedNative(input = supported()) {
  return native(input, coupledModes().map((mode): { lambda: number; shape: SolidVector3[] } => ({ lambda: mode.lambda,
    shape: [[0, 0, 0], [mode.shape[0], 0, 0], [mode.shape[1], 0, 0], [0, 0, 0]] })), 0, 2, RHO * 1000 / 6);
}

/** Regular tet (vertices +-a of a cube), nu = 0.25: every linear field u = A x with symmetric A is an exact
 * CST eigenvector. Deviatoric A: lambda = 10 mu / (rho a^2) (five-fold); dilatation: 15 K / (rho a^2). */
const A = 10;
function freeFree(): SolidModalInput {
  return { ...supported(), nodes: [[A, A, A], [-A, A, -A], [A, -A, -A], [-A, -A, A]], constraints: [], modeCount: 6,
    materials: [{ id: 'steel', youngMPa: 205000, poisson: 0.25, densityKgM3: 7850 }] };
}
function freeFreeNative(input = freeFree()) {
  const s2 = Math.SQRT2, s3 = Math.sqrt(3), s6 = Math.sqrt(6);
  const fields: number[][][] = [[[1 / s2, 0, 0], [0, -1 / s2, 0], [0, 0, 0]], [[1 / s6, 0, 0], [0, 1 / s6, 0], [0, 0, -2 / s6]],
    [[0, 1 / s2, 0], [1 / s2, 0, 0], [0, 0, 0]], [[0, 0, 0], [0, 0, 1 / s2], [0, 1 / s2, 0]],
    [[0, 0, 1 / s2], [0, 0, 0], [1 / s2, 0, 0]], [[1 / s3, 0, 0], [0, 1 / s3, 0], [0, 0, 1 / s3]]];
  const volume = 8 * A ** 3 / 3, mu = 205000 / 2.5, bulk = 205000 / 1.5;
  const norm = Math.sqrt(RHO * volume * A * A / 5);
  return native(input, fields.map((field, index) => ({
    lambda: index < 5 ? 10 * mu / (RHO * A * A) : 15 * bulk / (RHO * A * A),
    shape: input.nodes.map((p): SolidVector3 => {
      const [x, y, z] = [0, 1, 2].map(row => field[row].reduce((sum, v, column) => sum + v * p[column], 0) / norm);
      return [x, y, z];
    }) })),
  6, 12, RHO * volume);
}

describe('solid modal request translation', () => {
  it('converts kg/m^3 to t/mm^3 once and keeps the source identity and native plan fields', () => {
    const { plan, input, applicability, elasticDofs } = translateSolidModal(supported());
    expect(Object.keys(plan).sort()).toEqual(['elements', 'fixed', 'materials', 'modeCount', 'nodes', 'numericBudgetBytes', 'schema', 'source', 'units']);
    expect(Object.keys(plan.materials[0]).sort()).toEqual(['densityTPerMm3', 'id', 'poisson', 'youngMPa']);
    expect(Math.abs(plan.materials[0].densityTPerMm3 - RHO)).toBeLessThan(1e-24);
    expect(input.materials[0].densityKgM3).toBe(7850);
    expect(plan.source).toEqual(source);
    expect(plan.fixed).toEqual([[true, true, true], [false, true, true], [false, true, true], [true, true, true]]);
    expect([applicability, elasticDofs]).toEqual(['supported', 2]);
    expect(translateSolidModal(freeFree()).applicability).toBe('free-free');
  });
  it.each([
    ['unknown field', { ...supported(), extra: 1 }],
    ['missing field', Object.fromEntries(Object.entries(supported()).filter(([key]) => key !== 'modeCount'))],
    ['non-finite coordinate', { ...supported(), nodes: [[0, 0, 0], [Number.NaN, 0, 0], [0, 10, 0], [0, 0, 10]] }],
    ['infinite coordinate', { ...supported(), nodes: [[0, 0, 0], [Number.POSITIVE_INFINITY, 0, 0], [0, 10, 0], [0, 0, 10]] }],
    ['unused node', { ...supported(), nodes: [...supported().nodes, [5, 5, 5]] }],
    ['negative volume order', { ...supported(), elements: [{ nodes: [0, 2, 1, 3], materialId: 'steel' }] }],
    ['zero density', { ...supported(), materials: [{ id: 'steel', youngMPa: 205000, poisson: 0, densityKgM3: 0 }] }],
    ['negative density', { ...supported(), materials: [{ id: 'steel', youngMPa: 205000, poisson: 0, densityKgM3: -7850 }] }],
    ['density above 1e5 kg/m^3', { ...supported(), materials: [{ id: 'steel', youngMPa: 205000, poisson: 0, densityKgM3: 2e5 }] }],
    ['Poisson 0.5', { ...supported(), materials: [{ id: 'steel', youngMPa: 205000, poisson: 0.5, densityKgM3: 7850 }] }],
    ['duplicate constraint node', { ...supported(), constraints: [...supported().constraints, { node: 0, fixed: [true, true, true] }] }],
    ['restraint without a fixed translation', { ...supported(), constraints: [{ node: 0, fixed: [false, false, false] }] }],
    ['remaining rigid mechanism', { ...supported(), constraints: [{ node: 0, fixed: [true, true, true] }] }],
    ['zero modes', { ...supported(), modeCount: 0 }],
    ['21 modes', { ...freeFree(), modeCount: 21 }],
    ['fractional modes', { ...supported(), modeCount: 1.5 }],
    ['more modes than free DOFs', { ...supported(), modeCount: 3 }],
    ['more modes than elastic free-free DOFs', { ...freeFree(), modeCount: 7 }],
    ['budget below the dense reservation', { ...supported(), numericBudgetBytes: RESERVED_FOUR_NODES - 1 }],
    ['boolean coordinate', { ...supported(), nodes: [[0, 0, 0], [true, 0, 0], [0, 10, 0], [0, 0, 10]] }],
  ])('refuses %s before any native work', (_name, value) => {
    expect(() => translateSolidModal(value)).toThrow(/^solid-(modal-)?input: /u);
  });
  it('refuses two separate unrestrained bodies and hashes the owned input stably', async () => {
    const base = freeFree();
    const shifted = base.nodes.map(([x, y, z]): SolidVector3 => [x + 100, y, z]);
    expect(() => translateSolidModal({ ...base, nodes: [...base.nodes, ...shifted],
      elements: [{ nodes: [0, 1, 2, 3], materialId: 'steel' }, { nodes: [4, 5, 6, 7], materialId: 'steel' }] }))
      .toThrow('one face-connected solid');
    expect(await solidModalInputSha256(base)).toBe(await solidModalInputSha256(freeFree()));
  });
});

describe('solid modal native result decoding', () => {
  it('accepts the independently solved coupled two-DOF supported response', () => {
    const result = decodeSolidModal(supportedNative(), supported(), digest);
    const expected = coupledModes();
    expect(result.applicability).toBe('supported');
    expect(result.modes.map(mode => mode.number)).toEqual([1, 2]);
    result.modes.forEach((mode, index) => {
      expect(mode.eigenvaluePerSecondSquared).toBe(expected[index].lambda);
      expect(mode.frequencyHz).toBeCloseTo(Math.sqrt(expected[index].lambda) / (2 * Math.PI), 6);
    });
    expect(result.source).toEqual(source);
    expect(result.fixed[0]).toEqual([true, true, true]);
    expect(result.independentMaximumResidual).toBeLessThan(1e-12);
    expect(result.independentMaximumOrthogonalityError).toBeLessThan(1e-12);
    expect(result.structuralCertification).toBe(false);
  });
  it('accepts the exact free-free regular-tetrahedron spectrum with a degenerate deviatoric cluster', () => {
    const result = decodeSolidModal(freeFreeNative(), freeFree(), digest);
    expect(result.rigidBodyModes).toBe(6);
    expect(result.modes[0].eigenvaluePerSecondSquared).toBe(result.modes[4].eigenvaluePerSecondSquared);
    expect(result.modes[5].eigenvaluePerSecondSquared / result.modes[0].eigenvaluePerSecondSquared).toBeCloseTo(2.5, 12);
    expect(result.independentMaximumResidual).toBeLessThan(1e-12);
  });
  it('halves frequencies and mass-normalized shapes when the density is four times larger', () => {
    const heavy: SolidModalInput = { ...supported(), materials: [{ id: 'steel', youngMPa: 205000, poisson: 0, densityKgM3: 4 * 7850 }] };
    const light = decodeSolidModal(supportedNative(), supported(), digest);
    const raw = supportedNative();
    const scaled = { ...raw, totalMassT: 4 * raw.totalMassT, modes: raw.modes.map(mode => ({ ...mode,
      eigenvaluePerSecondSquared: mode.eigenvaluePerSecondSquared / 4, frequencyHz: mode.frequencyHz / 2,
      massNormalizedShapePerSqrtT: mode.massNormalizedShapePerSqrtT.map(v => v.map(x => x / 2)) })) };
    const result = decodeSolidModal(scaled, heavy, digest);
    result.modes.forEach((mode, index) => expect(mode.frequencyHz / light.modes[index].frequencyHz).toBeCloseTo(0.5, 12));
    // The unscaled shapes would not be mass-normalized for the heavier material.
    expect(() => decodeSolidModal({ ...scaled, modes: raw.modes.map(mode => ({ ...mode,
      eigenvaluePerSecondSquared: mode.eigenvaluePerSecondSquared / 4, frequencyHz: mode.frequencyHz / 2 })) }, heavy, digest))
      .toThrow('mass orthonormality');
  });
  const mutate = (change: (raw: ReturnType<typeof supportedNative>) => unknown) => change(supportedNative());
  it.each([
    ['extra field', mutate(raw => ({ ...raw, extra: 1 }))],
    ['missing field', mutate(raw => Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'reservedNumericBytes')))],
    ['schema 1', mutate(raw => ({ ...raw, schema: 'pointercad-solid-tet4-modal-native/1' }))],
    ['lumped mass', mutate(raw => ({ ...raw, massMatrix: 'lumped' }))],
    ['units', mutate(raw => ({ ...raw, units: 'N-mm-MPa' }))],
    ['stale revision', mutate(raw => ({ ...raw, source: { ...raw.source, revision: 2 } }))],
    ['other mesh', mutate(raw => ({ ...raw, source: { ...raw.source, meshKey: 'tet:2' } }))],
    ['mode count', mutate(raw => ({ ...raw, modes: raw.modes.slice(0, 1) }))],
    ['mode numbering', mutate(raw => ({ ...raw, modes: raw.modes.map(mode => ({ ...mode, number: 1 })) }))],
    ['r148 shape field name', mutate(raw => ({ ...raw, modes: raw.modes.map(({ massNormalizedShapePerSqrtT, ...mode }) => ({ ...mode, massNormalizedShapeMmPerSqrtT: massNormalizedShapePerSqrtT })) }))],
    ['descending order', mutate(raw => ({ ...raw, modes: [{ ...raw.modes[1], number: 1 }, { ...raw.modes[0], number: 2 }] }))],
    ['negative eigenvalue', mutate(raw => ({ ...raw, modes: raw.modes.map((mode, i) => i === 0 ? { ...mode, eigenvaluePerSecondSquared: -mode.eigenvaluePerSecondSquared } : mode) }))],
    ['frequency', mutate(raw => ({ ...raw, modes: raw.modes.map(mode => ({ ...mode, frequencyHz: mode.frequencyHz * 1.001 })) }))],
    ['eigenvalue in kg units', mutate(raw => ({ ...raw, modes: raw.modes.map(mode => ({ ...mode,
      eigenvaluePerSecondSquared: mode.eigenvaluePerSecondSquared * 1000, frequencyHz: mode.frequencyHz * Math.sqrt(1000) })) }))],
    ['shape normalized in kg', mutate(raw => ({ ...raw, modes: raw.modes.map(mode => ({ ...mode,
      massNormalizedShapePerSqrtT: mode.massNormalizedShapePerSqrtT.map(v => v.map(x => x / Math.sqrt(1000))) })) }))],
    ['duplicate mode', mutate(raw => ({ ...raw, modes: [raw.modes[0], { ...raw.modes[0], number: 2 }] }))],
    ['non-finite shape', mutate(raw => ({ ...raw, modes: raw.modes.map(mode => ({ ...mode, massNormalizedShapePerSqrtT: [[0, 0, 0], [Number.NaN, 0, 0], [0, 0, 0], [0, 0, 0]] })) }))],
    ['infinite eigenvalue', mutate(raw => ({ ...raw, modes: raw.modes.map(mode => ({ ...mode, eigenvaluePerSecondSquared: Number.POSITIVE_INFINITY })) }))],
    ['restrained component moved', mutate(raw => ({ ...raw, modes: raw.modes.map(mode => ({ ...mode,
      massNormalizedShapePerSqrtT: mode.massNormalizedShapePerSqrtT.map((v, node) => node === 0 ? [1e-30, 0, 0] : v) })) }))],
    ['shape row count', mutate(raw => ({ ...raw, modes: raw.modes.map(mode => ({ ...mode, massNormalizedShapePerSqrtT: mode.massNormalizedShapePerSqrtT.slice(0, 3) })) }))],
    ['total mass in kg', mutate(raw => ({ ...raw, totalMassT: raw.totalMassT * 1000 }))],
    ['rigid count', mutate(raw => ({ ...raw, rigidBodyModes: 6 }))],
    ['free DOFs', mutate(raw => ({ ...raw, freeDofs: 3 }))],
    ['native residual above 1e-8', mutate(raw => ({ ...raw, modes: raw.modes.map(mode => ({ ...mode, normalizedResidual: 2e-8 })) }))],
    ['negative native residual', mutate(raw => ({ ...raw, modes: raw.modes.map(mode => ({ ...mode, normalizedResidual: -1e-16 })) }))],
    ['orthogonality above 1e-8', mutate(raw => ({ ...raw, maximumMassOrthogonalityError: 2e-8 }))],
    ['rigid residual while supported', mutate(raw => ({ ...raw, maximumRigidMotionResidual: 1e-16 }))],
    ['element mass error', mutate(raw => ({ ...raw, maximumElementMassError: 2e-10 }))],
    ['r147 six-array reservation', mutate(raw => ({ ...raw, reservedNumericBytes: (6 * 144 + 64 * 12 + 4096) * 8 }))],
  ])('refuses %s', (_name, raw) => {
    expect(() => decodeSolidModal(raw, supported(), digest)).toThrow(/^solid-(modal-)?(result|input): /u);
  });
  it('refuses a free-free mode contaminated by a rigid translation and an invalid digest', () => {
    const raw = freeFreeNative();
    const contaminated = { ...raw, modes: raw.modes.map((mode, i) => i === 0
      ? { ...mode, massNormalizedShapePerSqrtT: mode.massNormalizedShapePerSqrtT.map(([x, y, z]) => [x + 1e-3, y, z]) } : mode) };
    expect(() => decodeSolidModal(contaminated, freeFree(), digest)).toThrow('solid-modal-result');
    expect(() => decodeSolidModal(raw, freeFree(), 'A'.repeat(64))).toThrow('invalid digest');
  });
});

describe('solid modal density conversion ownership', () => {
  it('keeps independent density literals, caller input and repeated input translation unchanged', () => {
    // Independent SI pairs written directly, not calculated with the production conversion.
    const pairs: readonly (readonly [number, number])[] = [
      [1, 1e-12], [1000, 1e-9], [2700, 2.7e-9], [7850, 7.85e-9], [100000, 1e-7],
    ];
    for (const [densityKgM3, expectedTPerMm3] of pairs) {
      const base = supported();
      const request: SolidModalInput = { ...base, materials: [{ ...base.materials[0], densityKgM3 }] };
      const before = structuredClone(request);
      const first = translateSolidModal(request);
      const second = translateSolidModal(first.input);
      expect(first.plan.materials[0].densityTPerMm3).toBe(expectedTPerMm3);
      expect(first.input.materials[0].densityKgM3).toBe(densityKgM3);
      expect(second.plan).toEqual(first.plan); // no second unit conversion of the native plan density
      expect(request).toEqual(before);
      expect(first.input).toEqual(before);
      expect(first.input.materials[0]).not.toBe(request.materials[0]);
    }
  });
});
