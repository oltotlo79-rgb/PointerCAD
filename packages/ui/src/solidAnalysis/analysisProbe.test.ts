import { createHash } from 'node:crypto';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeSolidAnalysis, decodeSolidModal, solidInputSha256, solidModalInputSha256, solidModalReservedBytes,
  solidResultReportRows, type CadSolidOutcome, type SolidAnalysisInput, type SolidModalInput } from '@pointercad/fem';
import { createBrowserFileGateway } from '../file/fileGateway.js';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { exportSolidResultCsv } from './exportSolidResultCsv.js';
import { readSolidElementProbe, SOLID_PROBE_UNITS } from './readSolidElementProbe.js';
import { SolidAnalysisPanel } from './SolidAnalysisPanel.js';
import { createSolidAnalysisSession, type SolidAnalysisSession } from './solidAnalysisSession.js';
import { SolidElementProbeValues } from './SolidElementProbe.js';
import { createSolidFieldLayer } from './solidFieldLayer.js';
import { buildSolidFieldMesh, SOLID_RESULT_WARNING_KEYS, SOLID_RESULT_WARNING_LIMITS, SOLID_RESULT_WARNINGS,
  solidFieldOverlayCounts, solidResultWarnings } from './solidFieldView.js';
import { solidModeResultFor } from './solidModalDisplay.js';
import { projectSolidMode } from './solidModeView.js';

type SolidResultWarning = NonNullable<ReturnType<typeof solidResultWarnings>>['warnings'][number];
/** Pinned expected values: the same literals as the product constants, kept independent of them. */
const SOLID_PROBE_COORDINATES = 'global-XYZ-undeformed';

/*
 * EX-09 WP-postprocess-verification (W64 probe/overlay/warnings, W71 independent comparison, W72 binding) at the UI layer.
 * Every expected number below is computed in this file from the FEM result (displacements) or from a closed form copied
 * with its source; no expected value is produced by the product function under test.
 */

type Outcome = Extract<CadSolidOutcome, { kind: 'result' }>;
type V3 = readonly [number, number, number];
type Six = readonly [number, number, number, number, number, number];
type Tet = readonly [number, number, number, number];
type Fixed = readonly [boolean, boolean, boolean];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Linear tetrahedron: rows of J^-1 for J = [X1 - X0, X2 - X0, X3 - X0] are (e2 x e3, e3 x e1, e1 x e2) / det. */
function tetGeometry(points: readonly V3[]): { readonly gradients: readonly V3[]; readonly volume: number } {
  const [x0, x1, x2, x3] = points;
  const e1 = sub(x1, x0), e2 = sub(x2, x0), e3 = sub(x3, x0), det = dot3(e1, cross3(e2, e3));
  const row = (v: V3): V3 => [v[0] / det, v[1] / det, v[2] / det];
  const g1 = row(cross3(e2, e3)), g2 = row(cross3(e3, e1)), g3 = row(cross3(e1, e2));
  return { gradients: [[-g1[0] - g2[0] - g3[0], -g1[1] - g2[1] - g3[1], -g1[2] - g2[2] - g3[2]], g1, g2, g3], volume: det / 6 };
}
/** Positive orientation by exchanging the second and third node when the determinant is negative. */
function orient(nodes: readonly V3[], element: Tet): Tet {
  return tetGeometry(element.map(node => nodes[node])).volume > 0 ? element : [element[0], element[2], element[1], element[3]];
}
interface Elastic { readonly youngMPa: number; readonly poisson: number }
/**
 * Independent Tet4 evaluation from nodal displacements: displacement gradient H = sum u_a (x) grad N_a, engineering
 * strain, isotropic Hooke stress, nodal forces V sigma grad N_a, von Mises from the deviatoric stress sqrt(3/2 s:s),
 * equivalent strain from the deviatoric tensor strain sqrt(2/3 e':e') and the energy as half the nodal work.
 */
function elementState(points: readonly V3[], moves: readonly V3[], material: Elastic) {
  const { gradients, volume } = tetGeometry(points);
  const h = [0, 1, 2].map(i => [0, 1, 2].map(j => moves.reduce((sum, u, a) => sum + u[i] * gradients[a][j], 0)));
  const strain: Six = [h[0][0], h[1][1], h[2][2], h[1][2] + h[2][1], h[0][2] + h[2][0], h[0][1] + h[1][0]];
  const { youngMPa: e, poisson: nu } = material;
  const lambda = e * nu / ((1 + nu) * (1 - 2 * nu)), mu = e / (2 * (1 + nu)), trace = strain[0] + strain[1] + strain[2];
  const stress: Six = [lambda * trace + 2 * mu * strain[0], lambda * trace + 2 * mu * strain[1],
    lambda * trace + 2 * mu * strain[2], mu * strain[3], mu * strain[4], mu * strain[5]];
  const [sx, sy, sz, syz, sxz, sxy] = stress;
  const sigma = [[sx, sxy, sxz], [sxy, sy, syz], [sxz, syz, sz]];
  const forces = gradients.map((g): V3 => [volume * dot3([sx, sxy, sxz], g), volume * dot3([sxy, sy, syz], g),
    volume * dot3([sxz, syz, sz], g)]);
  const tensorStrain = [[strain[0], strain[5] / 2, strain[4] / 2], [strain[5] / 2, strain[1], strain[3] / 2],
    [strain[4] / 2, strain[3] / 2, strain[2]]];
  const deviatoric = (m: number[][]): number => {
    const mean = (m[0][0] + m[1][1] + m[2][2]) / 3;
    return m.reduce((sum, rowValues, i) => sum + rowValues.reduce((inner, value, j) => inner + (value - (i === j ? mean : 0)) ** 2, 0), 0);
  };
  const energy = forces.reduce((sum, force, a) => sum + dot3(force, moves[a]), 0) / 2;
  return { strain, stress, forces, volume, energy, vonMises: Math.sqrt(1.5 * deviatoric(sigma)),
    equivalentStrain: Math.sqrt(2 / 3 * deviatoric(tensorStrain)) };
}

