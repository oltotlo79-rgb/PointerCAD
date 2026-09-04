import { beforeAll, describe, expect, it } from 'vitest';

import type { BoxParameters, CurveSpec } from '../types.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import { makePlanarFace } from './makePlanarFace.js';
import { makeExtrudeSolid } from './makeSolidSweep.js';
import { buildSolidBodyMesh, hasSolid, isValidShape, measureArea, measureVolume } from './solidMesh.js';

const BOX: BoxParameters = { dx: 10, dy: 20, dz: 30 };
/** 10 × 20 × 30 = 6000 mm³。手計算した期待値で、実測に合わせて動かさない。 */
const BOX_VOLUME = 6000;
/** 10 × 20 × 30 の箱の表面積。2(10·20 + 20·30 + 30·10) = 2(200 + 600 + 300) = 2200 mm²。 */
const BOX_AREA = 2200;

/** 計画書 タスク3 の検証表にある板。40 × 30 を 10 押し出した形。 */
const PLATE_WIDTH = 40;
const PLATE_DEPTH = 30;
const PLATE_HEIGHT = 10;
/**
 * 40 × 30 × 10 の板の表面積。2(40·30 + 40·10 + 30·10) = 2(1200 + 400 + 300) = 3800 mm²。
 *
 * **計画書 タスク3 の検証表は同じ導出式に 4200 と書いているが、式を計算すると 3800 になる。**
 * 期待値を実測へ合わせるのではなく、導出式から自分で計算した 3800 を採る
 * (`rules/02-禁止事項.md`「テストの期待値を安易に書き換えない」)。
 */
const PLATE_AREA = 3800;

/** 半径 20 の円を Z へ 5 押し出した円柱の表面積。2π·20² + 2π·20·5 = 1000π mm²。 */
const CYLINDER_AREA = 1000 * Math.PI;

/** z = 0 の平面に置いた 40 × 30 の長方形。押し出すと板になる。 */
const PLATE_PROFILE: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 0, 0], to: [PLATE_WIDTH, 0, 0] },
  { kind: 'segment', from: [PLATE_WIDTH, 0, 0], to: [PLATE_WIDTH, PLATE_DEPTH, 0] },
  { kind: 'segment', from: [PLATE_WIDTH, PLATE_DEPTH, 0], to: [0, PLATE_DEPTH, 0] },
  { kind: 'segment', from: [0, PLATE_DEPTH, 0], to: [0, 0, 0] },
];

/** 半径 20 の円 1 本(全周)。押し出すと円柱になる。 */
const CIRCLE_PROFILE: readonly CurveSpec[] = [
  {
    kind: 'arc',
    center: [0, 0, 0],
    normal: [0, 0, 1],
    xAxis: [1, 0, 0],
    radius: 20,
    startAngle: 0,
    endAngle: 2 * Math.PI,
  },
];

/** z = 0 の平面に置いた 10 × 10 の正方形。面がソリッドを含まないことの確認に使う。 */
const SQUARE: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 0, 0], to: [10, 0, 0] },
  { kind: 'segment', from: [10, 0, 0], to: [10, 10, 0] },
  { kind: 'segment', from: [10, 10, 0], to: [0, 10, 0] },
  { kind: 'segment', from: [0, 10, 0], to: [0, 0, 0] },
];

