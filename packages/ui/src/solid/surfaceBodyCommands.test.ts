import { plainText } from '@pointercad/model';
import { expressionValueFromNumber } from '@pointercad/expression';
import { appendSolid, createEmptyPartDocument, findSolid, liveBodyIds, type SurfaceFeature } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { chooseNumericInput, commitNumericInput, createNumericInput, reduceNumericInput, SOLID_TOOL_STEPS } from '../sketch/numericInput.js';
import { commitSolidInput, solidToolReadiness } from './solidCommands.js';
import { consumedIds } from './solidHistoryState.js';
import { setSolidChoice, setSolidField, summarizeSolid } from './solidSummary.js';
import { subShapeElementId, type SubShapeBody } from './subShapeSelection.js';

const surface: SurfaceFeature = {
  id: 'surface-1', name: 'Surface', suppressed: false, kind: 'surface',
  operation: { kind: 'planar', profile: { sketchId: 'sketch-1', curveIds: ['outline'] } },
};
const part = appendSolid(createEmptyPartDocument(), surface);
const body: SubShapeBody = {
  featureId: surface.id, bodyKind: 'shell', isValid: true,
  mesh: { edgePositions: new Float32Array(0) }, faces: [], edges: [], vertices: [],
};

function input(tool: 'thicken' | 'offsetBody', expression: string, side = 'normal') {
  const initial = createNumericInput(tool, SOLID_TOOL_STEPS[tool]);
  const state = tool === 'thicken' ? chooseNumericInput(initial, 'thickenSide', side) : initial;
  const result = commitNumericInput(reduceNumericInput(state, { type: 'edit', index: 0, source: expression }));
  if (result.kind !== 'solidCommitted') throw new Error(result.kind);
  return result.commit;
}

describe('surface body commands', () => {
  it.each(['thicken', 'offsetBody'] as const)('%s requires one live face-only body at confirmation', tool => {
    const commit = input(tool, '1');
    expect(solidToolReadiness(part, [surface.id], tool, [body])).toEqual({ ready: true, reasonKey: null });
    for (const bodyKind of ['solid', 'mesh', 'mixed'] as const) {
      const candidates = [{ ...body, bodyKind }];
      expect(solidToolReadiness(part, [surface.id], tool, candidates).reasonKey).toBe('surfaceBody.select');
      expect(commitSolidInput(part, [surface.id], commit, candidates)).toEqual({ ok: false, reasonKey: 'surfaceBody.select' });
    }
    for (const selection of [[], [surface.id, 'another'], [subShapeElementId(surface.id, 'face', body.faces.length)]]) {
      expect(commitSolidInput(part, selection, commit, [body]).ok).toBe(false);
    }
    expect(commitSolidInput(part, [surface.id], commit, []).ok).toBe(false);
  });

  it.each(['normal', 'reverse', 'both'])('keeps the thickness expression and the %s side', side => {
    const result = commitSolidInput(part, [surface.id], input('thicken', '2+1', side), [body]);
    if (!result.ok) throw new Error(result.reasonKey);
    const feature = findSolid(result.document, result.featureId);
    if (feature?.kind !== 'thicken') throw new Error('Missing thickened body');
    expect(feature).toMatchObject({ targetFeatureId: surface.id, thickness: { source: '2+1', value: 3 }, side });
    expect(liveBodyIds(result.document)).toEqual([feature.id]);
    const summary = summarizeSolid(result.document, feature);
    expect(summary.references.map(ref => ref.elementId)).toEqual([surface.id]);
    expect(summary.fields.map(field => field.key)).toEqual(['thickenAmount']);
    expect(summary.choices).toMatchObject([{ value: side, options: [{ value: 'normal' }, { value: 'reverse' }, { value: 'both' }] }]);
    const edited = setSolidField(setSolidChoice(feature, 'thickenSide', 'reverse'), 'thickenAmount', expressionValueFromNumber(4));
    expect(edited).toMatchObject({ side: 'reverse', thickness: { value: 4 } });
    expect(setSolidChoice(feature, 'thickenSide', 'unknown')).toBe(feature);
    expect(consumedIds(result.document, [{ featureId: feature.id, code: 'kernelFailed', text: plainText('failed') }]).has(surface.id)).toBe(false);
  });

  it('preserves a signed offset expression, its editable distance and the original body', () => {
    const result = commitSolidInput(part, [surface.id], input('offsetBody', '-2*3'), [body]);
    if (!result.ok) throw new Error(result.reasonKey);
    const feature = findSolid(result.document, result.featureId);
    if (feature?.kind !== 'surface') throw new Error('Missing offset surface');
    expect(feature.operation.kind === 'offsetBody'
      ? [feature.operation.targetFeatureId, feature.operation.distance.source, feature.operation.distance.value] : null)
      .toEqual([surface.id, '-2*3', -6]);
    expect(liveBodyIds(result.document)).toEqual([surface.id, feature.id]);
    const summary = summarizeSolid(result.document, feature);
    expect(summary.fields.map(field => field.key)).toEqual(['surfaceOffset']);
    expect(summary.references.map(ref => ref.elementId)).toEqual([surface.id]);
    expect(summary.subShapeCounts).toEqual([]);
    expect(setSolidField(feature, 'surfaceOffset', expressionValueFromNumber(4))).toMatchObject({ operation: { kind: 'offsetBody', distance: { value: 4 } } });
    expect(commitSolidInput(part, [surface.id], input('offsetBody', '0'), [body])).toEqual({ ok: false, reasonKey: 'surfaceBody.nonzero' });
    expect(commitSolidInput(part, [surface.id], input('thicken', '1'), [{ ...body, isValid: false }]).ok).toBe(false);
  });
});
