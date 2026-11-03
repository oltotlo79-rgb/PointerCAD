import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cantilever } from './analysisCases.testSupport.js';
import { bucklingFixture } from './buckling.testSupport.js';
import { analyzeFatigue } from './fatigue.js';
import { compareVerification, type VerificationInput } from './verificationComparison.testSupport.js';
import { bucklingInput, linearInput, modalInput, plasticInput } from './verificationCases.testSupport.js';
import { verificationData } from './verificationInput.testSupport.js';
import { isRecord } from './valueGuards.js';
import type { SolidModalInput } from './solidModalModel.js';
import type { SolidPlasticInput } from './solidPlasticTranslation.js';

// Copied from solidModalNative.test.ts:supported: the fixture is independently specified by nodes,
// restraints and material, not obtained from the verification catalogue.
const modal: SolidModalInput = { schema: 'pointercad-solid-tet4-modal/1',
  source: { documentId: 'native-doc', revision: 7, meshKey: 'tet:7' }, units: 'N-mm-MPa', numericBudgetBytes: 16 * 1024 * 1024,
  nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]], elements: [{ nodes: [0, 1, 2, 3], materialId: 'steel' }],
  materials: [{ id: 'steel', youngMPa: 205000, poisson: 0, densityKgM3: 7850 }],
  constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, true, true] },
    { node: 2, fixed: [false, true, true] }, { node: 3, fixed: [true, true, true] }], modeCount: 2 };

// The same fixture procedure as solidPlasticNative.test.ts:input/supports, with one tetrahedron.
const nodes = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]] as const;
const prescribed: { node: number; dof: 'x' | 'y' | 'z'; valueMm: number }[] = [];
nodes.forEach((point, node) => {
  if (point[0] === 0) prescribed.push({ node, dof: 'x', valueMm: 0 });
  if (point[0] === 10) prescribed.push({ node, dof: 'x', valueMm: .0025 * 10 });
  if (point[1] === 0) prescribed.push({ node, dof: 'y', valueMm: 0 });
  if (point[2] === 0) prescribed.push({ node, dof: 'z', valueMm: 0 });
});
const plastic: SolidPlasticInput = { schema: 'pointercad-solid-plastic/1', source: { documentId: 'native-plastic-doc', revision: 3 },
  plan: { schema: 'pointercad-oofem-solid-plastic-plan/1', units: 'N-mm-MPa', nodes, elements: [[0, 1, 2, 3]],
    material: { youngMPa: 200000, poisson: .3, yieldStressMPa: 250, hardeningModulusMPa: 2000,
      source: { kind: 'user-supplied', reference: 'Numerical uniaxial benchmark entered for this test' } },
    prescribedMm: prescribed, forcesN: [], loadFactor: [0, 1, 0, -1, 0], stepsPerSegment: 5 } };

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Expected fixture record');
  return value;
}
// Impact source: beamImpactNativeFixture.test.ts:inputFor and its existing pinned physical plan.
function impactInput(): VerificationInput {
  const fixture: unknown = JSON.parse(readFileSync(new URL('./fixtures/beamImpactNativeFixture.json', import.meta.url), 'utf8'));
  const plan = record(record(fixture).plan), impact = record(plan.impact);
  if (!Array.isArray(impact.contacts)) throw new Error('Missing fixture contact');
  const contact = record(impact.contacts[0]);
  const evidence = { kind: 'user-supplied', reference: 'Pinned native one-element axial benchmark',
    condition: 'Explicit isotropic elastic constants; no capacity or general impact claim' };
  return { geometry: verificationData({ nodes: [{ id: 'native-1', position: [0, 0, 0] }, { id: 'native-2', position: [1, 0, 0] }],
    members: [{ id: 'native-member', componentId: 'native-component', occurrencePath: ['native-component'], startNodeId: 'native-1',
      endNodeId: 'native-2', materialId: 'steel', sectionId: 'explicit-section', localYHint: [0, 1, 0] }],
    sections: [{ id: 'explicit-section', area: 1e-4, iy: 1e-9, iz: 1e-9, torsionConstant: 2e-9, shearFactor: .8333333333333334, source: evidence }] }),
  boundary: verificationData({ supports: [{ nodeId: 'native-1', restrained: [true, true, true, true, true, true] },
    { nodeId: 'native-2', restrained: [false, true, true, true, true, true] }],
    initialVelocities: [{ nodeId: 'native-2', velocityMPerS: [.01, 0, 0] }],
    contacts: [{ nodeId: 'native-2', directionUnit: [1, 0, 0], gapM: contact.gapM }], contactStiffnessNPerM: 21e6,
    history: { timeStepS: impact.timeStepS, stepCount: impact.stepCount, outputEvery: impact.outputEvery } }),
  material: verificationData([{ id: 'steel', youngModulus: 210e9, shearModulus: 210e9 / 2.6, densityKgM3: 7850, source: evidence }]),
  units: 'N-m-s', source: { documentId: 'native-axial-benchmark', documentRevision: 1, geometryRevision: 'explicit-one-metre-member' } };
}

