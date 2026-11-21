import { expressionValueFromNumber } from '@pointercad/expression';
import { appendSolid, createEmptyPartDocument, type PartDocument, type SolidBody } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';
import { subShapeElementId } from '../../solid/subShapeSelection.js';
import { bodyFor, resetTestStore } from '../../store/testing/createTestStore.js';
import { useAppStore } from '../../store/useAppStore.js';
import { runSolidTool } from './solidToolActions.js';
function fixture(): PartDocument {
  const base = createEmptyPartDocument();
  const feature = { id: 'body-a', name: 'A', kind: 'extrude' as const, suppressed: false,
    profile: { sketchId: base.activeSketchId, faceFeatureId: 'face' },
    distance: expressionValueFromNumber(10), reversed: false, symmetric: false };
  return appendSolid(appendSolid(base, feature), { ...feature, id: 'body-b', name: 'B' });
}

beforeEach(resetTestStore);
const creationTools = ['extrude', 'revolve', 'sphere', 'box', 'cylinder', 'cone', 'torus'] as const;

describe('solid creation menu explicit targets', () => {
  it.each(creationTools)('%s opens the result and target controls without selecting a body by order', tool => {
    const document = fixture();
    useAppStore.setState({ document, selection: ['body-b', 'body-a'], pickAnchor: [100, 100] });
    runSolidTool(tool, { ready: true, reasonKey: null });
    const input = useAppStore.getState().numericInput;
    const target = input?.choices.find((choice) => choice.key === 'extrudeTarget');
    expect(input?.toolId).toBe(tool);
    expect(target?.labelKey).toBe(tool === 'extrude' ? 'numericInput.choice.extrudeTarget' : 'numericInput.choice.solidTarget');
    const result = input?.choices.find(choice => choice.key === 'extrudeOperation');
    expect(result?.labelKey).toBe(tool === 'extrude' ? 'numericInput.choice.extrudeOperation' : 'numericInput.choice.solidOperation');
    expect(result?.value).toBe('new');
    expect(target?.value).toBe('');
    expect(target?.presentation).toBe('menu');
    expect(target?.options.map((option) => option.value)).toEqual(['', 'body-a', 'body-b']);
    expect(result?.options.map(option => option.value)).toEqual(['new', 'join', 'cut']);
    expect(useAppStore.getState().document).toBe(document);
  });
  it('opens at the picked place and hands the picked face outline to the input window (M-10 ①)', () => {
    const outline = { left: 300, top: 200, right: 500, bottom: 360 } as const;
    useAppStore.setState({ document: fixture() });
    useAppStore.getState().setPickAnchor([400, 280], outline);
    runSolidTool('extrude', { ready: true, reasonKey: null });
    expect(useAppStore.getState().numericInputAnchor).toEqual([400, 280]);
    expect(useAppStore.getState().numericInputAvoid).toEqual(outline);
    useAppStore.getState().setPickAnchor([100, 100]);
    runSolidTool('extrude', { ready: true, reasonKey: null });
    expect(useAppStore.getState().numericInputAvoid).toBeNull();
  });
  it.each([['hole', 'holeSize'], ['threadHole', 'threadSize']] as const)(
    '%s pressed after picking only two edges of one flat face opens edge distance and keeps them as edge 1 and 2 (M-10 ③)', (tool, step) => {
      const edge = (index: number) => ({ index, curveKind: 'line' as const, length: 10, midpoint: [0, 0, 10] as const,
        start: [0, 0, 10] as const, end: [10, 0, 10] as const, axis: [1, 0, 0] as const, radius: null, segmentOffset: 0, segmentCount: 1 });
      const body: SolidBody = { ...bodyFor('body-a'), edges: [edge(0), edge(1)],
        faces: [{ index: 0, surfaceKind: 'plane', area: 100, centroid: [5, 5, 10], axis: [0, 0, 1], radius: null,
          triangleOffset: 0, triangleCount: 1, boundaryEdgeIndices: [0, 1] }] };
      const picked = [subShapeElementId('body-a', 'edge', 1), subShapeElementId('body-a', 'edge', 0)];
      useAppStore.setState({ document: fixture(), bodies: [body], selectionKind: 'edge', selection: picked });
      runSolidTool(tool, { ready: true, reasonKey: null });
      const state = useAppStore.getState();
      expect(state.numericInput?.step).toBe(step);
      expect(state.numericInput?.choices.find(choice => choice.key === 'holePlacement')?.value).toBe('edge-distance');
      expect(state.selection).toEqual(picked);
      expect(state.selectionKind).toBe('face');
    });
  it.each(creationTools)('%s offers only new without a live target', tool => {
    useAppStore.setState({ document: createEmptyPartDocument(), pickAnchor: [100, 100] });
    runSolidTool(tool, { ready: true, reasonKey: null });
    expect(useAppStore.getState().numericInput?.choices.find((choice) => choice.key === 'extrudeOperation')?.options.map((option) => option.value)).toEqual(['new']);
  });
});
