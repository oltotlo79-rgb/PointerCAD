import { beforeAll, describe, expect, it } from 'vitest';

import type { PrimitiveStepSpec, SolidFaceInfo, SubShapeQuery, ThreadStepSpec, Vec3Tuple } from '../types.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makePrimitive } from './makePrimitive.js';
import { makeThreadHole } from './makeThread.js';
import { hasSolid, isValidShape } from './solidMesh.js';
import { collectSubShapes } from './subShapes.js';
import { tessellate } from './tessellate.js';

type Occt = Awaited<ReturnType<typeof loadOcctForNode>>;

/**
 * EX05: 円柱の側面に、径方向へ下穴をあけて**めねじ**を切る(軸そのものにおねじを切る makeThreadShaft とは別の道)。
 * 期待値は形から独立に求める: 入口は軸から R の面の上、掘る向きは軸へ向かう放射方向、止まり穴の体積は
 * 下穴の円板の上で「面までの高さ − 底の高さ」を積分した値。M6 並目の D1 は model の表を輸入せずに計算する。
 */
const RADIUS = 10;
const HEIGHT = 40;
const DEPTH = 8;
const MAJOR = 6;
const PITCH = 1;
const THREAD_LENGTH = 6;
const MINOR = 6 - 1.0825317547305482;
const POSITION_TOLERANCE = 1e-7;
const DIRECTION_TOLERANCE = 1e-9;
const VOLUME_RELATIVE = 1e-6;
const ADAPTIVE_EPS = 1e-9;
const ADAPTIVE_ERROR_LIMIT = 1e-8;
const SWEEP_TIMEOUT = 120_000;

/** 軸 z・半径 R の円柱を、x 軸の向きの半径 r の止まり穴(入口から深さ DEPTH)で削った体積(y = r sin t で滑らかにして Simpson)。 */
function blindRadialVolume(r: number): number {
  const intervals = 4000;
  const step = Math.PI / intervals;
  let sum = 0;
  for (let i = 0; i <= intervals; i += 1) {
    const t = -Math.PI / 2 + i * step;
    const value = 2 * r * r * Math.cos(t) ** 2 * (Math.sqrt(RADIUS * RADIUS - r * r * Math.sin(t) ** 2) - (RADIUS - DEPTH));
    sum += (i === 0 || i === intervals ? 1 : i % 2 === 1 ? 4 : 2) * value;
  }
  return (sum * step) / 3;
}

function expectRelative(actual: number, expected: number): void {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(VOLUME_RELATIVE);
}

