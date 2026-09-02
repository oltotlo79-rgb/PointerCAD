import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';

import type { CurveSpec, ExtrudeStepSpec, RevolveStepSpec } from '../types.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makePlanarFace } from './makePlanarFace.js';
import { makeExtrudeSolid, makeRevolveSolid } from './makeSolidSweep.js';
import { buildSolidBodyMesh, hasSolid, isValidShape, measureVolume } from './solidMesh.js';

/** z = 0 の平面(XY 面)に置いた 40 × 30 の長方形。P2 完了条件の「簡単な部品」の断面。 */
const RECTANGLE_40_30: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 0, 0], to: [40, 0, 0] },
  { kind: 'segment', from: [40, 0, 0], to: [40, 30, 0] },
  { kind: 'segment', from: [40, 30, 0], to: [0, 30, 0] },
  { kind: 'segment', from: [0, 30, 0], to: [0, 0, 0] },
];

/** y = 0 の平面(XZ 面)に置いた長方形。x: 10 → 20、z: 0 → 5。Z 軸まわりに回すと中空の円筒になる。 */
const RECTANGLE_XZ: readonly CurveSpec[] = [
  { kind: 'segment', from: [10, 0, 0], to: [20, 0, 0] },
  { kind: 'segment', from: [20, 0, 0], to: [20, 0, 5] },
  { kind: 'segment', from: [20, 0, 5], to: [10, 0, 5] },
  { kind: 'segment', from: [10, 0, 5], to: [10, 0, 0] },
];

/** 片辺が Z 軸に接する断面。x: 0 → 10、z: 0 → 5。回すと中空でない円柱になる。 */
const RECTANGLE_TOUCHING_AXIS: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 0, 0], to: [10, 0, 0] },
  { kind: 'segment', from: [10, 0, 0], to: [10, 0, 5] },
  { kind: 'segment', from: [10, 0, 5], to: [0, 0, 5] },
  { kind: 'segment', from: [0, 0, 5], to: [0, 0, 0] },
];

/** Z 軸をまたぐ断面。x: −5 → 5。回すと形が自分自身と重なるので作れない。 */
const RECTANGLE_ACROSS_AXIS: readonly CurveSpec[] = [
  { kind: 'segment', from: [-5, 0, 0], to: [5, 0, 0] },
  { kind: 'segment', from: [5, 0, 0], to: [5, 0, 5] },
  { kind: 'segment', from: [5, 0, 5], to: [-5, 0, 5] },
  { kind: 'segment', from: [-5, 0, 5], to: [-5, 0, 0] },
];

/** 閉じていない輪郭(L 字の 3 本)。makePlanarFace が断る経路の確認に使う。 */
const OPEN_L_SHAPE: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 0, 0], to: [10, 0, 0] },
  { kind: 'segment', from: [10, 0, 0], to: [10, 10, 0] },
  { kind: 'segment', from: [10, 10, 0], to: [0, 10, 0] },
];

/** 40 × 30 × 10 = 12000 mm³。手計算した期待値で、実測に合わせて動かさない。 */
const EXTRUDE_VOLUME = 12000;

/**
 * 中空円筒の体積 1500π = 4712.3889803846896 mm³。
 *
 * 独立に 2 通りで導出し、同じ値になることを検査の中でも確かめる。
 *   ① 中空円筒の公式: π(R² − r²)h = π(20² − 10²)·5 = π·300·5 = 1500π
 *   ② パップス・ギュルダンの定理 V = θ·R̄·A
 *      断面積 A = (20 − 10)·(5 − 0) = 50 mm²
 *      断面の重心までの半径 R̄ = (10 + 20)/2 = 15 mm
 *      θ = 2π のとき V = 2π·15·50 = 1500π
 */
const REVOLVE_FULL_VOLUME = 4712.3889803846896;

/**
 * 同じ断面を π/2(90°)だけ回した体積 375π = 1178.0972450961724 mm³。
 * パップスの定理で θ = π/2 とすると V = (π/2)·15·50 = 375π(全周の 1/4)。
 */
const REVOLVE_QUARTER_VOLUME = 1178.0972450961724;

/**
 * 片辺が軸に接する断面を 1 周回した円柱の体積 500π = 1570.7963267948965 mm³。
 *   ① 円柱の公式: πr²h = π·10²·5 = 500π
 *   ② パップスの定理: θ·R̄·A = 2π·5·(10·5) = 500π(R̄ = (0 + 10)/2 = 5)
 */