/** Relative <= tolerance per component; an exact zero expectation allows 1e-12 absolute (as readSolidElementProbe.test.ts). */
function expectClose(actual: readonly number[] | undefined, expected: readonly number[], tolerance = 1e-6): void {
  expect(actual?.length).toBe(expected.length);
  expected.forEach((value, i) => {
    const got = actual?.[i] ?? Number.NaN;
    if (value === 0) expect(Math.abs(got)).toBeLessThanOrEqual(1e-12);
    else expect(Math.abs(got - value)).toBeLessThanOrEqual(tolerance * Math.abs(value));
  });
}

/** Independent published-draft SS400 row (t <= 16 mm, 245 MPa), the same row as readSolidElementProbe.test.ts. */
const SS400 = { materialConditionId: 'ss400-plate-0-16', yieldMPa: 245, sourceId: 'jisf-g3101-draft', thicknessMm: 16,
  condition: '圧延鋼板（熱処理の指定なし）', evidence: 'standard-draft', basis: 'minimum' } as const;

function meshOf(source: SolidAnalysisInput['source'], nodes: readonly V3[], elements: readonly Tet[], boundary: readonly number[],
  hash: string): Outcome['mesh'] {
  const coordinates = nodes.flat(), tags = Array.from({ length: boundary.length / 3 }, (_, index) => index);
  const volumes = elements.map(element => tetGeometry(element.map(node => nodes[node])).volume);
  return { kind: 'netgen-tetra-mesh', input: { schema: 'pointercad-convex-plc/1', source: { documentId: source.documentId,
    revision: source.revision, featureId: 'probe', bodyKey: 'probe' }, units: 'mm', coordinates, triangles: [...boundary], tags,
  tagCount: tags.length }, inputSha256: hash, coordinates, tetrahedra: elements.flat(), boundaryTriangles: [...boundary],
  boundaryTags: tags, volumeMm3: volumes.reduce((sum, value) => sum + value, 0), minTetVolumeMm3: Math.min(...volumes) };
}

interface Model {
  readonly nodes: readonly V3[];
  readonly elements: readonly Tet[];
  readonly material: SolidAnalysisInput['materials'][number];
  readonly fixed: ReadonlyMap<number, Fixed>;
  readonly displacement: readonly V3[];
  /** 'nodal': the independently computed internal forces of the free DOFs as concentrated loads; otherwise surface tractions. */
  readonly loads: 'nodal' | SolidAnalysisInput['surfaceLoads'];
  readonly source?: SolidAnalysisInput['source'];
  readonly pivot?: number;
  readonly boundary?: readonly number[];
}
/** A result the real FEM decoder accepts: native element actions are this file's independent K_e u_e. */
async function solved(model: Model): Promise<Outcome> {
  const { nodes, elements, material, fixed, displacement } = model;
  const states = elements.map(element => elementState(element.map(node => nodes[node]), element.map(node => displacement[node]), material));
  const internal = nodes.map((): [number, number, number] => [0, 0, 0]);
  elements.forEach((element, e) => element.forEach((node, a) => {
    for (let axis = 0; axis < 3; axis += 1) internal[node][axis] += states[e].forces[a][axis];
  }));
  const source = model.source ?? { documentId: 'probe-doc', revision: 7, meshKey: 'tet:probe' };
  const nodalLoads: SolidAnalysisInput['nodalLoads'] = model.loads !== 'nodal' ? [] : nodes.flatMap((_, node) => {
    const flags = fixed.get(node) ?? [false, false, false], force = internal[node];
    return flags.every(Boolean) ? [] : [{ node, forceN: [flags[0] ? 0 : force[0], flags[1] ? 0 : force[1], flags[2] ? 0 : force[2]] as const }];
  });
  const input: SolidAnalysisInput = { schema: 'pointercad-solid-tet4/1', source, units: 'N-mm-MPa', numericBudgetBytes: 16 * 1024 * 1024,
    nodes, elements: elements.map(element => ({ nodes: element, materialId: material.id })), materials: [material],
    constraints: [...fixed].map(([node, flags]) => ({ node, fixed: flags })), nodalLoads,
    surfaceLoads: model.loads === 'nodal' ? [] : model.loads };
  const hash = await solidInputSha256(input);
  const result = decodeSolidAnalysis({ schema: 'pointercad-solid-tet4-native/1', source, displacementMm: displacement,
    elementForcesN: states.map(state => state.forces.flat()), reservedNumericBytes: 50000, minimumScaledPivot: model.pivot ?? 1 }, input, hash);
  const total = nodalLoads.reduce((sum, load): V3 => [sum[0] + load.forceN[0], sum[1] + load.forceN[1], sum[2] + load.forceN[2]],
    [0, 0, 0] as V3);
  return { kind: 'result', result, prepared: { input, loadedAreaMm2: 0, totalForceN: total },
    mesh: meshOf(source, nodes, elements, model.boundary ?? [], hash) };
}

/** Typed (not decoded) result for the pure display rules; only the fields those rules read are meaningful. */
function typedOutcome(spec: { readonly nodes: readonly V3[]; readonly elements: readonly Tet[]; readonly stresses: readonly Six[];
  readonly constraints?: SolidAnalysisInput['constraints']; readonly nodalLoads?: SolidAnalysisInput['nodalLoads'];
  readonly boundary?: readonly number[] }): Outcome {
  const source = { documentId: 'typed-doc', revision: 1, meshKey: 'typed' };
  const input: SolidAnalysisInput = { schema: 'pointercad-solid-tet4/1', source, units: 'N-mm-MPa', numericBudgetBytes: 1,
    nodes: spec.nodes, elements: spec.elements.map(nodes => ({ nodes, materialId: 'm' })), materials: [{ id: 'm', youngMPa: 1, poisson: 0.3 }],
    constraints: spec.constraints ?? [], nodalLoads: spec.nodalLoads ?? [], surfaceLoads: [] };
  const result: Outcome['result'] = { kind: 'oofem-linear-solid-tet4', source, inputSha256: 'x',
    method: 'oofem-ltrspace-isole-native-ldlt/1', units: 'N-mm-MPa', structuralCertification: false,
    displacementMm: spec.nodes.map((): V3 => [0, 0, 0]), reactionN: spec.nodes.map((): V3 => [0, 0, 0]),
    elements: spec.stresses.map(stressMPa => ({ strain: [0, 0, 0, 0, 0, 0] as const, stressMPa })), strainEnergyNmm: 0,
    maximumRelativeEquilibriumResidual: 1e-15, reservedNumericBytes: 1, nativeElementForcesN: spec.elements.map(() => []),
    minimumScaledPivot: 1 };
  return { kind: 'result', result, prepared: { input, loadedAreaMm2: 0, totalForceN: [0, 0, 0] },
    mesh: meshOf(source, spec.nodes, spec.elements, spec.boundary ?? [], 'x') };
}

