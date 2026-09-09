import { existsSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFontStore, DRAWING_FONT_ASSET } from '@pointercad/drawing';
import { evaluateExpression, expressionValueFromNumber as num } from '@pointercad/expression';
import { textFeature, type TextFeatureInput, type TextFeatureResult } from './textFeature.js';
import { WORK_PLANES } from './planeMath.js';
import type { CoordinateInput } from './types.js';

const root = new URL('../../../../', import.meta.url);
if (!existsSync(new URL('pnpm-workspace.yaml', root))) throw new Error('文字検査の起点が違います。');
const font = createFontStore({ read: () => Promise.resolve(Uint8Array.from(readFileSync(
  new URL(`apps/web/public/fonts/${DRAWING_FONT_ASSET.fileName}`, root))).buffer) });
const input: TextFeatureInput = { idPrefix: 'text-1', name: '文字1', text: '8', height: num(10), angleDegrees: 0,
  align: 'start', origin: [num(0), num(0), num(0)], plane: WORK_PLANES.xy, outlineText: font.outline };
const successful = (result: TextFeatureResult): Extract<TextFeatureResult, { ok: true }> => {
  if (!result.ok) throw new Error(result.reason);
  return result;
};
const coordinates = (result: TextFeatureResult): readonly CoordinateInput[] => successful(result).features.flatMap((feature) =>
  feature.kind === 'line' ? [feature.from, feature.to] : [...feature.points]);
const point = (coordinate: CoordinateInput): readonly number[] => {
  if (coordinate.mode !== 'absolute') throw new Error('Expected world coordinates');
  return [coordinate.x.value, coordinate.y.value, coordinate.z.value];
};
describe('実字体から作図面の線分・制御点スプラインを作る', () => {
  beforeAll(async () => { expect(await font.load()).toBe('ready'); });
  it('8を外周1つと穴2つの3輪へ写す', () => {
    const result = successful(textFeature(input)); expect(result.contours).toHaveLength(3);
    expect(result.contours.filter((contour) => contour.signedArea > 0)).toHaveLength(1);
    expect(result.contours.filter((contour) => contour.signedArea < 0)).toHaveLength(2);
  });
  it('1は1輪になる', () => { expect(successful(textFeature({ ...input, text: '1' })).contours).toHaveLength(1); });
  it('直線を線分、曲線を4制御点の3次スプラインにする', () => {
    const result = successful(textFeature(input));
    expect(result.features.some((feature) => feature.kind === 'line')).toBe(true);
    const curves = result.features.filter((feature) => feature.kind === 'spline');
    expect(curves.length).toBeGreaterThan(0);
    for (const curve of curves) { expect(curve.points).toHaveLength(4); expect(curve.mode).toBe('control'); expect(curve.closed).toBe(false); }
  });
  it('高さを倍にすると全座標が倍になる', () => {
    const first = coordinates(textFeature(input)), second = coordinates(textFeature({ ...input, height: num(20) }));
    expect(second).toHaveLength(first.length);
    first.forEach((coordinate, index) => point(coordinate).forEach((value, axis) => expect(point(second[index])[axis]).toBeCloseTo(value * 2, 10)));
  });
  it('90度回転でxが-y、yがxになる', () => {
    const first = coordinates(textFeature(input)), second = coordinates(textFeature({ ...input, angleDegrees: 90 }));
    first.forEach((coordinate, index) => {
      expect(point(second[index])[0]).toBeCloseTo(-point(coordinate)[1], 10);
      expect(point(second[index])[1]).toBeCloseTo(point(coordinate)[0], 10);
    });
  });
  it('YZ平面ではx=0に置く', () => {
    const first = coordinates(textFeature(input)), second = coordinates(textFeature({ ...input, plane: WORK_PLANES.yz }));
    first.forEach((coordinate, index) => {
      expect(point(second[index])[0]).toBe(0); expect(point(second[index])[1]).toBeCloseTo(point(coordinate)[0], 10);
      expect(point(second[index])[2]).toBeCloseTo(point(coordinate)[1], 10);
    });
  });
  it('高さのパラメータが変更後も式として再評価される', () => {
    const points = coordinates(textFeature({ ...input, height: { source: '文字高さ', value: 10, display: '10' } }));
    for (const coordinate of points) {
      if (coordinate.mode !== 'absolute') throw new Error('Expected world coordinates');
      for (const expression of [coordinate.x, coordinate.y, coordinate.z]) {
        const result = evaluateExpression(expression.source, { variables: new Map([['文字高さ', 20]]) });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value.value).toBeCloseTo(expression.value * 2, 10);
      }
    }
  });
  it('原点の式を高さの式と独立に保つ', () => {
    const result = coordinates(textFeature({ ...input, origin: [{ source: '原点X', value: 30, display: '30' }, num(0), num(0)] }));
    expect(result.every((coordinate) => coordinate.mode === 'absolute' && coordinate.x.source.includes('原点X'))).toBe(true);
  });
  it('中心揃えを字体の送り幅で求める', () => {
    const first = coordinates(textFeature(input)), second = coordinates(textFeature({ ...input, align: 'middle' }));
    const advance = font.outline('8', 10).metrics?.advanceMm;
    expect(advance).toBeDefined();
    first.forEach((coordinate, index) => expect(point(second[index])[0]).toBeCloseTo(point(coordinate)[0] - (advance ?? 0) / 2, 10));
  });
  it('空白だけなら何も作らない', () => { expect(textFeature({ ...input, text: ' ' })).toEqual({ ok: true, features: [], contours: [] }); });
  it('字体が無ければ理由を返す', () => { expect(textFeature({ ...input, outlineText: () => ({ status: 'failed', subpaths: [], fillRule: 'nonzero', metrics: null, missingCharacters: [] }) })).toEqual({ ok: false, reason: 'fontUnavailable' }); });
  it.each([0, -10, Infinity, NaN])('高さ%sを断る', (value) => { expect(textFeature({ ...input, height: { source: 'h', value, display: String(value) } })).toEqual({ ok: false, reason: 'invalidInput' }); });
  it('有限の高さでも変換後の面積が無限になる場合は一部の輪郭を返さない', () => {
    expect(textFeature({ ...input, height: { source: '1e200', value: 1e200, display: '1e200' } }))
      .toEqual({ ok: false, reason: 'invalidInput' });
  });
  it('縮退した作図面を断る', () => { expect(textFeature({ ...input, plane: { ...WORK_PLANES.xy, axisV: [1, 0, 0] } })).toEqual({ ok: false, reason: 'invalidInput' }); });
  it('作図面外の原点を断り、平面を勝手に変えない', () => {
    expect(textFeature({ ...input, origin: [num(0), num(0), num(1)] })).toEqual({ ok: false, reason: 'invalidInput' });
  });
  it('平行移動した作図面ではその面上に輪郭を作る', () => {
    const result = textFeature({ ...input, plane: { ...WORK_PLANES.xy, id: 'offset', origin: [0, 0, 15] },
      origin: [num(10), num(20), num(15)] });
    expect(coordinates(result).every((coordinate) => point(coordinate)[2] === 15)).toBe(true);
  });
  it('同じ入力と接頭辞から同じIDと座標が得られる', () => { expect(textFeature(input)).toEqual(textFeature(input)); });
});
