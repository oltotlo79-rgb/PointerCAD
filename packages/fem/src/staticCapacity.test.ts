import { describe, expect, it } from 'vitest';
import type { AnalysisMaterialCapacity, BeamAnalysisDocument, BeamAnalysisResult, Vector6 } from './analysisModel.js';
import { compareWithYield, elementFibreStresses, type BeamFibreSection } from './beamFibreStress.js';
import type { SolidAnalysisInput, SolidAnalysisResult, SolidVector6 } from './solidAnalysisModel.js';
import { beamStaticCapacity, solidStaticCapacity } from './staticCapacity.js';

// W02b table: SS400 <=16 mm (G3101 draft table 3), S45C condition-specific reference values.
const ss400: AnalysisMaterialCapacity = { materialConditionId: 'ss400-plate-0-16', condition: '圧延鋼板（熱処理の指定なし）',
  thicknessMm: 16, yieldMPa: 245, sourceId: 'jisf-g3101-draft', evidence: 'standard-draft', basis: 'minimum' };
const normalized: AnalysisMaterialCapacity = { materialConditionId: 's45c-normalized-reference',
  condition: '焼ならし・適用寸法未指定の参考値', thicknessMm: null, yieldMPa: 345,
  sourceId: 'tsubaki-s45c', evidence: 'manufacturer-reference', basis: 'reference' };
const tempered: AnalysisMaterialCapacity = { ...normalized, materialConditionId: 's45c-quenched-tempered-reference',
  condition: '焼入焼戻・適用寸法未指定の参考値', yieldMPa: 490 };
const capacities = new Map([['steel', ss400]]);
const rectangle: BeamFibreSection = { kind: 'rectangle', widthYM: 0.02, depthZM: 0.04 };
const rectangleOutlines = new Map([['section', rectangle]]);

function relative(actual: number | null, expected: number, tolerance = 1e-9): void {
  expect(actual).not.toBeNull();
  if (actual === null) throw new Error('expected an evaluated number');
  expect(Number.isFinite(actual)).toBe(true);
  if (expected === 0) expect(Math.abs(actual)).toBeLessThanOrEqual(tolerance);
  else expect(Math.abs((actual - expected) / expected)).toBeLessThanOrEqual(tolerance);
}

function beamFixture(forces: Vector6, units: 'N-m' | 'N-mm' = 'N-m', round = false): {
  document: BeamAnalysisDocument; result: BeamAnalysisResult; outlines: ReadonlyMap<string, BeamFibreSection>;
} {
  const scale = units === 'N-mm' ? 1000 : 1;
  const source = { kind: 'user-supplied', reference: 'hand calculation', condition: 'linear elastic' } as const;
  const document: BeamAnalysisDocument = {
    schema: 'pointercad-beam/1', id: 'static', revision: 1,
    source: { documentId: 'cad', documentRevision: 1, geometryRevision: 'geometry' }, units,
    nodes: [{ id: 'a', position: [0, 0, 0] }, { id: 'b', position: [scale, 0, 0] }],
    members: [{ id: 'member', componentId: 'part', occurrencePath: ['assembly', 'part'], startNodeId: 'a', endNodeId: 'b',
      materialId: 'steel', sectionId: 'section', localYHint: [0, 1, 0] }],
    materials: [{ id: 'steel', youngModulus: 200e9 / scale ** 2, shearModulus: 80e9 / scale ** 2, densityKgM3: 7850, source }],
    sections: [{ id: 'section', area: (round ? Math.PI * 0.01 ** 2 : 0.0008) * scale ** 2,
      iy: (round ? Math.PI * 0.01 ** 4 / 4 : 0.02 * 0.04 ** 3 / 12) * scale ** 4,
      iz: (round ? Math.PI * 0.01 ** 4 / 4 : 0.04 * 0.02 ** 3 / 12) * scale ** 4,
      torsionConstant: (round ? Math.PI * 0.01 ** 4 / 2 : 7.32e-8) * scale ** 4, shearFactor: 5 / 6, source }],
    constraints: [{ id: 'clamp', kind: 'fixed', nodeId: 'a' }],
    loads: [{ id: 'load', kind: 'nodal', nodeId: 'b', force: [forces[0], forces[1], forces[2]],
      moment: [forces[3] * scale, forces[4] * scale, forces[5] * scale] }],
  };
  // Hand-written native result payload: start end-action is the negative of the +x-face resultant.
  const result: BeamAnalysisResult = {
    kind: 'oofem-linear-beam-3d', model: 'linear-timoshenko-isotropic', analysisId: 'static', analysisRevision: 1,
    source: document.source, inputSha256: 'manual-result-no-native-solver', nodes: [],
    elements: [{ memberId: 'member', componentId: 'part', occurrencePath: ['assembly', 'part'], solverElement: 1,
      nodeIds: ['a', 'b'], frame: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], lengthM: 1 },
      start: [-forces[0], -forces[1], -forces[2], -forces[3], -forces[4], -forces[5]], end: forces }],
    balance: { referenceM: [0, 0, 0], forceN: [0, 0, 0], momentNm: [0, 0, 0], maximumFreeResidual: 0 },
    structuralCertification: false,
  };
  const circle: BeamFibreSection = { kind: 'circle', diameterM: 0.02 };
  return { document, result, outlines: round ? new Map([['section', circle]]) : rectangleOutlines };
}