describe('ソリッドの体積・妥当性・表示用データのまとめ取り', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  it('10 × 20 × 30 mm の箱の体積が 6000 mm³ になる', () => {
    const handle = makeBox(oc, BOX);
    try {
      expect(measureVolume(oc, handle.shape)).toBeCloseTo(BOX_VOLUME, 6);
    } finally {
      handle.delete();
    }
  });

  // 計画書 §1.2-2 の未確認点の実測を検査として残す。
  // 閉じた立体では OnlyClosed の真偽で結果が変わらないため、
  // measureVolume は false を採っている(solidMesh.ts の注釈を参照)。
  it('閉じた立体では OnlyClosed の true と false が同じ体積を返す', () => {
    const handle = makeBox(oc, BOX);
    const openProps = new oc.GProp_GProps_1();
    const closedProps = new oc.GProp_GProps_1();
    try {
      oc.BRepGProp.VolumeProperties_1(handle.shape, openProps, false, false, false);
      oc.BRepGProp.VolumeProperties_1(handle.shape, closedProps, true, false, false);
      expect(openProps.Mass()).toBeCloseTo(BOX_VOLUME, 6);
      expect(closedProps.Mass()).toBeCloseTo(BOX_VOLUME, 6);
      expect(openProps.Mass()).toBeCloseTo(closedProps.Mass(), 9);
    } finally {
      closedProps.delete();
      openProps.delete();
      handle.delete();
    }
  });

  it('箱は B-rep として妥当である', () => {
    const handle = makeBox(oc, BOX);
    try {
      expect(isValidShape(oc, handle.shape)).toBe(true);
    } finally {
      handle.delete();
    }
  });

  it('箱は閉じたソリッドを含む', () => {
    const handle = makeBox(oc, BOX);
    try {
      expect(hasSolid(oc, handle.shape)).toBe(true);
    } finally {
      handle.delete();
    }
  });

  it('平面の面はソリッドを含まない', () => {
    const handle = makePlanarFace(oc, SQUARE);
    try {
      expect(hasSolid(oc, handle.face)).toBe(false);
    } finally {
      handle.delete();
    }
  });

  it('平面の面の体積は 0 になる', () => {
    const handle = makePlanarFace(oc, SQUARE);
    try {
      expect(measureVolume(oc, handle.face)).toBeCloseTo(0, 6);
    } finally {
      handle.delete();
    }
  });

  it('箱の表示用データを面 6・三角形 12・稜線 12・体積 6000 でまとめて返す', () => {
    const handle = makeBox(oc, BOX);
    try {
      const body = buildSolidBodyMesh(oc, 'extrude-1', handle.shape);
      expect(body.id).toBe('extrude-1');
      expect(body.faceCount).toBe(6);
      expect(body.triangleCount).toBe(12);
      expect(body.edgeCount).toBe(12);
      expect(body.volume).toBeCloseTo(BOX_VOLUME, 6);
      // 直方体は節点 24 個(面ごとに 4 個 × 6 面)、三角形 12 枚、稜線 12 本。
      expect(body.positions.length).toBe(72);
      expect(body.normals.length).toBe(72);
      expect(body.indices.length).toBe(36);
      expect(body.edgePositions.length).toBe(72);
    } finally {
      handle.delete();
    }
  });

  // 計画書 §2.8(タスク10)。面・辺・頂点の一覧を collectSubShapes から添える。
  it('箱の面・辺・頂点の一覧を添え、faceCount / edgeCount が一覧の長さと一致する', () => {
    const handle = makeBox(oc, BOX);
    try {
      const body = buildSolidBodyMesh(oc, 'extrude-1', handle.shape);
      // faceCount / edgeCount は faces.length / edges.length と必ず一致する(§2.8)。
      expect(body.faces).toHaveLength(body.faceCount);
      expect(body.edges).toHaveLength(body.edgeCount);
      expect(body.faces).toHaveLength(6);
      expect(body.edges).toHaveLength(12);
      // 直方体の頂点は 8 個。
      expect(body.vertices).toHaveLength(8);
      // 通し番号は 0 始まりの連番(subShapes.ts の約束)。
      expect(body.faces.map((face) => face.index)).toEqual([0, 1, 2, 3, 4, 5]);
      // ねじ穴以外の段は印を渡さない。既定は空配列(threadMarks が第 5 引数の省略時)。
      expect(body.threadMarks).toEqual([]);
    } finally {
      handle.delete();
    }
  });

  // ここから下は P5 タスク3(FR-1102、FR-428)で足した表面積と形の種類。
  // 期待値はすべて手計算で、実測に合わせて動かさない。

  it('10 × 20 × 30 mm の箱の表面積が 2200 mm² になる', () => {
    const handle = makeBox(oc, BOX);
    try {
      expect(measureArea(oc, handle.shape)).toBeCloseTo(BOX_AREA, 6);
    } finally {
      handle.delete();
    }
  });

  it('40 × 30 × 10 mm の板の表面積が 3800 mm² になる', () => {
    const handle = makeExtrudeSolid(oc, {
      kind: 'extrude',
      profile: PLATE_PROFILE,
      direction: [0, 0, 1],
      distance: PLATE_HEIGHT,
    });
    try {
      expect(measureArea(oc, handle.shape)).toBeCloseTo(PLATE_AREA, 6);
    } finally {
      handle.delete();
    }
  });

  it('半径 20・高さ 5 の円柱の表面積が 1000π mm² になる', () => {
    const handle = makeExtrudeSolid(oc, {
      kind: 'extrude',
      profile: CIRCLE_PROFILE,
      direction: [0, 0, 1],
      distance: 5,
    });
    try {
      expect(measureArea(oc, handle.shape)).toBeCloseTo(CYLINDER_AREA, 6);
    } finally {
      handle.delete();
    }
  });

  // 全体の表面積(SurfaceProperties_1)と、面 1 枚ずつの面積(subShapes.ts)は
  // 同じ指定(SkipShared=false・UseTriangulation=false)で測っているので必ず一致する。
  it('箱の表面積は面ごとの面積の合計と一致する', () => {
    const handle = makeBox(oc, BOX);
    try {
      const body = buildSolidBodyMesh(oc, 'extrude-1', handle.shape);
      const sum = body.faces.reduce((total, face) => total + face.area, 0);
      expect(body.area).toBeCloseTo(sum, 6);
      expect(body.area).toBeCloseTo(BOX_AREA, 6);
    } finally {
      handle.delete();
    }
  });

  it('閉じた立体の bodyKind は solid になる(曲面はタスク41)', () => {
    const handle = makeBox(oc, BOX);
    try {
      const body = buildSolidBodyMesh(oc, 'extrude-1', handle.shape);
      expect(body.bodyKind).toBe('solid');
      expect(body.volume).toBeCloseTo(BOX_VOLUME, 6);
    } finally {
      handle.delete();
    }
  });

  // FR-428 の曲面が来たときの分岐を先に固定する(§0.a-0.45 の
  // 「shell の段だけ体積 0 を通して面積 > 0 を確かめる」の材料)。
  it('閉じていない面だけの形は bodyKind が shell になり、体積 0・面積 100 で返る', () => {
    const handle = makePlanarFace(oc, SQUARE);
    try {
      const body = buildSolidBodyMesh(oc, 'surface-1', handle.face);
      expect(body.bodyKind).toBe('shell');
      expect(body.volume).toBeCloseTo(0, 6);
      expect(body.area).toBeCloseTo(100, 6);
    } finally {
      handle.delete();
    }
  });

  it('渡した threadMarks をそのまま返す(ねじ穴の段、§0.a-0.15)', () => {
    const handle = makeBox(oc, BOX);
    try {
      const marks = [
        { origin: [0, 0, 0] as const, direction: [0, 0, 1] as const, majorDiameter: 6, length: 10 },
      ];
      const body = buildSolidBodyMesh(oc, 'thread-1', handle.shape, {}, marks);
      expect(body.threadMarks).toEqual(marks);
    } finally {
      handle.delete();
    }
  });
});