// ---- Fixtures -------------------------------------------------------------------------------------------------------

/** Two positively oriented 10 mm Tet4 sharing face (1, 2, 3); 3-2-1 supports; a general (non-affine) displacement. */
const TWO_NODES: readonly V3[] = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10], [20 / 3, 20 / 3, 20 / 3]];
const TWO_ELEMENTS: readonly Tet[] = [orient(TWO_NODES, [0, 1, 2, 3]), orient(TWO_NODES, [4, 1, 3, 2])];
const TWO_FIXED = new Map<number, Fixed>([[0, [true, true, true]], [1, [false, true, true]], [2, [false, false, true]]]);
const TWO_DISPLACEMENT: readonly V3[] = [[0, 0, 0], [0.0012, 0, 0], [-0.0004, 0.0009, 0], [0.0005, -0.0003, 0.0011],
  [0.0017, 0.0006, -0.0002]];
const twoTet = (source?: SolidAnalysisInput['source']): Promise<Outcome> => solved({ nodes: TWO_NODES, elements: TWO_ELEMENTS,
  material: { id: 'steel', youngMPa: 210000, poisson: 0.3, capacity: SS400 }, fixed: TWO_FIXED, displacement: TWO_DISPLACEMENT,
  loads: 'nodal', ...(source === undefined ? {} : { source }) });

/** 10 mm cube, Kuhn (Freudenthal) split into six tetrahedra around the diagonal 0-7; node index = x + 2y + 4z bits. */
const CUBE_NODES: readonly V3[] = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [10, 10, 0], [0, 0, 10], [10, 0, 10], [0, 10, 10], [10, 10, 10]];
const KUHN: readonly Tet[] = [[0, 1, 3, 7], [0, 1, 5, 7], [0, 2, 3, 7], [0, 2, 6, 7], [0, 4, 5, 7], [0, 4, 6, 7]];
const CUBE_ELEMENTS: readonly Tet[] = KUHN.map(element => orient(CUBE_NODES, element));
/** Hand list of the twelve boundary triangles: each face is split along the diagonal from its lowest to its highest corner. */
const CUBE_BOUNDARY: readonly (readonly [number, number, number])[] = [[0, 2, 6], [0, 4, 6], [1, 3, 7], [1, 5, 7], [0, 1, 5],
  [0, 4, 5], [2, 3, 7], [2, 6, 7], [0, 1, 3], [0, 2, 3], [4, 5, 7], [4, 6, 7]];
const BOTTOM_FIXED = new Map<number, Fixed>([0, 1, 2, 3].map((node): [number, Fixed] => [node, [true, true, true]]));
/** Uniaxial u = (0, 0, 1e-4 z), nu = 0: sigma_zz = 210000 * 1e-4 = 21 MPa in every element, all other components 0. */
const UNIAXIAL: readonly V3[] = CUBE_NODES.map((point): V3 => [0, 0, 1e-4 * point[2]]);
const TOP_TRACTION = (factor: number): SolidAnalysisInput['surfaceLoads'] => [[4, 5, 7], [4, 6, 7]].map(([a, b, c]) => ({
  nodes: [a, b, c] as const, tractionMPa: [0, 0, 21 * factor] as const }));
const cube = (loads: Model['loads'], pivot = 1): Promise<Outcome> => solved({ nodes: CUBE_NODES, elements: CUBE_ELEMENTS,
  material: { id: 'steel', youngMPa: 210000, poisson: 0 }, fixed: BOTTOM_FIXED, displacement: UNIAXIAL, loads, pivot,
  boundary: CUBE_BOUNDARY.flat() });

/** The W71 modal-supported-tet-first-v1 conditions (verificationComparison.testSupport.ts MODAL_CASE, copied). */
const MODAL: SolidModalInput = { schema: 'pointercad-solid-tet4-modal/1',
  source: { documentId: 'native-doc', revision: 7, meshKey: 'tet:7' }, units: 'N-mm-MPa', numericBudgetBytes: 16 * 1024 * 1024,
  nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]], elements: [{ nodes: [0, 1, 2, 3], materialId: 'steel' }],
  materials: [{ id: 'steel', youngMPa: 205000, poisson: 0, densityKgM3: 7850 }],
  constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, true, true] },
    { node: 2, fixed: [false, true, true] }, { node: 3, fixed: [true, true, true] }], modeCount: 2 };
// Closed form of MODAL_CASE (solidModalNative.test.ts:closedForm): free DOFs u1x, u2x; K = diag(k1, k2), consistent
// M = [[d, o], [o, d]]; the first eigenvalue is the smaller root of (d^2 - o^2) L^2 - d (k1 + k2) L + k1 k2 = 0.
const MODAL_VOLUME = 1000 / 6, MODAL_DENSITY = 7.85e-9, K1 = 205000 * 10 / 6, K2 = 205000 * 10 / 12;
const MODAL_D = MODAL_DENSITY * MODAL_VOLUME / 10, MODAL_O = MODAL_DENSITY * MODAL_VOLUME / 20;
const MODAL_A = MODAL_D * MODAL_D - MODAL_O * MODAL_O, MODAL_B = MODAL_D * (K1 + K2);
const MODAL_LARGER = (MODAL_B + Math.sqrt(MODAL_B * MODAL_B - 4 * MODAL_A * K1 * K2)) / (2 * MODAL_A);
const MODAL_EXPECTED = K1 * K2 / (MODAL_A * MODAL_LARGER);
/** MODAL_CASE: scale = expected, tolerance 1e-9, strict false (error <= tolerance). Not loosened here. */
const MODAL_TOLERANCE = 1e-9;

// ---- 1. Coordinates and units ---------------------------------------------------------------------------------------

