/** Finite, ordered JSON-compatible values used to bind a result to its input conditions. */
export type VerificationValue = null | boolean | number | string | readonly VerificationValue[] | { readonly [key: string]: VerificationValue };
export interface VerificationInput {
  readonly geometry: VerificationValue;
  readonly boundary: VerificationValue;
  readonly material: VerificationValue;
  readonly units: string;
  readonly source: VerificationValue;
}
export interface VerificationObservation {
  readonly caseId: string;
  readonly input: VerificationInput;
  readonly value: number;
}
export type VerificationKind = 'linear-static' | 'buckling' | 'modal' | 'plastic-solid' | 'contact' | 'impact' | 'fatigue';
export interface VerificationCase {
  readonly id: string;
  readonly kind: VerificationKind;
  readonly input: VerificationInput;
  readonly reference: string;
  readonly exclusion: string;
  readonly expected: number;
  readonly scale: number;
  readonly tolerance: number;
  readonly strict: boolean;
}

function isVerificationArray(value: VerificationValue): value is readonly VerificationValue[] { return Array.isArray(value); }
function isUnknownArray(value: unknown): value is readonly unknown[] { return Array.isArray(value); }

/** Reject missing/extra keys, non-finite numbers, sparse arrays and non-JSON values. */
function same(expected: VerificationValue, actual: unknown): boolean {
  if (typeof expected === 'number') return typeof actual === 'number' && Number.isFinite(actual) && Object.is(expected, actual);
  if (expected === null || typeof expected !== 'object') return expected === actual;
  if (isVerificationArray(expected)) {
    if (!isUnknownArray(actual) || actual.length !== expected.length) return false;
    for (let i = 0; i < expected.length; i += 1) if (!(i in actual) || !same(expected[i], actual[i])) return false;
    return true;
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const e = expected, a = actual as Record<string, unknown>;
  const keys = Object.keys(e);
  return keys.length === Object.keys(a).length && keys.every(key => Object.hasOwn(a, key) && same(e[key], a[key]));
}

/** A definition is an independently fixed benchmark; never construct it from the observed result. */
function compareVerificationCase(definition: VerificationCase, observation: VerificationObservation): { readonly error: number; readonly passed: boolean } {
  const input = definition.input;
  if (observation.caseId !== definition.id || !same({ geometry: input.geometry, boundary: input.boundary,
    material: input.material, units: input.units, source: input.source }, observation.input))
    throw new Error('verification: mismatched case or input');
  if (!Number.isFinite(observation.value)) throw new Error('verification: nonfinite observation');
  const error = Math.abs(observation.value - definition.expected) / definition.scale;
  return { error, passed: definition.strict ? error < definition.tolerance : error <= definition.tolerance };
}

const linearExpected = 4000 * 2 ** 3 / (3 * 208e9 * 5e-6) + 4000 * 2 / ((5 / 6) * 80e9 * .003);
const LINEAR_CASE: VerificationCase = { id: 'linear-cantilever-tip-y-v1', kind: 'linear-static',
  input: { geometry: { nodes: [{ id: 'tip', position: [2, 0, 0] }, { id: 'base', position: [0, 0, 0] }],
    members: [{ start: 'base', end: 'tip', localYHint: [0, 1, 0] }], area: .003, iy: 2e-6, iz: 5e-6, torsion: 3e-6, shearFactor: 5 / 6 },
    boundary: { constraints: [{ kind: 'fixed', nodeId: 'base' }],
      loads: [{ nodeId: 'tip', force: [0, 4000, 0], moment: [0, 0, 0] }] },
    material: { young: 208e9, shear: 80e9, density: 7850, source: { kind: 'user-supplied',
      reference: 'Independent analytic test constants; no material grade inference', condition: 'Linear isotropic test material at a fixed reference condition' } }, units: 'N-m',
    source: { id: 'analytic-cantilever', revision: 0, source: { documentId: 'cad-session-a', documentRevision: 7, geometryRevision: 'geometry-generation-12' } } },
  reference: 'linearStaticBenchmark.testSupport.ts:Timoshenko', exclusion: 'none; tip displacement',
  expected: linearExpected, scale: linearExpected, tolerance: 1e-3, strict: false };


const volume = 1000 / 6, density = 7.85e-9, k1 = 205000 * 10 / 6, k2 = 205000 * 10 / 12;
const d = density * volume / 10, o = density * volume / 20, a = d * d - o * o, b = d * (k1 + k2);
const larger = (b + Math.sqrt(b * b - 4 * a * k1 * k2)) / (2 * a);
const modalExpected = k1 * k2 / (a * larger);
const MODAL_CASE: VerificationCase = { id: 'modal-supported-tet-first-v1', kind: 'modal',
  input: { geometry: { nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]],
    elements: [{ nodes: [0, 1, 2, 3], materialId: 'steel' }], modeCount: 2 },
  boundary: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, true, true] },
    { node: 2, fixed: [false, true, true] }, { node: 3, fixed: [true, true, true] }],
  material: [{ id: 'steel', youngMPa: 205000, poisson: 0, densityKgM3: 7850 }], units: 'N-mm-MPa',
  source: { documentId: 'native-doc', revision: 7, meshKey: 'tet:7' } },
  reference: 'solidModalNative.test.ts:closedForm', exclusion: 'none; first eigenvalue',
  expected: modalExpected, scale: modalExpected, tolerance: 1e-9, strict: false };