const fatigueSource = { kind: 'user-supplied', reference: 'Test-only relation; not a material value', condition: 'Hand-derived example' };
const fatigueHistories = [
  { id: 'a', unit: 'MPa', stressMpa: [-50, 50], sequence: 'repeated-periodic', repeats: 1000, source: fatigueSource },
  { id: 'b', unit: 'MPa', stressMpa: [-100, 100], sequence: 'repeated-periodic', repeats: 10, source: fatigueSource },
];
const fatigueCurve = { id: 'curve', unit: 'MPa', stressDefinition: 'range', meanStressAssumption: 'mean-independent',
  referenceStressMpa: 100, referenceCycles: 2e6, slope: 3, cutoffStressMpa: null, source: fatigueSource };
const fatigueInput: VerificationInput = { geometry: null, boundary: verificationData({ histories: fatigueHistories }),
  material: verificationData({ curve: fatigueCurve }), units: 'MPa', source: 'fatigue.test.ts:two-block-miner' };

// Extracted directly from native_shear_bar_plan(), without running a solver.
const contactInput: VerificationInput = {"geometry": {"nodes": [[0, 0, 0], [0, 0, 20], [0, 10, 0], [0, 10, 20], [100, 0, 0], [100, 0, 20], [100, 10, 0], [100, 10, 20], [100, 0, 0], [100, 0, 20], [100, 10, 0], [100, 10, 20], [101, 0, 0], [101, 0, 20], [101, 10, 0], [101, 10, 20]], "elements": [[0, 4, 6, 7], [0, 6, 2, 7], [0, 2, 3, 7], [0, 3, 1, 7], [0, 1, 5, 7], [0, 5, 4, 7], [8, 12, 14, 15], [8, 14, 10, 15], [8, 10, 11, 15], [8, 11, 9, 15], [8, 9, 13, 15], [8, 13, 12, 15]], "bodies": {"bar": [0, 1, 2, 3, 4, 5, 6, 7], "stop": [8, 9, 10, 11, 12, 13, 14, 15]}}, "boundary": {"prescribed": [{"node": 0, "axis": 0, "values": [0, 0, 0, 0, 0]},
    {"node": 0, "axis": 1, "values": [0, 0, 0, 0, 0]},
    {"node": 0, "axis": 2, "values": [0, 0, 0, 0, 0]},
    {"node": 1, "axis": 0, "values": [0, 0, 0, 0, 0]},
    {"node": 1, "axis": 1, "values": [0, 0, 0, 0, 0]},
    {"node": 1, "axis": 2, "values": [0, 0, 0, 0, 0]},
    {"node": 2, "axis": 0, "values": [0, 0, 0, 0, 0]},
    {"node": 2, "axis": 1, "values": [0, 0, 0, 0, 0]},
    {"node": 2, "axis": 2, "values": [0, 0, 0, 0, 0]},
    {"node": 3, "axis": 0, "values": [0, 0, 0, 0, 0]},
    {"node": 3, "axis": 1, "values": [0, 0, 0, 0, 0]},
    {"node": 3, "axis": 2, "values": [0, 0, 0, 0, 0]},
    {"node": 4, "axis": 0, "values": [5e-07, 5e-07, -5e-07, 5e-07, 5e-07]},
    {"node": 4, "axis": 2, "values": [0, 0, 0, 0, 0]},
    {"node": 5, "axis": 0, "values": [5e-07, 5e-07, -5e-07, 5e-07, 5e-07]},
    {"node": 5, "axis": 2, "values": [0, 0, 0, 0, 0]},
    {"node": 6, "axis": 0, "values": [5e-07, 5e-07, -5e-07, 5e-07, 5e-07]},
    {"node": 6, "axis": 2, "values": [0, 0, 0, 0, 0]},
    {"node": 7, "axis": 0, "values": [5e-07, 5e-07, -5e-07, 5e-07, 5e-07]},
    {"node": 7, "axis": 2, "values": [0, 0, 0, 0, 0]},
    {"node": 8, "axis": 0, "values": [0, 0, 0, 0, 0]},
    {"node": 8, "axis": 1, "values": [0, 0, 0, 0, 0]},
    {"node": 8, "axis": 2, "values": [0, 0, 0, 0, 0]},
    {"node": 9, "axis": 0, "values": [0, 0, 0, 0, 0]},
    {"node": 9, "axis": 1, "values": [0, 0, 0, 0, 0]},
    {"node": 9, "axis": 2, "values": [0, 0, 0, 0, 0]},
    {"node": 10, "axis": 0, "values": [0, 0, 0, 0, 0]},
    {"node": 10, "axis": 1, "values": [0, 0, 0, 0, 0]},
    {"node": 10, "axis": 2, "values": [0, 0, 0, 0, 0]},
    {"node": 11, "axis": 0, "values": [0, 0, 0, 0, 0]},
    {"node": 11, "axis": 1, "values": [0, 0, 0, 0, 0]},
    {"node": 11, "axis": 2, "values": [0, 0, 0, 0, 0]},
    {"node": 12, "axis": 0, "values": [0, 0, 0, 0, 0]},
    {"node": 12, "axis": 1, "values": [0, 0, 0, 0, 0]},
    {"node": 12, "axis": 2, "values": [0, 0, 0, 0, 0]},
    {"node": 13, "axis": 0, "values": [0, 0, 0, 0, 0]},
    {"node": 13, "axis": 1, "values": [0, 0, 0, 0, 0]},
    {"node": 13, "axis": 2, "values": [0, 0, 0, 0, 0]},
    {"node": 14, "axis": 0, "values": [0, 0, 0, 0, 0]},
    {"node": 14, "axis": 1, "values": [0, 0, 0, 0, 0]},
    {"node": 14, "axis": 2, "values": [0, 0, 0, 0, 0]},
    {"node": 15, "axis": 0, "values": [0, 0, 0, 0, 0]},
    {"node": 15, "axis": 1, "values": [0, 0, 0, 0, 0]},
    {"node": 15, "axis": 2, "values": [0, 0, 0, 0, 0]}], "loads": [{"node": 4, "axis": 1, "values": [0.03333333333333333, 0.3333333333333333, 0.3333333333333333, 0.3333333333333333, 0.6666666666666666]},
    {"node": 5, "axis": 1, "values": [0.016666666666666666, 0.16666666666666666, 0.16666666666666666, 0.16666666666666666, 0.3333333333333333]},
    {"node": 6, "axis": 1, "values": [0.016666666666666666, 0.16666666666666666, 0.16666666666666666, 0.16666666666666666, 0.3333333333333333]},
    {"node": 7, "axis": 1, "values": [0.03333333333333333, 0.3333333333333333, 0.3333333333333333, 0.3333333333333333, 0.6666666666666666]}], "contacts": [{"id": "patch-0", "masterBody": "stop", "slaveBody": "bar", "masterFace": "stop-face-0", "slaveFace": "bar-face-0", "masterNodes": [0, 2, 3], "slaveNodes": [4, 6, 7], "normal": [-1, 0, 0], "initialGapMm": 0, "knNPerMm3": 10000, "ktNPerMm3": 10000, "mu": 0.3, "sourceId": "independent-native-shear-oracle", "referenceLengthMm": 10, "referenceForceN": 1},
    {"id": "patch-1", "masterBody": "stop", "slaveBody": "bar", "masterFace": "stop-face-1", "slaveFace": "bar-face-1", "masterNodes": [0, 3, 1], "slaveNodes": [4, 7, 5], "normal": [-1, 0, 0], "initialGapMm": 0, "knNPerMm3": 10000, "ktNPerMm3": 10000, "mu": 0.3, "sourceId": "independent-native-shear-oracle", "referenceLengthMm": 10, "referenceForceN": 1}], "steps": 5, "maxIterations": 50}, "material": {"youngMPa": 210000, "poisson": 0}, "units": "N-mm-MPa", "source": "solidContactConvergence.test.py:native_shear_bar_plan"};

