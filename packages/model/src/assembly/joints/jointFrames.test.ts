import { describe, expect, it } from 'vitest';
import { crossVec3, dotVec3, lengthVec3, type Vec3 } from '../../sketch/vec3.js';
import { IDENTITY_PLACEMENT, quaternionFromAxisAngle, type RigidPlacement } from '../placementMath.js';
import type { Joint } from '../types.js';
import {
  createJointFrame,
  jointCoordinateNames,
  jointFramePairFromTargets,
  transformJointFrame,
  validJointFrame,
  validJointPlacement,
  type JointFrame,
} from './jointFrames.js';

function frame(axis: Vec3 = [0, 0, 1]): JointFrame {
  const result = createJointFrame([1, 2, 3], axis);
  if (result === null) throw new Error('frame');
  return result;
}
describe('明示JointFrameと名前付きcoordinate', () => {
  it('Zの既定基底は右手系で決定的', () => {
    expect(frame()).toEqual({ origin: [1, 2, 3], x: [0, 1, 0], y: [-1, 0, 0], z: [0, 0, 1] });
    expect(frame()).toEqual(frame());
  });
  it.each<Vec3>([[1, 2, 3], [-2, 3, -1], [1e6, 1, 0]])('任意軸%sでも単位・直交・det+1', (x, y, z) => {
    const f = frame([x, y, z]);
    for (const v of [f.x, f.y, f.z]) expect(Math.abs(lengthVec3(v) - 1)).toBeLessThan(1e-12);
    for (const v of [dotVec3(f.x, f.y), dotVec3(f.y, f.z), dotVec3(f.z, f.x)]) expect(Math.abs(v)).toBeLessThan(1e-12);
    expect(Math.abs(dotVec3(crossVec3(f.x, f.y), f.z) - 1)).toBeLessThan(1e-12);
  });
  it('明示接線を垂直面へ射影してXを固定する', () => {
    expect(createJointFrame([0, 0, 0], [0, 0, 2], [3, 0, 4]))
      .toEqual({ origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });
  });
  it('零軸・平行接線・NaN・Infinityを断る', () => {
    expect(createJointFrame([0, 0, 0], [0, 0, 0])).toBeNull();
    expect(createJointFrame([0, 0, 0], [0, 0, 1], [0, 0, 1])).toBeNull();
    expect(createJointFrame([NaN, 0, 0], [0, 0, 1])).toBeNull();
    expect(createJointFrame([0, 0, 0], [0, Infinity, 1])).toBeNull();
    expect(createJointFrame([0, 0, 0], [0, 0, 1], [NaN, 0, 0])).toBeNull();
  });
  it('鏡映と非直交基底を回転として受け付けない', () => {
    expect(validJointFrame({ ...frame(), y: [1, 0, 0] })).toBe(false);
    expect(validJointFrame({ ...frame(), x: [0, 1, 0.01] })).toBe(false);
    expect(transformJointFrame(frame(), { ...IDENTITY_PLACEMENT, rotation: [0, 0, 0, 0] })).toBeNull();
  });
  it('移動と回転を合成し元の局所フレームを変えない', () => {
    const source = frame();
    const before = structuredClone(source);
    const result = transformJointFrame(source, { position: [10, 20, 30], rotation: quaternionFromAxisAngle([0, 0, 1], Math.PI / 2) });
    expect(result?.origin[0]).toBeCloseTo(8, 12);
    expect(result?.origin[1]).toBeCloseTo(21, 12);
    expect(result?.origin[2]).toBe(33);
    expect(result?.x[0]).toBeCloseTo(-1, 12);
    expect(source).toEqual(before);
  });
  it.each([
    ['revolute', ['angle']], ['slider', ['translation']], ['cylindrical', ['angle', 'translation']], ['ball', []],
  ] as const)('%sの独立coordinateだけを返す', (kind, names) => {
    expect(jointCoordinateNames(kind)).toEqual(names);
  });
  it('世界座標の対象を部品局所へ戻し、再配置すると同じ対象になる', () => {
    const joint: Joint = {
      id: 'joint-1', name: 'ジョイント1', kind: 'revolute',
      a: { kind: 'origin', componentId: 'a', element: 'z' },
      b: { kind: 'origin', componentId: 'b', element: 'z' },
      minValue: null, maxValue: null, suppressed: false,
    };
    const placementA: RigidPlacement = {
      position: [10, 20, 30],
      rotation: quaternionFromAxisAngle([0, 0, 1], Math.PI / 2),
    };
    const targets = {
      a: { kind: 'axis' as const, point: [8, 21, 33] as Vec3, direction: [0, 0, 1] as Vec3, radius: null },
      b: { kind: 'axis' as const, point: [4, 5, 6] as Vec3, direction: [0, 1, 0] as Vec3, radius: null },
    };
    const pair = jointFramePairFromTargets(
      joint,
      targets,
      new Map([['a', placementA], ['b', IDENTITY_PLACEMENT]]),
    );
    expect(pair).not.toBeNull();
    if (pair === null) throw new Error('joint frame');
    expect(transformJointFrame(pair.a, placementA)?.origin).toEqual(targets.a.point);
    expect(transformJointFrame(pair.a, placementA)?.z).toEqual(targets.a.direction);
    expect(transformJointFrame(pair.b, IDENTITY_PLACEMENT)?.origin).toEqual(targets.b.point);
    expect(transformJointFrame(pair.b, IDENTITY_PLACEMENT)?.z).toEqual(targets.b.direction);
  });
  it('軸が要るジョイントは向きの無い対象を断り、ballだけは安定した局所軸を補う', () => {
    const base: Joint = {
      id: 'joint-1', name: 'ジョイント1', kind: 'revolute',
      a: { kind: 'origin', componentId: 'a', element: 'origin' },
      b: { kind: 'origin', componentId: 'b', element: 'origin' },
      minValue: null, maxValue: null, suppressed: false,
    };
    const targets = {
      a: { kind: 'point' as const, point: [0, 0, 0] as Vec3, direction: null, radius: null },
      b: { kind: 'point' as const, point: [0, 0, 0] as Vec3, direction: null, radius: null },
    };
    const placements = new Map([['a', IDENTITY_PLACEMENT], ['b', IDENTITY_PLACEMENT]]);
    expect(jointFramePairFromTargets(base, targets, placements)).toBeNull();
    expect(jointFramePairFromTargets({ ...base, kind: 'ball' }, targets, placements))
      .toMatchObject({ a: { z: [0, 0, 1] }, b: { z: [0, 0, 1] } });
  });
});

