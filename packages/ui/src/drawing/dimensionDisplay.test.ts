import type { Dimension, DrawingDocument, OutlinedText, Point2 } from '@pointercad/drawing';
import { createDrawingDocument, createEmptyPartDocument, resolveDrawingDimensions, type ResolvedDimensionTarget, type ResolvedDrawingDimension } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { displayDrawingDimension } from './dimensionDisplay.js';
import { drawingNoteFields } from './drawingNoteFields.js';

const document: DrawingDocument = { ...createDrawingDocument('図面', { sourceRef: 's', sourceKind: 'part', fileName: '', path: '', contentHash: '', importedAt: '' }),
  views: [{ id: 'v', name: '正面', kind: 'front', position: [0, 0], scale: 2, direction: [0, 1, 0], xDir: [1, 0, 0],
    showHidden: true, showCenterLines: true, layerId: 'layer-1' }] };
const base: Dimension = { id: 'd', kind: 'length', measurement: 'trueDistance', targets: [{ kind: 'point', viewId: 'v', paperPoint: [0, 0], modelPoint: [0, 0, 0] }],
  placement: { commonNormalCoordinate: 10, textPosition: null }, reference: false, origin: 'manual', layerId: 'layer-4' };
const line: ResolvedDimensionTarget = { kind: 'line', from: [0, 0, 0], to: [30, 40, 0], length: 50, paperFrom: [0, 0], paperTo: [60, 0] };
const circle: ResolvedDimensionTarget = { kind: 'circle', center: [0, 0, 0], axis: [0, 1, 0], radius: 4, length: Math.PI * 8,
  from: [4, 0, 0], to: [4, 0, 0], paperCenter: [0, 0], paperFrom: [8, 0], paperTo: [8, 0] };
const outline = (text: string, sizeMm: number): OutlinedText => ({ status: 'ready', fillRule: 'nonzero', subpaths: [], missingCharacters: [],
  metrics: { fontId: 'test', sizeMm, advanceMm: text.length * sizeMm / 2,
    inkBounds: { left: 0, bottom: -0.2 * sizeMm, right: text.length * sizeMm / 2, top: sizeMm * 0.8 } } });
function resolved(targets: readonly ResolvedDimensionTarget[] = [line], dimension: Partial<Dimension> = {}, value = 50): ResolvedDrawingDimension {
  return { dimension: { ...base, ...dimension }, targets, value, coordinates: null, text: String(value), status: 'resolved', reason: null };
}

describe('寸法の前後の文字への係数の差し込み', () => {
  const part = { ...createEmptyPartDocument(), parameters: [
    { name: 'n', value: { source: '2', value: 2, display: '2' }, unit: 'none' as const, description: '' },
    { name: 't', value: { source: 'n * 3', value: 6, display: '6' }, unit: 'mm' as const, description: '' },
  ] };
  const context = { resolveFields: drawingNoteFields(document, { sources: [{ metadata: document.source, document: part }] }) };

  it('前の文字を差し込んでから文字の囲みを測り、入力した文字を保つ', () => {
    const dimension = resolved([line], { prefix: '{=n}×' });
    const display = displayDrawingDimension(document, dimension, outline, context);
    expect(display.element.texts?.[0].text).toBe('2×50');
    if (display.bounds === null) throw new Error('文字境界なし');
    expect(display.bounds.right - display.bounds.left).toBe(7);
    expect(dimension.dimension.prefix).toBe('{=n}×');
    expect(displayDrawingDimension(document, dimension, outline).element.texts?.[0].text).toBe('{=n}×50');
  });

  it('前後の文字を差し込み、後ろの空白を保って公差の後ろに置く', () => {
    const dimension = resolved([line], { prefix: '{=n}×', suffix: ' {=t} 通し', reference: true,
      tolerance: { kind: 'symmetric', value: 0.1 } });
    const display = displayDrawingDimension(document, dimension, outline, context);
    expect(display.element.texts?.[0].text).toBe('(2×50±0.1 6 通し)');
    expect(dimension.dimension.suffix).toBe(' {=t} 通し');
  });

  it('累進寸法の各目盛りで解けない名前を？にする', () => {
    const paper = { ...document, dimensions: [{ ...base, measurement: 'horizontal' as const, prefix: '{=missing}×', suffix: ' {=t}',
      series: { kind: 'progressive' as const, baseIndex: 0 }, targets: [0, 50].map((x) => ({
        kind: 'point' as const, viewId: 'v', paperPoint: [x * 2, 0] as const, modelPoint: [x, 0, 0] as const,
      })) }] };
    const [dimension] = resolveDrawingDimensions(paper, { modelCenter: [0, 0, 0], instances: [] });
    const display = displayDrawingDimension(paper, dimension, outline, context);
    expect(display.unresolved).toBe(false);
    expect(display.element.texts?.map((text) => text.text)).toEqual(['？×0 6', '？×50 6']);
  });

  it('座標寸法の {{ を { として表示し、座標と参考寸法の括弧を保つ', () => {
    const dimension = { ...resolved([line], { kind: 'coordinate', measurement: 'coordinate', prefix: '{{=n} ', reference: true }),
      value: null, coordinates: [30, 40] as const, text: '({{=n} X: 30 / Y: 40)' };
    const display = displayDrawingDimension(document, dimension, outline, context);
    expect(display.element.texts?.[0].text).toBe('({=n} X: 30 / Y: 40)');
  });
});

