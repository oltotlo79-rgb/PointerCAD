import { expectWithinBudget } from '@pointercad/test-utils';
import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';

import type { CurveSpec, ExtrudeStepSpec, RevolveStepSpec } from '../types.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makePlanarFace } from './makePlanarFace.js';
import type { ExtrudeEndSpec } from './makeSolidSweep.js';
import { makeExtrudeSolid, makeRevolveSolid } from './makeSolidSweep.js';
import { buildSolidBodyMesh, hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import { makeCompound } from './transformShape.js';

/** z = 0 の平面(XY 面)に置いた 40 × 30 の長方形。P2 完了条件の「簡単な部品」の断面。 */
const RECTANGLE_40_30: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 0, 0], to: [40, 0, 0] },
  { kind: 'segment', from: [40, 0, 0], to: [40, 30, 0] },
  { kind: 'segment', from: [40, 30, 0], to: [0, 30, 0] },
  { kind: 'segment', from: [0, 30, 0], to: [0, 0, 0] },
];

/** z = height の平面に置いた長方形(反時計回り)。押し出しの相手になる板を作るのに使う。 */
function rectangleAt(
  height: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
): readonly CurveSpec[] {
  return [
    { kind: 'segment', from: [minX, minY, height], to: [maxX, minY, height] },
    { kind: 'segment', from: [maxX, minY, height], to: [maxX, maxY, height] },
    { kind: 'segment', from: [maxX, maxY, height], to: [minX, maxY, height] },
    { kind: 'segment', from: [minX, maxY, height], to: [minX, minY, height] },
  ];
}

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

/** 稜線の並び(点 1 つあたり x・y・z の 3 個)から、指定した軸の最小・最大を求める。 */
function edgeRange(edgePositions: Float32Array, axis: 0 | 1 | 2): readonly [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = axis; index < edgePositions.length; index += 3) {
    min = Math.min(min, edgePositions[index]);
    max = Math.max(max, edgePositions[index]);
  }
  return [min, max];
}

