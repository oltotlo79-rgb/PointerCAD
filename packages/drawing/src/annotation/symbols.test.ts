import { describe, expect, it } from 'vitest';
import { drawingSymbol, type DrawingSymbolKind } from './symbols.js';

describe('図面の共通記号(P8-32)', () => {
  it('第三角法は同心円2個を4半円、円錐台を4線で表す', () => {
    const geometry = drawingSymbol('thirdAngle')!;
    expect(geometry.lines).toHaveLength(4);
    expect(geometry.arcs).toHaveLength(4);
    expect(geometry.centerLines).toHaveLength(2);
    expect(geometry.arcs.map((arc) => arc.radius)).toEqual([2, 2, 4, 4]);
    for (const arc of geometry.arcs) expect(arc.endAngle - arc.startAngle).toBe(Math.PI);
  });
  it('第三角法は円が左・小径端が左の円錐台が右になる', () => {
    const geometry = drawingSymbol('thirdAngle')!;
    expect(geometry.arcs[0].center).toEqual([-6, 0]);
    expect(geometry.lines[0]).toEqual({ from: [0, -2], to: [0, 2] });
    expect(geometry.lines[2]).toEqual({ from: [10, 4], to: [10, -4] });
  });
  it('第三角法は20×8mmの枠内に収まる', () => {
    const geometry = drawingSymbol('thirdAngle')!;
    const left = Math.min(...geometry.arcs.map((arc) => arc.center[0] - arc.radius));
    const right = Math.max(...geometry.lines.flatMap((line) => [line.from[0], line.to[0]]));
    expect(right - left).toBe(20);
    expect(2 * Math.max(...geometry.arcs.map((arc) => arc.radius))).toBe(8);
  });
  it('深さは上横棒・下向きの幹・両翼を備える', () => {
    expect(drawingSymbol('depth', 2)?.lines).toEqual([
      { from: [0, 2], to: [2, 2] }, { from: [1, 2], to: [1, 0] },
      { from: [0, 1], to: [1, 0] }, { from: [1, 0], to: [2, 1] },
    ]);
  });
  it('ざぐりは上が開いたコの字になる', () => {
    expect(drawingSymbol('counterbore', 1)?.lines).toEqual([
      { from: [0, 1], to: [0, 0] }, { from: [0, 0], to: [1, 0] }, { from: [1, 0], to: [1, 1] },
    ]);
  });
  it('皿もみは直角に開いたVになる', () => {
    expect(drawingSymbol('countersink')?.lines).toHaveLength(2);
    const [left, right] = drawingSymbol('countersink', 1)!.lines;
    expect((left.from[0] - left.to[0]) * (right.to[0] - right.from[0])
      + (left.from[1] - left.to[1]) * (right.to[1] - right.from[1])).toBe(0);
  });
  it('正方形は文字高さを一辺とする閉じた4線', () => {
    const lines = drawingSymbol('square')!.lines;
    expect(lines).toHaveLength(4);
    lines.forEach((line, index) => {
      expect(line.to).toEqual(lines[(index + 1) % 4].from);
      expect(Math.hypot(line.to[0] - line.from[0], line.to[1] - line.from[1])).toBe(3.5);
    });
  });
  it('円弧記号は上向きの半円', () => expect(drawingSymbol('arcLength', 4)?.arcs).toEqual([
    { center: [2, 0], radius: 2, startAngle: 0, endAngle: Math.PI },
  ]));
  it('球のSだけは意味のある文字を返す', () => {
    expect(drawingSymbol('sphere')?.texts[0].text).toBe('S');
    expect(drawingSymbol('sphere')?.lines).toEqual([]);
  });
  it.each(['thirdAngle', 'depth', 'counterbore', 'countersink', 'square', 'arcLength', 'sphere'] as DrawingSymbolKind[])(
    '%sの文字高さを2倍にすると形も文字も2倍になる', (kind) => {
      const small = drawingSymbol(kind, 3.5)!;
      const large = drawingSymbol(kind, 7)!;
      const double = (point: readonly number[]) => point.map((value) => value * 2);
      expect(large.lines).toEqual(small.lines.map((line) => ({ from: double(line.from), to: double(line.to) })));
      expect(large.arcs).toEqual(small.arcs.map((arc) => ({ ...arc, center: double(arc.center), radius: arc.radius * 2 })));
      expect(large.centerLines).toEqual(small.centerLines.map((line) => ({ from: double(line.from), to: double(line.to) })));
      expect(large.texts).toEqual(small.texts.map((text) => ({ ...text, position: double(text.position), sizeMm: text.sizeMm * 2 })));
    },
  );
  it('配置だけを平行移動し円弧角度を変えない', () => {
    const arc = drawingSymbol('arcLength', 4, [10, 20])!.arcs[0];
    expect(arc).toEqual({ center: [12, 20], radius: 2, startAngle: 0, endAngle: Math.PI });
  });
  it('同じ入力は同じ結果で、呼び出し間で配列を共有しない', () => {
    const first = drawingSymbol('depth');
    expect(drawingSymbol('depth')).toEqual(first);
    expect(drawingSymbol('depth')?.lines).not.toBe(first?.lines);
  });
  it.each([0, -1, NaN, Infinity])('不正な高さ%sを断る', (height) => expect(drawingSymbol('depth', height)).toBeNull());
  it('不正な原点を断る', () => expect(drawingSymbol('depth', 3.5, [NaN, 0])).toBeNull());
});
