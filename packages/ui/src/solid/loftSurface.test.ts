import { expressionValueFromNumber } from '@pointercad/expression';
import { absoluteCoordinate, appendFeature, createEmptyPartDocument, FREE_WORK_PLANE_ID, replaceSketch, type SketchSplineFeature } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { createNumericInput, reduceNumericInput } from '../sketch/numericInput.js';
import { commitRuledInput, loftToolReadiness, ruledSectionsOf } from './ruledCommands.js';
import { setSolidToggle, summarizeSolid } from './solidSummary.js';

function context(closed = true, construction = false) {
  const base = createEmptyPartDocument(); let sketch = base.sketches[0];
  for (const z of [0, 20]) {
    const feature: SketchSplineFeature = { id: `spline-${z}`, name: `輪郭${z}`, kind: 'spline',
      planeId: FREE_WORK_PLANE_ID, mode: 'control', closed, construction,
      points: [[0, 0], [10, 0], [10, 10], [0, 10]].map(([x, y]) => absoluteCoordinate(x, y, z)) };
    sketch = appendFeature(sketch, feature);
  }
  return { document: replaceSketch(base, sketch), bodies: [], selection: ['spline-0', 'spline-20'] };
}

describe('P11b ロフトの直接輪郭・作成・再編集', () => {
  it('閉じたスプライン2本を面の作成なしで断面として選べる', () => {
    const source = context();
    expect(loftToolReadiness(source)).toEqual({ ready: true, reasonKey: null });
    expect(ruledSectionsOf(source)).toEqual([0, 20].map((z) => ({ kind: 'sketchCurves',
      ref: { sketchId: source.document.activeSketchId, curveIds: [`spline-${z}`] } })));
  });
  it.each([[false, false], [true, true]])('開いた線/構築線は断面へ混ぜない closed=%s construction=%s', (closed, construction) => {
    expect(loftToolReadiness(context(closed, construction)).ready).toBe(false);
    expect(ruledSectionsOf(context(closed, construction))).toEqual([]);
  });
  it('既定オフから平滑化を指定し、式と断面を保持して再編集できる', () => {
    const source = context(), initial = createNumericInput('loft', 'loftTwist');
    expect(initial.toggles).toEqual([expect.objectContaining({ key: 'loftSmooth', value: false })]);
    const toggled = reduceNumericInput(initial, { type: 'toggle', key: 'loftSmooth' });
    const outcome = commitRuledInput(source, { kind: 'solid', tool: 'loft', step: 'loftTwist',
      values: { ruledTwist: expressionValueFromNumber(0) }, flags: { loftSmooth: toggled.toggles[0].value } });
    expect(outcome.ok).toBe(true); if (!outcome.ok) return;
    const feature = outcome.document.solids[0]; expect(feature.kind).toBe('loft'); if (feature.kind !== 'loft') return;
    expect(feature.smooth).toBe(true); expect(outcome.document.sketches).toEqual(source.document.sketches);
    const summary = summarizeSolid(outcome.document, feature);
    expect(summary.references.map((ref) => ref.name)).toEqual(expect.arrayContaining([expect.stringContaining('輪郭0'), expect.stringContaining('輪郭20')]));
    const edited = setSolidToggle(feature, 'loftSmooth', false);
    expect(edited).toEqual({ ...feature, smooth: false });
  });
  it('罫線面の作成欄にはロフトの平滑化を出さない', () => {
    expect(createNumericInput('ruled', 'ruledTwist').toggles).toEqual([]);
  });
});
