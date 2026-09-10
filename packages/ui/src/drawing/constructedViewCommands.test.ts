import { beforeEach, describe, expect, it } from 'vitest';
import type { DimensionTarget, DrawingView, DrawingViewConstruction } from '@pointercad/drawing';
import { createDrawingDocument } from '@pointercad/model';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitConstructedDrawingView, startConstructedDrawingView } from './constructedViewCommands.js';
import { initialConstructedViewFields, parseConstructedViewDraft, type ConstructedViewChoices } from './constructedViewDraft.js';

beforeEach(resetTestStore);
const expression = (value: number) => ({ source: String(value), value, display: String(value) });
const front: DrawingView = { id: 'front', name: '正面', kind: 'front', position: [100, 100], direction: [0, 0, 1], xDir: [1, 0, 0],
  scale: null, showHidden: true, showCenterLines: true, layerId: 'layer-1' };
const detail: DrawingViewConstruction = { kind: 'detail', sourceViewId: 'front', center: [0, 0], radius: expression(10), scale: expression(2), label: 'A' };
const draft = { name: '拡大図', position: [200, 120] as const, scale: null, construction: detail, showHidden: true, showCenterLines: true };
function setup() {
  const document = { ...createDrawingDocument('図面', { sourceRef: 'source', sourceKind: 'part', fileName: 'box.pcad', path: '', contentHash: 'hash', importedAt: '' }), views: [front] };
  useAppStore.getState().openDrawing(document);
  useAppStore.setState({ drawingSourceResolution: { bodyIds: ['box'], center: [5, 0, 0], dimensionInstances: [] } });
  return document;
}
const choices: ConstructedViewChoices = { kind: 'detail', sourceViewId: 'front', planeKind: 'workPlane', workPlane: 'xy', mode: 'full',
  keepSide: 'positive', reversed: false, regionKind: 'circle', axis: 'u' };

describe('派生図の作成と再編集', () => {
  it('作成条件を一度のUndo/Redoで戻し、元部品の状態を保つ', () => {
    const saved = setup(), part = useAppStore.getState().document;
    expect(commitConstructedDrawingView(saved, draft)).toBe(true);
    const after = useAppStore.getState().drawing;
    expect(after?.views[1]).toMatchObject({ kind: 'detail', construction: detail });
    expect(useAppStore.getState().document).toBe(part);
    useAppStore.getState().undoDrawing(); expect(useAppStore.getState().drawing).toBe(saved);
    useAppStore.getState().redoDrawing(); expect(useAppStore.getState().drawing).toBe(after);
  });
  it('現在選択した図だけを編集し、閉じた後の古い確定では変更しない', () => {
    const saved = setup(); commitConstructedDrawingView(saved, draft);
    const after = useAppStore.getState().drawing;
    if (after == null) throw new Error('drawing missing');
    const view = after.views[1];
    expect(commitConstructedDrawingView(after, { ...draft, name: '新しい名前' }, view)).toBe(true);
    useAppStore.getState().undoDrawing();
    useAppStore.getState().selectDrawingIds([]);
    expect(commitConstructedDrawingView(after, draft, view)).toBe(false);
    expect(useAppStore.getState().drawing).toBe(after);
  });
  it.each([0, -2, NaN, Infinity])('不正縮尺%sで文書とUndoを変更しない', (scale) => {
    const saved = setup(); expect(commitConstructedDrawingView(saved, { ...draft, scale })).toBe(false);
    expect(useAppStore.getState().drawing).toBe(saved); expect(useAppStore.getState().canUndo).toBe(false);
  });
  it('欠落した元図・循環参照・解けない式では変更しない', () => {
    const saved = setup();
    for (const construction of [{ ...detail, sourceViewId: 'gone' }, { ...detail, sourceViewId: 'view-1' },
      { ...detail, radius: { ...expression(10), source: 'missing' } }]) {
      expect(commitConstructedDrawingView(saved, { ...draft, construction })).toBe(false);
      expect(useAppStore.getState().drawing).toBe(saved);
    }
  });
  it('再計算中と別文書からの確定を拒否する', () => {
    const saved = setup(); useAppStore.setState({ drawingBusy: true });
    expect(commitConstructedDrawingView(saved, draft)).toBe(false);
    useAppStore.setState({ drawingBusy: false });
    useAppStore.getState().openDrawing({ ...saved, name: '別の図面' });
    expect(commitConstructedDrawingView(saved, draft)).toBe(false);
  });
  it('元図と事前に選択した3点を作成フォームへ渡し、文書を変えない', () => {
    const saved = setup();
    const targets: readonly DimensionTarget[] = [0, 1, 2].map((x) => ({ kind: 'point', viewId: 'front', paperPoint: [100, 100], modelPoint: [x, 0, 0] }));
    useAppStore.getState().setDrawingTargets(targets);
    expect(startConstructedDrawingView('section')).toBe(true);
    expect(useAppStore.getState().drawingEditor).toEqual({ kind: 'view', constructionKind: 'section', sourceViewId: 'front', targets });
    expect(useAppStore.getState().drawing).toBe(saved); expect(useAppStore.getState().canUndo).toBe(false);
  });
  it('空の図面から作成を頼むと理由を示す', () => {
    const saved = setup(); useAppStore.setState({ drawing: { ...saved, views: [] } });
    expect(startConstructedDrawingView('detail')).toBe(false); expect(useAppStore.getState().drawingMessage).not.toBeNull();
  });
});

