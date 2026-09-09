import { describe, expect, it } from 'vitest';
import { outlineInkBounds, textOutline, type GlyphPathCommand } from './textOutline.js';

const square: readonly GlyphPathCommand[] = [
  { type: 'M', x: 0, y: 0 }, { type: 'L', x: 4, y: 0 },
  { type: 'L', x: 4, y: 4 }, { type: 'L', x: 0, y: 4 },
];
describe('字体に依存しない文字の輪郭(P8-44)', () => {
  it('2次の係数を比較して得た制御点(2,2),(4,2)へ持ち上げる', () => {
    const geometry = textOutline([{ type: 'M', x: 0, y: 0 }, { type: 'Q', x1: 3, y1: 3, x: 6, y: 0 }], false);
    expect(geometry?.subpaths[0].commands[1]).toEqual({ kind: 'C', control1: [2, 2], control2: [4, 2], to: [6, 0] });
    expect(geometry?.inkBounds).toEqual({ left: 0, bottom: 0, right: 6, top: 1.5 });
  });
  it('複数のQは直前の終点を始点にする', () => {
    const geometry = textOutline([{ type: 'M', x: 0, y: 0 }, { type: 'Q', x1: 3, y1: 3, x: 6, y: 0 },
      { type: 'Q', x1: 9, y1: -3, x: 12, y: 0 }], false);
    expect(geometry?.subpaths[0].commands[2]).toEqual({ kind: 'C', control1: [8, -2], control2: [10, -2], to: [12, 0] });
  });
  it('3次曲線は制御点を保ち、字体のYを用紙のYへ反転する', () => {
    const geometry = textOutline([{ type: 'M', x: 0, y: 0 }, { type: 'C', x1: 1, y1: 3, x2: 2, y2: 3, x: 3, y: 0 }]);
    expect(geometry?.subpaths[0].commands[1]).toEqual({ kind: 'C', control1: [1, -3], control2: [2, -3], to: [3, -0] });
    expect(geometry?.inkBounds.bottom).toBe(-2.25);
  });
  it('制御点の囲みではなく曲線上の極値で墨の範囲を測る', () => {
    const geometry = textOutline([{ type: 'M', x: 0, y: 0 }, { type: 'C', x1: 0, y1: 4, x2: 4, y2: 4, x: 4, y: 0 }], false);
    expect(geometry?.inkBounds).toEqual({ left: 0, bottom: 0, right: 4, top: 3 });
  });
  it('CFFがZを省略しても次のMと末尾で輪を閉じる', () => {
    const geometry = textOutline([...square, ...square.map((command) => command.type === 'Z' ? command : { ...command, x: command.x + 10 })]);
    expect(geometry?.subpaths).toHaveLength(2);
    expect(geometry?.subpaths.every(({ commands }) => commands.at(-1)?.kind === 'Z')).toBe(true);
  });
  it('明示Zを重複させず、空のMから面を作らない', () => {
    const geometry = textOutline([...square, { type: 'Z' }, { type: 'M', x: 20, y: 20 }]);
    expect(geometry?.subpaths).toHaveLength(1);
    expect(geometry?.subpaths[0].commands.filter((command) => command.kind === 'Z')).toHaveLength(1);
  });
  it('外周と穴の向きを一緒に反転してnonzeroの複合パスを保つ', () => {
    const geometry = textOutline([...square, { type: 'M', x: 1, y: 1 }, { type: 'L', x: 1, y: 3 },
      { type: 'L', x: 3, y: 3 }, { type: 'L', x: 3, y: 1 }]);
    expect(geometry?.fillRule).toBe('nonzero');
    const areas = geometry?.subpaths.map(({ commands }) => {
      const points = commands.flatMap((command) => command.kind === 'Z' ? [] : [command.to]);
      return points.reduce((sum, [x, y], i) => {
        const next = points[(i + 1) % points.length]; return sum + x * next[1] - y * next[0];
      }, 0) / 2;
    });
    expect(areas).toEqual([-16, 4]);
  });
  it('空白の輪郭は空で、範囲も零になる', () => {
    expect(textOutline([])).toEqual({ subpaths: [], fillRule: 'nonzero', inkBounds: { left: 0, bottom: 0, right: 0, top: 0 } });
  });
  it('Mより前の描画命令を断る', () => {
    expect(textOutline([{ type: 'L', x: 1, y: 1 }])).toBeNull();
  });
  it.each([NaN, Infinity, -Infinity])('非有限の制御点%sを断る', (x1) => {
    expect(textOutline([{ type: 'M', x: 0, y: 0 }, { type: 'Q', x1, y1: 1, x: 2, y: 0 }])).toBeNull();
  });
  it('入力を変更せず、何度変換しても同じ輪郭になる', () => {
    const input = Object.freeze(square.map((command) => Object.freeze({ ...command })));
    expect(textOutline(input)).toEqual(textOutline(input));
    expect(input).toEqual(square);
  });
  it('直線の囲みは端点だけから求める', () => {
    const geometry = textOutline(square);
    expect(geometry?.inkBounds).toEqual({ left: 0, bottom: -4, right: 4, top: -0 });
    expect(outlineInkBounds([])).toEqual({ left: 0, bottom: 0, right: 0, top: 0 });
  });
});
