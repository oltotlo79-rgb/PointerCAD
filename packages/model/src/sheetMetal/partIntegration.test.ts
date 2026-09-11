import { exactExpressionValueFromNumber as n } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument, replaceSketch, appendSolid } from '../part/createPartDocument.js';
import { resolvePart } from '../part/resolvePart.js';
import { collectExpressionSources, reevaluatePartDocument, renameVariableInPartDocument } from '../part/reevaluatePart.js';
import { canMoveHistoryItem } from '../part/timelineOrder.js';
import { absoluteCoordinate } from '../sketch/createSketchDocument.js';
import { DEFAULT_WORK_PLANE_ID } from '../sketch/planeMath.js';
import { createSheetBaseFeature, createSheetFlangeFeature, createSheetBendFeature, createSheetReliefFeature } from './createSheetFeature.js';
import { sheetBoundaryEdges } from './panelGeometry.js';
import { setSheetUnfoldDefinition } from './sheetUnfoldDefinition.js';
import { affectsShape } from '../part/documentChange.js';

function fixture() {
  const empty = createEmptyPartDocument(), sketch = empty.sketches[0];
  let document = replaceSketch(empty, { ...sketch, features: [
    { kind: 'rectangle', id: 'rect', name: '輪郭', planeId: DEFAULT_WORK_PLANE_ID, construction: false, corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(50, 30, 0) },
    { kind: 'face', id: 'face', name: '面', planeId: DEFAULT_WORK_PLANE_ID, boundary: [{ featureId: 'rect' }], color: '#ffffff' },
  ] });
  const base = createSheetBaseFeature(document, { sketchId: sketch.id, faceFeatureId: 'face' },
    { thickness: { ...n(2), source: '板厚' }, innerRadius: n(3), kFactor: { ...n(0.4), source: '係数' } });
  document = appendSolid(document, base);
  const resolved = resolvePart(document), panel = resolved.sheetMetalBodies?.get(base.id)?.panels[0];
  if (panel === undefined) throw new Error('実スケッチから基板を解決できません');
  const edges = sheetBoundaryEdges(panel); if (!edges.ok) throw new Error(edges.message);
  const top = edges.value.find((edge) => edge.from[1] === 30 && edge.to[1] === 30); if (top === undefined) throw new Error('上縁が必要です');
  const flange = createSheetFlangeFeature(document, base.id, [{ panelId: panel.id, boundaryId: top.id }]);
  return { document: appendSolid(document, flange), base, flange };
}

