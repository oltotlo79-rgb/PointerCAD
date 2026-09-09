import { describe, expect, it } from 'vitest';
import { createCenterMarks, hideCenterMark, type CenterMarkSource } from './centerMark.js';

const view = { id: 'front', showCenterLines: true };
const circle: CenterMarkSource = { id: 'circle', kind: 'circle', center: [20, 30], radius: 8 };
describe('元の形状IDで保持する中心線と中心マーク(P8-37)', () => {
  it('半径8の円の十字は2本、長さ22mmで円から3mm出る', () => {
    const marks = createCenterMarks(view, [circle]);
    expect(marks).toHaveLength(1);
    expect(marks?.[0].lines).toEqual([{ from: [9, 30], to: [31, 30] }, { from: [20, 19], to: [20, 41] }]);
  });
  it('細い一点鎖線を共通のJISスタイルから得る', () => {
    expect(createCenterMarks(view, [circle])?.[0].style).toEqual({ widthMm: 0.25, lineType: 'chain' });
  });
  it('同じ中心の円を1つにまとめて大きい円の外へ延ばす', () => {
    const small = { ...circle, id: 'small', radius: 4 };
    expect(createCenterMarks(view, [small, circle])).toEqual(createCenterMarks(view, [circle, small]));
    expect(createCenterMarks(view, [small, circle])?.[0].sourceIds).toHaveLength(2);
    expect(createCenterMarks(view, [small, circle])?.[0].lines[0]).toEqual({ from: [9, 30], to: [31, 30] });
  });
  it('削除したマークは再計算・半径変更・同心輪の代表変更でも復活しない', () => {
    const small = { ...circle, id: 'small', radius: 4 };
    const mark = createCenterMarks(view, [circle, small])?.[0];
    if (mark === undefined) throw new Error('中心マークがない');
    const hidden = hideCenterMark(view, mark);
    expect(createCenterMarks(hidden, [circle, small])).toEqual([]);
    expect(createCenterMarks(hidden, [{ ...small, radius: 20 }])).toEqual([]);
    expect(view).toEqual({ id: 'front', showCenterLines: true });
  });
  it('表示を切ると空になり、入れ直すと戻る', () => {
    expect(createCenterMarks({ ...view, showCenterLines: false }, [circle])).toEqual([]);
    expect(createCenterMarks(view, [circle])).toHaveLength(1);
  });
  it('円筒の側面の中心線を両端へ3mmずつ延ばす', () => {
    const cylinder: CenterMarkSource = { id: 'cylinder', kind: 'cylinderSide', from: [0, 0], to: [30, 40] };
    const line = createCenterMarks(view, [cylinder])?.[0].lines[0];
    expect(line?.from[0]).toBeCloseTo(-1.8, 12);
    expect(line?.from[1]).toBeCloseTo(-2.4, 12);
    expect(line?.to).toEqual([31.8, 42.4]);
  });
  it('別の図の同じ円の削除に影響しない', () => {
    const mark = createCenterMarks(view, [circle])?.[0];
    if (mark === undefined) throw new Error('中心マークがない');
    expect(createCenterMarks({ ...hideCenterMark(view, mark), id: 'right' }, [circle])).toHaveLength(1);
  });
  it('中心が異なる円は別のマークになる', () => {
    expect(createCenterMarks(view, [circle, { ...circle, id: 'other', center: [50, 30] }])).toHaveLength(2);
  });
  it('不正な半径・座標・同じID・縮退した軸を断る', () => {
    expect(createCenterMarks(view, [{ ...circle, radius: 0 }])).toBeNull();
    expect(createCenterMarks(view, [{ ...circle, center: [NaN, 0] }])).toBeNull();
    expect(createCenterMarks(view, [circle, circle])).toBeNull();
    expect(createCenterMarks(view, [{ id: 'axis', kind: 'cylinderSide', from: [0, 0], to: [0, 0] }])).toBeNull();
  });
});