describe('寸法の画面とSVGに共通する表示', () => {
  it.each([2.5, 3.5, 5])('基本寸法は文字高%sでも四辺に紙面1mmの余白を取り、実測値とサイズ寸法線を保つ', (textHeight) => {
    const paper = { ...document, sheet: { ...document.sheet, textHeight } };
    const ordinary = displayDrawingDimension(paper, resolved([line], { prefix: '2×', suffix: ' 通し' }), outline);
    const basic = displayDrawingDimension(paper, resolved([line], { basic: true, prefix: '2×', suffix: ' 通し' }), outline);
    expect(basic.element.texts).toEqual(ordinary.element.texts); expect(basic.unresolved).toBe(false);
    expect(basic.sizeDimensionLine).toEqual({ from: [0, 10], to: [60, 10] });
    if (basic.bounds === null || ordinary.bounds === null) throw new Error('文字境界なし');
    expect(ordinary.bounds.left - basic.bounds.left).toBeCloseTo(1, 10);
    expect(basic.bounds.right - ordinary.bounds.right).toBeCloseTo(1, 10);
    expect(ordinary.bounds.bottom - basic.bounds.bottom).toBeCloseTo(1, 10);
    expect(basic.bounds.top - ordinary.bounds.top).toBeCloseTo(1, 10);
    for (const scale of [0.5, 1, 2]) {
      const scaled = displayDrawingDimension({ ...paper, sheet: { ...paper.sheet, scale } },
        resolved([line], { basic: true, prefix: '2×', suffix: ' 通し' }), outline);
      expect(scaled.bounds).toEqual(basic.bounds);
    }
    expect(basic.element.curves?.at(-1)).toMatchObject({ kind: 'polyline', closed: true });
    expect(displayDrawingDimension(document, resolved([line], { basic: true, reference: true }), outline).unresolved).toBe(true);
  });
  it('弧長を半径や紙上長に置き換えず、実測値と寸法円弧を表示する', () => {
    const display = displayDrawingDimension(document, resolved([circle], { kind: 'arcLength', measurement: 'radius' }, Math.PI * 8), outline);
    expect(display.unresolved).toBe(false); expect(display.element.texts?.[0].text).toMatch(/^⌒25\.13/u);
    expect(display.element.curves?.[0]?.kind).toBe('polyline'); expect(display.element.fills).toHaveLength(2);
  });
  it('座標は縮尺によらない符号付きのX/Yを、終点へ引出線で示す', () => {
    const points: readonly ResolvedDimensionTarget[] = [{ kind: 'point', point: [0, 0, 0], paperPoint: [20, 30] },
      { kind: 'point', point: [-30, 0, 40], paperPoint: [-40, 110] }];
    const display = displayDrawingDimension(document, { ...resolved(points, { kind: 'coordinate', measurement: 'coordinate' }),
      value: null, coordinates: [-30, 40], text: 'X: -30 / Y: 40' }, outline);
    expect(display.unresolved).toBe(false); expect(display.element.texts?.[0].text).toBe('X: -30 / Y: 40');
    expect(display.element.curves?.[0]).toMatchObject({ kind: 'segment', from: [-40, 110] }); expect(display.element.fills).toHaveLength(1);
  });
  it('紙上60mmでも元の実距離50を表示する', () => {
    const display = displayDrawingDimension(document, resolved(), outline);
    expect(display.element.texts?.[0].text).toBe('50');
    expect(display.element.curves?.[0]).toEqual({ kind: 'segment', from: [0, 10], to: [60, 10] });
    expect(display.element.fills).toHaveLength(2);
  });
  it('用紙の文字高さを通常寸法と座標寸法へ共通に適用する', () => {
    const custom = { ...document, sheet: { ...document.sheet, textHeight: 5 } };
    expect(displayDrawingDimension(custom, resolved(), outline).element.texts?.[0].sizeMm).toBe(5);
    const dimension = { ...resolved([line], { kind: 'coordinate', measurement: 'coordinate' }), value: null,
      coordinates: [30, 40] as const, text: 'X: 30±0.1 / Y: 40±0.1', displayTolerance: { kind: 'symmetric', value: 0.1 } as const };
    const display = displayDrawingDimension(custom, dimension, outline);
    expect(display.element.texts?.[0]).toMatchObject({ sizeMm: 5, text: 'X: 30±0.1 / Y: 40±0.1' });
    expect(display.unresolved).toBe(false);
  });
  it('倍尺の円に実径8を表示し、紙面の矢印は半径8の位置へ置く', () => {
    const display = displayDrawingDimension(document, resolved([circle], { kind: 'diameter', measurement: 'radius' }, 8), outline);
    expect(display.element.texts?.[0].text).toBe('φ8');
    expect(display.element.curves?.[0]).toEqual({ kind: 'segment', from: [-8, 0], to: [8, 0] });
  });
  it('半径寸法の矢印は1つでR4になる', () => {
    const display = displayDrawingDimension(document, resolved([circle], { kind: 'radius', measurement: 'radius' }, 4), outline);
    expect(display.element.texts?.[0].text).toBe('R4'); expect(display.element.fills).toHaveLength(1);
  });
  it('60度傾いた円は短軸方向の実際の楕円上へ矢印を置く', () => {
    const tilted: ResolvedDimensionTarget = { ...circle, axis: [0, 0.5, Math.sqrt(3) / 2] };
    const display = displayDrawingDimension(document, resolved([tilted], { kind: 'diameter', measurement: 'radius',
      placement: { commonNormalCoordinate: 10, textPosition: [0, 15] } }, 8), outline);
    const curve = display.element.curves?.[0];
    expect(curve?.kind).toBe('segment');
    if (curve?.kind !== 'segment') throw new Error('segment');
    expect(curve.from[1]).toBeCloseTo(-4); expect(curve.to[1]).toBeCloseTo(4);
    expect(display.element.texts?.[0].text).toBe('φ8');
  });
  it('真横から見てつぶれた円へ誤った直径の線を出さない', () => {
    const side: ResolvedDimensionTarget = { ...circle, axis: [0, 0, 1] };
    expect(displayDrawingDimension(document, resolved([side], { kind: 'diameter', measurement: 'radius' }, 8), outline).unresolved).toBe(true);
  });
  it('±0.1を1行に表示する', () => {
    const display = displayDrawingDimension(document, resolved([line], { tolerance: { kind: 'symmetric', value: 0.1 } }), outline);
    expect(display.element.texts?.map((text) => text.text)).toEqual(['50±0.1']);
  });
  it('表示と共通出力で接尾文字を公差の後ろに置き参考寸法全体を括る', () => {
    const display = displayDrawingDimension(document, resolved([line], { prefix: '4×', suffix: ' 通し', reference: true,
      tolerance: { kind: 'symmetric', value: 0.1 } }), outline);
    expect(display.element.texts?.map((text) => text.text)).toEqual(['(4×50±0.1 通し)']);
  });
  it('上下偏差を2段に分けて0.7倍の字体で表示する', () => {
    const display = displayDrawingDimension(document, resolved([line], { tolerance: { kind: 'deviation', upper: 0.2, lower: -0.1 } }), outline);
    const texts = display.element.texts ?? [];
    // 表示の負号は数学用U+2212。式入力のASCIIハイフンと混同しない。
    expect(texts.map((text) => text.text)).toEqual(['50', '+0.2', '−0.1']);
    expect(texts[1].sizeMm).toBeCloseTo(3.5 * 0.7);
    expect(texts[1].position[1]).toBeGreaterThan(texts[2].position[1]);
  });
  it('未解決は元の値を残さず別色の？にする', () => {
    const display = displayDrawingDimension(document, { ...resolved(), status: 'unresolved', value: null, targets: [], reason: 'target' }, outline);
    expect(display.element.style?.color).toBe('#c2410c');
    expect(display.element.texts?.[0].text).toBe('？'); expect(display.element.curves).toEqual([]);
  });
  it('水平寸法の移動軸は用紙の縦方向になる', () => {
    expect(displayDrawingDimension(document, resolved([line], { measurement: 'horizontal' }, 30), outline).normal).toEqual([-0, 1]);
  });
  it('2点の垂直寸法は用紙のXを法線とする', () => {
    const points: readonly ResolvedDimensionTarget[] = [
      { kind: 'point', point: [0, 0, 0], paperPoint: [0, 0] }, { kind: 'point', point: [0, 0, 30], paperPoint: [0, 60] }];
    expect(displayDrawingDimension(document, resolved(points, { measurement: 'vertical' }, 30), outline).normal).toEqual([-1, 0]);
  });
  it('ドラッグ済みの文字位置を共通出力へそのまま渡す', () => {
    const position: Point2 = [25, 35];
    const display = displayDrawingDimension(document, resolved([line], { placement: { commonNormalCoordinate: 34, textPosition: position } }), outline);
    expect(display.textPosition).toEqual(position); expect(display.element.texts?.[0].position).toEqual(position);
  });
  it('直角の2辺は交点から90度の寸法円弧を作る', () => {
    const vertical: ResolvedDimensionTarget = { ...line, to: [0, 0, 40], paperTo: [0, 80], length: 40 };
    const display = displayDrawingDimension(document, resolved([line, vertical], { kind: 'angle', measurement: 'angle' }, 90), outline);
    expect(display.element.texts?.[0].text).toBe('90°');
    expect(display.element.curves?.[0]).toMatchObject({ kind: 'arc', center: [0, 0], startAngle: 0, endAngle: Math.PI / 2 });
  });
});