describe('円柱の側面のねじ穴(EX05)', () => {
  let oc: Occt;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  /** 製品の measureVolume ではなく、誤差を見積もる積分で測る(makeHole.test.ts の EX05 と同じ理由)。 */
  function adaptiveVolume(shape: Parameters<typeof isValidShape>[1]): number {
    const properties = new oc.GProp_GProps_1();
    try {
      const error = oc.BRepGProp.VolumeProperties_2(shape, properties, ADAPTIVE_EPS, false, false);
      expect(Math.abs(error)).toBeLessThan(ADAPTIVE_ERROR_LIMIT);
      return properties.Mass();
    } finally {
      properties.delete();
    }
  }

  function facesOf(shape: Parameters<typeof collectSubShapes>[1]): readonly SolidFaceInfo[] {
    const mesh = tessellate(oc, shape);
    const lines = extractEdges(oc, shape);
    return collectSubShapes(oc, shape, mesh.faceRanges, lines.edgeRanges).faces;
  }

  function sideQuery(faces: readonly SolidFaceInfo[]): Extract<SubShapeQuery, { kind: 'face' }> {
    const found = faces.filter((face) => face.surfaceKind === 'cylinder' && face.radius !== null && Math.abs(face.radius - RADIUS) < 1e-9);
    const side = found[0];
    if (found.length !== 1 || side === undefined) throw new Error('円柱の側面が 1 枚ではありません');
    return { kind: 'face', index: side.index, surfaceKind: side.surfaceKind, area: side.area, position: side.centroid,
      axis: side.axis, radius: side.radius };
  }

  function shaft(): ReturnType<typeof makePrimitive> {
    const primitive: PrimitiveStepSpec = { kind: 'primitive', origin: [0, 0, 0], axis: [0, 0, 1],
      shape: { kind: 'cylinder', radius: RADIUS, height: HEIGHT }, originQuery: null, targetKey: null };
    return makePrimitive(oc, primitive);
  }

  function tapped(face: SubShapeQuery, locations: readonly { height: number; angle: number }[], real: boolean,
    overrides: Partial<ThreadStepSpec> = {}): ThreadStepSpec {
    return { kind: 'thread', targetKey: 'target', face, centers: [], drillDiameter: MINOR, depth: DEPTH, tiltAngle: 0, tiltAzimuth: 0,
      transforms: [], thread: real ? { majorDiameter: MAJOR, pitch: PITCH, length: THREAD_LENGTH } : null,
      mark: { majorDiameter: MAJOR, length: THREAD_LENGTH }, cylindrical: { kind: 'cylinder-face', locations }, ...overrides };
  }

  /** 切った量(もとの円柱 π R² H から引く)と、出来た形の妥当さ。 */
  function removedBy(spec: ThreadStepSpec, target: ReturnType<typeof makePrimitive>, faces: readonly SolidFaceInfo[]) {
    const output = makeThreadHole(oc, spec, target.shape, faces);
    try {
      expect(isValidShape(oc, output.handle.shape)).toBe(true);
      expect(hasSolid(oc, output.handle.shape)).toBe(true);
      return { removed: Math.PI * RADIUS ** 2 * HEIGHT - adaptiveVolume(output.handle.shape), marks: output.marks };
    } finally {
      output.handle.delete();
    }
  }

  const LOCATIONS = [{ height: 12, angle: 0 }, { height: 28, angle: Math.PI / 2 }] as const;

  it('2 つの位置で、それぞれの径方向の軸に下穴を掘り、その軸のまわりにめねじを切る', () => {
    const target = shaft();
    try {
      const faces = facesOf(target.shape);
      const side = sideQuery(faces);

      // 印(ねじの軸)は位置ごとに、入口が軸から R の面の上、向きは軸へ向かう放射方向。
      const drilled = removedBy(tapped(side, LOCATIONS, false), target, faces);
      expect(drilled.marks).toHaveLength(2);
      const radials = drilled.marks.map((mark, index) => {
        const location = LOCATIONS[index];
        if (location === undefined) throw new Error('位置が足りません');
        expect(Math.abs(mark.origin[2] - location.height)).toBeLessThan(POSITION_TOLERANCE);
        expect(Math.abs(Math.hypot(mark.origin[0], mark.origin[1]) - RADIUS)).toBeLessThan(POSITION_TOLERANCE);
        const radial: Vec3Tuple = [mark.origin[0] / RADIUS, mark.origin[1] / RADIUS, 0];
        expect(Math.hypot(mark.direction[0] + radial[0], mark.direction[1] + radial[1], mark.direction[2])).toBeLessThan(DIRECTION_TOLERANCE);
        expect(mark.majorDiameter).toBe(MAJOR);
        expect(mark.length).toBe(THREAD_LENGTH);
        return radial;
      });
      const [first, second] = radials;
      if (first === undefined || second === undefined) throw new Error('放射方向が足りません');
      // 角度 0 と 90 度は別の放射方向で、正の向きは軸 z を親指にした右手の回り(第 2 = z × 第 1)。
      expect(Math.hypot(second[0] + first[1], second[1] - first[0], second[2])).toBeLessThan(DIRECTION_TOLERANCE);

      // 下穴だけ(簡略表示): 2 つの止まり穴の体積。
      expectRelative(drilled.removed, 2 * blindRadialVolume(MINOR / 2));

      // めねじ: 下穴より多く削り、呼び径 d の同じ深さの止まり穴よりは少ない(溝は下穴の壁から外径までの間だけ)。
      // 軸のおねじなら下穴の内側は削らないので、下穴の体積を下回る(ここで区別できる)。
      const threaded = removedBy(tapped(side, LOCATIONS, true), target, faces);
      expect(threaded.marks).toEqual(drilled.marks);
      expect(threaded.removed).toBeGreaterThan(drilled.removed * (1 + 1e-3));
      expect(threaded.removed).toBeLessThan(2 * blindRadialVolume(MAJOR / 2));

      // 位置ごとの向き: 2 つを 1 段で切った量は、1 つずつ切った量の和(2 つ目の溝が 1 つ目の向きを使えば一致しない)。
      const alone = LOCATIONS.map((location) => removedBy(tapped(side, [location], true), target, faces));
      expectRelative(threaded.removed, (alone[0]?.removed ?? NaN) + (alone[1]?.removed ?? NaN));
      expect(alone.map((row) => row.marks[0])).toEqual(threaded.marks);
      expectRelative(adaptiveVolume(target.shape), Math.PI * RADIUS ** 2 * HEIGHT);
    } finally {
      target.delete();
    }
  }, SWEEP_TIMEOUT);

  it('高さを変えて作り直すと、同じ量を軸に沿ってずらした位置で削る', () => {
    const target = shaft();
    try {
      const faces = facesOf(target.shape);
      const side = sideQuery(faces);
      const before = removedBy(tapped(side, [{ height: 12, angle: 0 }], true), target, faces);
      const after = removedBy(tapped(side, [{ height: 20, angle: 0 }], true), target, faces);
      const again = removedBy(tapped(side, [{ height: 12, angle: 0 }], true), target, faces);
      expectRelative(after.removed, before.removed);
      expectRelative(again.removed, before.removed);
      expect(again.marks).toEqual(before.marks);
      const moved = after.marks[0], original = before.marks[0];
      if (moved === undefined || original === undefined) throw new Error('印がありません');
      expect(Math.abs(moved.origin[2] - original.origin[2] - 8)).toBeLessThan(POSITION_TOLERANCE);
      expect(moved.direction).toEqual(original.direction);
    } finally {
      target.delete();
    }
  }, SWEEP_TIMEOUT);

  it.each([
    ['深さ 0', { depth: 0 }, '穴の深さは 0 より大きい数にしてください。'],
    ['負の深さ', { depth: -2 }, '穴の深さは 0 より大きい数にしてください。'],
    ['中心の点を併せて渡す', { centers: [[RADIUS, 0, 12]] }, '円筒の側面の穴では、中心の点・傾き・皿もみはまだ使えません。位置は高さと角度で指定してください。'],
    ['皿もみ', { entry: { kind: 'countersink', diameter: 9, angle: Math.PI / 2 } }, '円筒の側面の穴では、中心の点・傾き・皿もみはまだ使えません。位置は高さと角度で指定してください。'],
  ] as const)('%s は断り、もとの円柱は変えない', (_label, overrides, message) => {
    const target = shaft();
    try {
      const faces = facesOf(target.shape);
      expect(() => makeThreadHole(oc, tapped(sideQuery(faces), [{ height: 12, angle: 0 }], true, overrides), target.shape, faces))
        .toThrow(message);
      expectRelative(adaptiveVolume(target.shape), Math.PI * RADIUS ** 2 * HEIGHT);
    } finally {
      target.delete();
    }
  });
});