describe('criterion 1: probe values, units and coordinate system against an independent Tet4 evaluation', () => {
  it('returns six strains, von Mises, equivalent strain, yield ratio, energy and reactions within 1e-6 of this file', async () => {
    const outcome = await twoTet(), { nodes, elements, materials } = outcome.prepared.input;
    const material = materials[0], displacement = outcome.result.displacementMm;
    // Independent assembly from the FEM displacements: reaction = internal force on restrained DOFs, 0 on free DOFs.
    const states = elements.map(element => elementState(element.nodes.map(node => nodes[node]),
      element.nodes.map(node => displacement[node]), material));
    const internal = nodes.map((): [number, number, number] => [0, 0, 0]);
    elements.forEach((element, e) => element.nodes.forEach((node, a) => {
      for (let axis = 0; axis < 3; axis += 1) internal[node][axis] += states[e].forces[a][axis];
    }));
    const reaction = (node: number): V3 => {
      const flags = TWO_FIXED.get(node) ?? [false, false, false];
      return [flags[0] ? internal[node][0] : 0, flags[1] ? internal[node][1] : 0, flags[2] ? internal[node][2] : 0];
    };
    const field = buildSolidFieldMesh(outcome, 'vonMises', 10);
    if (field === null) throw new Error('field');
    for (const index of [0, 1]) {
      const probe = await readSolidElementProbe(outcome, field, index), expected = states[index];
      if (probe === null) throw new Error('probe');
      expectClose(probe.strain, expected.strain);
      expectClose(probe.stressMPa, expected.stress);
      expectClose([probe.vonMisesMPa], [expected.vonMises]);
      expectClose([probe.equivalentStrain], [expected.equivalentStrain]);
      expectClose([probe.yieldRatio ?? Number.NaN], [245 / expected.vonMises]);
      expectClose([probe.strainEnergyNmm], [expected.energy]);
      expect(probe.capacityMissing).toBe(false);
      probe.nodes.forEach(node => {
        expect(node.index).toBe(elements[index].nodes[probe.nodes.indexOf(node)]);
        // Undeformed document coordinates (not the scale-10 display positions) and the real displacement.
        expect(node.positionMm).toEqual(TWO_NODES[node.index]);
        expect(node.displacementMm).toEqual(TWO_DISPLACEMENT[node.index]);
        expectClose(node.reactionN, reaction(node.index));
      });
      // Units and coordinate system come with the values; the shown unit text is read from i18n keys.
      expect(probe.coordinates).toBe(SOLID_PROBE_COORDINATES);
      expect(probe.coordinates).toBe('global-XYZ-undeformed');
      expect(probe.units).toBe(SOLID_PROBE_UNITS);
      expect([t(probe.units.length), t(probe.units.stress), t(probe.units.force), t(probe.units.energy), t(probe.units.strain)])
        .toEqual(['mm', 'MPa', 'N', 'N·mm', '無次元']);
      const html = renderToStaticMarkup(createElement(SolidElementProbeValues, { probe })).replaceAll('<!-- -->', '');
      expect(html).toContain(`${t('solidAnalysis.probeMises')}: ${probe.vonMisesMPa} ${t(probe.units.stress)}`);
      expect(html).toContain(`${t('solidAnalysis.probeEquivalentStrain')}: ${probe.equivalentStrain}`);
      expect(html).toContain(`${t('solidAnalysis.probeEnergy')}: ${probe.strainEnergyNmm} ${t(probe.units.energy)}`);
      expect(html).toContain(`data-coordinates="global-XYZ-undeformed">${t('solidAnalysis.probeCoordinates')}`);
      const first = probe.nodes[0];
      expect(html).toContain(`${t('solidAnalysis.probePosition')} ${first.positionMm.join(', ')} ${t(probe.units.length)};`
        + `${t('solidAnalysis.probeDisplacement')} ${first.displacementMm.join(', ')} ${t(probe.units.length)}; `
        + `${t('solidAnalysis.probeReaction')} ${first.reactionN.join(', ')} ${t(probe.units.force)}`);
    }
  });
});

// ---- 2. Mesh overlay ------------------------------------------------------------------------------------------------

/** Runtime check of the overlay mesh classes (as solidFieldLayer.test.ts; a bare instanceof Mesh is Mesh<any, any, any>). */
function isFieldMesh(object: THREE.Object3D | undefined): object is THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
  return object instanceof THREE.Mesh && object.geometry instanceof THREE.BufferGeometry
    && object.material instanceof THREE.MeshBasicMaterial;
}