function solidFixture(stress: SolidVector6): { input: SolidAnalysisInput; result: SolidAnalysisResult } {
  const input: SolidAnalysisInput = {
    schema: 'pointercad-solid-tet4/1', source: { documentId: 'cad', revision: 1, meshKey: 'tetra' }, units: 'N-mm-MPa',
    numericBudgetBytes: 100000, nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
    elements: [{ nodes: [0, 1, 2, 3], materialId: 'steel' }],
    materials: [{ id: 'steel', youngMPa: 200000, poisson: 0.3 }], constraints: [], nodalLoads: [], surfaceLoads: [],
  };
  // Constitutive postprocessing accepts an already validated result; no solve/decode is performed by this fixture.
  const result: SolidAnalysisResult = {
    kind: 'oofem-linear-solid-tet4', source: input.source, inputSha256: 'manual-result-no-native-solver',
    method: 'oofem-ltrspace-isole-native-ldlt/1', units: 'N-mm-MPa', structuralCertification: false,
    displacementMm: [], reactionN: [], elements: [{ stressMPa: stress, strain: [0, 0, 0, 0, 0, 0] }],
    strainEnergyNmm: 0, maximumRelativeEquilibriumResidual: 0, reservedNumericBytes: 100000,
    nativeElementForcesN: [], minimumScaledPivot: 1,
  };
  return { input, result };
}

describe('beam static capacity: independent closed-form solutions', () => {
  it('pure axial load: N/A = 80000/800 = 100 MPa', () => {
    const { document, result, outlines } = beamFixture([80000, 0, 0, 0, 0, 0]);
    const actual = beamStaticCapacity(result, document, capacities, outlines);
    for (const end of actual.elements[0].ends) {
      relative(end.tension.stressMPa, 100, 1e-6); relative(end.compression.stressMPa, 100, 1e-6);
      relative(end.maximumVonMisesMPa, 100, 1e-6); relative(end.tension.strain, 0.0005);
      relative(end.tension.axialMPa, 100); relative(end.tension.bendingYMPa, 0);
    }
    relative(actual.minimumSafetyFactor, 2.45);
    expect(actual.structuralCertification).toBe(false);
  });

  it('pure bending: Mc/I = 100000*20/(20*40^3/12) = 18.75 MPa', () => {
    const { document, result, outlines } = beamFixture([0, 0, 0, 0, 100, 0]);
    const actual = beamStaticCapacity(result, document, capacities, outlines);
    for (const end of actual.elements[0].ends) {
      relative(end.tension.stressMPa, 18.75, 1e-6); relative(end.compression.stressMPa, -18.75, 1e-6);
      relative(end.maximumVonMisesMPa, 18.75, 1e-6);
      relative(end.tension.zM, 0.02); relative(end.compression.zM, -0.02);
      relative(end.tension.strain, 18.75 / 200000); relative(end.compression.strain, -18.75 / 200000);
    }
  });

  it.each([-10, 10])('pure circular torsion (%s Nm): |Tr/J| = 10000*10/(pi*10^4/2) = 20/pi MPa', torque => {
    const { document, result, outlines } = beamFixture([0, 0, 0, torque, 0, 0], 'N-m', true);
    const actual = beamStaticCapacity(result, document, capacities, outlines);
    for (const end of actual.elements[0].ends) {
      relative(end.tension.stressMPa, 0); relative(end.compression.stressMPa, 0);
      relative(end.maximumTorsionShearMPa, 20 / Math.PI, 1e-6);
      relative(end.maximumVonMisesMPa, 20 * Math.sqrt(3) / Math.PI, 1e-6);
      relative(end.maximumTorsionShearStrain, 20 / Math.PI / 80000);
      relative(end.safetyFactor, 245 * Math.PI / (20 * Math.sqrt(3)));
    }
  });

  it('axial plus biaxial bending: 100 +/-18.75 +/-18.75 MPa at the opposite corners', () => {
    const { document, result, outlines } = beamFixture([80000, 0, 0, 0, 100, 50]);
    const actual = beamStaticCapacity(result, document, capacities, outlines);
    for (const end of actual.elements[0].ends) {
      relative(end.tension.stressMPa, 137.5, 1e-6); relative(end.compression.stressMPa, 62.5, 1e-6);
      relative(end.maximumVonMisesMPa, 137.5, 1e-6);
      expect([end.tension.yM, end.tension.zM]).toEqual([-0.01, 0.02]);
      expect([end.compression.yM, end.compression.zM]).toEqual([0.01, -0.02]);
      relative(end.tension.bendingYMPa, 18.75); relative(end.tension.bendingZMPa, 18.75);
    }
  });
});

