import { describe, expect, it } from 'vitest';
import { balloon, type BalloonInput } from './balloon.js';

const input = (): BalloonInput => ({ itemNumber: 7, bomNumbers: new Set([7, 12]), position: [20, 0], target: [0, 0], targetKind: 'edge' });
describe('部品表と一致する風船（P8-55）', () => {
  it('高さ3.5の文字を直径8.75の丸に入れる', () => {
    const result = balloon(input());
    expect(result?.circle.radius).toBe(4.375);
    expect(result?.circle.endAngle).toBe(2 * Math.PI);
    expect(result?.text).toMatchObject({ text: '7', position: [20, 0], sizeMm: 3.5, anchor: 'middle' });
  });
  it('3桁の番号は実字体の墨の対角線を丸の内側へ収める', () => {
    const result = balloon({ ...input(), itemNumber: 123, bomNumbers: new Set([123]), measureText: (_, sizeMm) => ({
      fontId: 'wide', sizeMm, advanceMm: sizeMm * 3, inkBounds: { left: -0.2, right: sizeMm * 3 - 0.2, bottom: -0.1, top: sizeMm - 0.1 },
    }) });
    if (result === null) throw new Error('風船なし');
    expect(result.circle.radius).toBe(4.375);
    expect(result.text.sizeMm).toBeLessThan(3.5);
    expect(Math.hypot(result.text.sizeMm * 3, result.text.sizeMm)).toBeCloseTo(7.75, 10);
  });
  it('字体の実測に失敗した番号を仮の幅で描かない', () => {
    expect(balloon({ ...input(), measureText: () => null })).toBeNull();
  });
  it('引出線を丸の中心まで貫通させない', () => { expect(balloon(input())?.lines).toEqual([{ from: [0, 0], to: [15.625, 0] }]); });
  it('面は黒丸で指す', () => { const result = balloon({ ...input(), targetKind: 'face' }); expect(result?.dot?.center).toEqual([0, 0]); expect(result?.arrow).toBeNull(); });
  it('輪郭は矢印で指す', () => { const result = balloon(input()); expect(result?.arrow).not.toBeNull(); expect(result?.dot).toBeNull(); });
  it('表に無い番号を拒否する', () => { expect(balloon({ ...input(), itemNumber: 8 })).toBeNull(); });
  it('同じ番号を別の位置へ複数置ける', () => {
    expect(balloon(input())?.text.text).toBe('7');
    expect(balloon({ ...input(), position: [30, 40] })?.text.text).toBe('7');
  });
  it('先端から外へ押し出し丸どうしを0.5mm以上離す', () => {
    const result = balloon({ ...input(), occupied: [{ center: [20, 0], radius: 4.375 }] });
    expect(result?.circle.center).toEqual([29.25, 0]);
  });
  it('連続する禁止区間をまとめて飛び越す', () => {
    const result = balloon({ ...input(), occupied: [{ center: [20, 0], radius: 4.375 }, { center: [30, 0], radius: 4.375 }] });
    expect(result?.circle.center).toEqual([39.25, 0]);
  });
  it('離れた丸まで不要に移動しない', () => {
    expect(balloon({ ...input(), occupied: [{ center: [60, 0], radius: 4.375 }] })?.circle.center).toEqual([20, 0]);
  });
  it('先端を丸の中に隠さない', () => { expect(balloon({ ...input(), target: [20, 0] })).toBeNull(); });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('不正な文字高さ%sを拒否する', (heightMm) => { expect(balloon({ ...input(), heightMm })).toBeNull(); });
  it('障害物の順序で結果が変わらず元の位置も変更しない', () => {
    const source = input();
    const occupied = [{ center: [20, 0] as const, radius: 4.375 }, { center: [30, 0] as const, radius: 4.375 }];
    expect(balloon({ ...source, occupied })).toEqual(balloon({ ...source, occupied: [...occupied].reverse() }));
    expect(source.position).toEqual([20, 0]);
  });
});
