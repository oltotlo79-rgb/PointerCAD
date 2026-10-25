import { decodeSolidAnalysis, solidInputSha256, type SolidAnalysisInput } from '@pointercad/fem';
import { createSolidAnalysisSession } from '../solidAnalysis/solidAnalysisSession.js';
import { useAppStore } from '../store/useAppStore.js';
import { BASE_EDITS, edited } from './fatigue.testSupport.js';
import { editFatigueSession } from './fatigueSession.js';
import { selectFatigueSolidElement, type FatigueSolidSource } from './fatigueSolidSession.js';

/** Independent one-free-DOF analytical tet: E=200 MPa, F=1 N, volume=1/6 mm3 gives u=0.03 mm and sigma_xx=6 MPa.
 * The actual result decoder and fatigue core run; this is not native solver or browser evidence. */
export async function analyticalSolid(ownerId: string, revision = 0): Promise<FatigueSolidSource> {
  const input: SolidAnalysisInput = { schema: 'pointercad-solid-tet4/1', source: { documentId: ownerId, revision, meshKey: 'mesh3' },
    units: 'N-mm-MPa', numericBudgetBytes: 1000000, nodes: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
    elements: [{ nodes: [0, 1, 2, 3], materialId: 'm' }], materials: [{ id: 'm', youngMPa: 200, poisson: 0 }],
    constraints: [{ node: 0, fixed: [true, true, true] }, { node: 1, fixed: [false, true, true] },
      { node: 2, fixed: [true, true, true] }, { node: 3, fixed: [true, true, true] }],
    nodalLoads: [{ node: 1, forceN: [1, 0, 0] }], surfaceLoads: [] };
  const hash = await solidInputSha256(input);
  const result = decodeSolidAnalysis({ schema: 'pointercad-solid-tet4-native/1', source: input.source,
    displacementMm: [[0, 0, 0], [0.03, 0, 0], [0, 0, 0], [0, 0, 0]],
    elementForcesN: [[-1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]], reservedNumericBytes: 50000, minimumScaledPivot: 1 }, input, hash);
  const triangles: readonly number[] = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
  const coordinates = input.nodes.flat();
  const mesh: FatigueSolidSource['mesh'] = { kind: 'netgen-tetra-mesh', input: { schema: 'pointercad-convex-plc/1',
    source: { documentId: ownerId, revision, featureId: 'tet', bodyKey: 'body' }, units: 'mm', coordinates,
    triangles, tags: [0, 1, 2, 3], tagCount: 4 }, inputSha256: 'mesh3', coordinates,
    tetrahedra: [0, 1, 2, 3], boundaryTriangles: triangles, boundaryTags: [0, 1, 2, 3], volumeMm3: 1 / 6, minTetVolumeMm3: 1 / 6 };
  return { kind: 'result', result, prepared: { input, loadedAreaMm2: 0, totalForceN: [1, 0, 0] }, mesh };
}

export function solidDraft(source: FatigueSolidSource, ownerId = source.result.source.documentId) {
  const session = edited(BASE_EDITS, ownerId);
  return selectFatigueSolidElement(editFatigueSession(session, { kind: 'history-stress', index: 0, source: '0, 1, 0, -1' }), source, 0, source.result.source.documentId);
}

export function installSolid(source: FatigueSolidSource): void {
  const state = useAppStore.getState();
  useAppStore.setState({ solidAnalysisSession: { ...createSolidAnalysisSession(state.activeDocumentId),
    status: 'complete', result: source }, fatigueSession: solidDraft(source, state.activeDocumentId) });
}
