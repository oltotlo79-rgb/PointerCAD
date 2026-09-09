import { describe, expect, it } from 'vitest';
import { arrangeDimensions, dragDimensionPlacement, type DimensionArrangementItem, type DimensionTextBox } from './placement.js';

const item = (h: number, id = String(h), patch: Partial<DimensionArrangementItem> = {}): DimensionArrangementItem => ({
  id, viewId: 'front', normal: [0, 1], referenceNormalCoordinate: 0,
  placement: { commonNormalCoordinate: h, textPosition: null }, ...patch,
});
const heights = (items: readonly DimensionArrangementItem[], boxes: readonly DimensionTextBox[] = []) =>
  arrangeDimensions(items, boxes)?.placements.map((placement) => placement.commonNormalCoordinate);

describe('実測した文字の囲みで寸法を整列する(P8-27)', () => {
  it.each([[5, 6, 7], [5, 30, 60]])('%jを8mm間隔にそろえる', (...values) => {
    expect(heights(values.map((value) => item(value)))).toEqual([5, 13, 21]);
  });
  it('入力順が違っても対応する寸法へ配置を戻す', () => {
    expect(heights([item(60), item(5), item(30)])).toEqual([21, 5, 13]);
  });
  it('負の側は外へ向かって間隔を広げる', () => {
    expect(heights([item(-5), item(-6), item(-7)])).toEqual([-5, -13, -21]);
  });
  it('違う向き・別の図・対象の反対側は別々に整列する', () => {
    expect(heights([item(5), item(6, 'b', { normal: [1, 0] }), item(7, 'c', { viewId: 'right' }), item(-8)])).toEqual([5, 6, 7, -8]);
  });
  it('逆向きの法線も同じ物理的な側へそろえる', () => {
    expect(heights([item(5), item(-6, 'b', { normal: [0, -1] })])).toEqual([5, -13]);
  });
  it('測定文字の囲みが重なる外側だけを8mm動かす', () => {
    const boxes = [{ ownerId: '5', bounds: { left: 0, right: 4, bottom: 0, top: 10 } },
      { ownerId: '6', bounds: { left: 0, right: 4, bottom: 1, top: 11 } }];
    expect(heights([item(5), item(6)], boxes)).toEqual([5, 21]);
  });
  it('接しているだけの矩形は重なりとしない', () => {
    const boxes = [{ ownerId: '5', bounds: { left: 0, right: 4, bottom: 0, top: 8 } },
      { ownerId: '6', bounds: { left: 0, right: 4, bottom: 1, top: 9 } }];
    expect(heights([item(5), item(6)], boxes)).toEqual([5, 13]);
  });
  it('10回動かしても重なれば印を返し、無限に動かさない', () => {
    const result = arrangeDimensions([item(5)], [
      { ownerId: 'locked', bounds: { left: -1000, right: 1000, bottom: -1000, top: 1000 } },
      { ownerId: '5', bounds: { left: 0, right: 4, bottom: 0, top: 4 } },
    ]);
    expect(result?.placements[0].commonNormalCoordinate).toBe(85);
    expect(result?.unresolvedOverlapIds).toEqual(['5']);
  });
  it('文字を手動配置していたら法線方向へ同じ量だけ動かす', () => {
    const result = arrangeDimensions([item(5), item(6, 'b', { placement: { commonNormalCoordinate: 6, textPosition: [20, 10] } })]);
    expect(result?.placements[1].textPosition).toEqual([20, 17]);
  });
  it('ドラッグはhと沿線方向の文字位置の両方へ反映する', () => {
    expect(dragDimensionPlacement(item(5).placement, [0, 1], [20, 10], [3, 4])).toEqual({ commonNormalCoordinate: 9, textPosition: [23, 14] });
  });
  it('法線の長さに依存せず、紙上のmmを保つ', () => {
    expect(dragDimensionPlacement(item(5).placement, [0, 2], [20, 10], [3, 4])?.commonNormalCoordinate).toBe(9);
  });
  it('元の配列を変えず、繰り返しの結果が一致する', () => {
    const values = Object.freeze([Object.freeze(item(5)), Object.freeze(item(6))]);
    expect(arrangeDimensions(values)).toEqual(arrangeDimensions(values));
    expect(values[1].placement.commonNormalCoordinate).toBe(6);
  });
  it('不正な方向・間隔・ID・囲みを断り、空配列は受け入れる', () => {
    expect(arrangeDimensions([])).toEqual({ placements: [], unresolvedOverlapIds: [] });
    expect(arrangeDimensions([item(5, 'a', { normal: [0, 0] })])).toBeNull();
    expect(arrangeDimensions([item(5)], [], 0)).toBeNull();
    expect(arrangeDimensions([item(5, 'a'), item(6, 'a')])).toBeNull();
    expect(arrangeDimensions([item(5)], [{ ownerId: '5', bounds: { left: 1, right: 0, bottom: 0, top: 1 } }])).toBeNull();
    expect(dragDimensionPlacement(item(5).placement, [0, 0], [0, 0], [1, 1])).toBeNull();
  });
});
