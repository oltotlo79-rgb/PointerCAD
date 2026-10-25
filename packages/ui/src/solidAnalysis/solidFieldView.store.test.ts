import type { CadSolidOutcome } from '@pointercad/fem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { solidSavedInput } from './solidAnalysisSession.js';
import { DEFAULT_SOLID_FIELD_VIEW, solidAnalysisFieldOf } from './solidFieldState.js';

type SolidResult = Extract<CadSolidOutcome, { kind: 'result' }>;
type Vector3 = readonly [number, number, number];
const NODES: readonly Vector3[] = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];

/** One unit Tet4 with uniaxial 100 MPa (same fixture shape as solidFieldState.test.ts). */
function outcome(): SolidResult {
  const input = { schema: 'pointercad-solid-tet4/1', source: { documentId: 'd', revision: 1, meshKey: 'm' }, units: 'N-mm-MPa',
    numericBudgetBytes: 1, nodes: NODES, elements: [{ nodes: [0, 1, 2, 3] as const, materialId: 'material' }],
    materials: [{ id: 'material', youngMPa: 1, poisson: 0.3 }], constraints: [], nodalLoads: [], surfaceLoads: [] } as const;
  const result: SolidResult['result'] = { kind: 'oofem-linear-solid-tet4', source: input.source, inputSha256: 'x',
    method: 'oofem-ltrspace-isole-native-ldlt/1', units: 'N-mm-MPa', structuralCertification: false,
    displacementMm: NODES.map((): Vector3 => [0, 0, 0]), reactionN: NODES.map((): Vector3 => [0, 0, 0]),
    elements: [{ strain: [0, 0, 0, 0, 0, 0], stressMPa: [100, 0, 0, 0, 0, 0] }], strainEnergyNmm: 0,
    maximumRelativeEquilibriumResidual: 0, reservedNumericBytes: 0, nativeElementForcesN: [[]], minimumScaledPivot: 1 };
  const mesh: SolidResult['mesh'] = { kind: 'netgen-tetra-mesh', input: { schema: 'pointercad-convex-plc/1',
    source: { documentId: 'd', revision: 1, featureId: 'f', bodyKey: 'k' }, units: 'mm', coordinates: [], triangles: [],
    tags: [], tagCount: 0 }, inputSha256: 'x', coordinates: [], tetrahedra: [], boundaryTriangles: [], boundaryTags: [],
  volumeMm3: 0, minTetVolumeMm3: 0 };
  return { kind: 'result', result, prepared: { input, loadedAreaMm2: 1, totalForceN: [0, 0, 0] }, mesh };
}

// Same setup as store/solidAnalysisSlice.test.ts: the strength panel is open and a runner double records cancels.
beforeEach(() => { resetTestStore(); useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null }); });
afterEach(() => { useAppStore.setState({ solidAnalysisSession: null, solidAnalysisRunner: null }); resetTestStore(); });

function openSession(): ReturnType<typeof vi.fn> {
  useAppStore.getState().toggleStrength();
  const runner = { run: vi.fn(), cancel: vi.fn(), captureFaces: vi.fn(), validate: vi.fn() };
  useAppStore.setState({ solidAnalysisRunner: runner });
  useAppStore.getState().openSolidAnalysis();
  runner.cancel.mockClear();
  return runner.cancel;
}
/** A completed current result, as attachSolidAnalysis sets it after a successful run. */
function complete(): void {
  const session = useAppStore.getState().solidAnalysisSession;
  if (!session) throw new Error('Missing solid session');
  useAppStore.setState({ solidAnalysisSession: { ...session, status: 'complete', result: outcome() } });
  expect(solidAnalysisFieldOf(useAppStore.getState().solidAnalysisSession)?.elementValues).toEqual([100]);
}

describe('solid field view choice in the store', () => {
  it('changes only the display choice of a completed result: no cancel, revision, result or saved-input change', () => {
    const cancel = openSession();
    complete();
    const before = useAppStore.getState().solidAnalysisSession;
    if (!before) throw new Error('Missing solid session');
    expect(before.fieldView).toEqual(DEFAULT_SOLID_FIELD_VIEW);
    useAppStore.getState().setSolidAnalysisFieldView({ quantity: 'xy' });
    useAppStore.getState().setSolidAnalysisFieldView({ deformationScale: 250 });
    const after = useAppStore.getState().solidAnalysisSession;
    expect(after?.fieldView).toEqual({ quantity: 'xy', deformationScale: 250 });
    expect(after?.revision).toBe(before.revision);
    expect(after?.status).toBe('complete');
    expect(after?.result).toBe(before.result);
    expect(solidAnalysisFieldOf(after ?? null)?.elementValues).toEqual([0]);
    expect(cancel).not.toHaveBeenCalled();
    const valid = { ...before, bodyFeatureId: 'box', fixedFaces: ['bottom'], loadedFaces: ['top'],
      values: { ...before.values, young: '210 GPa', poisson: '0.3', tz: '0', volume: '1' } };
    expect(solidSavedInput({ ...valid, fieldView: { quantity: 'xy', deformationScale: 250 } }, 'part', []))
      .toEqual(solidSavedInput(valid, 'part', []));
  });

  it('refuses non-finite and negative scales and keeps the previous choice', () => {
    openSession();
    useAppStore.getState().setSolidAnalysisFieldView({ deformationScale: 10 });
    for (const deformationScale of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      useAppStore.getState().setSolidAnalysisFieldView({ deformationScale });
      expect(useAppStore.getState().solidAnalysisSession?.fieldView.deformationScale).toBe(10);
    }
    useAppStore.getState().setSolidAnalysisFieldView({ deformationScale: 0 });
    expect(useAppStore.getState().solidAnalysisSession?.fieldView.deformationScale).toBe(0);
  });

  it.each([
    ['an input edit', () => { useAppStore.getState().editSolidAnalysis('young', '1'); }],
    ['a load-mode switch', () => { useAppStore.getState().setSolidAnalysisLoadMode('pressure'); }],
    ['cancel', () => { useAppStore.getState().cancelSolidAnalysis(); }],
  ] as const)('drops a visible completed field after %s, keeping the session owner and the document history', (_label, end) => {
    openSession();
    complete();
    const before = useAppStore.getState();
    const owner = before.solidAnalysisSession?.ownerId;
    end();
    const after = useAppStore.getState();
    expect(after.solidAnalysisSession?.result).toBeNull();
    expect(solidAnalysisFieldOf(after.solidAnalysisSession)).toBeNull();
    expect(after.solidAnalysisSession?.ownerId).toBe(owner);
    expect(after.document).toBe(before.document);
    expect(after.undoStack).toBe(before.undoStack);
  });

  it('drops a visible completed field when the session is closed', () => {
    openSession();
    complete();
    useAppStore.getState().closeSolidAnalysis();
    expect(useAppStore.getState().solidAnalysisSession).toBeNull();
    expect(solidAnalysisFieldOf(useAppStore.getState().solidAnalysisSession)).toBeNull();
  });
});