describe('派生図の入力欄と式', () => {
  it('位置と半径と縮尺の式を評価し、半径と縮尺の元の式も保存する', () => {
    const saved = setup(), fields = { ...initialConstructedViewFields(undefined, '詳細'), x: '100+20', y: '80+10', radius: '20/2', scale: '8/4' };
    expect(parseConstructedViewDraft(saved, fields, choices, [])).toMatchObject({ position: [120, 90], scale: null,
      construction: { radius: { source: '20/2', value: 10 }, scale: { source: '8/4', value: 2 } } });
  });
  it.each(['x', 'y', 'radius', 'scale'] as const)('必須の%sを空にしても0として扱わない', (key) => {
    const fields = { ...initialConstructedViewFields(undefined, '詳細'), scale: '2', [key]: '' };
    expect(parseConstructedViewDraft(setup(), fields, choices, [])).toBeNull();
  });
  it('既存の面・3点参照は再編集時の選択が空でも保持する', () => {
    const saved = setup(); const target: DimensionTarget = { kind: 'point', viewId: 'front', paperPoint: [0, 0], modelPoint: [0, 0, 0] };
    const construction: DrawingViewConstruction = { kind: 'section', mode: 'full', label: 'A', reversed: false, keepSide: 'positive',
      plane: { kind: 'threePoints', points: [target, target, target] } };
    const fields = initialConstructedViewFields({ ...front, construction }, '断面');
    expect(parseConstructedViewDraft(saved, fields, { ...choices, kind: 'section', planeKind: 'threePoints' }, [], construction)?.construction).toEqual(construction);
    // 幾何学的な同一点の拒否はcommitで共通のPlaneSpec検証へ渡す。
    expect(commitConstructedDrawingView(saved, { ...draft, construction })).toBe(false);
  });
  it('段付き境界の横位置と深さを行ごとに評価し、壊れた行は拒否する', () => {
    const saved = setup(); const fields = { ...initialConstructedViewFields(undefined, '段付き'), boundary: '-10,0\n0,0\n0,10/2\n10,5' };
    const sectionChoices = { ...choices, kind: 'section', mode: 'stepped' } as const;
    expect(parseConstructedViewDraft(saved, fields, sectionChoices, [])?.construction).toMatchObject({ boundary: [[-10, 0], [0, 0], [0, 5], [10, 5]] });
    expect(parseConstructedViewDraft(saved, { ...fields, boundary: '1,2,3' }, sectionChoices, [])).toBeNull();
  });
});
