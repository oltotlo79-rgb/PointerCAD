import { describe, expect, it } from 'vitest';
import { expressionValueFromNumber as num } from '@pointercad/expression';
import { machiningSymbols } from './machiningSymbols.js';
import type { ChamferFeature, HoleFeature, SubShapeRef, ThreadHoleFeature, ThreadShaftFeature } from '../part/types.js';

const face: SubShapeRef = { bodyFeatureId: 'box', index: 0, fingerprint: {
  kind: 'face', surfaceKind: 'plane', area: 100, position: [0, 0, 0], axis: [0, 0, 1], radius: null,
} };
const base = { id: 'machining', name: '加工', suppressed: false, targetFeatureId: 'box' };
function hole(patch: Partial<HoleFeature> = {}): HoleFeature {
  return { ...base, kind: 'hole', face, centers: [{ sketchId: 'sketch', pointFeatureId: 'point' }],
    diameter: num(8), depth: { kind: 'through' }, tiltAngle: num(0), tiltAzimuth: num(0), ...patch };
}
function thread(patch: Partial<ThreadHoleFeature> = {}): ThreadHoleFeature {
  return { ...base, kind: 'threadHole', face, centers: [{ sketchId: 'sketch', pointFeatureId: 'point' }],
    designation: 'M8', series: 'coarse', pitch: num(1.25), drillDiameter: num(6.647),
    depth: { kind: 'through' }, threadLength: num(10), representation: 'simplified',
    tiltAngle: num(0), tiltAzimuth: num(0), ...patch };
}
function chamfer(size: ChamferFeature['size']): ChamferFeature {
  return { ...base, kind: 'chamfer', targets: [], size, swapReferenceFace: false };
}
const plainText = (feature: Parameters<typeof machiningSymbols>[0]) => machiningSymbols(feature)?.tokens
  .map((token) => token.kind === 'text' ? token.text : `[${token.symbol}]`).join('');

describe('加工フィーチャーの現在値から作る注記(P8-33)', () => {
  it('M8の並目はM8×1.25', () => expect(plainText(thread())).toBe('M8×1.25'));
  it('M8の細目はM8×1', () => expect(plainText(thread({ series: 'fine', pitch: num(1) }))).toBe('M8×1'));
  it('M6の並目はM6×1', () => expect(plainText(thread({ designation: 'M6', pitch: num(1) }))).toBe('M6×1'));
  it('外ねじのnominal欄から同じ呼びを作る', () => {
    const shaft: ThreadShaftFeature = { ...base, kind: 'threadShaft', face, nominal: 'M8', series: 'coarse',
      pitch: num(1.25), length: num(10), fromEnd: 'first', modeled: false };
    expect(plainText(shaft)).toBe('M8×1.25');
    expect(plainText({ ...shaft, modeled: true, fromEnd: 'last' })).toBe('M8×1.25');
  });
  it('式で変えたピッチを既定の規格値へ戻さない', () => {
    expect(plainText(thread({ pitch: { ...num(0.8), source: 'pitch / 2' } }))).toBe('M8×0.8');
  });
  it('表にない呼びを断る', () => expect(machiningSymbols(thread({ designation: 'M9' }))).toBeNull());
  it('45°で2mmの面取りはC2', () => {
    expect(plainText(chamfer({ kind: 'distanceAngle', distance: num(2), angle: num(45) }))).toBe('C2');
  });
  it('30°の面取りは距離と角度を明記する', () => {
    expect(plainText(chamfer({ kind: 'distanceAngle', distance: num(2), angle: num(30) }))).toBe('2×30°');
  });
  it('等距離でも面の角度が未解決ならCを使わない', () => {
    const feature = chamfer({ kind: 'equal', distance: num(2) });
    expect(plainText(feature)).toBe('2×2');
    expect(machiningSymbols(feature, { chamferAngleDegrees: 45 })?.tokens).toEqual([{ kind: 'text', text: 'C2' }]);
  });
  it('二距離が異なる場合にはCで片方の距離を隠さない', () => {
    const feature = chamfer({ kind: 'twoDistances', distance1: num(2), distance2: num(3) });
    expect(machiningSymbols(feature, { chamferAngleDegrees: 45 })?.tokens).toEqual([{ kind: 'text', text: '2×3' }]);
  });
  it('普通の貫通穴はφ8', () => expect(plainText(hole())).toBe('φ8'));
  it('止まり穴は深さ記号と10', () => {
    expect(plainText(hole({ depth: { kind: 'blind', depth: num(10) } }))).toBe('φ8[depth]10');
  });
  it('ざぐりは径と深さを別の記号で示す', () => {
    expect(plainText(hole({ entry: { kind: 'counterbore', diameter: num(14), depth: num(5) } })))
      .toBe('φ8[counterbore]φ14[depth]5');
  });
  it('90°の皿もみはφ16', () => {
    expect(plainText(hole({ entry: { kind: 'countersink', diameter: num(16), angle: num(90) } })))
      .toBe('φ8[countersink]φ16');
  });
  it('90°以外の皿もみは角度を省略しない', () => {
    expect(plainText(hole({ entry: { kind: 'countersink', diameter: num(16), angle: num(60) } })))
      .toBe('φ8[countersink]φ16×60°');
  });
  it('止まりねじ穴と入口加工を同時に注記する', () => {
    expect(plainText(thread({ depth: { kind: 'blind', depth: num(15) },
      entry: { kind: 'counterbore', diameter: num(14), depth: num(5) } })))
      .toBe('M8×1.25[depth]15[counterbore]φ14[depth]5');
  });
  it('抑制中の加工には注記を出さない', () => expect(machiningSymbols(hole({ suppressed: true }))).toBeNull());
  it('非有限値を0や記号だけの注記にしない', () => {
    expect(machiningSymbols(hole({ diameter: { source: 'bad', value: NaN, display: 'bad' } }))).toBeNull();
    expect(machiningSymbols(thread({ pitch: { source: 'bad', value: Infinity, display: 'bad' } }))).toBeNull();
  });
  it('穴より小さい入口径と負の深さを断る', () => {
    expect(machiningSymbols(hole({ entry: { kind: 'counterbore', diameter: num(4), depth: num(5) } }))).toBeNull();
    expect(machiningSymbols(hole({ depth: { kind: 'blind', depth: num(-1) } }))).toBeNull();
  });
  it('不正な面取り角度と皿もみ角度を断る', () => {
    expect(machiningSymbols(chamfer({ kind: 'distanceAngle', distance: num(2), angle: num(90) }))).toBeNull();
    expect(machiningSymbols(hole({ entry: { kind: 'countersink', diameter: num(16), angle: num(180) } }))).toBeNull();
  });
  it('元の式とフィーチャーを変更せず同じ注記を返す', () => {
    const feature = thread(); const before = JSON.stringify(feature);
    expect(machiningSymbols(feature)).toEqual(machiningSymbols(feature));
    expect(machiningSymbols(feature)?.featureId).toBe('machining');
    expect(JSON.stringify(feature)).toBe(before);
  });
});
