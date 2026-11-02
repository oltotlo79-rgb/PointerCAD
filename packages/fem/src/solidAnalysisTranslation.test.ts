import { describe, expect, it } from 'vitest';
import type { SolidAnalysisInput } from './solidAnalysisModel.js';
import { solidStrainStress, solidTetGeometry, translateSolidAnalysis } from './solidAnalysisTranslation.js';
import { solidInputSha256 } from './solidAnalysisTranslation.js';
import { findStrengthMaterial, STRENGTH_SOURCES } from '../../model/src/measure/strengthMaterials.js';

describe('W12 prescribed translations, gravity and rigid modes', () => {
  it('owns prescribed vectors, defaults omitted nodes to zero, and hashes the new values', async () => {
    const base = fixture(), prescribedMm: [number, number, number] = [0.1, -0.2, 0.3];
    const supplied = { ...base, constraints: base.constraints.map(row => row.node === 0 ? { ...row, prescribedMm } : row) };
    const { input, plan } = translateSolidAnalysis(supplied);
    expect(plan.prescribedMm).toEqual([[0.1, -0.2, 0.3], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    expect(input.constraints[0].prescribedMm).not.toBe(prescribedMm);
    expect(plan.prescribedMm?.[0]).not.toBe(input.constraints[0].prescribedMm);
    prescribedMm[0] = 10;
    expect(plan.prescribedMm?.[0][0]).toBe(0.1);
    expect(await solidInputSha256(input)).not.toBe(await solidInputSha256(base));
    expect(translateSolidAnalysis(JSON.parse(JSON.stringify(input)))).toEqual({ input, plan });
    expect(Object.hasOwn(translateSolidAnalysis(base).plan, 'prescribedMm')).toBe(false);
    expect(translateSolidAnalysis({ ...base, constraints: base.constraints.map(row => ({ ...row, prescribedMm: [0, 0, 0] })) })
      .plan.prescribedMm).toEqual(base.nodes.map(() => [0, 0, 0]));
  });
  it.each([undefined, [0, 0], [0, 0, 0, 0], [NaN, 0, 0], [0, Infinity, 0], [0, 0, '1'], new Array<unknown>(3)]
    .map(prescribedMm => ({ prescribedMm })))(
    'rejects malformed prescribed translations $prescribedMm without changing input', ({ prescribedMm }) => {
      const base = fixture(), input = { ...base, constraints: [{ ...base.constraints[0], prescribedMm }, ...base.constraints.slice(1)] };
      const before = structuredClone(input);
      expect(() => translateSolidAnalysis(input)).toThrow();
      expect(input).toEqual(before);
    });
  it('rejects a nonzero prescription on a free axis and unexpected constraint fields', () => {
    const base = fixture();
    expect(() => translateSolidAnalysis({ ...base, constraints: base.constraints.map(row => row.node === 1
      ? { ...row, prescribedMm: [0.1, 0, 0] } : row) })).toThrow('unrestrained axis');
    expect(() => translateSolidAnalysis({ ...base, constraints: base.constraints.map(row => ({ ...row, displacement: 1 })) }))
      .toThrow('unexpected fields');
  });
  it('lumps an independently known tetrahedron mass and adds it to nodal and surface forces', async () => {
    const base = fixture(), gravity = { accelerationMps2: [3, -4, -9.80665], densities: [{ materialId: 'steel', densityKgM3: 7850 }] };
    const supplied = { ...base, gravity, surfaceLoads: [{ nodes: [0, 1, 2] as const, tractionMPa: [0, 0, 6] as const }] };
    const { input, plan } = translateSolidAnalysis(supplied);
    const without = translateSolidAnalysis({ ...base, surfaceLoads: supplied.surfaceLoads }).plan;
    const massKg = (1 / 6) * 1e-9 * 7850;
    for (let node = 0; node < 4; node += 1) for (let axis = 0; axis < 3; axis += 1) {
      expect(Math.abs(plan.forcesN[node][axis] - without.forcesN[node][axis] - massKg * gravity.accelerationMps2[axis] / 4)
        / (massKg * Math.abs(gravity.accelerationMps2[axis]))).toBeLessThanOrEqual(1e-9);
    }
    expect(input.gravity).not.toBe(gravity);
    expect(input.gravity?.densities[0]).not.toBe(gravity.densities[0]);
    expect(input.gravity?.accelerationMps2).not.toBe(gravity.accelerationMps2);
    expect(await solidInputSha256(input)).not.toBe(await solidInputSha256({ ...base, surfaceLoads: supplied.surfaceLoads }));
    expect(translateSolidAnalysis(JSON.parse(JSON.stringify(input)))).toEqual({ input, plan });
    gravity.accelerationMps2[0] = 100;
    gravity.densities[0].densityKgM3 = 1;
    expect(input.gravity?.accelerationMps2[0]).toBe(3);
    expect(input.gravity?.densities[0].densityKgM3).toBe(7850);
  });
  it('uses each element material density and requires density for every used material', () => {
    const base = fixture(), input = { ...base, nodes: [...base.nodes, [1, 1, 1]],
      elements: [...base.elements, { nodes: [1, 2, 3, 4], materialId: 'other' }],
      materials: [...base.materials, { id: 'other', youngMPa: 200, poisson: 0 }], nodalLoads: [],
      gravity: { accelerationMps2: [0, 0, -10], densities: [{ materialId: 'steel', densityKgM3: 6000 },
        { materialId: 'other', densityKgM3: 3000 }] } };
    const { plan } = translateSolidAnalysis(input);
    // Independent volumes 1/6 and 1/3 mm^3 give masses 1e-6 kg each.
    expect(Math.abs(plan.forcesN.reduce((sum, force) => sum + force[2], 0) + 2e-5) / 2e-5).toBeLessThanOrEqual(1e-9);
    expect(() => translateSolidAnalysis({ ...input, gravity: { ...input.gravity, densities: input.gravity.densities.slice(0, 1) } }))
      .toThrow('missing gravity material density');
  });
  it('rejects invalid gravity data without defaults or non-finite accumulation', () => {
    const base = fixture(), valid = { accelerationMps2: [0, 0, -10], densities: [{ materialId: 'steel', densityKgM3: 7850 }] };
    for (const gravity of [undefined, {}, { ...valid, extra: 0 }, { ...valid, accelerationMps2: [0, NaN, 0] },
      { ...valid, accelerationMps2: [0, 0] }, { ...valid, densities: [] },
      ...[0, -1, NaN, Infinity].map(densityKgM3 => ({ ...valid, densities: [{ materialId: 'steel', densityKgM3 }] })),
      { ...valid, densities: [{ materialId: 'unknown', densityKgM3: 1 }] },
      { ...valid, densities: [valid.densities[0], valid.densities[0]] },
      { ...valid, accelerationMps2: [Number.MAX_VALUE, 0, 0], densities: [{ materialId: 'steel', densityKgM3: Number.MAX_VALUE }] },
      { ...valid, densities: [{ materialId: 'steel', densityKgM3: Number.MIN_VALUE }] }]) {
      const input = { ...base, gravity }, before = structuredClone(input);
      expect(() => translateSolidAnalysis(input)).toThrow();
      expect(input).toEqual(before);
    }
    expect(translateSolidAnalysis({ ...base, gravity: { ...valid, accelerationMps2: [0, 0, 0] } }).plan.forcesN)
      .toEqual(translateSolidAnalysis(base).plan.forcesN);
  });
  it.each([
    ['no restraints', []],
    ['one fixed point', [{ node: 0, fixed: [true, true, true] }]],
    ['two fixed points on a line', [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [true, true, true] }]],
    ['unrestrained z translation', [0, 1, 2, 3].map(node => ({ node, fixed: [true, true, false] }))],
  ])('rejects %s with a rigid-body reason and preserves input', (_, constraints) => {
    const input = { ...fixture(), constraints }, before = structuredClone(input);
    expect(() => translateSolidAnalysis(input)).toThrow('rigid-body');
    expect(input).toEqual(before);
  });
});

describe('W12 legacy plan bytes', () => {
  it('keeps the pre-extension JSON including key order and omitted optional fields', () => {
    const input = fixture();
    const expected = JSON.stringify({ schema: 'pointercad-solid-tet4-plan/1', input,
      forcesN: [[0, 0, 0], [1, 0, 0], [0, 0, 0], [0, 0, 0]],
      fixed: [[true, true, true], [false, true, true], [true, true, true], [true, true, true]] });
    expect(JSON.stringify(translateSolidAnalysis(input).plan)).toBe(expected);
  });
});

function fixture(): SolidAnalysisInput {
  return { schema: 'pointercad-solid-tet4/1', source: { documentId: 'part', revision: 4, meshKey: 'mesh-4' },
    units: 'N-mm-MPa', numericBudgetBytes: 16 * 1024 * 1024,
    nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
    elements: [{ nodes: [0, 1, 2, 3], materialId: 'steel' }],
    materials: [{ id: 'steel', youngMPa: 210000, poisson: 0 }],
    constraints: [{ node: 0, fixed: [true, true, true] }, { node: 2, fixed: [true, true, true] },
      { node: 3, fixed: [true, true, true] }, { node: 1, fixed: [false, true, true] }],
    nodalLoads: [{ node: 1, forceN: [1, 0, 0] }], surfaceLoads: [] };
}

describe('solid tet4 translation and independent continuum identities', () => {
  it('retains coherent N-mm-MPa inputs and owns vectors before an await', () => {
    const input = fixture(), translated = translateSolidAnalysis(input);
    expect(translated.plan.forcesN).toEqual([[0, 0, 0], [1, 0, 0], [0, 0, 0], [0, 0, 0]]);
    expect(translated.input.nodes).not.toBe(input.nodes);
    expect(translated.input.nodes[0]).not.toBe(input.nodes[0]);
  });
  it('integrates constant traction over a half-square-mm triangle, preserving winding independence', () => {
    const input = fixture();
    for (const nodes of [[0, 1, 2], [2, 1, 0]] as const) {
      const { plan } = translateSolidAnalysis({ ...input, nodalLoads: [], surfaceLoads: [{ nodes, tractionMPa: [0, 0, 6] }] });
      expect(plan.forcesN).toEqual([[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 0]]);
    }
  });
  it('uses engineering shear gamma and shear stress G gamma, not twice that stress', () => {
    const geometry = solidTetGeometry(fixture().nodes);
    expect(geometry.volumeMm3).toBe(1 / 6);
    // u_x = 0.02*y. Tensor epsilon_xy=0.01; engineering gamma_xy=0.02.
    const result = solidStrainStress(geometry.gradients, [[0, 0, 0], [0, 0, 0], [0.02, 0, 0], [0, 0, 0]],
      { id: 'reference', youngMPa: 200, poisson: 0.25 });
    expect(result.strain).toEqual([0, 0, 0, 0, 0, 0.02]);
    expect(result.stressMPa).toEqual([0, 0, 0, 0, 0, 1.6]);
  });
  it('rejects a rigid rotation left free despite fixing all translations of one point', () => {
    expect(() => translateSolidAnalysis({ ...fixture(), constraints: [{ node: 0, fixed: [true, true, true] }] }))
      .toThrow('rigid-body');
  });
  it('rejects inverted tetrahedra and incompressible or non-finite material data', () => {
    expect(() => translateSolidAnalysis({ ...fixture(), elements: [{ nodes: [0, 2, 1, 3], materialId: 'steel' }] }))
      .toThrow('non-positive');
    for (const poisson of [0.5, -1, Number.NaN]) {
      expect(() => translateSolidAnalysis({ ...fixture(), materials: [{ id: 'steel', youngMPa: 210000, poisson }] })).toThrow();
    }
  });
  it.each(['point', 'edge'] as const)('refuses a %s-only connection instead of inventing a tied interface', mode => {
    const base = fixture();
    const nodes = mode === 'point'
      ? [...base.nodes, [-1, 0, 0], [0, -1, 0], [0, 0, -1]]
      : [...base.nodes, [0, -1, 0], [0, 0, -1]];
    const elements = [...base.elements, { nodes: mode === 'point' ? [0, 5, 4, 6] : [0, 1, 4, 5], materialId: 'steel' }];
    expect(() => translateSolidAnalysis({ ...base, nodes, elements,
      constraints: nodes.map((_, node) => ({ node, fixed: [true, true, true] })) })).toThrow('point/edge-only');
  });
  it('retains the existing 10000-node capacity beyond both rejected small-cap proposal limits', () => {
    const base = fixture();
    const nodes: [number, number, number][] = [];
    const elements: { nodes: [number, number, number, number]; materialId: string }[] = [];
    for (let i = 0; i < 2500; i += 1) {
      const n = nodes.length, x = i * 3;
      nodes.push([x, 0, 0], [x + 1, 0, 0], [x, 1, 0], [x, 0, 1]);
      elements.push({ nodes: [n, n + 1, n + 2, n + 3], materialId: 'steel' });
    }
    const result = translateSolidAnalysis({ ...base, nodes, elements, nodalLoads: [],
      constraints: nodes.map((_, node) => ({ node, fixed: [true, true, true] })) });
    expect(result.input.nodes).toHaveLength(10000);
    expect(result.input.elements).toHaveLength(2500);
    expect(() => translateSolidAnalysis({ ...result.input, nodes: [...nodes, [0, 0, 2]] })).toThrow('bounded');
  });
});

describe('solid yield capacity input contract', () => {
  const rows = [
    ['ss400-plate-0-16', 245, 'jisf-g3101-draft', 16],
    ['ss400-plate-16-40', 235, 'jisf-g3101-draft', 40],
    ['ss400-plate-40-100', 215, 'jisf-g3101-draft', 100],
    ['s45c-normalized-reference', 345, 'tsubaki-s45c', null],
    ['s45c-quenched-tempered-reference', 490, 'tsubaki-s45c', null],
  ] as const;
  it.each(rows)('carries the exact W01 yield/source and evidence for %s', async (materialConditionId, yieldMPa, sourceId, thicknessMm) => {
    const preset = findStrengthMaterial(materialConditionId);
    if (preset === undefined) throw new Error('Missing W01 row');
    expect(preset.yieldStress.mpa).toBe(String(yieldMPa));
    expect(preset.yieldStress.sourceId).toBe(sourceId);
    const capacity = { materialConditionId, yieldMPa, sourceId, thicknessMm, condition: preset.condition,
      evidence: STRENGTH_SOURCES[sourceId].evidence, basis: preset.yieldStress.basis };
    const base = fixture();
    const supplied = { ...base, materials: base.materials.map(material => ({ ...material, capacity })) };
    const { input, plan } = translateSolidAnalysis(supplied);
    expect(input.materials[0].capacity).toEqual(capacity);
    expect(plan.input.materials[0].capacity).toEqual(capacity);
    expect(input.materials[0].capacity).not.toBe(capacity);
    expect(() => translateSolidAnalysis({ ...supplied, materials: [{ ...supplied.materials[0], unexpected: true }] }))
      .toThrow('unexpected fields');
    expect(() => translateSolidAnalysis({ ...supplied,
      materials: [{ ...supplied.materials[0], capacity: { ...capacity, unexpected: true } }] })).toThrow();
    if (sourceId === 'tsubaki-s45c') expect(input.materials[0].capacity)
      .toMatchObject({ evidence: 'manufacturer-reference', basis: 'reference' });
    expect(plan.forcesN).toEqual(translateSolidAnalysis(base).plan.forcesN);
    expect(plan.fixed).toEqual(translateSolidAnalysis(base).plan.fixed);
    const geometry = solidTetGeometry(base.nodes);
    const displacement = [[0, 0, 0], [0.01, 0, 0], [0, 0, 0], [0, 0, 0]] as const;
    expect(solidStrainStress(geometry.gradients, displacement, input.materials[0]))
      .toEqual(solidStrainStress(geometry.gradients, displacement, base.materials[0]));
    expect(await solidInputSha256(input)).not.toBe(await solidInputSha256(base));
    const restored: unknown = JSON.parse(JSON.stringify(input));
    expect(translateSolidAnalysis(restored)).toEqual({ input, plan });
    for (const [invalid, code] of [
      [{ ...capacity, sourceId: undefined }, 'material-capacity-source-missing'],
      [{ ...capacity, condition: 'different treatment' }, 'material-capacity-condition-mismatch'],
      ...(thicknessMm === null ? [] : [[{ ...capacity, thicknessMm: 101 }, 'material-capacity-thickness-outside']] as const),
    ] as const) {
      const before = structuredClone({ input, plan });
      expect(() => translateSolidAnalysis({ ...supplied,
        materials: supplied.materials.map(material => ({ ...material, capacity: invalid })) }))
        .toThrow(expect.objectContaining({ code }));
      expect({ input, plan }).toEqual(before);
    }
  });
  it.each([
    [16, 'ss400-plate-0-16', 245, 'ss400-plate-16-40', 235],
    [40, 'ss400-plate-16-40', 235, 'ss400-plate-40-100', 215],
  ] as const)('preserves the inclusive lower band and rejects the next band at %s mm',
    (thicknessMm, lowerId, lowerYield, upperId, upperYield) => {
      const base = fixture();
      const makeInput = (materialConditionId: string, yieldMPa: number, thickness: number) => {
        const preset = findStrengthMaterial(materialConditionId);
        if (preset === undefined) throw new Error('Missing W01 row');
        return { ...base, materials: base.materials.map(material => ({ ...material,
          capacity: { materialConditionId, yieldMPa, sourceId: 'jisf-g3101-draft', thicknessMm: thickness,
            condition: preset.condition, evidence: 'standard-draft', basis: 'minimum' } })) };
      };
      const lower = makeInput(lowerId, lowerYield, thicknessMm);
      expect(translateSolidAnalysis(lower).input.materials[0].capacity?.yieldMPa).toBe(lowerYield);
      const rejected = makeInput(upperId, upperYield, thicknessMm), before = structuredClone(rejected);
      expect(() => translateSolidAnalysis(rejected))
        .toThrow(expect.objectContaining({ code: 'material-capacity-thickness-outside' }));
      expect(rejected).toEqual(before);
      expect(translateSolidAnalysis(makeInput(upperId, upperYield, thicknessMm + 0.001)).input.materials[0].capacity)
        .toMatchObject({ materialConditionId: upperId, yieldMPa: upperYield, thicknessMm: thicknessMm + 0.001 });
    });
  it('keeps legacy material fields exact and rejects every unknown field beside the optional capacity', () => {
    const base = fixture();
    expect(translateSolidAnalysis(base).input.materials).toEqual(base.materials);
    expect(Object.hasOwn(translateSolidAnalysis(base).input.materials[0], 'capacity')).toBe(false);
    for (const extra of [{ unexpected: true }, { yieldMPa: 245 }, { sourceId: 'jisf-g3101-draft' },
      { [Symbol('hidden')]: true }]) {
      expect(() => translateSolidAnalysis({ ...base, materials: [{ ...base.materials[0], ...extra }] })).toThrow('unexpected fields');
    }
    expect(() => translateSolidAnalysis({ ...base, materials: [{ ...base.materials[0], capacity: undefined }] }))
      .toThrow(expect.objectContaining({ code: 'material-capacity-missing' }));
  });
});
