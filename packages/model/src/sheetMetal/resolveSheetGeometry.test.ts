import { exactExpressionValueFromNumber as n } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import type { ResolvedFace } from '../sketch/types.js';
import { sheetBoundaryEdges } from './panelGeometry.js';
import { availableSheetBoundaryEdges } from './availableBoundaryEdges.js';
import { resolveRectangularFlange, resolveSheetBase } from './resolveSheetGeometry.js';
import { sheetFlatKey, sheetShapeKey } from './shapeKey.js';
import type { SheetBaseFeature, SheetFlangeFeature } from './types.js';

const base: SheetBaseFeature = { id: 'base', name: '基板', suppressed: false, kind: 'sheetBase',
  profile: { sketchId: 'sketch', faceFeatureId: 'outer' }, holes: [], reversed: false,
  rule: { thickness: n(2), innerRadius: n(3), kFactor: n(0.4) } };
function face(width = 50): ResolvedFace {
  return { featureId: 'outer', color: '#FFFFFF', curves: [
    { kind: 'segment', featureId: 'bottom', from: [0, 0, 0], to: [width, 0, 0] },
    { kind: 'segment', featureId: 'right', from: [width, 0, 0], to: [width, 30, 0] },
    { kind: 'segment', featureId: 'top', from: [width, 30, 0], to: [0, 30, 0] },
    { kind: 'segment', featureId: 'left', from: [0, 30, 0], to: [0, 0, 0] },
  ] };
}
function resolvedBase(feature = base, width = 50) {
  const result = resolveSheetBase(feature, () => face(width)); if (!result.ok) throw new Error(result.message); return result.value;
}
function flangeFor(panelId: string, boundaryIds: readonly string[]): SheetFlangeFeature & { readonly profile: null } {
  return { kind: 'sheetFlange', id: 'flange', name: 'フランジ', suppressed: false, targetFeatureId: 'base',
    edges: boundaryIds.map((boundaryId) => ({ panelId, boundaryId })), length: n(20), angle: n(90), startOffset: n(0), endOffset: n(0),
    lengthBasis: 'tangent', rule: { innerRadius: null, kFactor: null }, profile: null };
}
const edgeId = (name: string) => JSON.stringify(['sheet-edge', name, 0]);

describe('P10 保存入力から形状段・隣接パネル・鍵への解決', () => {
  it('基板・穴の輪郭と板厚を保持し、反転は明示した法線に対して適用する', () => {
    const hole = { ...face(5), featureId: 'hole' };
    const feature = { ...base, holes: [{ sketchId: 'sketch', faceFeatureId: 'hole' }], reversed: true };
    const result = resolveSheetBase(feature, (ref) => ref.faceFeatureId === 'hole' ? hole : face());
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.message);
    expect(result.value.plan).toMatchObject({ kind: 'sheetBase', thickness: 2, normal: [0, 0, 1], reversed: true, holes: [hole.curves] });
    expect(result.value.body.panels[0].normal[2]).toBe(-1);
    expect(resolveSheetBase(feature, (ref) => ref.faceFeatureId === 'hole' ? undefined : face()).ok).toBe(false);
  });
  it('反対の2縁を選ぶU板は選択順によらず同じ形状段・安定ID・展開長を作る', () => {
    const source = resolvedBase(), id = source.body.panels[0].id, key = sheetShapeKey(source.plan);
    const first = resolveRectangularFlange(flangeFor(id, [edgeId('top'), edgeId('bottom')]), source.body, key);
    const second = resolveRectangularFlange(flangeFor(id, [edgeId('bottom'), edgeId('top')]), source.body, key);
    expect(first).toEqual(second); expect(first.ok).toBe(true); if (!first.ok) throw new Error(first.message);
    expect(first.value.body.panels).toHaveLength(3); expect(first.value.body.bends).toHaveLength(2);
    expect(first.value.plan.kind).toBe('sheetFlange');
    for (const bend of first.value.body.bends) expect(bend.allowance).toBeCloseTo(5.969026041821, 10);
    expect(source.body.panels).toHaveLength(1); expect(source.body.bends).toEqual([]);
  });
  it('K編集では折曲げの鍵が変わらず、展開の鍵だけが変わる。寸法と上流変更は形状の鍵を変える', () => {
    const source = resolvedBase(), id = source.body.panels[0].id, key = sheetShapeKey(source.plan);
    const feature = flangeFor(id, [edgeId('top')]);
    const first = resolveRectangularFlange(feature, source.body, key);
    const changedK = resolveRectangularFlange({ ...feature, rule: { innerRadius: null, kFactor: n(0.3) } }, source.body, key);
    const changedLength = resolveRectangularFlange({ ...feature, length: n(25) }, source.body, key);
    expect(first.ok && changedK.ok && changedLength.ok).toBe(true);
    if (!first.ok || !changedK.ok || !changedLength.ok) throw new Error('正常な板金を解決できませんでした');
    const firstKey = sheetShapeKey(first.value.plan), changedKey = sheetShapeKey(changedK.value.plan);
    expect(firstKey).toBe(changedKey); expect(firstKey).not.toBe(sheetShapeKey(changedLength.value.plan));
    expect(sheetFlatKey(firstKey, first.value.body, id, [])).not.toBe(sheetFlatKey(changedKey, changedK.value.body, id, []));
    const larger = resolvedBase(base, 60);
    const largerFlange = resolveRectangularFlange(feature, larger.body, sheetShapeKey(larger.plan));
    expect(largerFlange.ok).toBe(true); if (!largerFlange.ok) throw new Error(largerFlange.message);
    expect(sheetShapeKey(largerFlange.value.plan)).not.toBe(firstKey);
  });
  it('外寸からの控除と端の切詰めを段へ反映し、繰返し使用した縁と幅消失を拒否する', () => {
    const source = resolvedBase(), id = source.body.panels[0].id, key = sheetShapeKey(source.plan);
    const feature = { ...flangeFor(id, [edgeId('top')]), lengthBasis: 'outer' as const, startOffset: n(2), endOffset: n(3) };
    const result = resolveRectangularFlange(feature, source.body, key);
    expect(result.ok).toBe(true); if (!result.ok || result.value.plan.kind !== 'sheetFlange') throw new Error('フランジの解決失敗');
    const first = result.value.plan.flanges[0];
    if (first.kind !== 'rectangle') throw new Error('矩形フランジが必要です');
    expect(first.secondLength).toBeCloseTo(15, 10);
    expect(result.value.plan.flanges[0].width).toBe(45);
    expect(resolveRectangularFlange(feature, result.value.body, sheetShapeKey(result.value.plan)).ok).toBe(false);
    expect(resolveRectangularFlange({ ...feature, startOffset: n(50) }, source.body, key).ok).toBe(false);
    const child = result.value.body.panels[1], edges = sheetBoundaryEdges(child);
    expect(edges.ok).toBe(true);
    if (!edges.ok) throw new Error(edges.message);
    const available = availableSheetBoundaryEdges(result.value.body, child.id);
    if (!available.ok) throw new Error(available.message);
    expect(available.value).toHaveLength(3);
    const attached = edges.value.find((edge) => !available.value.some((item) => item.id === edge.id));
    if (attached === undefined) throw new Error('接続済みの子側基準縁が必要です');
    const repeated = resolveRectangularFlange(flangeFor(child.id, [attached.id]), result.value.body, sheetShapeKey(result.value.plan));
    expect(repeated.ok).toBe(false);
    if (repeated.ok) throw new Error('子側の接続縁へ二重に曲げを追加できてはいけません');
    expect(repeated.message).toContain('すでに曲げ');
  });
});
