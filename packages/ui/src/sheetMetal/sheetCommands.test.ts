import { absoluteCoordinate, createEmptyPartDocument, replaceSketch, createSheetBaseFeature, createSheetFlangeFeature, createSheetBendFeature, createSheetReliefFeature, resolvePart, sheetBoundaryEdges } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';
import { summarizeSolid, setSolidField, setSolidToggle, setSolidChoice } from '../solid/solidSummary.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { buildSheetCreation } from './sheetCommands.js';
import { sheetFieldUnitError } from './sheetFieldError.js';
import { preserveSheetEditValues, sheetInputDocument } from './sheetEditInputs.js';

function fixture() {
  const empty = createEmptyPartDocument(), sketch = empty.sketches[0];
  const document = replaceSketch(empty, { ...sketch, features: [
    { kind: 'rectangle', id: 'rect', name: '長方形', planeId: 'xy', construction: false, corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(50, 30, 0) },
    { kind: 'face', id: 'face', name: '基板輪郭', planeId: 'xy', boundary: [{ featureId: 'rect' }], color: '#ffffff' },
  ] });
  return { document, base: createSheetBaseFeature(document, { sketchId: sketch.id, faceFeatureId: 'face' }) };
}
beforeEach(() => { resetTestStore(); });

describe('板金の作成と再編集の入力契約', () => {
  it('再編集で履歴を増やさず、既存の式をinchで再解釈せず、曲げ条件を継承へ戻せる', () => {
    const { document, base } = fixture(), first = buildSheetCreation(document, base, { sheetThickness: '1+1' }, 'mm', {});
    if (!first.ok) throw new Error(first.message);
    const panel = resolvePart(first.document).sheetMetalBodies?.get(base.id)?.panels[0]; if (panel === undefined) throw new Error('基板が必要です');
    const edges = sheetBoundaryEdges(panel); if (!edges.ok) throw new Error(edges.message);
    const flange = createSheetFlangeFeature(first.document, base.id, [{ panelId: panel.id, boundaryId: edges.value[0].id }]);
    const second = buildSheetCreation(first.document, flange, {}, 'mm', {}); if (!second.ok) throw new Error(second.message);
    const draft = preserveSheetEditValues({ ...base, id: 'new-draft', reversed: true }, first.feature);
    const edit = buildSheetCreation(second.document, draft, {}, 'inch', {}, first.feature); if (!edit.ok) throw new Error(edit.message);
    expect(edit.document.solids.map((feature) => feature.id)).toEqual(second.document.solids.map((feature) => feature.id));
    expect(edit.document.solids[0]).toMatchObject({ reversed: true, rule: { thickness: { value: 2, source: '1+1' } } });
    expect(edit.document.solids[1]).toBe(second.document.solids[1]);
    expect(sheetInputDocument(second.document, flange).solids).toEqual([first.feature]);
    expect(buildSheetCreation(second.document, draft, {}, 'mm', {}, { ...first.feature }).ok).toBe(false);
    const override = { ...flange, rule: { innerRadius: { source: '4', value: 4, display: '4' }, kFactor: { source: '0.3', value: 0.3, display: '0.3' } } };
    expect(preserveSheetEditValues(flange, override)).toMatchObject({ rule: { innerRadius: null, kFactor: null } });
  });
  it('元板金の継ぎ目を初期入力へ渡し、再編集では変更した継ぎ目を保持する', () => {
    const { document } = fixture(), boundary = { panelId: 'panel', boundaryId: 'edge' };
    const saved = { ...document, sheetUnfolds: [{ sourceFeatureId: 'target', fixedPanelId: 'panel', seamConnectionIds: ['cut-1'] }] };
    const feature = createSheetReliefFeature(saved, 'target', boundary);
    expect(feature.seamConnectionIds).toEqual(['cut-1']);
    expect(createSheetReliefFeature(saved, 'another', boundary).seamConnectionIds).toEqual([]);
    const edited = preserveSheetEditValues({ ...feature, id: 'new-draft', seamConnectionIds: ['cut-2'] }, feature);
    expect(edited).toMatchObject({ id: feature.id, seamConnectionIds: ['cut-2'], depth: feature.depth });
    expect(preserveSheetEditValues({ ...feature, seamConnectionIds: [] }, feature)).toMatchObject({ seamConnectionIds: [] });
  });
  it('リリーフの単位と式を保持し、形状・寸法の再編集とUndo/Redoを通す', () => {
    const { document, base } = fixture(), first = buildSheetCreation(document, base, {}, 'mm', {});
    if (!first.ok) throw new Error(first.message);
    const body = resolvePart(first.document).sheetMetalBodies?.get(base.id); if (body === undefined) throw new Error('基板が必要です');
    const edges = sheetBoundaryEdges(body.panels[0]); if (!edges.ok) throw new Error(edges.message);
    const relief = createSheetReliefFeature(first.document, base.id, { panelId: body.panels[0].id, boundaryId: edges.value[0].id }, body.rule);
    const result = buildSheetCreation(first.document, relief, { sheetReliefPosition: '1', sheetReliefWidth: '0.1', sheetReliefDepth: '2*3mm' }, 'inch', {});
    if (!result.ok) throw new Error(result.message);
    expect(result.feature).toMatchObject({ position: { value: 25.4 }, width: { value: 2.54 }, depth: { source: '2*3mm', value: 6 } });
    expect(summarizeSolid(result.document, result.feature).choices[0]).toMatchObject({ key: 'sheetReliefShape', value: 'rectangle' });
    expect(setSolidChoice(result.feature, 'sheetReliefShape', 'slot')).toMatchObject({ shape: 'slot' });
    expect(setSolidChoice(result.feature, 'sheetReliefShape', 'invalid')).toBe(result.feature);
    expect(setSolidField(result.feature, 'sheetReliefDepth', { source: '8', value: 8, display: '8' })).toMatchObject({ depth: { value: 8 } });
    for (const sources of [{ sheetReliefWidth: '0' }, { sheetReliefDepth: '-1' }, { sheetReliefPosition: '-1' }])
      expect(buildSheetCreation(first.document, relief, sources, 'mm', {}).ok).toBe(false);
    useAppStore.getState().applyDocument(first.document, { undoable: false }); useAppStore.getState().applyDocument(result.document);
    useAppStore.getState().undo(); expect(useAppStore.getState().document).toBe(first.document);
    useAppStore.getState().redo(); expect(useAppStore.getState().document).toBe(result.document);
  });
  it('指定線曲げの式と固定側を再編集でき、確定全体をUndo1回で戻す', () => {
    const { document, base } = fixture(), sketch = document.sketches[0];
    const withLine = replaceSketch(document, { ...sketch, features: [...sketch.features,
      { kind: 'line', id: 'axis', name: '曲げ線', planeId: 'xy', construction: true, from: absoluteCoordinate(0, 15, 0), to: absoluteCoordinate(50, 15, 0) }] });
    const first = buildSheetCreation(withLine, base, {}, 'mm', {}); if (!first.ok) throw new Error(first.message);
    const panelId = resolvePart(first.document).sheetMetalBodies?.get(base.id)?.panels[0].id;
    if (panelId === undefined) throw new Error('基板パネルが必要です');
    const bend = createSheetBendFeature(first.document, base.id, panelId, { sketchId: sketch.id, lineFeatureId: 'axis' });
    const result = buildSheetCreation(first.document, bend, { sheetAngle: '45*2' }, 'inch', {}); if (!result.ok) throw new Error(result.message);
    expect(result.feature).toMatchObject({ angle: { source: '45*2', value: 90 } });
    expect(summarizeSolid(result.document, result.feature).choices[0]).toMatchObject({ key: 'sheetFixedSide', value: 'right' });
    expect(setSolidChoice(result.feature, 'sheetFixedSide', 'left')).toMatchObject({ fixedSide: 'left' });
    expect(setSolidChoice(result.feature, 'sheetFixedSide', 'invalid')).toBe(result.feature);
    expect(setSolidField(result.feature, 'sheetAngle', { source: '-45', display: '-45', value: -45 })).toMatchObject({ angle: { value: -45 } });
    useAppStore.getState().applyDocument(first.document, { undoable: false });
    useAppStore.getState().applyDocument(result.document);
    useAppStore.getState().undo(); expect(useAppStore.getState().document).toBe(first.document);
    useAppStore.getState().redo(); expect(useAppStore.getState().document).toBe(result.document);
    expect(buildSheetCreation(first.document, bend, { sheetAngle: '90mm' }, 'mm', {}).ok).toBe(false);
  });
  it('inch入力の板厚と無次元Kを区別し、式のまま履歴へ渡す', () => {
    const { document, base } = fixture();
    const result = buildSheetCreation(document, base, { sheetThickness: '0.1', sheetRadius: '3mm', sheetKFactor: '0.4' }, 'inch', {});
    expect(result.ok).toBe(true); if (!result.ok || result.feature.kind !== 'sheetBase') throw new Error('基板が必要です');
    expect(result.feature.rule.thickness.value).toBeCloseTo(2.54, 12);
    expect(result.feature.rule.thickness.source).toContain('in'); expect(result.feature.rule.kFactor.source).toBe('0.4');
    expect(document.solids).toEqual([]);
    const fields = summarizeSolid(result.document, result.feature).fields;
    expect(fields.map((item) => item.unit)).toEqual(['mm', 'mm', 'ratio']);
    const changed = setSolidField(result.feature, 'sheetThickness', { source: '3', display: '3', value: 3 });
    expect(changed).toMatchObject({ rule: { thickness: { value: 3 } } });
    expect(setSolidToggle(changed, 'reversed', true)).toMatchObject({ reversed: true });
  });
  it('不正な厚み・K・単位を断り、元文書を変更しない', () => {
    const { document, base } = fixture();
    for (const sources of [{ sheetThickness: '0' }, { sheetKFactor: '0.6' }, { sheetKFactor: '0.4mm' }, { sheetRadius: '1/0' }])
      expect(buildSheetCreation(document, base, sources, 'mm', {}).ok).toBe(false);
    expect(document.solids).toEqual([]);
    expect(sheetFieldUnitError('sheetKFactor', '0.4mm')?.message).toContain('長さの単位');
    expect(sheetFieldUnitError('sheetAngle', '90in')).not.toBeNull();
    expect(sheetFieldUnitError('sheetRadius', '3mm')).toBeNull();
    expect(sheetFieldUnitError('sheetKFactor', '0.4')).toBeNull();
  });
  it('基板→フランジの確定をそれぞれUndo1回で戻し、無効な幅は積まない', () => {
    const { document, base } = fixture();
    useAppStore.getState().applyDocument(document, { undoable: false });
    const first = buildSheetCreation(document, base, {}, 'mm', {}); if (!first.ok) throw new Error(first.message);
    useAppStore.getState().applyDocument(first.document);
    const panel = resolvePart(first.document).sheetMetalBodies?.get(base.id)?.panels[0]; if (panel === undefined) throw new Error('パネルが必要です');
    const edges = sheetBoundaryEdges(panel); if (!edges.ok) throw new Error(edges.message);
    const flange = createSheetFlangeFeature(first.document, base.id, [{ panelId: panel.id, boundaryId: edges.value[0].id }]);
    expect(buildSheetCreation(first.document, flange, { sheetStartOffset: '100' }, 'mm', {}).ok).toBe(false);
    const second = buildSheetCreation(first.document, flange, {}, 'mm', {}); if (!second.ok) throw new Error(second.message);
    useAppStore.getState().applyDocument(second.document);
    useAppStore.getState().undo(); expect(useAppStore.getState().document.solids.map((item) => item.kind)).toEqual(['sheetBase']);
    useAppStore.getState().undo(); expect(useAppStore.getState().document.solids).toEqual([]);
    useAppStore.getState().redo(); useAppStore.getState().redo();
    expect(useAppStore.getState().document.solids.map((item) => item.kind)).toEqual(['sheetBase', 'sheetFlange']);
  });
  it('作成入力を文書切替や道具切替へ持ち越さず、同じ道具の新規入力も識別する', () => {
    const state = useAppStore.getState(); state.openSheetMetalTool('sheetBase');
    const first = useAppStore.getState().sheetMetalTool; expect(first).not.toBeNull();
    useAppStore.getState().openSheetMetalTool('sheetBase');
    expect(useAppStore.getState().sheetMetalTool?.id).not.toBe(first?.id);
    useAppStore.getState().setActiveTool('line'); expect(useAppStore.getState().sheetMetalTool).toBeNull();
    useAppStore.getState().openSheetMetalTool('sheetFlange');
    const next = createEmptyPartDocument(); useAppStore.getState().applyDocument(next, { replacesDocument: true });
    expect(useAppStore.getState().sheetMetalTool).toBeNull();
  });
});