const REVOLVE_CYLINDER_VOLUME = 1570.7963267948965;

const EXTRUDE_UP: ExtrudeStepSpec = {
  kind: 'extrude',
  profile: RECTANGLE_40_30,
  direction: [0, 0, 1],
  distance: 10,
};

const REVOLVE_FULL: RevolveStepSpec = {
  kind: 'revolve',
  profile: RECTANGLE_XZ,
  axisOrigin: [0, 0, 0],
  axisDirection: [0, 0, 1],
  angle: 2 * Math.PI,
};

/**
 * 面のうち、下地の曲面が平面であるものの数。
 * 部分形状の集め方と列挙の扱いは tessellate.ts / solidMesh.ts と同じで、
 * TopExp_Explorer を使わず MapShapes_2 と値どうしの比較で選ぶ。
 */
function countPlanarFaces(oc: OpenCascadeInstance, shape: TopoDS_Shape): number {
  const subShapes = new oc.TopTools_IndexedMapOfShape_1();
  try {
    oc.TopExp.MapShapes_2(shape, subShapes, true, true);
    const faceType = oc.TopAbs_ShapeEnum.TopAbs_FACE;
    const planeType = oc.GeomAbs_SurfaceType.GeomAbs_Plane;
    const subShapeCount = Number(subShapes.Size());
    let planarFaceCount = 0;

    for (let subShapeIndex = 1; subShapeIndex <= subShapeCount; subShapeIndex += 1) {
      const subShape = subShapes.FindKey(subShapeIndex);
      if (subShape.ShapeType() !== faceType) {
        continue;
      }
      const face = oc.TopoDS.Face_1(subShape);
      const adaptor = new oc.BRepAdaptor_Surface_2(face, true);
      if (adaptor.GetType() === planeType) {
        planarFaceCount += 1;
      }
      adaptor.delete();
      face.delete();
    }
    return planarFaceCount;
  } finally {
    subShapes.delete();
  }
}

/** 稜線の並び(線分 1 本あたり 6 個)から z の最小・最大を求める。 */
function edgeRangeZ(edgePositions: Float32Array): readonly [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = 2; index < edgePositions.length; index += 3) {
    min = Math.min(min, edgePositions[index]);
    max = Math.max(max, edgePositions[index]);
  }
  return [min, max];
}

