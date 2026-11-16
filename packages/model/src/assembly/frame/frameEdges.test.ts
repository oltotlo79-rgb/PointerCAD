/**
 * フレームの一括配置(J-01 包み 4)の、辺から線を作る純関数の検査: 直線の辺は 中点 ± 長さ/2 × 向き を部品の配置で写した線になり、
 * 直線でない辺・向きの無い辺は線にしない事。期待の値は手で解いた物(Z まわり 90° の回転と平行移動)。
 */
import { describe, expect, it } from 'vitest';

import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import { quaternionFromAxisAngle, type RigidPlacement } from '../placementMath.js';
import { frameLineFromEdge } from './frameEdges.js';

const LINE_EDGE: SubShapeRef = { bodyFeatureId: 'box-1', index: 0,
  fingerprint: { kind: 'edge', curveKind: 'line', length: 100, position: [50, 0, 0], axis: [1, 0, 0], radius: null } };
/** Z まわり 90° に回して (10, 20, 30) へ動かす配置。局所の +X は世界の +Y になる。 */
const TURNED: RigidPlacement = { position: [10, 20, 30], rotation: quaternionFromAxisAngle([0, 0, 1], Math.PI / 2) };

function expectPoint(actual: readonly number[] | undefined, expected: readonly number[]): void {
  expected.forEach((value, index) => { expect(actual?.[index]).toBeCloseTo(value, 9); });
}

describe('辺から線を作る', () => {
  it('直線の辺は 中点 ± 長さ/2 × 向き を、部品の配置で世界へ写した線になる', () => {
    const line = frameLineFromEdge(LINE_EDGE, TURNED);
    expectPoint(line?.start, [10, 20, 30]);
    expectPoint(line?.end, [10, 120, 30]);
  });

  it('向きの長さが 1 でなくても、指紋の長さだけの線になる', () => {
    const line = frameLineFromEdge({ ...LINE_EDGE, fingerprint: { kind: 'edge', curveKind: 'line', length: 100, position: [50, 0, 0],
      axis: [0, 0, 2], radius: null } }, { position: [0, 0, 0], rotation: [0, 0, 0, 1] });
    expectPoint(line?.start, [50, 0, -50]);
    expectPoint(line?.end, [50, 0, 50]);
  });

  it('円の辺・向きの無い辺・面は線にしない', () => {
    const identity: RigidPlacement = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };
    expect(frameLineFromEdge({ ...LINE_EDGE, fingerprint: { kind: 'edge', curveKind: 'circle', length: 31.4, position: [0, 0, 0],
      axis: [0, 0, 1], radius: 5 } }, identity)).toBeNull();
    expect(frameLineFromEdge({ ...LINE_EDGE, fingerprint: { kind: 'edge', curveKind: 'line', length: 10, position: [0, 0, 0],
      axis: null, radius: null } }, identity)).toBeNull();
    expect(frameLineFromEdge({ ...LINE_EDGE, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 100, position: [0, 0, 0],
      axis: [0, 0, 1], radius: null } }, identity)).toBeNull();
  });
});