describe('beam evidence, units, and unavailable evaluation', () => {
  it('circular tube combines axial stress and outer-radius torsion using the hollow polar moment', () => {
    const { document, result } = beamFixture([7500 * Math.PI, 0, 0, 10, 0, 0], 'N-m', true);
    const tube: BeamFibreSection = { kind: 'tube', outsideDiameterM: 0.02, wallThicknessM: 0.005 };
    const hollow = { ...document, sections: document.sections.map(row => ({ ...row,
      area: 75 * Math.PI * 1e-6, iy: 2343.75 * Math.PI * 1e-12, iz: 2343.75 * Math.PI * 1e-12,
      torsionConstant: 4687.5 * Math.PI * 1e-12 })) };
    const row = beamStaticCapacity(result, hollow, capacities, new Map([['section', tube]])).elements[0].ends[0];
    relative(row.tension.stressMPa, 100);
    relative(row.maximumTorsionShearMPa, 64 / (3 * Math.PI));
    relative(row.maximumVonMisesMPa, Math.sqrt(10000 + 4096 / (3 * Math.PI ** 2)));
  });

  it.each([ss400, normalized, tempered])('$materialConditionId preserves the sourced condition and yield/stress ratio', capacity => {
    const { document, result, outlines } = beamFixture([80000, 0, 0, 0, 0, 0]);
    const actual = beamStaticCapacity(result, document, new Map([['steel', capacity]]), outlines);
    relative(actual.minimumSafetyFactor, capacity.yieldMPa / 100);
    expect(actual.elements[0].capacity).toEqual(capacity);
    expect(actual.elements[0].capacity).not.toBe(capacity);
    expect(actual.elements[0].ends[0].capacity).toMatchObject({ sourceId: capacity.sourceId, evidence: capacity.evidence, basis: capacity.basis });
  });

  it('uses the existing fibre helper and nominal yield comparison without changing their interpretation', () => {
    const forces: Vector6 = [80000, 0, 0, 0, 100, 50];
    const { document, result, outlines } = beamFixture(forces);
    const actual = beamStaticCapacity(result, document, capacities, outlines);
    const legacy = elementFibreStresses([{ element: 1, memberId: 'member', segment: 0, start: [forces], end: [forces] }],
      { kind: 'rectangle', widthYM: 0.02, depthZM: 0.04 },
      { areaM2: 0.0008, iyM4: 0.02 * 0.04 ** 3 / 12, izM4: 0.04 * 0.02 ** 3 / 12 });
    for (const [index, end] of actual.elements[0].ends.entries()) {
      relative(end.tension.stressMPa, legacy[index].tension.stressPa / 1e6);
      relative(end.compression.stressMPa, legacy[index].compression.stressPa / 1e6);
      expect([end.tension.yM, end.tension.zM]).toEqual([legacy[index].tension.yM, legacy[index].tension.zM]);
      const comparison = compareWithYield(legacy[index].tension.stressPa,
        { presetId: ss400.materialConditionId, condition: ss400.condition, yieldMPa: 245, sourceId: ss400.sourceId });
      expect(comparison.status).toBe('nominal-stress-below-yield');
      if (comparison.status === 'data-missing') throw new Error(comparison.reason);
      relative(end.maximumVonMisesMPa, comparison.peakMPa);
      relative(end.safetyFactor, comparison.yieldMPa / comparison.peakMPa);
    }
  });

  it.each([false, true])('N-mm and N-m inputs have the same MPa and dimensionless outputs (round=%s)', round => {
    const forces: Vector6 = round ? [12000, 0, 0, 10, 30, -20] : [80000, 0, 0, 0, 100, 50];
    const metre = beamFixture(forces, 'N-m', round), millimetre = beamFixture(forces, 'N-mm', round);
    const a = beamStaticCapacity(metre.result, metre.document, capacities, metre.outlines);
    const b = beamStaticCapacity(millimetre.result, millimetre.document, capacities, millimetre.outlines);
    relative(b.maximumVonMisesMPa, a.maximumVonMisesMPa ?? Number.NaN);
    relative(b.minimumSafetyFactor, a.minimumSafetyFactor ?? Number.NaN);
    relative(b.elements[0].ends[0].tension.strain, a.elements[0].ends[0].tension.strain);
  });

  it('missing evidence retains calculable stresses but never invents a safety factor', () => {
    const { document, result, outlines } = beamFixture([80000, 0, 0, 0, 0, 0]);
    const actual = beamStaticCapacity(result, document, new Map(), outlines);
    relative(actual.maximumVonMisesMPa, 100);
    expect(actual).toMatchObject({ minimumSafetyFactor: null, reason: 'missing-sourced-capacity' });
    expect(actual.elements[0]).toMatchObject({ capacity: null, safetyFactor: null, reason: 'missing-sourced-capacity' });
  });

  it('zero stress has no finite yield ratio', () => {
    const { document, result, outlines } = beamFixture([0, 0, 0, 0, 0, 0]);
    expect(beamStaticCapacity(result, document, capacities, outlines)).toMatchObject({ maximumVonMisesMPa: 0,
      minimumSafetyFactor: null, reason: 'zero-equivalent-stress' });
  });

  it('unknown units and stale result identity remain unevaluated', () => {
    const { document, result, outlines } = beamFixture([80000, 0, 0, 0, 0, 0]);
    expect(beamStaticCapacity({ ...result, analysisRevision: 2 }, document, capacities, outlines))
      .toMatchObject({ maximumVonMisesMPa: null, minimumSafetyFactor: null, reason: 'result-document-mismatch' });
    Object.defineProperty(document, 'units', { value: 'kip-in' });
    expect(beamStaticCapacity(result, document, capacities, outlines))
      .toMatchObject({ maximumVonMisesMPa: null, minimumSafetyFactor: null, reason: 'unknown-units' });
  });

  it.each([
    { forces: [0, 0, 0, 10, 0, 0] as const, reason: 'unsupported-rectangular-torsion' },
    { forces: [80000, 1, 0, 0, 0, 0] as const, reason: 'unsupported-transverse-shear' },
  ])('$reason cannot produce a misleading von Mises stress or ratio', ({ forces, reason }) => {
    const { document, result, outlines } = beamFixture(forces);
    const actual = beamStaticCapacity(result, document, capacities, outlines);
    expect(actual).toMatchObject({ maximumVonMisesMPa: null, minimumSafetyFactor: null, reason });
    expect(Number.isFinite(actual.elements[0].ends[0].tension.stressMPa)).toBe(true);
  });

  it('inconsistent outline and circular torsion constants are rejected', () => {
    const { document, result, outlines } = beamFixture([0, 0, 0, 10, 0, 0], 'N-m', true);
    const wrong = { ...document, sections: document.sections.map(row => ({ ...row, torsionConstant: row.torsionConstant * 2 })) };
    expect(beamStaticCapacity(result, wrong, capacities, outlines)).toMatchObject({ minimumSafetyFactor: null, reason: 'inconsistent-polar-torsion-constant' });
    expect(beamStaticCapacity(result, document, capacities, rectangleOutlines)).toMatchObject({ minimumSafetyFactor: null, reason: 'section-inconsistent' });
  });

  it('does not expose infinite derived numbers or invalid evidence', () => {
    const { document, result, outlines } = beamFixture([Number.MAX_VALUE, 0, 0, 0, 0, 0]);
    expect(beamStaticCapacity(result, document, capacities, outlines)).toMatchObject({ minimumSafetyFactor: null, reason: 'non-finite-fibre-stress' });
    const valid = beamFixture([80000, 0, 0, 0, 0, 0]);
    expect(beamStaticCapacity(valid.result, valid.document, new Map([['steel', { ...ss400, sourceId: '' }]]), valid.outlines))
      .toMatchObject({ minimumSafetyFactor: null, reason: 'missing-sourced-capacity' });
  });

  it('uses the largest absolute stress when compression governs', () => {
    const { document, result, outlines } = beamFixture([-80000, 0, 0, 0, 100, 50]);
    const actual = beamStaticCapacity(result, document, capacities, outlines);
    relative(actual.elements[0].ends[0].compression.stressMPa, -137.5);
    relative(actual.maximumVonMisesMPa, 137.5); relative(actual.minimumSafetyFactor, 245 / 137.5);
  });

  it('does not mutate the result, document, outline, or capacity inputs', () => {
    const fixture = beamFixture([80000, 0, 0, 0, 100, 50]);
    const before = JSON.stringify([fixture.document, fixture.result, [...fixture.outlines], [...capacities]]);
    beamStaticCapacity(fixture.result, fixture.document, capacities, fixture.outlines);
    expect(JSON.stringify([fixture.document, fixture.result, [...fixture.outlines], [...capacities]])).toBe(before);
  });
});