describe('criterion 2: the drawn overlay is the analysed mesh', () => {
  const key = (corners: readonly number[]): string => [...corners].sort((left, right) => left - right).join(',');

  it('draws the 12 boundary triangles, 6 elements and 8 nodes of the cube result, and 3 sample corners within 1e-9', async () => {
    const outcome = await cube(TOP_TRACTION(1)), still = buildSolidFieldMesh(outcome, 'vonMises', 0);
    const moved = buildSolidFieldMesh(outcome, 'vonMises', 10);
    if (still === null || moved === null) throw new Error('field');
    const layer = createSolidFieldLayer();
    layer.set(moved);
    const mesh = outcome.mesh;
    expect(layer.overlayCounts()).toEqual({ triangles: mesh.boundaryTriangles.length / 3,
      elements: outcome.prepared.input.elements.length, nodes: outcome.prepared.input.nodes.length });
    expect(layer.overlayCounts()).toEqual({ triangles: 12, elements: 6, nodes: 8 });
    expect(layer.triangleCount()).toBe(12);
    // Undeformed corners are exactly the analysed node coordinates: identify every corner by its coordinates alone.
    const nodeAt = (k: number): number => CUBE_NODES.findIndex(point => point.every((value, axis) => value === still.positions[3 * k + axis]));
    const corners = Array.from({ length: still.positions.length / 3 }, (_, k) => nodeAt(k));
    expect(corners).not.toContain(-1);
    expect(corners).toEqual(still.triangleNodes);
    const triangles = Array.from({ length: corners.length / 3 }, (_, i) => key(corners.slice(3 * i, 3 * i + 3)));
    expect(triangles.sort()).toEqual(CUBE_BOUNDARY.map(key).sort());
    // Three sample nodes: every drawn corner of node n is X_n + 10 u_n within 1e-9 mm; the GPU buffer is its float32.
    const child = layer.group.children[0];
    if (!isFieldMesh(child)) throw new Error('drawn geometry');
    const drawn = child.geometry.getAttribute('position');
    for (const sample of [5, 6, 7]) {
      const expected = [0, 1, 2].map(axis => CUBE_NODES[sample][axis] + 10 * UNIAXIAL[sample][axis]);
      const at = corners.flatMap((node, k) => node === sample ? [k] : []);
      expect(at.length).toBeGreaterThan(0);
      for (const k of at) {
        const position = moved.positions.slice(3 * k, 3 * k + 3);
        position.forEach((value, axis) => expect(Math.abs(value - expected[axis])).toBeLessThanOrEqual(1e-9));
        expect([drawn.getX(k), drawn.getY(k), drawn.getZ(k)]).toEqual(position.map(Math.fround));
      }
    }
    layer.set(null);
    expect(layer.overlayCounts()).toEqual({ triangles: 0, elements: 0, nodes: 0 });
    layer.dispose();
  });

  it('shows only the boundary of a mesh with an interior node: 8 of 9 nodes, all 12 elements', () => {
    const nodes: readonly V3[] = [...CUBE_NODES, [5, 5, 5]];
    const elements = CUBE_BOUNDARY.map(([a, b, c]) => orient(nodes, [a, b, c, 8]));
    const outcome = typedOutcome({ nodes, elements, stresses: elements.map((): Six => [1, 0, 0, 0, 0, 0]),
      boundary: CUBE_BOUNDARY.flat() });
    const field = buildSolidFieldMesh(outcome, 'xx', 0);
    if (field === null) throw new Error('field');
    const boundaryNodes = new Set(outcome.mesh.boundaryTriangles).size;
    expect(boundaryNodes).toBe(8);
    expect(solidFieldOverlayCounts(field)).toEqual({ triangles: 12, elements: 12, nodes: boundaryNodes });
    expect(outcome.prepared.input.nodes).toHaveLength(9);
  });

  describe('display switching', () => {
    beforeEach(() => { resetTestStore(); useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null }); });
    afterEach(() => { useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null }); resetTestStore(); });
    const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value, (_key, item: unknown) =>
      item instanceof Map ? [...item.entries()] : item instanceof Set ? [...item.values()] : item)).digest('hex');

    it('changes neither the document nor the history (identity and SHA-256)', async () => {
      useAppStore.getState().toggleStrength();
      useAppStore.setState({ solidAnalysisRunner: { run: vi.fn(), cancel: vi.fn(), captureFaces: vi.fn(), validate: vi.fn() } });
      useAppStore.getState().openSolidAnalysis();
      const session = useAppStore.getState().solidAnalysisSession;
      if (session === null) throw new Error('session');
      const outcome = await cube(TOP_TRACTION(1));
      useAppStore.setState({ solidAnalysisSession: { ...session, status: 'complete', result: outcome } });
      const before = useAppStore.getState(), documentSha = digest(before.document), historySha = digest(before.undoStack);
      for (const view of [{ quantity: 'strainZz' as const }, { deformationScale: 100 }, { quantity: 'vonMises' as const, deformationScale: 1 }]) {
        useAppStore.getState().setSolidAnalysisFieldView(view);
        const after = useAppStore.getState();
        expect(after.document).toBe(before.document);
        expect(after.undoStack).toBe(before.undoStack);
        expect(digest(after.document)).toBe(documentSha);
        expect(digest(after.undoStack)).toBe(historySha);
        expect(after.solidAnalysisSession?.result).toBe(outcome);
      }
    });
  });
});

// ---- 3. Result warnings ---------------------------------------------------------------------------------------------

/** L-shaped block of three Kuhn cubes (cells (0,0), (1,0), (0,1)); the inner vertical edge x = y = 10 is re-entrant. */
function lShape(): { readonly nodes: readonly V3[]; readonly elements: readonly Tet[]; readonly corner: readonly number[] } {
  const index = new Map<string, number>(), nodes: V3[] = [];
  const at = (i: number, j: number, k: number): number => {
    const name = `${i},${j},${k}`, found = index.get(name);
    if (found !== undefined) return found;
    nodes.push([10 * i, 10 * j, 10 * k]); index.set(name, nodes.length - 1); return nodes.length - 1;
  };
  const elements: Tet[] = [];
  for (const [ci, cj] of [[0, 0], [1, 0], [0, 1]]) {
    const local = [at(ci, cj, 0), at(ci + 1, cj, 0), at(ci, cj + 1, 0), at(ci + 1, cj + 1, 0),
      at(ci, cj, 1), at(ci + 1, cj, 1), at(ci, cj + 1, 1), at(ci + 1, cj + 1, 1)];
    for (const element of KUHN) elements.push([local[element[0]], local[element[1]], local[element[2]], local[element[3]]]);
  }
  const corner = [at(1, 1, 0), at(1, 1, 1)];
  return { nodes, elements: elements.map(element => orient(nodes, element)), corner };
}
/** Independent nodal averaging of element values: arithmetic mean over the elements of each node. */
function averagingFraction(elements: readonly Tet[], values: readonly number[], nodeCount: number): number {
  const shared = Array.from({ length: nodeCount }, (_, node) => values.filter((_value, e) => elements[e].includes(node)));
  const nodal = shared.map(list => list.reduce((sum, value) => sum + value, 0) / list.length);
  const peak = Math.max(...values);
  return Math.max(...elements.map((element, e) => Math.abs(values[e] - element.reduce((sum, node) => sum + nodal[node], 0) / 4))) / peak;
}

