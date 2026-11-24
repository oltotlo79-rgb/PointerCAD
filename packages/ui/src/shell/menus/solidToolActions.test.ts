import { expressionValueFromNumber } from '@pointercad/expression';
import { appendSolid, createEmptyPartDocument, type HoleFeature, type PartDocument, type SolidBody } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';
import { subShapeElementId } from '../../solid/subShapeSelection.js';
import { bodyFor, resetTestStore } from '../../store/testing/createTestStore.js';
import { useAppStore } from '../../store/useAppStore.js';
import { SOLID_TOOL_STEPS } from '../../sketch/numericInput.js';
import { runPushPull, runSolidTool } from './solidToolActions.js';
function fixture(): PartDocument {
  const base = createEmptyPartDocument();
  const feature = { id: 'body-a', name: 'A', kind: 'extrude' as const, suppressed: false,
    profile: { sketchId: base.activeSketchId, faceFeatureId: 'face' },
    distance: expressionValueFromNumber(10), reversed: false, symmetric: false };
  return appendSolid(appendSolid(base, feature), { ...feature, id: 'body-b', name: 'B' });
}

beforeEach(resetTestStore);
const creationTools = ['extrude', 'revolve', 'sphere', 'box', 'cylinder', 'cone', 'torus', 'sweep', 'ruled', 'loft'] as const;

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

describe('押し引き(M-05 4-1a)', () => {
  it('立体の平らな面 1 枚なら、面の移動の入力欄を開き、選んだ面を残す', () => {
    const face = subShapeElementId('body-a', 'face', 0);
    const body: SolidBody = { ...bodyFor('body-a'), faces: [{ index: 0, surfaceKind: 'plane', area: 100, centroid: [5, 5, 10],
      axis: [0, 0, 1], radius: null, triangleOffset: 0, triangleCount: 1 }] };
    useAppStore.setState({ document: fixture(), bodies: [body], selectionKind: 'face', selection: [face], pickAnchor: [100, 100] });
    runPushPull();
    const state = useAppStore.getState();
    expect(state.activeTool).toBe('faceOffset');
    expect(state.numericInput?.toolId).toBe('faceOffset');
    expect(state.numericInput?.step).toBe(SOLID_TOOL_STEPS.faceOffset);
    expect(state.selection).toEqual([face]);
    expect(state.solidErrorKey).toBeNull();
  });
  it('振り分けが決まらない選択では、道具も選択も文書も変えずに理由だけを出す', () => {
    const document = fixture();
    useAppStore.setState({ document, selection: ['body-b', 'body-a'] });
    const before = useAppStore.getState();
    runPushPull();
    const state = useAppStore.getState();
    expect(state.solidErrorKey).toBe('solidError.pushPullUnsupported');
    expect(state.activeTool).toBe(before.activeTool);
    expect(state.numericInput).toBeNull();
    expect(state.selection).toEqual(['body-b', 'body-a']);
    expect(state.document).toBe(document);
  });
  it('下穴の壁の面なら、道具を開かずに穴を選び、その穴の径の欄へ焦点を移す頼みを出す(4-1b)', () => {
    const value = expressionValueFromNumber;
    const hole: HoleFeature = { id: 'hole-1', name: 'H', kind: 'hole', suppressed: false, targetFeatureId: 'body-a',
      face: { bodyFeatureId: 'body-a', index: 0, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 100, position: [5, 5, 10],
        axis: [0, 0, 1], radius: null } },
      centers: [{ sketchId: 'centers', pointFeatureId: 'center-1' }], diameter: value(6), depth: { kind: 'through' },
      tiltAngle: value(0), tiltAzimuth: value(0) };
    // 計算部が名付けた面の出どころ(`assembly/boltedJointDraft.test.ts` の wall と同じ形)。面 1 が穴 hole-1 の下穴の壁。
    const body: SolidBody = { ...bodyFor('hole-1'), faces: [
      { index: 0, surfaceKind: 'plane', area: 100, centroid: [5, 5, 10], axis: [0, 0, 1], radius: null, triangleOffset: 0, triangleCount: 1 },
      { index: 1, surfaceKind: 'cylinder', area: 90, centroid: [5, 5, 5], axis: [0, 0, 1], radius: 3, triangleOffset: 1, triangleCount: 1 },
    ], origins: { version: 1, state: 'tracked', bindings: [{ state: 'unique', current: { kind: 'face', index: 1 },
      origin: { version: 1, shapeKind: 'face', identity: { kind: 'hole-face', featureId: 'hole-1',
        center: { sketchId: 'centers', producer: { kind: 'point', featureId: 'center-1' } }, placement: { kind: 'original' },
        stage: 'bore', role: 'wall' } } }] } };
    const document = appendSolid(fixture(), hole);
    useAppStore.setState({ document, bodies: [body], selectionKind: 'face', selection: [subShapeElementId('hole-1', 'face', 1)] });
    const before = useAppStore.getState();
    runPushPull();
    const state = useAppStore.getState();
    expect(state.selection).toEqual(['hole-1']);
    expect(state.focusRequest?.target).toEqual({ kind: 'solidField', featureId: 'hole-1', fieldKey: 'diameter' });
    expect(state.activeTool).toBe(before.activeTool);
    expect(state.numericInput).toBeNull();
    expect(state.solidErrorKey).toBeNull();
    expect(state.document).toBe(document);
  });
});

describe('焦点を移す頼み(focusRequest)', () => {
  it('果たした受け手は自分の頼みだけを消し、後から来た頼みは残す', () => {
    const store = useAppStore.getState();
    store.requestFocus({ kind: 'commandLine' });
    const first = useAppStore.getState().focusRequest;
    store.requestFocus({ kind: 'solidField', featureId: 'hole-1', fieldKey: 'diameter' });
    const second = useAppStore.getState().focusRequest;
    if (first === null || second === null) throw new Error('頼みが置かれていない');
    expect(second.serial).toBeGreaterThan(first.serial);
    store.consumeFocusRequest(first.serial);
    expect(useAppStore.getState().focusRequest).toBe(second);
    store.consumeFocusRequest(second.serial);
    expect(useAppStore.getState().focusRequest).toBeNull();
  });
  it('部品を作り直すと頼みは捨てるが、通し番号は戻さない(古い番号で新しい頼みを消さない)', () => {
    const store = useAppStore.getState();
    store.requestFocus({ kind: 'solidField', featureId: 'hole-1', fieldKey: 'diameter' });
    const before = useAppStore.getState().focusRequest;
    if (before === null) throw new Error('頼みが置かれていない');
    store.resetDocument(createEmptyPartDocument());
    expect(useAppStore.getState().focusRequest).toBeNull();
    expect(useAppStore.getState().focusRequestSerial).toBe(before.serial);
    store.requestFocus({ kind: 'commandLine' });
    const after = useAppStore.getState().focusRequest;
    expect(after?.serial).toBe(before.serial + 1);
    store.consumeFocusRequest(before.serial);
    expect(useAppStore.getState().focusRequest).toBe(after);
  });
});
