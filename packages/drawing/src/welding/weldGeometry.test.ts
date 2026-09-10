import { describe, expect, it } from 'vitest';
import type { SemanticTextMetrics } from '../render/types.js';
import { weldGeometry, type WeldDisplaySide } from './weldGeometry.js';
import { weldSymbolGeometry } from './symbolGeometry.js';
import type { WeldKind } from './types.js';

const measure = (text: string, sizeMm: number): SemanticTextMetrics => ({ fontId: 'fixture', sizeMm, advanceMm: text.length * sizeMm * 0.6,
  inkBounds: { left: -0.2, right: text.length * sizeMm * 0.6 - 0.3, bottom: -sizeMm * 0.2, top: sizeMm * 0.8 } });
const fillet: WeldDisplaySide = { kind: 'fillet', side: 'arrow', size: 'a5', length: '100(4)-200', rootGap: '', grooveAngle: '', contour: 'none', finish: '' };
const input = { sides: [fillet], position: [30, 40] as const, target: [10, 10] as const, height: 3.5, allAround: false, fieldWeld: false, tail: '', measure };

describe('溶接記号の紙上幾何とJISの配置', () => {
  it('対象が右側なら基線と尾を左へ伸ばし、左サイズ・右長さの文字を反転しない', () => {
    const result = weldGeometry({ ...input, position: [100, 100], target: [180, 80], tail: 'WPS-01', closedTail: true });
    expect(result).not.toBeNull(); if (result === null) return;
    expect(result.baseline.to[0]).toBeLessThan(result.baseline.from[0]);
    const size = result.texts.find((text) => text.text === 'a5'), length = result.texts.find((text) => text.text === '100(4)-200');
    expect(size?.position[0]).toBeLessThan(length?.position[0] ?? 0);
    expect(result.texts.every((text) => text.position[0] + measure(text.text, text.sizeMm).inkBounds.right < 100)).toBe(true);
    expect(result.curves.at(-1)).toEqual({ kind: 'segment', from: [100, 100], to: [180, 80] });
  });
  it.each<WeldKind>(['fillet', 'squareButt', 'vButt', 'bevelButt', 'uButt', 'jButt', 'spot', 'seam'])('%sを字体に依存しないベクトルで上下反転する', (kind) => {
    const above = weldSymbolGeometry(kind, 'opposite', 3.5, [0, 0]), below = weldSymbolGeometry(kind, 'arrow', 3.5, [0, 0]);
    expect(above).not.toBeNull(); expect(below).not.toBeNull();
    for (const curve of above ?? []) if (curve.kind === 'segment') { expect(curve.from[1]).toBeGreaterThanOrEqual(0); expect(curve.to[1]).toBeGreaterThanOrEqual(0); }
    for (const curve of below ?? []) if (curve.kind === 'segment') { expect(curve.from[1]).toBeLessThanOrEqual(0); expect(curve.to[1]).toBeLessThanOrEqual(0); }
    expect(above).not.toEqual(below);
  });
  it('基線の下の矢側に脚長と断続寸法を配置し、文字輪郭と基線は交差しない', () => {
    const result = weldGeometry(input); expect(result).not.toBeNull(); if (result === null) return;
    expect(result.texts.map((text) => text.text)).toEqual(['a5', '100(4)-200']);
    for (const text of result.texts) expect(text.position[1] + measure(text.text, text.sizeMm).inkBounds.top).toBeLessThan(result.baseline.from[1]);
    const [size, length] = result.texts; expect(size.position[0] + measure(size.text, size.sizeMm).inkBounds.right).toBeLessThan(length.position[0]);
    const moved = weldGeometry({ ...input, position: [130, 140], target: [110, 110] });
    expect((moved?.baseline.to[0] ?? 0) - (moved?.baseline.from[0] ?? 0)).toBeCloseTo(result.baseline.to[0] - result.baseline.from[0], 10);
  });
  it('上下のV形と独立した寸法を保持し、広いルート間隔の文字も記号内に収める', () => {
    const result = weldGeometry({ ...input, sides: [{ ...fillet, kind: 'vButt', size: '4(6)', rootGap: '12', grooveAngle: '60°', length: '' },
      { ...fillet, kind: 'vButt', side: 'opposite', size: '3(4)', length: '' }] });
    expect(result).not.toBeNull(); expect(result?.texts.map((text) => text.text)).toEqual(['4(6)', '12', '60°', '3(4)']);
    expect(result?.texts.find((text) => text.text === '3(4)')?.position[1]).toBeGreaterThan(40);
    expect(result?.texts.find((text) => text.text === '12')?.position[1]).toBeLessThan(40);
  });
  it('現場旗は上・右、全周円は基線と矢の交点、折れ矢は対象に触れる', () => {
    const result = weldGeometry({ ...input, sides: [{ ...fillet, length: '' }], allAround: true, fieldWeld: true, arrowBendOffset: [-10, -5], tail: 'SMAW' });
    expect(result?.curves).toContainEqual({ kind: 'arc', center: [30, 40], radius: 3.5 * 0.55, startAngle: 0, endAngle: Math.PI * 2 });
    expect(result?.curves).toContainEqual({ kind: 'segment', from: [20, 35], to: [10, 10] });
    expect(result?.fills[0].subpaths[0].commands[0]).toEqual({ kind: 'M', to: [10, 10] });
    const flag = result?.curves.find((curve) => curve.kind === 'polyline');
    expect(flag?.kind === 'polyline' && flag.points.every(([x, y]) => x >= 30 && y > 40)).toBe(true);
  });
  it('閉じた尾と長い補足文、表面形状と仕上げPを輪郭範囲内に保つ', () => {
    const result = weldGeometry({ ...input, sides: [{ ...fillet, contour: 'flush', finish: 'P' }], tail: `WPS-01\n${'SMAW / '.repeat(30)}`, closedTail: true });
    expect(result).not.toBeNull(); if (result === null) return;
    expect(result.texts.some((text) => text.text === 'P')).toBe(true); expect(result.texts.length).toBeGreaterThan(5);
    for (const text of result.texts) {
      const ink = measure(text.text, text.sizeMm).inkBounds;
      expect(text.position[0] + ink.left).toBeGreaterThanOrEqual(result.bounds.left - 1e-10);
      expect(text.position[0] + ink.right).toBeLessThanOrEqual(result.bounds.right + 1e-10);
      expect(text.position[1] + ink.top).toBeLessThanOrEqual(result.bounds.top + 1e-10);
      expect(text.position[1] + ink.bottom).toBeGreaterThanOrEqual(result.bounds.bottom - 1e-10);
    }
  });
  it('基線中央のスポットとシームは中心が基線上で、シームは横棒を2本持つ', () => {
    const spot = weldSymbolGeometry('spot', 'center', 3.5, [30, 40]), seam = weldSymbolGeometry('seam', 'center', 3.5, [30, 40]);
    expect(spot?.[0]).toMatchObject({ kind: 'arc', center: [30, 40] }); expect(seam).toHaveLength(3);
    expect(weldSymbolGeometry('fillet', 'center', 3.5, [30, 40])).toBeNull();
    const result = weldGeometry({ ...input, sides: [{ ...fillet, kind: 'spot', side: 'center', size: '6', length: '(3)-30' }] });
    expect(result).not.toBeNull();
    for (const text of result?.texts ?? []) expect(text.position[1] + measure(text.text, text.sizeMm).inkBounds.top).toBeLessThan(40);
  });
  it('欠字・同位置の矢・空の閉じた尾を出力可能な記号にしない', () => {
    expect(weldGeometry({ ...input, measure: () => null })).toBeNull();
    expect(weldGeometry({ ...input, target: input.position })).toBeNull();
    expect(weldGeometry({ ...input, closedTail: true })).toBeNull();
  });
});