describe('P10 板金の部品履歴への接続', () => {
  it('リリーフの式・改名・依存を保持し、抑制や入口消失では元の板金を残す', () => {
    const initial = fixture(), body = resolvePart(initial.document).sheetMetalBodies?.get(initial.flange.id);
    if (body === undefined) throw new Error('フランジ付き基板が必要です');
    const edges = sheetBoundaryEdges(body.panels[0]); if (!edges.ok) throw new Error(edges.message);
    const right = edges.value.find((edge) => edge.from[0] === 50 && edge.to[0] === 50);
    if (right === undefined) throw new Error('基板の右縁が必要です');
    const relief = { ...createSheetReliefFeature(initial.document, initial.flange.id, { panelId: body.panels[0].id, boundaryId: right.id }, body.rule),
      position: n(30), width: { ...n(4), source: '逃げ幅' }, depth: n(5), shape: 'slot' as const };
    const document = appendSolid(initial.document, relief), result = resolvePart(document);
    expect(result.errors).toEqual([]); expect(result.liveBodyIds).toEqual([relief.id]);
    expect(result.steps.map((step) => step.plan.kind)).toEqual(['sheetBase', 'sheetFlange', 'sheetBody']);
    expect(collectExpressionSources(document)).toContain('逃げ幅');
    const changed = reevaluatePartDocument(document, new Map([['板厚', 2], ['係数', 0.4], ['逃げ幅', 6]]));
    expect(changed.failures).toEqual([]); expect(resolvePart(changed.document).steps[2].key).not.toBe(result.steps[2].key);
    expect(collectExpressionSources(renameVariableInPartDocument(document, '逃げ幅', '切欠幅'))).toContain('切欠幅');
    expect(canMoveHistoryItem(document, relief.id, 0).ok).toBe(false);
    const missing = resolvePart({ ...document, solids: [...initial.document.solids, { ...relief, boundary: { ...relief.boundary, boundaryId: 'missing' } }] });
    expect(missing.errors).toHaveLength(1); expect(missing.liveBodyIds).toEqual([initial.flange.id]);
    expect(resolvePart({ ...document, solids: [...initial.document.solids, { ...relief, suppressed: true }] }).liveBodyIds).toEqual([initial.flange.id]);
    const relieved = result.sheetMetalBodies?.get(relief.id); if (relieved === undefined) throw new Error('切欠き付き板金が必要です');
    expect(setSheetUnfoldDefinition(document, relieved, { sourceFeatureId: relief.id, fixedPanelId: relieved.panels[1].id, seamConnectionIds: [] }).ok).toBe(true);
  });
  it('固定面の変更は文書へ保存するが折曲げを再計算せず、同じ定義では文書を作り直さない', () => {
    const { document, flange } = fixture(), resolved = resolvePart(document);
    const sheet = resolved.sheetMetalBodies?.get(flange.id); if (sheet === undefined) throw new Error('板金が必要です');
    const definition = { sourceFeatureId: flange.id, fixedPanelId: sheet.panels[1].id, seamConnectionIds: [] };
    const changed = setSheetUnfoldDefinition(document, sheet, definition); if (!changed.ok) throw new Error(changed.message);
    expect(changed.value.sheetUnfolds).toEqual([definition]); expect(document.sheetUnfolds).toEqual([]);
    expect(affectsShape(document, changed.value)).toBe(false);
    const repeated = setSheetUnfoldDefinition(changed.value, sheet, definition);
    expect(repeated.ok && repeated.value === changed.value).toBe(true);
    expect(setSheetUnfoldDefinition(document, sheet, { ...definition, fixedPanelId: 'missing' }).ok).toBe(false);
    expect(setSheetUnfoldDefinition(document, sheet, { ...definition, seamConnectionIds: [sheet.bends[0].id] }).ok).toBe(false);
    expect(setSheetUnfoldDefinition(document, sheet, { ...definition, sourceFeatureId: 'missing' }).ok).toBe(false);
  });
  it('実スケッチから基板とフランジを解決し、最新の板金だけを表示する', () => {
    const { document, base, flange } = fixture(), resolved = resolvePart(document);
    expect(resolved.errors).toEqual([]); expect(resolved.steps.map((step) => step.plan.kind)).toEqual(['sheetBase', 'sheetFlange']);
    expect(resolved.liveBodyIds).toEqual([flange.id]); expect(resolved.steps[0].visible).toBe(false);
    expect(resolved.sheetMetalBodies?.get(flange.id)?.panels).toHaveLength(2);
    expect(resolved.sheetMetalBodies?.get(base.id)?.panels).toHaveLength(1);
  });
  it('上流の式・改名が曲げまで追従し、Kだけの変更では折曲げ鍵を再生成しない', () => {
    const { document, flange } = fixture(), first = resolvePart(document);
    expect(collectExpressionSources(document)).toContain('板厚'); expect(collectExpressionSources(document)).toContain('係数');
    const thickness = reevaluatePartDocument(document, new Map([['板厚', 4], ['係数', 0.4]]));
    expect(thickness.failures).toEqual([]);
    expect(resolvePart(thickness.document).steps[1].key).not.toBe(first.steps[1].key);
    const k = reevaluatePartDocument(document, new Map([['板厚', 2], ['係数', 0.3]]));
    const after = resolvePart(k.document);
    expect(after.steps.map((step) => step.key)).toEqual(first.steps.map((step) => step.key));
    expect(after.sheetMetalBodies?.get(flange.id)?.bends[0].allowance).toBeCloseTo(1.8 * Math.PI, 10);
    const renamed = renameVariableInPartDocument(document, '板厚', '材料厚');
    expect(collectExpressionSources(renamed)).toContain('材料厚'); expect(collectExpressionSources(renamed)).not.toContain('板厚');
  });
  it('失敗した曲げは基板を消費せず、抑制と依存を壊す並替えも既存履歴へ従う', () => {
    const { document, base, flange } = fixture();
    const invalid = resolvePart({ ...document, solids: [base, { ...flange, startOffset: n(50) }] });
    expect(invalid.errors).toHaveLength(1); expect(invalid.liveBodyIds).toEqual([base.id]);
    expect(invalid.sheetMetalBodies?.has(flange.id)).toBe(false);
    const suppressed = resolvePart({ ...document, solids: [base, { ...flange, suppressed: true }] });
    expect(suppressed.errors).toEqual([]); expect(suppressed.liveBodyIds).toEqual([base.id]);
    const move = canMoveHistoryItem(document, flange.id, 0);
    expect(move.ok).toBe(false);
    if (move.ok) throw new Error('フランジを基板より前へ移動できてはいけません');
    expect(move.blockingFeatureId).toBe(flange.id);
    expect(move.reason).toContain(base.name);
    expect(move.reason).toContain('より後ろ');
  });
  it('指定線曲げの履歴・式・線分依存と固定面を保持し、失敗や抑制では元を消費しない', () => {
    const initial = fixture(), sketch = initial.document.sketches[0];
    const withLine = replaceSketch(initial.document, { ...sketch, features: [...sketch.features,
      { kind: 'line', id: 'bend-axis', name: '曲げの線', planeId: DEFAULT_WORK_PLANE_ID, construction: true,
        from: absoluteCoordinate(0, 15, 0), to: absoluteCoordinate(50, 15, 0) }] });
    const panelId = resolvePart(withLine).sheetMetalBodies?.get(initial.flange.id)?.panels[0].id;
    if (panelId === undefined) throw new Error('曲げる基板のパネルが必要です');
    const bend = { ...createSheetBendFeature(withLine, initial.flange.id, panelId, { sketchId: sketch.id, lineFeatureId: 'bend-axis' }),
      angle: { ...n(90), source: '曲げ角' } };
    const document = appendSolid(withLine, bend), resolved = resolvePart(document);
    expect(resolved.errors).toEqual([]); expect(resolved.liveBodyIds).toEqual([bend.id]);
    expect(resolved.steps.map((step) => step.plan.kind)).toEqual(['sheetBase', 'sheetFlange', 'sheetBody']);
    expect(collectExpressionSources(document)).toContain('曲げ角');
    const changed = reevaluatePartDocument(document, new Map([['板厚', 2], ['係数', 0.4], ['曲げ角', -45]]));
    expect(changed.failures).toEqual([]); expect(resolvePart(changed.document).steps[2].key).not.toBe(resolved.steps[2].key);
    const renamed = renameVariableInPartDocument(document, '曲げ角', '折角');
    expect(collectExpressionSources(renamed)).toContain('折角');
    const body = resolved.sheetMetalBodies?.get(bend.id); if (body === undefined) throw new Error('解決した板金が必要です');
    expect(setSheetUnfoldDefinition(document, body, { sourceFeatureId: bend.id, fixedPanelId: body.panels[1].id, seamConnectionIds: [] }).ok).toBe(true);
    const missing = resolvePart({ ...document, solids: [...withLine.solids, { ...bend, line: { ...bend.line, lineFeatureId: 'missing' } }] });
    expect(missing.errors).toHaveLength(1); expect(missing.liveBodyIds).toEqual([initial.flange.id]);
    expect(resolvePart({ ...document, solids: [...withLine.solids, { ...bend, suppressed: true }] }).liveBodyIds).toEqual([initial.flange.id]);
    expect(canMoveHistoryItem(document, bend.id, 0).ok).toBe(false);
  });
});
