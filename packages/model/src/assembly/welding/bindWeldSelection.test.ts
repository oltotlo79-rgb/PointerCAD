import { describe, expect, it } from 'vitest';

import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import type { MateSubShapeGeometry } from '../../kernelBridge.js';
import { bindFilletWeldSelection, type FilletWeldPicks, type WeldGeometryResolver } from './bindWeldSelection.js';
import { plainTee, TEE_BODIES, teeRequest, WELD_TEST_REVISIONS } from './filletWeld.testSupport.js';
import { planFilletWeld } from './planFilletWeld.js';

/** 選んだ時の指紋(わざと古い値)。位置・向きの正本にしないことを確かめる。 */
function staleRef(index: number, kind: 'face' | 'edge'): SubShapeRef {
  return { bodyFeatureId: 'extrude-1', index, fingerprint: kind === 'face'
    ? { kind: 'face', surfaceKind: 'plane', area: 1, position: [999, 999, 999], axis: [1, 0, 0], radius: null }
    : { kind: 'edge', curveKind: 'line', length: 1, position: [999, 999, 999], axis: [0, 1, 0], radius: null } };
}

/** いまの形: 立板の側面(index 1)・下の辺(index 2)、底板の上面(index 3)。 */
const CURRENT = new Map<string, MateSubShapeGeometry>([
  ['component-1:1', { kind: 'face', surfaceKind: 'plane', area: 5000, position: [50, 8, 25], axis: [0, 1, 0], radius: null }],
  ['component-1:2', { kind: 'edge', curveKind: 'line', length: 100, position: [50, 8, 0], axis: [1, 0, 0], radius: null }],
  ['component-2:3', { kind: 'face', surfaceKind: 'plane', area: 6000, position: [50, 30, 10], axis: [0, 0, 1], radius: null }],
  ['component-2:4', { kind: 'face', surfaceKind: 'cylinder', area: 10, position: [0, 0, 0], axis: [0, 0, 1], radius: 2 }],
  ['component-1:5', { kind: 'edge', curveKind: 'circle', length: 10, position: [0, 0, 0], axis: [0, 0, 1], radius: 2 }],
  // 向きの求まらない直線の辺・平面(カーネルは求まらなければ axis を null にする)。
  ['component-1:6', { kind: 'edge', curveKind: 'line', length: 100, position: [50, 8, 0], axis: null, radius: null }],
  ['component-2:7', { kind: 'face', surfaceKind: 'plane', area: 6000, position: [50, 30, 10], axis: null, radius: null }],
]);

const resolve: WeldGeometryResolver = (component, reference) => CURRENT.get(`${component.id}:${String(reference.index)}`) ?? null;

const PICKS: FilletWeldPicks = {
  first: { componentId: 'component-1', ref: staleRef(1, 'face') },
  edge: { componentId: 'component-1', ref: staleRef(2, 'edge') },
  second: { componentId: 'component-2', ref: staleRef(3, 'face') },
};

function codes(picks: FilletWeldPicks): string[] {
  const bound = bindFilletWeldSelection(plainTee(), picks, resolve, WELD_TEST_REVISIONS);
  return bound.ok ? [] : bound.rejections.map((rejection) => rejection.code);
}

