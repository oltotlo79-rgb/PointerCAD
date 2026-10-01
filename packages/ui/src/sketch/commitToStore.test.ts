import { expressionValueFromNumber } from '@pointercad/expression';
import { parseDocument, serializeDocument } from '@pointercad/io';
import {
  absoluteCoordinate, appendFeature, appendSolid, createEmptyPartDocument, createEmptySketchDocument,
  DEFAULT_FACE_COLOR, replaceSketch, resolvePart, type PartDocument,
} from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';
import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { applyEditCommit, applyNumericTransition } from './commitToStore.js';
import { createNumericInput, type EditInputCommit } from './numericInput.js';

beforeEach(resetTestStore);

function part(): PartDocument {
  const sketch = appendFeature(appendFeature(createEmptySketchDocument(), {
    id: 'rect', name: '矩形1', planeId: 'xy', kind: 'rectangle', construction: false,
    corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(40, 30, 0),
  }), { id: 'face', name: '面1', planeId: 'xy', kind: 'face', color: DEFAULT_FACE_COLOR,
    boundary: [{ featureId: 'rect' }] });
  return appendSolid(replaceSketch(createEmptyPartDocument(), sketch), {
    id: 'extrude', name: '押し出し1', kind: 'extrude', suppressed: false,
    profile: { sketchId: sketch.id, faceFeatureId: 'face' }, distance: expressionValueFromNumber(10),
    reversed: false, symmetric: false,
  });
}
function extrudePlan(document: PartDocument, curves: number): string {
  const resolved = resolvePart(document);
  expect(resolved.errors).toEqual([]);
  expect(resolved.sketches[0].resolved.errors).toEqual([]);
  expect(resolved.steps).toHaveLength(1);
  const step = resolved.steps[0];
  expect(step.featureId).toBe('extrude');
  if (step.plan.kind !== 'extrude') throw new Error('Missing extrusion');
  expect(step.plan.profile).toHaveLength(curves);
  expect(step.plan.distance).toBe(10);
  return step.key;
}

describe('角加工の確定は既存面と押し出しの参照を保つ(F07)', () => {
  it.each(['sketchFillet', 'sketchChamfer'] as const)('%sの確定・Undo/Redo・保存読込', (tool) => {
    const document = part(), beforeKey = extrudePlan(document, 4);
    useAppStore.getState().applyDocument(document);
    useAppStore.getState().setActiveTool(tool);
    useAppStore.getState().setSelection(['rect#0', 'rect#1']);
    const commit: EditInputCommit = {
      kind: 'edit', tool, step: tool === 'sketchFillet' ? 'sketchFilletRadius' : 'sketchChamferSize',
      values: { cornerRadius: expressionValueFromNumber(5), cornerDistance1: expressionValueFromNumber(3) },
      flags: {}, choices: { chamferMode: 'equal' },
    };
    expect(applyEditCommit(commit)).toBe(true);
    const after = useAppStore.getState().document;
    expect(extrudePlan(after, 5)).not.toBe(beforeKey);
    expect(after.solids).toEqual(document.solids);
    expect(useAppStore.getState().activeTool).toBe(tool);
    expect(useAppStore.getState().selection).toHaveLength(1);
    expect(useAppStore.getState().editErrorKey).toBeNull();
    expect(useAppStore.getState().editNoticeKey).toBe('corner.notice.faceBoundary');
    expect(t('corner.notice.faceBoundary')).toContain('面の境界も更新しました');
    useAppStore.getState().undo();
    expect(useAppStore.getState().document).toBe(document);
    expect(extrudePlan(useAppStore.getState().document, 4)).toBe(beforeKey);
    useAppStore.getState().redo();
    expect(useAppStore.getState().document).toBe(after);
    extrudePlan(useAppStore.getState().document, 5);
    const reopened = parseDocument(serializeDocument(after));
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error('Could not reopen saved document');
    expect(reopened.document.sketches[0].features).toEqual(after.sketches[0].features);
    expect(reopened.document.solids).toEqual(after.solids);
    expect(extrudePlan(reopened.document, 5)).toBe(extrudePlan(after, 5));
  });

  it('境界の更新を拒否したら文書・Undo・選択・入力を保持し、理由を出す', () => {
    const initial = useAppStore.getState().document;
    const source = part(), sketch = source.sketches[0];
    const broken = replaceSketch(source, { ...sketch, features: sketch.features.map((feature) =>
      feature.kind === 'face' ? { ...feature, boundary: [{ featureId: 'rect', index: 0 }] } : feature) });
    useAppStore.getState().applyDocument(broken);
    useAppStore.getState().setActiveTool('sketchFillet');
    useAppStore.getState().setSelection(['rect#0', 'rect#1']);
    const input = createNumericInput('sketchFillet', 'sketchFilletRadius');
    useAppStore.getState().updateNumericInput(input);
    const history = useAppStore.getState().undoStack;
    applyNumericTransition({ kind: 'editCommitted', state: input, commit: {
      kind: 'edit', tool: 'sketchFillet', step: 'sketchFilletRadius',
      values: { cornerRadius: expressionValueFromNumber(5) }, flags: {}, choices: {},
    } });
    const state = useAppStore.getState();
    expect(state.document).toBe(broken);
    expect(state.undoStack).toBe(history);
    expect(state.selection).toEqual(['rect#0', 'rect#1']);
    expect(state.numericInput).toBe(input);
    expect(state.editErrorKey).toBe('corner.error.faceBoundary');
    expect(state.editNoticeKey).toBeNull();
    expect(t('corner.error.faceBoundary')).toContain('線と面は変更していません');
    state.undo();
    expect(useAppStore.getState().document).toBe(initial);
  });
});