describe('solid tensor postprocessing', () => {
  it('uniaxial stress gives Poisson contraction and principal stresses in descending order', () => {
    const { input, result } = solidFixture([100, 0, 0, 0, 0, 0]);
    const actual = solidStaticCapacity(result, input, capacities), row = actual.elements[0];
    expect(row.principalStressMPa).toEqual([100, 0, 0]);
    relative(row.maximumVonMisesMPa, 100); relative(row.safetyFactor, 2.45);
    if (!row.strain) throw new Error('expected elastic strain');
    row.strain.forEach((value, index) => relative(value, [0.0005, -0.00015, -0.00015, 0, 0, 0][index]));
    expect(row).toMatchObject({ integrationPoint: 0, capacity: ss400 });
  });

  it.each([3, 4, 5])('pure shear in tensor slot %s has principal stresses +/-40 and engineering shear strain 2(1+nu)tau/E', slot => {
    const stress: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
    stress[slot] = 40;
    const { input, result } = solidFixture(stress);
    const row = solidStaticCapacity(result, input, capacities).elements[0];
    if (!row.principalStressMPa || !row.strain) throw new Error('expected tensor outputs');
    row.principalStressMPa.forEach((value, index) => relative(value, [40, 0, -40][index]));
    relative(row.maximumVonMisesMPa, 40 * Math.sqrt(3));
    row.strain.forEach((value, index) => relative(value, index === slot ? 0.00052 : 0));
  });

  it('a rotated tensor with repeated eigenvalues has principal stresses 130,40,40 and von Mises 90 MPa', () => {
    // 40 I + 90 n*n^T, n=(1,1,1)/sqrt(3): all diagonal terms 70, off-diagonal terms 30.
    const { input, result } = solidFixture([70, 70, 70, 30, 30, 30]);
    const row = solidStaticCapacity(result, input, capacities).elements[0];
    if (!row.principalStressMPa) throw new Error('expected principal stresses');
    row.principalStressMPa.forEach((value, index) => relative(value, [130, 40, 40][index]));
    relative(row.maximumVonMisesMPa, 90);
  });

  it('hydrostatic stress has nonzero elastic strain but no von Mises yield ratio', () => {
    const { input, result } = solidFixture([-100, -100, -100, 0, 0, 0]);
    const actual = solidStaticCapacity(result, input, capacities);
    expect(actual).toMatchObject({ maximumVonMisesMPa: 0, minimumSafetyFactor: null, reason: 'zero-equivalent-stress' });
    expect(actual.elements[0].principalStressMPa).toEqual([-100, -100, -100]);
    relative(actual.elements[0].strain?.[0] ?? null, -0.0002);
  });

  it.each([ss400, normalized, tempered])('solid $materialConditionId uses the explicit yield and preserves evidence', capacity => {
    const { input, result } = solidFixture([100, 0, 0, 0, 0, 0]);
    const actual = solidStaticCapacity(result, input, new Map([['steel', capacity]]));
    relative(actual.minimumSafetyFactor, capacity.yieldMPa / 100);
    expect(actual.elements[0].capacity).toEqual(capacity);
  });

  it('takes the minimum ratio per material and does not silently drop a missing capacity', () => {
    const { input, result } = solidFixture([100, 0, 0, 0, 0, 0]);
    const mixed: SolidAnalysisInput = { ...input, elements: [...input.elements, { nodes: [0, 1, 2, 3], materialId: 'second' }],
      materials: [...input.materials, { id: 'second', youngMPa: 200000, poisson: 0.3 }] };
    const results: SolidAnalysisResult = { ...result, elements: [...result.elements, { stressMPa: [200, 0, 0, 0, 0, 0], strain: [0, 0, 0, 0, 0, 0] }] };
    const actual = solidStaticCapacity(results, mixed, new Map([['steel', ss400], ['second', normalized]]));
    relative(actual.maximumVonMisesMPa, 200); relative(actual.minimumSafetyFactor, 345 / 200);
    const missing = solidStaticCapacity(results, mixed, capacities);
    relative(missing.maximumVonMisesMPa, 200);
    expect(missing).toMatchObject({ minimumSafetyFactor: null, reason: 'missing-sourced-capacity' });
  });

  it('rejects unknown units, source mismatch, invalid elasticity and non-finite stress without numeric sentinels', () => {
    const { input, result } = solidFixture([100, 0, 0, 0, 0, 0]);
    expect(solidStaticCapacity(result, { ...input, source: { ...input.source, revision: 2 } }, capacities))
      .toMatchObject({ minimumSafetyFactor: null, reason: 'result-input-mismatch' });
    expect(solidStaticCapacity(result, { ...input, materials: [{ id: 'steel', youngMPa: 200000, poisson: 0.5 }] }, capacities))
      .toMatchObject({ minimumSafetyFactor: null, reason: 'invalid-elastic-properties' });
    const invalid = solidFixture([Number.NaN, 0, 0, 0, 0, 0]);
    expect(solidStaticCapacity(invalid.result, invalid.input, capacities).elements[0])
      .toMatchObject({ stressMPa: null, principalStressMPa: null, maximumVonMisesMPa: null, strain: null, safetyFactor: null, reason: 'non-finite-stress' });
    Object.defineProperty(result, 'units', { value: 'Pa' });
    expect(solidStaticCapacity(result, input, capacities)).toMatchObject({ maximumVonMisesMPa: null, minimumSafetyFactor: null, reason: 'unknown-units' });
  });

  it('empty data is unevaluated and input tensors are not mutated or aliased', () => {
    const { input, result } = solidFixture([70, 70, 70, 30, 30, 30]);
    const before = JSON.stringify([input, result, [...capacities]]);
    const actual = solidStaticCapacity(result, input, capacities);
    expect(JSON.stringify([input, result, [...capacities]])).toBe(before);
    expect(actual.elements[0].stressMPa).not.toBe(result.elements[0].stressMPa);
    expect(solidStaticCapacity({ ...result, elements: [] }, { ...input, elements: [] }, capacities))
      .toMatchObject({ maximumVonMisesMPa: null, minimumSafetyFactor: null, reason: 'no-elements' });
  });

  it('an overflowing yield ratio is null even when the stress and strain remain finite', () => {
    const { input, result } = solidFixture([1e-310, 0, 0, 0, 0, 0]);
    expect(solidStaticCapacity(result, input, capacities).elements[0])
      .toMatchObject({ safetyFactor: null, reason: 'unrepresentable-yield-ratio' });
  });

  it('a zero-stress element does not turn a loaded element ratio into Infinity', () => {
    const { input, result } = solidFixture([100, 0, 0, 0, 0, 0]);
    const twoInputs = { ...input, elements: [...input.elements, input.elements[0]] };
    const twoResults: SolidAnalysisResult = { ...result, elements: [...result.elements,
      { stressMPa: [0, 0, 0, 0, 0, 0], strain: [0, 0, 0, 0, 0, 0] }] };
    const actual = solidStaticCapacity(twoResults, twoInputs, capacities);
    relative(actual.minimumSafetyFactor, 2.45);
    expect(actual.elements[1]).toMatchObject({ safetyFactor: null, reason: 'zero-equivalent-stress' });
  });
});