describe('joint入口の配列形状・有限norm（M1）', () => {
  it.each(['empty', 'short', 'long', 'hole'] as const)('%sのVec3を原点・軸・接線・基底で断る', (kind) => {
    const vector: [number, number, number] = [1, 2, 3];
    if (kind === 'empty') vector.splice(0, 3);
    if (kind === 'short') vector.pop();
    if (kind === 'long') vector.push(4);
    if (kind === 'hole') Reflect.deleteProperty(vector, '1');
    expect(createJointFrame(vector, [0, 0, 1])).toBeNull();
    expect(createJointFrame([0, 0, 0], vector)).toBeNull();
    expect(createJointFrame([0, 0, 0], [0, 0, 1], vector)).toBeNull();
    for (const key of ['origin', 'x', 'y', 'z'] as const) {
      expect(validJointFrame({ ...frame(), [key]: vector })).toBe(false);
      expect(transformJointFrame({ ...frame(), [key]: vector }, IDENTITY_PLACEMENT)).toBeNull();
    }
  });
  it.each(['position-empty', 'position-short', 'position-long', 'position-hole',
    'rotation-empty', 'rotation-short', 'rotation-long', 'rotation-hole'] as const)('%sの配置を検証とtransformが断る', (kind) => {
    const position: [number, number, number] = [0, 0, 0];
    const rotation: [number, number, number, number] = [1, 0, 0, 1];
    const values = kind.startsWith('position') ? position : rotation;
    if (kind.endsWith('empty')) values.splice(0, values.length);
    if (kind.endsWith('short')) values.splice(1, values.length - 1);
    if (kind.endsWith('long')) values.push(0);
    if (kind.endsWith('hole')) Reflect.deleteProperty(values, '1');
    const placement: RigidPlacement = { position, rotation };
    expect(validJointPlacement(placement)).toBe(false);
    expect(transformJointFrame(frame(), placement)).toBeNull();
  });
  it.each([0, 1e-12, NaN, Infinity, 1e308])('有限非退化normを満たさない四元数値%sを断る', (value) => {
    const rotation: RigidPlacement['rotation'] = value === 1e308 ? [value, value, value, value] : [value, 0, 0, 0];
    expect(validJointPlacement({ ...IDENTITY_PLACEMENT, rotation })).toBe(false);
    expect(transformJointFrame(frame(), { ...IDENTITY_PLACEMENT, rotation })).toBeNull();
  });
  it('有限で非退化なら未正規化でも回転として受け付ける', () => {
    expect(validJointPlacement({ ...IDENTITY_PLACEMENT, rotation: [0, 0, 0, 2] })).toBe(true);
    expect(validJointPlacement({ ...IDENTITY_PLACEMENT, rotation: [0, 0, 0, 1.0001e-12] })).toBe(true);
    expect(transformJointFrame(frame(), { ...IDENTITY_PLACEMENT, rotation: [0, 0, 0, 2] })).toEqual(frame());
    expect(validJointPlacement({ ...IDENTITY_PLACEMENT, position: [0, NaN, 0] })).toBe(false);
    expect(validJointPlacement({ ...IDENTITY_PLACEMENT, position: [0, 0, Infinity] })).toBe(false);
  });
});
