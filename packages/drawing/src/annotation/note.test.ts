import { describe, expect, it } from 'vitest';
import { note, type NoteInput } from './note.js';

const input: NoteInput = {
  text: 'abc', position: [20, 40],
  measureText: (text, sizeMm) => ({ fontId: 'measured-fixture', sizeMm, advanceMm: text.length * 2,
    inkBounds: { left: 0, bottom: -0.5, right: text.length * 2, top: 2.5 } }),
};
describe('注記の実幅・複数行・引出線', () => {
  it('1行を指定位置に置く', () => { expect(note(input)?.texts).toEqual([{ text: 'abc', position: [20, 40], sizeMm: 3.5, anchor: 'start', baseline: 'bottom' }]); });
  it('3行を4.9mm送りで下へ並べる', () => {
    const rows = note({ ...input, text: 'a\nb\nc' })?.texts;
    expect(rows).toHaveLength(3);
    for (const [index, y] of [40, 35.1, 30.2].entries()) expect(rows?.[index].position[1]).toBeCloseTo(y, 10);
  });
  it('CRLFを行末文字として混ぜない', () => { expect(note({ ...input, text: 'a\r\nb\rc' })?.texts.map((text) => text.text)).toEqual(['a', 'b', 'c']); });
  it('空文字には文字も引出線も出さない', () => { expect(note({ ...input, text: '', leader: { target: [0, 0], end: 'arrow' } })).toEqual({ texts: [], lines: [], arrow: null, dot: null, widthMm: 0, heightMm: 0 }); });
  it('文字幅6mmに余白2mmを加えた受け線と斜線を作る', () => {
    const result = note({ ...input, leader: { target: [0, 0], end: 'arrow' } });
    expect(result?.lines).toEqual([{ from: [0, 0], to: [19, 39] }, { from: [19, 39], to: [27, 39] }]);
    expect(result?.arrow).not.toBeNull(); expect(result?.dot).toBeNull();
  });
  it('面を指す場合は共通の矢印長3.5mmに対し直径1/3の黒丸にする', () => {
    const result = note({ ...input, leader: { target: [2, 3], end: 'dot' } });
    expect(result?.dot?.center).toEqual([2, 3]); expect(result?.dot?.radius).toBeCloseTo(3.5 / 6, 10); expect(result?.arrow).toBeNull();
  });
  it('右側の対象には右端から斜線をつなぐ', () => { expect(note({ ...input, leader: { target: [60, 0], end: 'arrow' } })?.lines[0].to).toEqual([27, 39]); });
  it('空行も行送りに残す', () => { expect(note({ ...input, text: 'a\n\nb' })?.texts[2].position[1]).toBeCloseTo(30.2, 10); });
  it('幅の異なる字体を文字数によらず使う', () => {
    const result = note({ ...input, measureText: (_text, sizeMm) => ({ fontId: 'wide', sizeMm, advanceMm: 20, inkBounds: { left: -2, right: 21, top: 4, bottom: -1 } }) });
    expect(result?.widthMm).toBe(23); expect(result?.texts[0].position[0]).toBe(22);
  });
  it('未読込字体は理由を示す上位へnullを返す', () => { expect(note({ ...input, measureText: () => null })).toBeNull(); });
  it.each([0, -1, NaN, Infinity])('高さ%sは断る', (heightMm) => { expect(note({ ...input, heightMm })).toBeNull(); });
  it('先端と折れ点が同じなら退化した矢印を出さない', () => { expect(note({ ...input, leader: { target: [19, 39], end: 'arrow' } })).toBeNull(); });
  it('同じ入力が同じ結果になり入力を変えない', () => { const before = input.text; expect(note(input)).toEqual(note(input)); expect(input.text).toBe(before); });
});