describe('断面の押し出し(FR-401)', () => {
  let oc: OpenCascadeInstance;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  it('40 × 30 の長方形を 10 押し出すと体積 12000 の直方体になる', () => {
    const handle = makeExtrudeSolid(oc, EXTRUDE_UP);
    try {
      // 40 · 30 · 10 = 12000 mm³。
      expect(measureVolume(oc, handle.shape)).toBeCloseTo(EXTRUDE_VOLUME, 6);
      expect(isValidShape(oc, handle.shape)).toBe(true);
      expect(hasSolid(oc, handle.shape)).toBe(true);

      const body = buildSolidBodyMesh(oc, 'extrude-1', handle.shape);
      // 直方体は 6 面、面あたり三角形 2 枚、稜線 12 本。
      expect(body.faceCount).toBe(6);
      expect(body.triangleCount).toBe(12);
      expect(body.edgeCount).toBe(12);
      expect(body.volume).toBeCloseTo(EXTRUDE_VOLUME, 6);
    } finally {
      handle.delete();
    }
  });

  // 計画書 §1.2 の未確認点 1(Canonize に何を渡すか)の実測を検査として残す。
  it('押し出した直方体の 6 面すべてが平面になる(Canonize=true の効き目)', () => {
    const handle = makeExtrudeSolid(oc, EXTRUDE_UP);
    try {
      expect(countPlanarFaces(oc, handle.shape)).toBe(6);
    } finally {
      handle.delete();
    }
  });

  it('Canonize=false では側面 4 枚が平面にならない(採らなかった理由の実測)', () => {
    const face = makePlanarFace(oc, RECTANGLE_40_30);
    const vector = new oc.gp_Vec_4(0, 0, 10);
    const maker = new oc.BRepPrimAPI_MakePrism_1(face.face, vector, false, false);
    const shape = maker.Shape();
    try {
      // 上面と下面の 2 枚だけが平面で、側面 4 枚は押し出し曲面のまま残る。
      expect(countPlanarFaces(oc, shape)).toBe(2);
      // 体積と面数は Canonize の真偽で変わらないので、この 2 つでは選べない。
      expect(measureVolume(oc, shape)).toBeCloseTo(EXTRUDE_VOLUME, 6);
      expect(buildSolidBodyMesh(oc, 'canonize-false', shape).faceCount).toBe(6);
    } finally {
      shape.delete();
      maker.delete();
      vector.delete();
      face.delete();
    }
  });

  it('向きを [0, 0, -1] にすると逆向きへ伸びる(体積は同じ)', () => {
    const handle = makeExtrudeSolid(oc, { ...EXTRUDE_UP, direction: [0, 0, -1] });
    try {
      expect(measureVolume(oc, handle.shape)).toBeCloseTo(EXTRUDE_VOLUME, 6);
      const body = buildSolidBodyMesh(oc, 'extrude-2', handle.shape);
      const [minZ, maxZ] = edgeRangeZ(body.edgePositions);
      expect(minZ).toBeCloseTo(-10, 4);
      expect(maxZ).toBeCloseTo(0, 4);
    } finally {
      handle.delete();
    }
  });

  it('向きが単位ベクトルでなくても伸びる長さは distance に従う', () => {
    const handle = makeExtrudeSolid(oc, { ...EXTRUDE_UP, direction: [0, 0, 4] });
    try {
      expect(measureVolume(oc, handle.shape)).toBeCloseTo(EXTRUDE_VOLUME, 6);
      const body = buildSolidBodyMesh(oc, 'extrude-3', handle.shape);
      const [minZ, maxZ] = edgeRangeZ(body.edgePositions);
      expect(minZ).toBeCloseTo(0, 4);
      expect(maxZ).toBeCloseTo(10, 4);
    } finally {
      handle.delete();
    }
  });

  it('押し出す長さが 0 のときは理由を添えて断る', () => {
    expect(() => makeExtrudeSolid(oc, { ...EXTRUDE_UP, distance: 0 })).toThrow(
      '押し出す長さは 0 より大きい数にしてください。',
    );
  });

  it('押し出す長さが負のときも同じ理由で断る', () => {
    expect(() => makeExtrudeSolid(oc, { ...EXTRUDE_UP, distance: -5 })).toThrow(
      '押し出す長さは 0 より大きい数にしてください。',
    );
  });

  it('押し出す向きが 0 ベクトルのときは理由を添えて断る', () => {
    expect(() => makeExtrudeSolid(oc, { ...EXTRUDE_UP, direction: [0, 0, 0] })).toThrow(
      '押し出す向きが決まりません。',
    );
  });

  it('断面と同じ平面の向きへ押し出すと厚みが出ないので断る', () => {
    expect(() => makeExtrudeSolid(oc, { ...EXTRUDE_UP, direction: [1, 0, 0] })).toThrow(
      '押し出しても厚みが出ませんでした。',
    );
  });

  it('閉じていない断面は makePlanarFace の理由をそのまま返す', () => {
    expect(() => makeExtrudeSolid(oc, { ...EXTRUDE_UP, profile: OPEN_L_SHAPE })).toThrow(
      '輪郭が閉じていないため',
    );
  });
});