describe('criterion 3: singular, not-converged and averaging warnings', () => {
  it('keeps the thresholds in one place with the documented values', () => {
    // Rationale (also in solidFieldView.ts): 45 degrees > the default facet turn (0.3 rad); residual 1e-10 = FEM acceptance
    // 1e-8 / 100 and < the strictest solid W71 tolerance 1e-9; pivot 1e-6 gives eps / p = 2.2e-10 < 1e-9; averaging 0.1 of the
    // peak (Zienkiewicz-Zhu recovered-stress difference; a uniform W71 field has difference 0, never above any W71 tolerance).
    expect(SOLID_RESULT_WARNING_LIMITS).toEqual({ reentrantTurnDegrees: 45, residual: 1e-10, pivot: 1e-6, averagingFraction: 0.1 });
    expect(Number.EPSILON / SOLID_RESULT_WARNING_LIMITS.pivot).toBeLessThan(MODAL_TOLERANCE);
    expect(SOLID_RESULT_WARNING_LIMITS.residual).toBeLessThan(MODAL_TOLERANCE);
    expect(SOLID_RESULT_WARNINGS.map(kind => t(SOLID_RESULT_WARNING_KEYS[kind]))).toEqual([
      '最大の相当応力が、入隅・点荷重・点や線の拘束に接する要素にあります。この最大値は網を細かくするほど大きくなることがあり、評価に使えません。',
      '解の収束が不十分です（つり合いの残差が大きいか、剛性が特異に近い状態です）。拘束と網を見直して解析し直してください。',
      '要素の値と節点で平均した値の差が大きく、網の細分が収束していない可能性があります。網を細かくして解析し直してください。']);
  });

  it('negative: a decoded uniform cube under a surface traction on a fully supported face shows 0 warnings', async () => {
    const warnings = solidResultWarnings(await cube(TOP_TRACTION(1)));
    expect(warnings).toMatchObject({ warnings: [], singularNodes: [] });
    // Uniform up to rounding of the real FEM recovery: far below the 0.1 limit.
    expect(warnings?.averagingFraction).toBeLessThan(1e-12);
    expect(warnings?.peakVonMisesMPa).toBeCloseTo(21, 9);
  });

  it('singular: concentrated nodal loads, point supports and a re-entrant corner at the peak element', async () => {
    const point = solidResultWarnings(await cube('nodal'));
    expect(point?.warnings).toEqual(['singular']);
    expect(point?.singularNodes).toEqual([4, 5, 6, 7]);
    const supports = solidResultWarnings(typedOutcome({ nodes: CUBE_NODES, elements: CUBE_ELEMENTS,
      stresses: CUBE_ELEMENTS.map((): Six => [10, 0, 0, 0, 0, 0]), constraints: [{ node: 0, fixed: [true, true, true] },
        { node: 1, fixed: [false, true, true] }, { node: 2, fixed: [false, false, true] }] }));
    expect(supports?.warnings).toEqual(['singular']);
    expect(supports?.singularNodes).toEqual([0, 1, 2]);
    const l = lShape(), touching = l.elements.map(element => element.some(node => l.corner.includes(node)));
    const bottom = l.nodes.flatMap((point, node) => point[2] === 0 ? [{ node, fixed: [true, true, true] as const }] : []);
    const reentrant = solidResultWarnings(typedOutcome({ nodes: l.nodes, elements: l.elements, constraints: bottom,
      stresses: touching.map((near): Six => [near ? 100 : 99, 0, 0, 0, 0, 0]) }));
    expect(reentrant?.warnings).toEqual(['singular']);
    // Only the two nodes of the inner vertical edge: no convex box edge and no coplanar diagonal is reported.
    expect(reentrant?.singularNodes).toEqual([...l.corner].sort((left, right) => left - right));
    // Control: the same L with its peak away from the corner has no singular warning.
    const away = solidResultWarnings(typedOutcome({ nodes: l.nodes, elements: l.elements, constraints: bottom,
      stresses: touching.map((near): Six => [near ? 99 : 100, 0, 0, 0, 0, 0]) }));
    expect(away?.warnings).toEqual([]);
  });

  it('not converged: a decoded residual of about 4e-9 (accepted by FEM <= 1e-8) and a scaled pivot of 1e-9', async () => {
    const residual = await cube(TOP_TRACTION(1 + 4e-9));
    expect(residual.result.maximumRelativeEquilibriumResidual).toBeGreaterThan(SOLID_RESULT_WARNING_LIMITS.residual);
    expect(solidResultWarnings(residual)?.warnings).toEqual(['notConverged']);
    expect(solidResultWarnings(await cube(TOP_TRACTION(1), 1e-9))?.warnings).toEqual(['notConverged']);
  });

  it('averaging: one element far above its neighbours, with the fraction computed independently', () => {
    for (const [jump, expected] of [[100, ['averaging']], [10.5, []]] as const) {
      const values = CUBE_ELEMENTS.map((_, e) => e === 0 ? jump : 10);
      const warnings = solidResultWarnings(typedOutcome({ nodes: CUBE_NODES, elements: CUBE_ELEMENTS,
        stresses: values.map((value): Six => [value, 0, 0, 0, 0, 0]),
        constraints: [0, 1, 2, 3].map(node => ({ node, fixed: [true, true, true] as const })) }));
      const fraction = averagingFraction(CUBE_ELEMENTS, values, CUBE_NODES.length);
      expect(Math.abs((warnings?.averagingFraction ?? Number.NaN) - fraction)).toBeLessThanOrEqual(1e-12);
      expect(warnings?.warnings).toEqual(expected);
    }
  });

  describe('panel text', () => {
    beforeEach(() => {
      resetTestStore(); useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null });
      vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, snapshot) => snapshot());
      useAppStore.getState().toggleStrength();
      useAppStore.setState({ solidAnalysisRunner: { run: vi.fn(), cancel: vi.fn(), captureFaces: vi.fn(), validate: vi.fn() } });
      useAppStore.getState().openSolidAnalysis();
    });
    afterEach(() => { vi.restoreAllMocks(); useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null }); resetTestStore(); });
    const panel = (outcome: Outcome): string => {
      const session = useAppStore.getState().solidAnalysisSession;
      if (session === null) throw new Error('session');
      const complete: SolidAnalysisSession = { ...session, status: 'complete', result: outcome };
      useAppStore.setState({ solidAnalysisSession: complete });
      return renderToStaticMarkup(createElement(SolidAnalysisPanel, { session: complete }));
    };

    it('shows the i18n text of each condition and no warning list for the negative case', async () => {
      const cases: readonly (readonly [Outcome, readonly SolidResultWarning[]])[] = [
        [await cube(TOP_TRACTION(1)), []], [await cube('nodal'), ['singular']], [await cube(TOP_TRACTION(1), 1e-9), ['notConverged']],
        [typedOutcome({ nodes: CUBE_NODES, elements: CUBE_ELEMENTS, stresses: CUBE_ELEMENTS.map((_, e): Six => [e === 0 ? 100 : 10, 0, 0, 0, 0, 0]),
          constraints: [0, 1, 2, 3].map(node => ({ node, fixed: [true, true, true] as const })) }), ['averaging']]];
      for (const [outcome, expected] of cases) {
        const html = panel(outcome);
        for (const kind of SOLID_RESULT_WARNINGS) {
          expect(html.includes(t(SOLID_RESULT_WARNING_KEYS[kind])), kind).toBe(expected.includes(kind));
          expect(html.includes(`data-warning="${kind}"`), kind).toBe(expected.includes(kind));
        }
        expect(html.includes('data-testid="solid-result-warnings"')).toBe(expected.length > 0);
      }
    });
  });
});