/** 稜線の並びから z の最小・最大を求める。 */
function edgeRangeZ(edgePositions: Float32Array): readonly [number, number] {
  return edgeRange(edgePositions, 2);
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

/**
 * 板(押し出しの相手)を 1 枚作る。x は −10 → 50、y は −10 → 40 で、
 * 40 × 30 の断面をどの高さでも完全に覆う大きさにしてある。
 */
function makePlate(
  oc: OpenCascadeInstance,
  bottom: number,
  thickness: number,
): ReturnType<typeof makeExtrudeSolid> {
  return makeExtrudeSolid(oc, {
    kind: 'extrude',
    profile: rectangleAt(bottom, -10, 50, -10, 40),
    direction: [0, 0, 1],
    distance: thickness,
  });
}

/** 「次の面まで」の指定。相手は呼び出しごとに渡す。 */
const TO_NEXT: ExtrudeEndSpec = { kind: 'toNext' };

/** 5 度(ラジアン)。テーパの検証で使う。 */
const TAPER_5_DEG = (5 * Math.PI) / 180;

/** T = 10·tan5° = 0.87488663525924 mm(倍精度で表せる最も近い数を書く)。押し出した先の 1 辺が片側に縮む(広がる)量。 */
const TAPER_5_SHIFT = 0.8748866352592402;

/**
 * 40 × 30 を 10 押し出し、側面を 5° 内へ絞ったときの体積 11397.785043645907 mm³。
 *
 * 高さ z での断面は (40 − 2z·tan5)(30 − 2z·tan5) なので
 *   V = ∫₀¹⁰ (1200 − 140·tan5·z + 4·tan²5·z²) dz
 *     = 12000 − 7000·tan5 + (4000/3)·tan²5
 * (計画書 §2.11 の (1/tan5)·(1200T − 70T² + (4/3)T³) と同じ式。T = 10·tan5)
 */
const TAPER_INWARD_VOLUME = 11397.785043645907;

/** 同じ形を 5° 外へ広げたときの体積 12622.626333008903 mm³(計画書の値。倍精度で表せる最も近い数は 12622.626333008902)(上の式の符号違い)。 */
const TAPER_OUTWARD_VOLUME = 12622.626333008902;

/**
 * 40 × 30 を 5° 内へ絞りながら、z = 10 から z = 20 の板の中だけ残したときの
 * 体積 10234.177884247418 mm³。
 *   V = ∫₁₀²⁰ (1200 − 140·tan5·z + 4·tan²5·z²) dz
 *     = 12000 − 21000·tan5 + (28000/3)·tan²5
 */
const TAPER_IN_PLATE_VOLUME = 10234.177884247418;

/** 押し出し 1 段の所要の上限(ms)。要件 §5.2(NFR-PF-2)の数値そのままで、緩めない。 */
const SINGLE_STEP_BUDGET_MS = 500;

describe('押し出しの終端の指定(FR-415)', () => {
  let oc: OpenCascadeInstance;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  it('両側へ 10 / 10 押し出すと体積 24000 で z が −10 から 10 になる', () => {
    const handle = makeExtrudeSolid(
      oc,
      EXTRUDE_UP,
      {},
      { end: { kind: 'symmetric', forward: 10, backward: 10 } },
    );
    try {
      // 40 · 30 · (10 + 10) = 24000 mm³。
      expect(measureVolume(oc, handle.shape)).toBeCloseTo(24000, 6);
      expect(hasSolid(oc, handle.shape)).toBe(true);
      expect(isValidShape(oc, handle.shape)).toBe(true);

      const body = buildSolidBodyMesh(oc, 'symmetric-1', handle.shape);
      const [minZ, maxZ] = edgeRangeZ(body.edgePositions);
      expect(minZ).toBeCloseTo(-10, 4);
      expect(maxZ).toBeCloseTo(10, 4);
    } finally {
      handle.delete();
    }
  });

  it('前 15 / 後 5 でも合計は同じ 24000 で、位置だけがずれる', () => {
    const handle = makeExtrudeSolid(
      oc,
      EXTRUDE_UP,
      {},
      { end: { kind: 'symmetric', forward: 15, backward: 5 } },
    );
    try {
      // 40 · 30 · (15 + 5) = 24000 mm³。合計が同じなら体積も同じになる。
      expect(measureVolume(oc, handle.shape)).toBeCloseTo(24000, 6);

      const body = buildSolidBodyMesh(oc, 'symmetric-2', handle.shape);
      const [minZ, maxZ] = edgeRangeZ(body.edgePositions);
      expect(minZ).toBeCloseTo(-5, 4);
      expect(maxZ).toBeCloseTo(15, 4);
    } finally {
      handle.delete();
    }
  });

  it('後ろを 0 にした両側の指定は、いままでの片側の押し出しと同じ形になる', () => {
    const handle = makeExtrudeSolid(
      oc,
      EXTRUDE_UP,
      {},
      { end: { kind: 'symmetric', forward: 10, backward: 0 } },
    );
    try {
      expect(measureVolume(oc, handle.shape)).toBeCloseTo(EXTRUDE_VOLUME, 6);
      const body = buildSolidBodyMesh(oc, 'symmetric-3', handle.shape);
      const [minZ, maxZ] = edgeRangeZ(body.edgePositions);
      expect(minZ).toBeCloseTo(0, 4);
      expect(maxZ).toBeCloseTo(10, 4);
    } finally {
      handle.delete();
    }
  });

  it('両側とも 0 のときは理由を添えて断る', () => {
    expect(() =>
      makeExtrudeSolid(oc, EXTRUDE_UP, {}, { end: { kind: 'symmetric', forward: 0, backward: 0 } }),
    ).toThrow('押し出す長さは 0 より大きい数にしてください。');
  });

  it('両側の一方が負のときも同じ理由で断る', () => {
    expect(() =>
      makeExtrudeSolid(
        oc,
        EXTRUDE_UP,
        {},
        { end: { kind: 'symmetric', forward: 15, backward: -5 } },
      ),
    ).toThrow('押し出す長さは 0 より大きい数にしてください。');
  });

  it('「指定の面まで」は model が測った距離ぶん押し出す(距離の指定と同じ形)', () => {
    const handle = makeExtrudeSolid(oc, EXTRUDE_UP, {}, { end: { kind: 'toFace', distance: 10 } });
    try {
      expect(measureVolume(oc, handle.shape)).toBeCloseTo(EXTRUDE_VOLUME, 6);
      const body = buildSolidBodyMesh(oc, 'to-face-1', handle.shape);
      const [minZ, maxZ] = edgeRangeZ(body.edgePositions);
      expect(minZ).toBeCloseTo(0, 4);
      expect(maxZ).toBeCloseTo(10, 4);
    } finally {
      handle.delete();
    }
  });

  it('「指定の面まで」の距離が 0 のときは断る(面と断面が重なっている場合)', () => {
    expect(() =>
      makeExtrudeSolid(oc, EXTRUDE_UP, {}, { end: { kind: 'toFace', distance: 0 } }),
    ).toThrow('押し出す長さは 0 より大きい数にしてください。');
  });

  it('「次の面まで」10 mm 上に厚さ 10 の板があると、その板の中だけが残る', () => {
    const plate = makePlate(oc, 10, 10);
    try {
      const handle = makeExtrudeSolid(oc, EXTRUDE_UP, {}, { end: TO_NEXT, target: plate.shape });
      try {
        // 板の厚み 10 のあいだだけが共通部分になる。40 · 30 · 10 = 12000 mm³。
        expect(measureVolume(oc, handle.shape)).toBeCloseTo(EXTRUDE_VOLUME, 6);
        expect(hasSolid(oc, handle.shape)).toBe(true);
        expect(isValidShape(oc, handle.shape)).toBe(true);

        const body = buildSolidBodyMesh(oc, 'to-next-1', handle.shape);
        const [minZ, maxZ] = edgeRangeZ(body.edgePositions);
        expect(minZ).toBeCloseTo(10, 4);
        expect(maxZ).toBeCloseTo(20, 4);
      } finally {
        handle.delete();
      }
    } finally {
      plate.delete();
    }
  });

  it('「次の面まで」板の下面から押すと、板を貫かず上面で止まる', () => {
    const plate = makePlate(oc, 0, 25);
    try {
      const handle = makeExtrudeSolid(oc, EXTRUDE_UP, {}, { end: TO_NEXT, target: plate.shape });
      try {
        // 40 · 30 · 25 = 30000 mm³。次にぶつかる面は板の上面(z = 25)。
        expect(measureVolume(oc, handle.shape)).toBeCloseTo(30000, 6);

        const body = buildSolidBodyMesh(oc, 'to-next-2', handle.shape);
        const [minZ, maxZ] = edgeRangeZ(body.edgePositions);
        expect(minZ).toBeCloseTo(0, 4);
        expect(maxZ).toBeCloseTo(25, 4);
      } finally {
        handle.delete();
      }
    } finally {
      plate.delete();
    }
  });

  it('「次の面まで」板が 2 枚あるときは手前の 1 枚だけで止まる', () => {
    const near = makePlate(oc, 10, 10);
    const far = makePlate(oc, 30, 10);
    const both = makeCompound(oc, [near.shape, far.shape]);
    try {
      const handle = makeExtrudeSolid(oc, EXTRUDE_UP, {}, { end: TO_NEXT, target: both.shape });
      try {
        // 手前の板(z = 10 〜 20)だけが残るので 40 · 30 · 10 = 12000 mm³。
        expect(measureVolume(oc, handle.shape)).toBeCloseTo(EXTRUDE_VOLUME, 6);

        const body = buildSolidBodyMesh(oc, 'to-next-3', handle.shape);
        const [minZ, maxZ] = edgeRangeZ(body.edgePositions);
        expect(minZ).toBeCloseTo(10, 4);
        expect(maxZ).toBeCloseTo(20, 4);
      } finally {
        handle.delete();
      }
    } finally {
      both.delete();
      far.delete();
      near.delete();
    }
  });

  it('「次の面まで」押し出す先に何も無いときは理由を添えて断る', () => {
    // 板は押し出しの反対側(z = −20 〜 −10)にあるので、+Z へ押しても当たらない。
    const plate = makePlate(oc, -20, 10);
    try {
      expect(() =>
        makeExtrudeSolid(oc, EXTRUDE_UP, {}, { end: TO_NEXT, target: plate.shape }),
      ).toThrow('押し出す先に立体がありません。');
    } finally {
      plate.delete();
    }
  });

  it('「次の面まで」相手の立体が渡されていないときも同じ理由で断る', () => {
    expect(() => makeExtrudeSolid(oc, EXTRUDE_UP, {}, { end: TO_NEXT })).toThrow(
      '押し出す先に立体がありません。',
    );
  });

  it('「次の面まで」1 段の所要が 500 ms 以内(NFR-PF-2)', () => {
    const plate = makePlate(oc, 10, 10);
    try {
      const startedAt = performance.now();
      const handle = makeExtrudeSolid(oc, EXTRUDE_UP, {}, { end: TO_NEXT, target: plate.shape });
      const elapsedMs = performance.now() - startedAt;
      handle.delete();
      console.log(
        `「次の面まで」1 段: 実測 ${elapsedMs.toFixed(1)} ms(上限 ${String(SINGLE_STEP_BUDGET_MS)} ms)`,
      );
      expectWithinBudget(elapsedMs, SINGLE_STEP_BUDGET_MS, '「次の面まで」1 段');
    } finally {
      plate.delete();
    }
  });
});

describe('押し出しのテーパ角(FR-401)', () => {
  let oc: OpenCascadeInstance;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  it('5 度で内へ絞ると体積が 11397.785043645907 になる', () => {
    // 期待値そのものを積分の式で検算する(高さ z の断面 (40 − 2z·tan5)(30 − 2z·tan5))。
    const tangent = Math.tan(TAPER_5_DEG);
    expect(TAPER_INWARD_VOLUME).toBeCloseTo(
      12000 - 7000 * tangent + (4000 / 3) * tangent * tangent,
      6,
    );

    const handle = makeExtrudeSolid(oc, EXTRUDE_UP, {}, { taperAngle: TAPER_5_DEG });
    try {
      expect(measureVolume(oc, handle.shape)).toBeCloseTo(TAPER_INWARD_VOLUME, 6);
      expect(hasSolid(oc, handle.shape)).toBe(true);
      expect(isValidShape(oc, handle.shape)).toBe(true);
      // 傾けても四角い柱のままなので面は 6 枚。
      expect(buildSolidBodyMesh(oc, 'taper-1', handle.shape).faceCount).toBe(6);
    } finally {
      handle.delete();
    }
  });

  it('5 度で外へ広げると体積が 12622.6263330089 になる', () => {
    const tangent = Math.tan(TAPER_5_DEG);
    expect(TAPER_OUTWARD_VOLUME).toBeCloseTo(
      12000 + 7000 * tangent + (4000 / 3) * tangent * tangent,
      6,
    );

    const handle = makeExtrudeSolid(
      oc,
      EXTRUDE_UP,
      {},
      { taperAngle: TAPER_5_DEG, taperOutward: true },
    );
    try {
      expect(measureVolume(oc, handle.shape)).toBeCloseTo(TAPER_OUTWARD_VOLUME, 6);
      expect(isValidShape(oc, handle.shape)).toBe(true);
    } finally {
      handle.delete();
    }
  });

  it('内へ絞っても断面(押し始めの面)の大きさは変わらない', () => {
    const handle = makeExtrudeSolid(oc, EXTRUDE_UP, {}, { taperAngle: TAPER_5_DEG });
    try {
      const body = buildSolidBodyMesh(oc, 'taper-3', handle.shape);
      // 中立面は断面なので、いちばん広いところは指定どおりの 40 × 30 のまま。
      expect(edgeRange(body.edgePositions, 0)[0]).toBeCloseTo(0, 4);
      expect(edgeRange(body.edgePositions, 0)[1]).toBeCloseTo(40, 4);
      expect(edgeRange(body.edgePositions, 1)[0]).toBeCloseTo(0, 4);
      expect(edgeRange(body.edgePositions, 1)[1]).toBeCloseTo(30, 4);
      // 押し出した先は片側 T ずつ縮んで 38.25022672948152 × 28.25022672948152 になる。
      expect(40 - 2 * TAPER_5_SHIFT).toBeCloseTo(38.25022672948152, 9);
    } finally {
      handle.delete();
    }
  });

  it('外へ広げると押し出した先が片側 0.87488663525924 mm ずつはみ出す', () => {
    const handle = makeExtrudeSolid(
      oc,
      EXTRUDE_UP,
      {},
      { taperAngle: TAPER_5_DEG, taperOutward: true },
    );
    try {
      const body = buildSolidBodyMesh(oc, 'taper-4', handle.shape);
      expect(edgeRange(body.edgePositions, 0)[0]).toBeCloseTo(-TAPER_5_SHIFT, 4);
      expect(edgeRange(body.edgePositions, 0)[1]).toBeCloseTo(40 + TAPER_5_SHIFT, 4);
      expect(edgeRange(body.edgePositions, 1)[0]).toBeCloseTo(-TAPER_5_SHIFT, 4);
      expect(edgeRange(body.edgePositions, 1)[1]).toBeCloseTo(30 + TAPER_5_SHIFT, 4);
    } finally {
      handle.delete();
    }
  });

  it('傾きが 0 のときは何もしない(いままでと同じ直方体)', () => {
    const handle = makeExtrudeSolid(oc, EXTRUDE_UP, {}, { taperAngle: 0 });
    try {
      expect(measureVolume(oc, handle.shape)).toBeCloseTo(EXTRUDE_VOLUME, 6);
      const body = buildSolidBodyMesh(oc, 'taper-5', handle.shape);
      expect(body.faceCount).toBe(6);
      expect(body.triangleCount).toBe(12);
      expect(body.edgeCount).toBe(12);
    } finally {
      handle.delete();
    }
  });

  it('傾きが 90 度以上のときは理由を添えて断る', () => {
    expect(() => makeExtrudeSolid(oc, EXTRUDE_UP, {}, { taperAngle: Math.PI / 2 })).toThrow(
      '押し出しの傾きは 0 度以上 90 度未満にしてください。',
    );
  });

  it('傾きが負のときも同じ理由で断る(向きは taperOutward で指定する)', () => {
    expect(() => makeExtrudeSolid(oc, EXTRUDE_UP, {}, { taperAngle: -TAPER_5_DEG })).toThrow(
      '押し出しの傾きは 0 度以上 90 度未満にしてください。',
    );
  });

  it('傾きが大きすぎて形が潰れるときは理由を添えて断る', () => {
    // 40 × 30 を 89 度で 10 押し出すと、側面が中心へ倒れ込んで立体にならない。
    expect(() => makeExtrudeSolid(oc, EXTRUDE_UP, {}, { taperAngle: (89 * Math.PI) / 180 })).toThrow(
      '押し出しに傾きを付けられませんでした。角度を小さくしてください。',
    );
  });

  it('傾きと「次の面まで」を同時に指定できる', () => {
    const plate = makePlate(oc, 10, 10);
    try {
      const handle = makeExtrudeSolid(
        oc,
        EXTRUDE_UP,
        {},
        { end: TO_NEXT, target: plate.shape, taperAngle: TAPER_5_DEG },
      );
      try {
        // 板の中(z = 10 〜 20)だけを残した角錐台。
        // V = ∫₁₀²⁰ (1200 − 140·tan5·z + 4·tan²5·z²) dz = 12000 − 21000·tan5 + (28000/3)·tan²5。
        const tangent = Math.tan(TAPER_5_DEG);
        expect(TAPER_IN_PLATE_VOLUME).toBeCloseTo(
          12000 - 21000 * tangent + (28000 / 3) * tangent * tangent,
          6,
        );
        expect(measureVolume(oc, handle.shape)).toBeCloseTo(TAPER_IN_PLATE_VOLUME, 6);
        expect(isValidShape(oc, handle.shape)).toBe(true);
      } finally {
        handle.delete();
      }
    } finally {
      plate.delete();
    }
  });

  it('テーパと押し出しの終端に使う OCCT の道具が実行時にある(計画書 §1.5-1・§1.5-3)', () => {
    // §1.5-1: テーパは BRepOffsetAPI_DraftAngle_2 で作る(§0.a-0.34・0.35)。
    expect(typeof oc.BRepOffsetAPI_DraftAngle_2).toBe('function');
    // §1.5-3: BRepFeat_MakePrism_2 も実在するが、採らなかった理由は実測にある(報告記録)。
    expect(typeof oc.BRepFeat_MakePrism_2).toBe('function');
  });
});
