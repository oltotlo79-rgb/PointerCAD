import { expressionValueFromNumber as num } from '@pointercad/expression';
import { absoluteCoordinate, createEmptyPartDocument, replaceSketch, SKETCH_CONSTRAINT_KINDS,
  type SketchDocument, type WorkPlane } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { CONSTRAINT_MENU_ITEMS } from '../shell/menus/sketchMenuItems.js';
import { cancelConstraintPrompt, chooseConstraintTool, commitConstraintPrompt, changeConstraintValue } from './constraintActions.js';
import { commitAddConstraint, constraintContextOf, measuredConstraintValue, constraintReadiness } from './constraintCommands.js';
import { orderConstraintTargets } from './constraintPicking.js';

function setup(): SketchDocument {
  const part = createEmptyPartDocument();
  const sketch: SketchDocument = { ...part.sketches[0], features: [
    { id: 'a', name: 'a', kind: 'point', planeId: 'xy', at: absoluteCoordinate(3, 4, 0) },
    { id: 'b', name: 'b', kind: 'point', planeId: 'xy', at: absoluteCoordinate(-2, 7, 0) },
  ] };
  useAppStore.getState().resetDocument({ ...replaceSketch(part, sketch), schemaVersion: 21 });
  return sketch;
}

describe('signed axis constraint public route', () => {
  beforeEach(() => resetTestStore());

  it('creates, updates, cancels and restores the owner version in one Undo/Redo', () => {
    setup();
    const original = useAppStore.getState().document;
    useAppStore.getState().setSelection(['a', 'b']);
    chooseConstraintTool('horizontalDistance');
    expect(useAppStore.getState().constraintPrompt?.defaultSource).toBe('-5');
    cancelConstraintPrompt();
    expect(useAppStore.getState().document).toBe(original);
    useAppStore.getState().setSelection(['a', 'b']);
    chooseConstraintTool('horizontalDistance');
    commitConstraintPrompt('-8');
    const committed = useAppStore.getState().document;
    expect(committed.schemaVersion).toBe(22);
    const saved = useAppStore.getState().sketch.constraints?.[0];
    expect(saved).toMatchObject({ kind: 'horizontalDistance', length: { value: -8 } });
    useAppStore.getState().undo();
    expect(useAppStore.getState().document).toEqual(original);
    useAppStore.getState().redo();
    expect(useAppStore.getState().document).toEqual(committed);
    if (saved === undefined) throw new Error('missing constraint');
    changeConstraintValue(saved.id, '0');
    expect(useAppStore.getState().sketch.constraints?.[0]).toMatchObject({ length: { value: 0 } });
  });

  it('rejects a stale prompt target without editing the document', () => {
    const original = setup(), oldContext = constraintContextOf(original);
    const current = { ...original, features: original.features.filter(feature => feature.id !== 'b') };
    expect(commitAddConstraint(current, 'horizontalDistance', [
      { kind: 'point', pointId: 'a' }, { kind: 'point', pointId: 'b' },
    ], num(-5), oldContext)).toMatchObject({ ok: false, reason: 'otherSketch' });
    expect(current.constraints).toBeUndefined();
  });

  it('measures local signed components on a translated rotated plane', () => {
    const plane: WorkPlane = { id: 'custom', origin: [10, 20, 30], axisU: [0, 1, 0],
      axisV: [0, 0, 1], normal: [1, 0, 0] };
    const sketch: SketchDocument = { id: 's', name: 's', features: [
      { id: 'a', name: 'a', kind: 'point', planeId: plane.id, at: absoluteCoordinate(10, 22, 33) },
      { id: 'b', name: 'b', kind: 'point', planeId: plane.id, at: absoluteCoordinate(10, 17, 37) },
    ] };
    const context = constraintContextOf(sketch, { workPlane: () => plane });
    const targets = [{ kind: 'point', pointId: 'a' }, { kind: 'point', pointId: 'b' }] as const;
    expect(measuredConstraintValue('horizontalDistance', targets, context)?.value).toBe(-5);
    expect(measuredConstraintValue('verticalDistance', targets, context)?.value).toBe(4);
    expect(CONSTRAINT_MENU_ITEMS.map(item => item.id)).toEqual(SKETCH_CONSTRAINT_KINDS);
  });

  it.each(['midpoint', 'pointOnCurve'] as const)('commits %s through selection, preserving one Undo and reverse picker ordering', kind => {
    const sketch = setup();
    const next: SketchDocument = { ...sketch, features: [...sketch.features,
      { id: 'l', name: 'l', kind: 'line', planeId: 'xy', from: absoluteCoordinate(0, 0, 0),
        to: absoluteCoordinate(6, 8, 0), construction: false },
    ] };
    const original = replaceSketch(useAppStore.getState().document, next);
    useAppStore.getState().resetDocument(original);
    useAppStore.getState().setSelection(['l', 'a']);
    const context = constraintContextOf(next);
    expect(orderConstraintTargets(kind, [{ kind: 'curve', element: { featureId: 'l' } },
      { kind: 'point', pointId: 'a' }], context.resolved)).toEqual([
      { kind: 'point', pointId: 'a' }, { kind: 'curve', element: { featureId: 'l' } },
    ]);
    chooseConstraintTool(kind);
    const committed = useAppStore.getState().document;
    expect(committed.schemaVersion).toBe(22);
    expect(useAppStore.getState().sketch.constraints?.[0]).toMatchObject({ kind,
      a: { kind: 'point', pointId: 'a' }, b: { kind: 'curve', element: { featureId: 'l' } } });
    useAppStore.getState().undo(); expect(useAppStore.getState().document).toEqual(original);
    useAppStore.getState().redo(); expect(useAppStore.getState().document).toEqual(committed);
  });

  it('admits a full circle but refuses a partial arc and a stale selected curve', () => {
    const sketch = setup();
    const circle = { id: 'c', name: 'c', kind: 'arc', planeId: 'xy', center: absoluteCoordinate(10, 10, 0),
      radius: num(4), startAngle: num(0), endAngle: num(360), construction: false } as const;
    const full = { ...sketch, features: [...sketch.features, circle] };
    expect(constraintReadiness(full, ['a', 'c'], 'pointOnCurve').ready).toBe(true);
    const partial = { ...sketch, features: [...sketch.features, { ...circle, endAngle: num(180) }] };
    expect(constraintReadiness(partial, ['a', 'c'], 'pointOnCurve').reason).toBe('unsupportedElement');
    const targets = [{ kind: 'point', pointId: 'a' }, { kind: 'curve', element: { featureId: 'c' } }] as const;
    expect(commitAddConstraint(sketch, 'pointOnCurve', targets, undefined, constraintContextOf(full)))
      .toMatchObject({ ok: false, reason: 'otherSketch' });
  });
});