describe('W72 independent physical negatives', () => {
  it('rejects a physically wrong scalar for every fixed source input', () => {
    const rows: readonly { readonly caseId: string; readonly input: VerificationInput; readonly good: number; readonly wrong: number }[] = [
      { caseId: 'linear-cantilever-tip-y-v1', input: linearInput(cantilever({ mode: 'y' })), good: .010296410256410255, wrong: .010256410256410256 },
      { caseId: 'buckling-fixed-free-first-v1', input: bucklingInput(bucklingFixture({ pinned: false, segments: 16 })), good: .5181542310571913, wrong: 2.072616924228765 },
      { caseId: 'modal-supported-tet-first-v1', input: modalInput(modal), good: 1103734965810.5317, wrong: 551867482905.2659 },
      { caseId: 'solid-plastic-first-load-v1', input: plasticInput(plastic), good: 250 + (200000 * 2000 / (200000 + 2000)) * (.0025 - 250 / 200000), wrong: 500 },
      { caseId: 'contact-first-stick-v1', input: contactInput, good: 4.524886877828055e-8, wrong: .1 / 210000 },
      { caseId: 'impact-axial-energy-v1', input: impactInput(), good: 1.3083333333333334e-5, wrong: 0 },
      { caseId: 'fatigue-miner-two-blocks-v1', input: fatigueInput, good: .00054, wrong: .0000675 },
    ];
    for (const row of rows) {
      expect(compareVerification(row.caseId, { caseId: row.caseId, input: row.input, value: row.good }).passed, row.caseId).toBe(true);
      expect(compareVerification(row.caseId, { caseId: row.caseId, input: row.input, value: row.wrong }).passed, row.caseId).toBe(false);
    }
  });
  it('rejects distinct mesh, material, revision and a tampered observable', () => {
    const caseId = 'modal-supported-tet-first-v1', value = 1103734965810.5317;
    const changedMesh: SolidModalInput = { ...modal, nodes: [[0, 0, 0], [11, 0, 0], [0, 10, 0], [0, 0, 10]],
      source: { ...modal.source, meshKey: 'other-tet' } };
    const changedMaterial: SolidModalInput = { ...modal, materials: [{ ...modal.materials[0], densityKgM3: 15700 }] };
    const changedRevision: SolidModalInput = { ...modal, source: { ...modal.source, revision: 8 } };
    for (const input of [changedMesh, changedMaterial, changedRevision])
      expect(() => compareVerification(caseId, { caseId, input: modalInput(input), value })).toThrow();
    expect(compareVerification(caseId, { caseId, input: modalInput(modal), value: 551867482905.2659 }).passed).toBe(false);
  });
  it('computes the two-block fatigue fixture through the real fatigue implementation', () => {
    const result = analyzeFatigue({ schema: 'pointercad-fatigue/1', curve: fatigueCurve, histories: fatigueHistories });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Fatigue fixture rejected');
    const caseId = 'fatigue-miner-two-blocks-v1';
    expect(compareVerification(caseId, { caseId, input: fatigueInput, value: result.result.damage }).passed).toBe(true);
  });
});