const bucklingExpected = Math.PI ** 2 * 210e9 * 1e-12 / 4;
const BUCKLING_CASE: VerificationCase = { id: 'buckling-fixed-free-first-v1', kind: 'buckling',
  input: { geometry: { nodes: [[0, 0, 0], [1, 0, 0]], segments: 16, area: .001, iy: 1e-12, iz: 2e-12, torsion: 1.5e-12, shearFactor: 5 / 6 },
    boundary: { supports: [{ nodeId: 'node-0', restrained: [true, true, true, true, true, true] }],
      loads: [{ id: 'reference', kind: 'nodal', nodeId: 'node-1', force: [-1, 0, 0], moment: [0, 0, 0] }] },
    material: { young: 210e9, shear: 210e9 / 2.6, density: 7850, source: { kind: 'user-supplied',
      reference: 'Explicit independent prismatic-beam numerical benchmark', condition: 'Linear elastic benchmark only; no material-grade capacity assertion' } },
    units: 'N-m', source: { documentId: 'independent-modal-fixture', documentRevision: 1, geometryRevision: 'explicit-numeric-geometry' } },
  reference: 'buckling.testSupport.ts:eulerReference', exclusion: 'none; first bending mode',
  expected: bucklingExpected, scale: bucklingExpected, tolerance: 1e-4, strict: true };

const plasticExpected = 250 + (200000 * 2000 / (200000 + 2000)) * (.0025 - 250 / 200000);
const PLASTIC_CASE: VerificationCase = { id: 'solid-plastic-first-load-v1', kind: 'plastic-solid',
  input: { geometry: { nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]], elements: [[0, 1, 2, 3]] },
    boundary: { prescribedMm: [{ node: 0, dof: 'x', valueMm: 0 }, { node: 0, dof: 'y', valueMm: 0 }, { node: 0, dof: 'z', valueMm: 0 },
      { node: 1, dof: 'x', valueMm: .025 }, { node: 1, dof: 'y', valueMm: 0 }, { node: 1, dof: 'z', valueMm: 0 },
      { node: 2, dof: 'x', valueMm: 0 }, { node: 2, dof: 'z', valueMm: 0 },
      { node: 3, dof: 'x', valueMm: 0 }, { node: 3, dof: 'y', valueMm: 0 }], forcesN: [],
      loadFactor: [0, 1, 0, -1, 0], stepsPerSegment: 5 },
    material: { youngMPa: 200000, poisson: .3, yieldStressMPa: 250, hardeningModulusMPa: 2000,
      source: { kind: 'user-supplied', reference: 'Numerical uniaxial benchmark entered for this test' } },
    units: 'N-mm-MPa', source: { documentId: 'native-plastic-doc', revision: 3 } },
  reference: 'solidPlasticNative.test.ts:34-50,169-181', exclusion: 'none; first load, homogeneous uniaxial tetrahedron',
  expected: plasticExpected, scale: 250, tolerance: 1e-8, strict: false };

