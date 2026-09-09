import { beforeEach, describe, expect, it } from 'vitest';
import { drawingViewBasis } from '@pointercad/drawing';
import { createDefaultNamedViews, createDrawingDocument } from '@pointercad/model';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitDrawingView, drawingDirectionFromCamera } from './viewCommands.js';

beforeEach(resetTestStore);
function setup() {
  const part = useAppStore.getState().document;
  const source = { sourceRef: 'source-1', sourceKind: 'part' as const, fileName: 'part.pcad', path: '', contentHash: '', importedAt: '' };
  const document = createDrawingDocument('図面', source);
  useAppStore.getState().openDrawing(document, { sources: { sources: [{ metadata: source, document: part }] } });
  return document;
}
const draft = () => ({ cameraId: 'namedView-front', name: '正面', position: [100, 150] as const,
  scale: null, showHidden: true, showCenterLines: true });

describe('名前付き視点から図面への投影図の作成', () => {
  it.each([
    ['namedView-front', [1, 0, 0], [0, 0, 1]],
    ['namedView-top', [1, 0, 0], [0, 1, 0]],
    ['namedView-right', [0, 1, 0], [0, 0, 1]],
  ] as const)('%sの紙上の右と上が3D画面と一致する', (id, x, y) => {
    const camera = createDefaultNamedViews().find((entry) => entry.id === id)!;
    const direction = drawingDirectionFromCamera(camera)!;
    const basis = drawingViewBasis({ normal: direction.direction, xDir: direction.xDir })!;
    basis.x.forEach((value, index) => expect(value).toBeCloseTo(x[index], 12));
    basis.y.forEach((value, index) => expect(value).toBeCloseTo(y[index], 12));
  });
  it('任意のカメラのロールを保持し、zoomは実寸投影に影響しない', () => {
    const camera = createDefaultNamedViews()[0];
    const direction = drawingDirectionFromCamera({ ...camera, up: [1, 0, 0], zoom: 20 })!;
    const basis = drawingViewBasis({ normal: direction.direction, xDir: direction.xDir })!;
    basis.y.forEach((value, index) => expect(value).toBeCloseTo([1, 0, 0][index], 12));
    expect(drawingDirectionFromCamera({ ...camera, zoom: 20 })).toEqual(drawingDirectionFromCamera(camera));
  });
  it('投影図追加はUndo1回、Redoで全指定を復帰する', () => {
    const document = setup(); expect(commitDrawingView(draft())).toBe(true);
    const view = useAppStore.getState().drawing?.views[0];
    expect(view).toMatchObject({ name: '正面', position: [100, 150], scale: null, kind: 'front' });
    useAppStore.getState().undoDrawing(); expect(useAppStore.getState().drawing).toBe(document);
    useAppStore.getState().redoDrawing(); expect(useAppStore.getState().drawing?.views[0]).toEqual(view);
  });
  it('既存図の位置・個別縮尺・隠れ線を編集して戻せる', () => {
    setup(); commitDrawingView(draft()); const before = useAppStore.getState().drawing!;
    expect(commitDrawingView({ ...draft(), cameraId: '', position: [120, 140], scale: 0.5, showHidden: false }, before.views[0].id)).toBe(true);
    expect(useAppStore.getState().drawing?.views[0]).toMatchObject({ position: [120, 140], scale: 0.5, showHidden: false });
    useAppStore.getState().undoDrawing(); expect(useAppStore.getState().drawing).toBe(before);
  });
  it.each([NaN, Infinity, 0, -1])('不正縮尺%sは履歴を増やさない', (scale) => {
    const document = setup(); expect(commitDrawingView({ ...draft(), scale })).toBe(false);
    expect(useAppStore.getState().drawing).toBe(document); expect(useAppStore.getState().canUndo).toBe(false);
  });
  it('存在しない視点と紙外の位置を断る', () => {
    setup(); expect(commitDrawingView({ ...draft(), cameraId: 'missing' })).toBe(false);
    expect(commitDrawingView({ ...draft(), position: [-1, 150] })).toBe(false);
  });
  it('変更なしはUndoを増やさず、不正な改名は元の図を保つ', () => {
    setup(); commitDrawingView(draft()); const before = useAppStore.getState().drawing!;
    expect(commitDrawingView(draft(), before.views[0].id)).toBe(true);
    expect(useAppStore.getState().drawing).toBe(before);
    expect(commitDrawingView({ ...draft(), name: '' }, before.views[0].id)).toBe(false);
    expect(useAppStore.getState().drawing).toBe(before);
  });
});