describe('断面の回転(FR-402)', () => {
  let oc: OpenCascadeInstance;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  it('XZ 面の長方形を Z 軸まわりに 1 周回すと体積 1500π の中空円筒になる', () => {
    const handle = makeRevolveSolid(oc, REVOLVE_FULL);
    try {
      // 期待値そのものを 2 通りの式で検算する(円筒の公式とパップスの定理)。
      expect(REVOLVE_FULL_VOLUME).toBeCloseTo(Math.PI * (20 * 20 - 10 * 10) * 5, 9);
      expect(REVOLVE_FULL_VOLUME).toBeCloseTo(2 * Math.PI * 15 * 50, 9);

      expect(measureVolume(oc, handle.shape)).toBeCloseTo(REVOLVE_FULL_VOLUME, 6);
      expect(isValidShape(oc, handle.shape)).toBe(true);
      expect(hasSolid(oc, handle.shape)).toBe(true);

      const body = buildSolidBodyMesh(oc, 'revolve-1', handle.shape);
      // 全周の中空円筒は「外側の円筒・内側の円筒・上の円環・下の円環」の 4 面。
      expect(body.faceCount).toBe(4);
      expect(body.volume).toBeCloseTo(REVOLVE_FULL_VOLUME, 6);
    } finally {
      handle.delete();
    }
  });

  it('同じ断面を 90 度だけ回すと体積が 1/4(375π)になる', () => {
    const handle = makeRevolveSolid(oc, { ...REVOLVE_FULL, angle: Math.PI / 2 });
    try {
      // パップスの定理 θ·R̄·A に θ = π/2 を入れた値。全周の 1/4 でもある。
      expect(REVOLVE_QUARTER_VOLUME).toBeCloseTo((Math.PI / 2) * 15 * 50, 9);
      expect(REVOLVE_QUARTER_VOLUME).toBeCloseTo(REVOLVE_FULL_VOLUME / 4, 9);

      expect(measureVolume(oc, handle.shape)).toBeCloseTo(REVOLVE_QUARTER_VOLUME, 6);
      expect(isValidShape(oc, handle.shape)).toBe(true);
      expect(hasSolid(oc, handle.shape)).toBe(true);

      const body = buildSolidBodyMesh(oc, 'revolve-2', handle.shape);
      // 90 度では切り口の平面 2 枚が加わって 6 面になる。
      expect(body.faceCount).toBe(6);
    } finally {
      handle.delete();
    }
  });

  it('片辺が軸に接する断面を 1 周回すと中空でない円柱(500π)になる', () => {
    const handle = makeRevolveSolid(oc, { ...REVOLVE_FULL, profile: RECTANGLE_TOUCHING_AXIS });
    try {
      expect(REVOLVE_CYLINDER_VOLUME).toBeCloseTo(Math.PI * 10 * 10 * 5, 9);
      expect(REVOLVE_CYLINDER_VOLUME).toBeCloseTo(2 * Math.PI * 5 * 50, 9);

      expect(measureVolume(oc, handle.shape)).toBeCloseTo(REVOLVE_CYLINDER_VOLUME, 6);
      expect(isValidShape(oc, handle.shape)).toBe(true);
      expect(hasSolid(oc, handle.shape)).toBe(true);
    } finally {
      handle.delete();
    }
  });

  it('回転の角度が 0 のときは理由を添えて断る', () => {
    expect(() => makeRevolveSolid(oc, { ...REVOLVE_FULL, angle: 0 })).toThrow(
      '回転の角度は 0 より大きく 360 度以下にしてください。',
    );
  });

  it('回転の角度が 360 度を超えるときも断る', () => {
    expect(() => makeRevolveSolid(oc, { ...REVOLVE_FULL, angle: 2 * Math.PI + 0.5 })).toThrow(
      '回転の角度は 0 より大きく 360 度以下にしてください。',
    );
  });

  it('ちょうど 360 度(2π)は受け取る', () => {
    const handle = makeRevolveSolid(oc, { ...REVOLVE_FULL, angle: 2 * Math.PI });
    try {
      expect(measureVolume(oc, handle.shape)).toBeCloseTo(REVOLVE_FULL_VOLUME, 6);
    } finally {
      handle.delete();
    }
  });

  it('回転の軸の向きが 0 ベクトルのときは理由を添えて断る', () => {
    expect(() => makeRevolveSolid(oc, { ...REVOLVE_FULL, axisDirection: [0, 0, 0] })).toThrow(
      '回転の軸が決まりません。',
    );
  });

  it('断面が回転軸をまたいでいるときは理由を添えて断る', () => {
    expect(() => makeRevolveSolid(oc, { ...REVOLVE_FULL, profile: RECTANGLE_ACROSS_AXIS })).toThrow(
      '断面が回転軸と重なっているため、回せませんでした。',
    );
  });

  it('軸が断面の平面に直交していると厚みが出ないので断る', () => {
    // XY 面の断面を Z 軸まわりに回すと、OCCT は成功を返すが体積 0 の形になる。
    // 利用者には作れなかった理由を出して断る(FR-504)。
    expect(() =>
      makeRevolveSolid(oc, {
        ...REVOLVE_FULL,
        profile: RECTANGLE_40_30,
        angle: Math.PI / 2,
      }),
    ).toThrow('回しても厚みが出ませんでした。');
  });

  it('閉じていない断面は makePlanarFace の理由をそのまま返す', () => {
    expect(() => makeRevolveSolid(oc, { ...REVOLVE_FULL, profile: OPEN_L_SHAPE })).toThrow(
      '輪郭が閉じていないため',
    );
  });
});