const fixedCases: readonly VerificationCase[] = [LINEAR_CASE, BUCKLING_CASE, MODAL_CASE, PLASTIC_CASE,
{ id: "contact-first-stick-v1", kind: "contact", input: {"geometry": {"nodes": [[0, 0, 0], [0, 0, 20], [0, 10, 0], [0, 10, 20], [100, 0, 0], [100, 0, 20], [100, 10, 0], [100, 10, 20], [100, 0, 0], [100, 0, 20], [100, 10, 0], [100, 10, 20], [101, 0, 0], [101, 0, 20], [101, 10, 0], [101, 10, 20]],
    "elements": [[0, 4, 6, 7], [0, 6, 2, 7], [0, 2, 3, 7], [0, 3, 1, 7], [0, 1, 5, 7], [0, 5, 4, 7], [8, 12, 14, 15], [8, 14, 10, 15], [8, 10, 11, 15], [8, 11, 9, 15], [8, 9, 13, 15], [8, 13, 12, 15]],
    "bodies": {"bar": [0, 1, 2, 3, 4, 5, 6, 7], "stop": [8, 9, 10, 11, 12, 13, 14, 15]}}, "boundary": {"prescribed": [{"node": 0, "axis": 0, "values": [0, 0, 0, 0, 0]},
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
    {"id": "patch-1", "masterBody": "stop", "slaveBody": "bar", "masterFace": "stop-face-1", "slaveFace": "bar-face-1", "masterNodes": [0, 3, 1], "slaveNodes": [4, 7, 5], "normal": [-1, 0, 0], "initialGapMm": 0, "knNPerMm3": 10000, "ktNPerMm3": 10000, "mu": 0.3, "sourceId": "independent-native-shear-oracle", "referenceLengthMm": 10, "referenceForceN": 1}], "steps": 5, "maxIterations": 50}, "material": {"youngMPa": 210000, "poisson": 0}, "units": "N-mm-MPa", "source": "solidContactConvergence.test.py:native_shear_bar_plan"}, reference: "solidContactConvergence.test.ts:105-120", exclusion: "none; scalar observable only", expected: .1 / 2210000, scale: .1 / 2210000, tolerance: 1e-6, strict: false },
{ id: "impact-axial-energy-v1", kind: "impact", input: {"geometry": {"nodes": [{"id": "native-1", "position": [0, 0, 0]},
    {"id": "native-2", "position": [1, 0, 0]}], "members": [{"id": "native-member", "componentId": "native-component", "occurrencePath": ["native-component"], "startNodeId": "native-1", "endNodeId": "native-2", "materialId": "steel", "sectionId": "explicit-section", "localYHint": [0, 1, 0]}], "sections": [{"id": "explicit-section", "area": 0.0001, "iy": 1e-09, "iz": 1e-09, "torsionConstant": 2e-09, "shearFactor": 0.8333333333333334, "source": {"kind": "user-supplied", "reference": "Pinned native one-element axial benchmark", "condition": "Explicit isotropic elastic constants; no capacity or general impact claim"}}]}, "boundary": {"supports": [{"nodeId": "native-1", "restrained": [true, true, true, true, true, true]},
    {"nodeId": "native-2", "restrained": [false, true, true, true, true, true]}], "initialVelocities": [{"nodeId": "native-2", "velocityMPerS": [0.01, 0, 0]}], "contacts": [{"nodeId": "native-2", "directionUnit": [1, 0, 0], "gapM": 0}], "contactStiffnessNPerM": 21000000.0, "history": {"timeStepS": 6.199254089337072e-06, "stepCount": 30, "outputEvery": 1}}, "material": [{"id": "steel", "youngModulus": 210000000000.0, "shearModulus": 80769230769.23077, "densityKgM3": 7850, "source": {"kind": "user-supplied", "reference": "Pinned native one-element axial benchmark", "condition": "Explicit isotropic elastic constants; no capacity or general impact claim"}}], "units": "N-m-s", "source": {"documentId": "native-axial-benchmark", "documentRevision": 1, "geometryRevision": "explicit-one-metre-member"}}, reference: "beamImpactNativeFixture.test.ts:235-280", exclusion: "none; scalar observable only", expected: (7850 * 1e-4 / 3) * .01 ** 2 / 2, scale: (7850 * 1e-4 / 3) * .01 ** 2 / 2, tolerance: 1e-10, strict: false },
{ id: "fatigue-miner-two-blocks-v1", kind: "fatigue", input: {"geometry": null, "boundary": {"histories": [{"id": "a", "unit": "MPa", "stressMpa": [-50, 50], "sequence": "repeated-periodic", "repeats": 1000, "source": {"kind": "user-supplied", "reference": "Test-only relation; not a material value", "condition": "Hand-derived example"}},
    {"id": "b", "unit": "MPa", "stressMpa": [-100, 100], "sequence": "repeated-periodic", "repeats": 10, "source": {"kind": "user-supplied", "reference": "Test-only relation; not a material value", "condition": "Hand-derived example"}}]}, "material": {"curve": {"id": "curve", "unit": "MPa", "stressDefinition": "range", "meanStressAssumption": "mean-independent", "referenceStressMpa": 100, "referenceCycles": 2000000.0, "slope": 3, "cutoffStressMpa": null, "source": {"kind": "user-supplied", "reference": "Test-only relation; not a material value", "condition": "Hand-derived example"}}}, "units": "MPa", "source": "fatigue.test.ts:two-block-miner"}, reference: "fatigue.test.ts:60-70", exclusion: "none; scalar observable only", expected: 1000 / 2e6 + 10 / 2.5e5, scale: 1000 / 2e6 + 10 / 2.5e5, tolerance: 1e-12, strict: false }
];
/** Compare only against the internally fixed reference, never a caller-supplied expected value. */
export function compareVerification(caseId: string, observation: VerificationObservation): { readonly error: number; readonly passed: boolean } {
  const definition = fixedCases.find(item => item.id === caseId);
  if (definition === undefined || observation.caseId !== caseId) throw new Error('verification: unknown or mismatched case');
  return compareVerificationCase(definition, observation);
}