describe('選んだ面と辺をいまの形へ結び付ける', () => {
  it.each([true, false])('binds a current complete cylinder with known material side (exterior=%s)', (exterior) => {
    const cylinder: MateSubShapeGeometry = { kind: 'face', surfaceKind: 'cylinder', area: 2000 * Math.PI,
      position: [50, 34, 0], radius: 10, axis: [1, 0, 0], axisOrigin: [0, 34, 0],
      cylinderSpan: [0, 100], cylinderExterior: exterior };
    const current: WeldGeometryResolver = (component, reference) => component.id === 'component-2'
      ? cylinder : resolve(component, reference);
    const bound = bindFilletWeldSelection(plainTee(), PICKS, current, WELD_TEST_REVISIONS);
    if (!bound.ok) throw new Error(JSON.stringify(bound.rejections));
    expect(bound.second.normal).toBeNull();
    expect(bound.second.face.fingerprint).toMatchObject({ surfaceKind: 'cylinder', radius: 10, axis: [1, 0, 0] });
    expect(bound.second.face.fingerprint).not.toHaveProperty('cylinderExterior');
    for (const invalid of [{ ...cylinder, cylinderSpan: undefined }, { ...cylinder, cylinderExterior: undefined },
      { ...cylinder, axisOrigin: undefined }, { ...cylinder, radius: NaN }]) {
      const rejected = bindFilletWeldSelection(plainTee(), PICKS,
        (component, reference) => component.id === 'component-2' ? invalid : resolve(component, reference), WELD_TEST_REVISIONS);
      expect(rejected.ok ? [] : rejected.rejections.map(rejection => rejection.code)).toEqual(['faceNotPlanar']);
    }
    const wrongFirst = bindFilletWeldSelection(plainTee(), PICKS,
      (component, reference) => component.id === 'component-1' && reference.fingerprint.kind === 'face'
        ? cylinder : resolve(component, reference), WELD_TEST_REVISIONS);
    expect(wrongFirst.ok ? [] : wrongFirst.rejections.map(rejection => rejection.code)).toEqual(['faceNotPlanar']);
  });

  it('重心・法線・辺の中点・向き・長さは選び直した形から読み、選んだ時の指紋は使わない', () => {
    const bound = bindFilletWeldSelection(plainTee(), PICKS, resolve, WELD_TEST_REVISIONS);
    if (!bound.ok) throw new Error(JSON.stringify(bound.rejections));
    expect([bound.first.centroid, bound.first.normal, bound.first.sourceKey]).toEqual([[50, 8, 25], [0, 1, 0], 'part:standing@rev-s']);
    expect([bound.edge.midpoint, bound.edge.direction, bound.edge.length]).toEqual([[50, 8, 0], [1, 0, 0], 100]);
    expect([bound.second.centroid, bound.second.normal, bound.second.sourceKey]).toEqual([[50, 30, 10], [0, 0, 1], 'part:base@rev-b']);
    // 結び付けた選択から作る計画は、手で書いた選択から作る計画と同じ。
    const fromBound = planFilletWeld(plainTee(), teeRequest({ first: bound.first, edge: bound.edge, second: bound.second }), WELD_TEST_REVISIONS, TEE_BODIES);
    const fromHand = planFilletWeld(plainTee(), teeRequest(), WELD_TEST_REVISIONS, TEE_BODIES);
    expect(fromBound.ok && fromHand.ok ? [fromBound.plan.frame, fromBound.plan.contactLength] : null)
      .toEqual(fromHand.ok ? [fromHand.plan.frame, fromHand.plan.contactLength] : 'hand plan failed');
  });

  it('選び直せない・平面でない面・直線でない辺・2つ目の部品の辺・無い部品は理由を添えて断る', () => {
    expect(codes({ ...PICKS, second: { componentId: 'component-2', ref: staleRef(9, 'face') } })).toEqual(['selectionNotFound']);
    expect(codes({ ...PICKS, second: { componentId: 'component-2', ref: staleRef(4, 'face') } })).toEqual(['faceNotPlanar']);
    expect(codes({ ...PICKS, edge: { componentId: 'component-1', ref: staleRef(5, 'edge') } })).toEqual(['edgeNotStraight']);
    expect(codes({ ...PICKS, edge: { componentId: 'component-2', ref: staleRef(2, 'edge') } })).toEqual(['edgeNotOnFirstComponent']);
    expect(codes({ ...PICKS, first: { componentId: 'component-9', ref: staleRef(1, 'face') } })).toEqual(['componentMissing']);
    // 向きの求まらない直線・平面は、向きを仮定せずに断る。
    expect(codes({ ...PICKS, edge: { componentId: 'component-1', ref: staleRef(6, 'edge') } })).toEqual(['edgeNotStraight']);
    expect(codes({ ...PICKS, second: { componentId: 'component-2', ref: staleRef(7, 'face') } })).toEqual(['faceNotPlanar']);
    // 1 つ目の部品が無い時は、辺がその部品のものかは比べない(理由は componentMissing だけ)。1 つ目がある時は比べる。
    expect(codes({ ...PICKS, first: { componentId: 'component-9', ref: staleRef(1, 'face') },
      edge: { componentId: 'component-2', ref: staleRef(2, 'edge') } })).toEqual(['componentMissing', 'selectionNotFound']);
    // 面の位置へ辺を選んだ(種類の違う参照)も平面の面としては使わない。
    expect(codes({ ...PICKS, first: { componentId: 'component-1', ref: staleRef(2, 'edge') } })).toEqual(['faceNotPlanar']);
  });

  it('版の分からない部品は出どころの鍵が空になり、計画が版の無い部品として断る', () => {
    const bound = bindFilletWeldSelection(plainTee(), PICKS, resolve, new Map([['standing', 'rev-s']]));
    if (!bound.ok) throw new Error('bind failed');
    expect(bound.second.sourceKey).toBe('');
    const result = planFilletWeld(plainTee(), teeRequest({ first: bound.first, edge: bound.edge, second: bound.second }), new Map([['standing', 'rev-s']]), TEE_BODIES);
    expect(result.ok ? [] : result.rejections.map((rejection) => rejection.code)).toEqual(['missingSourceRevision']);
  });
});