// ---- 4. Study fingerprint -------------------------------------------------------------------------------------------

describe('criterion 4: a probe and an export only for the result of this input, mesh, material and solver version', () => {
  // Already covered elsewhere and cited, not repeated: verificationNegative.test.ts 'rejects distinct mesh, material, revision
  // and a tampered observable' (W72 comparison level) and e2e analysisResultBindingFlow.ts (material / mesh condition edits
  // and a cancelled run leave 0 results on the real screen).
  it('refuses another mesh, another material, another solver or document version and a tampered result', async () => {
    const outcome = await twoTet(), field = buildSolidFieldMesh(outcome, 'vonMises', 1);
    if (field === null) throw new Error('field');
    expect(await readSolidElementProbe(outcome, field, 0)).not.toBeNull();
    await expect(solidResultReportRows(outcome.prepared.input, outcome.result)).resolves
      .toContainEqual(['metadata', '', 'coordinates', 'global-XYZ-undeformed']);
    const input = outcome.prepared.input;
    // A result written by another solver version: same numbers, another method identifier (no type cast needed).
    const otherSolver = structuredClone(outcome.result);
    Reflect.set(otherSolver, 'method', 'oofem-ltrspace-isole-native-ldlt/2');
    const [s0, s1, s2, s3, s4, s5] = outcome.result.elements[0].stressMPa;
    const tampered: Six = [s0 * (1 + 1e-6), s1, s2, s3, s4, s5];
    const variants: readonly (readonly [string, Outcome])[] = [
      ['another mesh', { ...outcome, prepared: { ...outcome.prepared, input: { ...input,
        nodes: input.nodes.map((point, node): V3 => node === 4 ? [7, 7, 7] : point) } } }],
      ['another material', { ...outcome, prepared: { ...outcome.prepared, input: { ...input,
        materials: [{ ...input.materials[0], youngMPa: 205000 }] } } }],
      ['another solver version', { ...outcome, result: otherSolver }],
      ['another document revision', { ...outcome, prepared: { ...outcome.prepared, input: { ...input,
        source: { ...input.source, revision: input.source.revision + 1 } } } }],
      ['a tampered result', { ...outcome, result: { ...outcome.result, elements: outcome.result.elements.map((element, e) =>
        e === 0 ? { ...element, stressMPa: tampered } : element) } }],
    ];
    expect(otherSolver.method).not.toBe(outcome.result.method);
    for (const [label, changed] of variants) {
      expect(await readSolidElementProbe(changed, field, 0), label).toBeNull();
      await expect(solidResultReportRows(changed.prepared.input, changed.result), label).rejects.toThrow();
    }
  });
});

// ---- 5 and 7. Reproducible export, display scale --------------------------------------------------------------------

describe('criteria 5 and 7: byte-identical CSV with fingerprint, units, version and coordinates, independent of the scale', () => {
  beforeEach(() => { resetTestStore(); });
  afterEach(() => { useAppStore.setState({ solidAnalysisSession: null }); resetTestStore(); });

  async function exportAt(outcome: Outcome, deformationScale: number): Promise<Uint8Array> {
    const state = useAppStore.getState(), writes: Uint8Array[] = [];
    const session: SolidAnalysisSession = { ...createSolidAnalysisSession(state.activeDocumentId), status: 'complete', result: outcome,
      fieldView: { quantity: 'vonMises', deformationScale } };
    const writable = { write: (bytes: Uint8Array) => { writes.push(bytes); return Promise.resolve(); },
      close: () => Promise.resolve(), abort: () => Promise.resolve() };
    const handle = { name: 'solid-analysis.csv', createWritable: () => Promise.resolve(writable) };
    useAppStore.setState({ solidAnalysisSession: session, fileGateway: createBrowserFileGateway({ showSaveFilePicker: () => Promise.resolve(handle) }),
      requestedGeneration: 7, completedGeneration: 7, isComputing: false, recomputeCancelled: false, lastOutcome: 'success',
      timelineIndex: null, mathGeometryResult: { document: state.document, generation: 7, evaluated: true, outcomes: new Map() } });
    expect(await exportSolidResultCsv(session, new AbortController().signal)).toBe(true);
    expect(writes).toHaveLength(1);
    return writes[0];
  }

  it('writes the same bytes twice and at display scales 1, 10 and 100, with the real displacement', async () => {
    const documentId = useAppStore.getState().document.id;
    const outcome = await twoTet({ documentId, revision: 7, meshKey: 'tet:probe' });
    const bytes = [await exportAt(outcome, 1), await exportAt(outcome, 1), await exportAt(outcome, 10), await exportAt(outcome, 100)];
    for (const other of bytes.slice(1)) expect(other).toEqual(bytes[0]);
    const csv = new TextDecoder().decode(bytes[0]), hash = await solidInputSha256(outcome.prepared.input);
    expect(outcome.result.inputSha256).toBe(hash);
    for (const header of ['metadata,,schema,pointercad-solid-result-report/1', `metadata,,coordinates,${SOLID_PROBE_COORDINATES}`,
      'metadata,,units,N-mm-MPa', `metadata,,inputSha256,${hash}`, 'metadata,,method,oofem-ltrspace-isole-native-ldlt/1'])
      expect(csv).toContain(`${header}\r\n`);
    TWO_DISPLACEMENT.forEach((move, node) => ['x', 'y', 'z'].forEach((axis, component) =>
      expect(csv).toContain(`node,${node},u${axis}_mm,${move[component]}\r\n`)));
  });

  it('keeps the probe displacement equal to the FEM displacement at display scales 1, 10 and 100', async () => {
    const outcome = await twoTet(), positions: number[][] = [];
    for (const scale of [1, 10, 100]) {
      const field = buildSolidFieldMesh(outcome, 'strainXx', scale);
      if (field === null) throw new Error('field');
      positions.push([...field.positions]);
      const probe = await readSolidElementProbe(outcome, field, 1);
      expect(probe?.nodes.map(node => node.displacementMm)).toEqual(TWO_ELEMENTS[1].map(node => outcome.result.displacementMm[node]));
      expect(probe?.nodes.map(node => node.displacementMm)).toEqual(TWO_ELEMENTS[1].map(node => TWO_DISPLACEMENT[node]));
    }
    // The display scale does move the drawn corners (so the probe values are not unchanged by accident).
    expect(positions[1]).not.toEqual(positions[0]);
    expect(positions[2]).not.toEqual(positions[1]);
  });
});

