import type { BeamAnalysisDocument, Vector3 } from './analysisModel.js';

export const MODAL_REFERENCE = {
  young: 210e9, shear: 210e9 / 2.6, density: 7850,
  area: 0.001, iy: 1e-8, iz: 2e-8, torsion: 1.5e-8, length: 1,
};
const source = { kind: 'user-supplied' as const,
  reference: 'Explicit independent prismatic-beam numerical benchmark',
  condition: 'Linear elastic benchmark only; no material-grade capacity assertion' };

export interface ModalFixtureOptions {
  readonly segments?: number;
  readonly modes?: number;
  readonly thick?: boolean;
  readonly split?: boolean;
  readonly elbow?: boolean;
  readonly rotated?: boolean;
  readonly free?: boolean;
  readonly millimetres?: boolean;
  readonly densityScale?: number;
  readonly stiffnessScale?: number;
  readonly geometryScale?: number;
}
/** Exact orthogonal map with determinant +1, used independently of product frame code. */
export function rotateModalVector(vector: Vector3): Vector3 {
  return [
    (vector[0] + 2 * vector[1] + 2 * vector[2]) / 3,
    (2 * vector[0] + vector[1] - 2 * vector[2]) / 3,
    (-2 * vector[0] + 2 * vector[1] - vector[2]) / 3,
  ];
}

export function modalFixture(options: ModalFixtureOptions = {}): BeamAnalysisDocument {
  const geometry = options.geometryScale ?? 1;
  const unit = options.millimetres ? 1000 : 1;
  const scale = geometry * unit;
  const points: Vector3[] = options.elbow ? [[0, 0, 0], [0.5, 0, 0], [0.5, 0.4, 0.3]]
    : options.split ? [[0, 0, 0], [0.5, 0, 0], [1, 0, 0]] : [[0, 0, 0], [1, 0, 0]];
  const nodes = points.map((point, index) => {
    const transformed = options.rotated ? rotateModalVector(point) : point;
    return { id: `node-${index}`, position: transformed.map(value => value * scale) as [number, number, number] };
  });
  const hint: Vector3 = options.elbow ? [0, -0.6, 0.8] : [0, 1, 0];
  return {
    schema: 'pointercad-beam/2', id: 'modal-benchmark', revision: 1,
    modal: { modeCount: options.modes ?? 2, segmentsPerMember: options.segments ?? 8 },
    source: { documentId: 'independent-modal-fixture', documentRevision: 1, geometryRevision: 'explicit-numeric-geometry' },
    units: options.millimetres ? 'N-mm' : 'N-m', nodes,
    members: nodes.slice(1).map((node, index) => ({
      id: `member-${index}`, componentId: `component-${index}`, occurrencePath: [`component-${index}`],
      startNodeId: nodes[index].id, endNodeId: node.id, materialId: 'material', sectionId: 'section',
      localYHint: options.rotated ? rotateModalVector(hint) : hint,
    })),
    materials: [{ id: 'material', youngModulus: MODAL_REFERENCE.young * (options.stiffnessScale ?? 1) / unit ** 2,
      shearModulus: MODAL_REFERENCE.shear * (options.stiffnessScale ?? 1) / unit ** 2,
      densityKgM3: MODAL_REFERENCE.density * (options.densityScale ?? 1), source }],
    sections: [{ id: 'section', area: (options.thick ? 0.01 : MODAL_REFERENCE.area) * scale ** 2,
      iy: (options.thick ? 1e-4 : MODAL_REFERENCE.iy) * scale ** 4,
      iz: (options.thick ? 2e-4 : MODAL_REFERENCE.iz) * scale ** 4,
      torsionConstant: (options.thick ? 1.5e-4 : MODAL_REFERENCE.torsion) * scale ** 4,
      shearFactor: 5 / 6, source }],
    constraints: options.free ? [] : [{ id: 'physical-clamp', kind: 'fixed', nodeId: nodes[0].id }], loads: [],
  };
}