// ---- 6. Independent comparison with a W71 case ----------------------------------------------------------------------

describe('criterion 6: UI values against the W71 modal-supported-tet-first-v1 reference at its original tolerance', () => {
  it('ties the copied closed form to the W72 literal of the same case', () => {
    expect(Math.abs(MODAL_EXPECTED - 1103734965810.5317) / MODAL_EXPECTED).toBeLessThanOrEqual(MODAL_TOLERANCE);
  });

  function modalRaw(eigenvalues: readonly number[]): unknown {
    const modes = eigenvalues.map((lambda, index) => {
      // (K - L M) phi = 0 on (u1x, u2x): phi2 / phi1 = (k1 - L d) / (L o); mass-normalised phi^T M phi = 1.
      const ratio = (K1 - lambda * MODAL_D) / (lambda * MODAL_O);
      const norm = Math.sqrt(MODAL_D + 2 * MODAL_O * ratio + MODAL_D * ratio * ratio);
      return { number: index + 1, eigenvaluePerSecondSquared: lambda, frequencyHz: Math.sqrt(lambda) / (2 * Math.PI),
        normalizedResidual: 0, massNormalizedShapePerSqrtT: [[0, 0, 0], [1 / norm, 0, 0], [ratio / norm, 0, 0], [0, 0, 0]] };
    });
    return { schema: 'pointercad-solid-tet4-modal-native/2', source: MODAL.source, massMatrix: 'consistent', units: 'N-mm-MPa-t-s',
      modes, totalMassT: MODAL_DENSITY * MODAL_VOLUME, rigidBodyModes: 0, freeDofs: 2, maximumMassOrthogonalityError: 0,
      maximumRigidMotionResidual: 0, maximumElementMassError: 0, reservedNumericBytes: solidModalReservedBytes(4) };
  }

  it('the shown first frequency of the modal display gives the reference eigenvalue within 1e-9', async () => {
    const hash = await solidModalInputSha256(MODAL);
    // FEM re-checks the eigen-residual and mass orthonormality with its own closed-form tet4 operators (<= 1e-8).
    const result = decodeSolidModal(modalRaw([MODAL_EXPECTED, MODAL_LARGER]), MODAL, hash);
    const display = solidModeResultFor(MODAL, result);
    if (display === null) throw new Error('modal display');
    const preview = projectSolidMode(display, MODAL.source, { modeNumber: 1, amplitudeMm: 10, phase: 1 });
    if (preview.kind !== 'preview') throw new Error(preview.reason);
    const shown = (2 * Math.PI * preview.frequencyHz) ** 2, fem = result.modes[0].eigenvaluePerSecondSquared;
    expect(Math.abs(shown - MODAL_EXPECTED) / MODAL_EXPECTED).toBeLessThanOrEqual(MODAL_TOLERANCE);
    expect(Math.abs(fem - MODAL_EXPECTED) / MODAL_EXPECTED).toBeLessThanOrEqual(MODAL_TOLERANCE);
    expect(Math.abs(shown - fem) / MODAL_EXPECTED).toBeLessThanOrEqual(MODAL_TOLERANCE);
    // The W72 physical negative (half the eigenvalue) is refused by FEM before any display.
    expect(() => decodeSolidModal(modalRaw([551867482905.2659, MODAL_LARGER]), MODAL, hash)).toThrow();
  });

  it('the linear element probe on the same tetrahedron, material and supports matches the closed form within 1e-9', async () => {
    // Same nodes, E = 205000 MPa, nu = 0 and supports as MODAL_CASE; 1 N on node 1 in x. With K = diag(k1, k2) of that
    // case, u1x = F / k1, eps_xx = u1x / 10 mm, sigma_xx = E eps_xx = 0.06 MPa, reaction at node 0 = -F in x.
    const force = 1, u = force / K1;
    const fixed = new Map<number, Fixed>(MODAL.constraints.map((item): [number, Fixed] => [item.node, item.fixed]));
    const outcome = await solved({ nodes: MODAL.nodes, elements: [[0, 1, 2, 3]], material: { id: 'steel', youngMPa: 205000, poisson: 0 },
      fixed, displacement: [[0, 0, 0], [u, 0, 0], [0, 0, 0], [0, 0, 0]], loads: 'nodal', source: MODAL.source });
    const field = buildSolidFieldMesh(outcome, 'xx', 1);
    if (field === null) throw new Error('field');
    const probe = await readSolidElementProbe(outcome, field, 0);
    if (probe === null) throw new Error('probe');
    const strain = u / 10, stress = 205000 * strain;
    expect(Math.abs(stress - 0.06) / 0.06).toBeLessThanOrEqual(MODAL_TOLERANCE);
    expectClose(probe.strain, [strain, 0, 0, 0, 0, 0], MODAL_TOLERANCE);
    expectClose(probe.stressMPa, [stress, 0, 0, 0, 0, 0], MODAL_TOLERANCE);
    expectClose([probe.vonMisesMPa, probe.strainEnergyNmm], [stress, force * u / 2], MODAL_TOLERANCE);
    expectClose(probe.nodes[0].reactionN, [-force, 0, 0], MODAL_TOLERANCE);
    expectClose(probe.nodes[1].displacementMm, [u, 0, 0], MODAL_TOLERANCE);
    // The probe shows the FEM value itself (no second rounding in the UI).
    expect(probe.strain).toEqual(outcome.result.elements[0].strain);
    expect(probe.stressMPa).toEqual(outcome.result.elements[0].stressMPa);
  });
});
