import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { expectWithinBudget } from '../testUtils/perfBudget.js';
import type { CurveSpec, SolidBodyKind, SolidFaceInfo, SubShapeQuery, Vec3Tuple } from '../types.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import { makeExtrudeSolid } from './makeSolidSweep.js';
import type { SurfaceInput } from './makeSurface.js';
import { isShellShape, makeSurface, SHELL_NOT_SUPPORTED_MESSAGE } from './makeSurface.js';
import { buildSolidBodyMesh, hasSolid, measureArea, measureVolume } from './solidMesh.js';
import type { SubShapeTables } from './subShapes.js';
import { collectSubShapes } from './subShapes.js';
import { tessellate } from './tessellate.js';

/**
 * 曲面(面だけの形、FR-428)の検査。計画書 P5 タスク41 の検証表。
 *
 * **期待値はすべて手で解いた値**(計画書の数値をそのまま信じない。
 * `docs/報告記録.md` 2026-09-03 23:40 の②の対策)。導出は各定数の注釈にある。
 *
 * この検査がいちばん確かめたいのは、面積や面の数そのものより
 * **「立体になっていない(`hasSolid` が偽 = `bodyKind` が `'shell'`)」ことと、
 * それでもボディとして扱える(三角形分割が通り、面積が出る)こと**の 2 点である
 * (§0.a-0.45)。あわせて、**ソリッドの段の「体積 0 は失敗」が緩んでいないこと**も見る。
 */

/** 単一フィーチャーの所要の上限(ms)。要件 §5.2(NFR-PF-2)の数値そのままで、緩めない。 */
const SINGLE_STEP_BUDGET_MS = 500;

/** 開いた輪郭(長さ 40 の線分 1 本)を 10 押し出した面の面積 = 40 × 10。 */
const SEGMENT_EXTRUDE_AREA = 400;

/** 閉じた輪郭(40 × 30 の長方形)を 10 押し出した側面の面積 = 2 × (40 + 30) × 10。 */
const CLOSED_EXTRUDE_AREA = 1400;

/**
 * 半径 10 の半円弧を全周回した球面の面積 = 4π × 10² = 1256.6370614359173。
 * `4 * Math.PI * 100` をそのまま書かずに数値で置くのは、期待値を式ではなく値で固定するため
 * (この 10 進の並びは `4 * Math.PI * 100` と同じ倍精度の値になることを実測で確かめてある)。
 */
const SPHERE_AREA = 1256.6370614359173;

/** 40 × 30 の閉じた輪郭から張った平らな面の面積。 */
const PLANAR_AREA = 1200;

/**
 * ロフトの殻(40 × 30 → 20 × 15、高さ 10)の側面積 = 1386.396103067893。
 *
 * **導出。** 側面は台形 4 枚になる。
 * - x = ±20 側: 平行な 2 辺が 30 と 15、その間隔は (−10, 0, 10) の長さ √200 = 14.142135623730951。
 *   面積 = (30 + 15) / 2 × √200 = 22.5 × 14.142135623730951 = 318.1980515339464(2 枚で 636.3961030678928)。
 * - y = ±15 側: 平行な 2 辺が 40 と 20、その間隔は (0, −7.5, 10) の長さ √156.25 = 12.5。
 *   面積 = (40 + 20) / 2 × 12.5 = 375(2 枚で 750)。
 * 合計 636.3961030678928 + 750 = 1386.396103067893(倍精度で書ける並び)。
 */
const LOFT_SIDE_AREA = 1386.396103067893;

/**
 * 閉じた輪郭(40 × 30、原点中心、z = 0)を 10 押し出した**開いた殻**の体積の積分値 = 8000。
 *
 * **導出。** `measureVolume` は `OnlyClosed = false` で ∫(1/3)(r·n)dA を面ごとに足す
 * (`solidMesh.ts` の注釈)。ふたの無いこの殻では
 * x = ±20 の面が各 (1/3) × 20 × (30 × 10) = 2000、
 * y = ±15 の面が各 (1/3) × 15 × (40 × 10) = 2000 で、合計 8000 になる。
 *
 * **この値そのものに意味は無い。** ここで固定しておきたいのは
 * **「面だけの形の体積は 0 とは限らない」**ことである。だから `bodyKind` は
 * 体積ではなく `hasSolid` で決める(§0.a-0.45)。体積で見分けようとすると、
 * この殻は「体積 8000 の立体」に見えてしまう。
 */
const OPEN_SHELL_VOLUME_INTEGRAL = 8000;

/** 40 × 30 × 10 の箱。面の取り出し(指紋)の材料に使う。 */
const BOX_FACE_AREA = 1200;

/** 水平な長方形の閉じた輪郭(原点中心、高さ z)。線分 4 本で反時計回りに閉じる。 */
function rectangle(width: number, depth: number, z: number): readonly CurveSpec[] {
  const corners: readonly Vec3Tuple[] = [
    [-width / 2, -depth / 2, z],
    [width / 2, -depth / 2, z],
    [width / 2, depth / 2, z],
    [-width / 2, depth / 2, z],
  ];
  return corners.map((from, index) => ({
    kind: 'segment',
    from,
    to: corners[(index + 1) % corners.length],
  }));
}

/** 長さ 40 の線分 1 本(x = 0 の平面に乗るので、Z へ押し出した面も x = 0 に乗る)。 */
const SEGMENT_PROFILE: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 0, 0], to: [0, 40, 0] },
];

/**
 * 半径 10 の半円弧。中心は原点、面の法線は +Y、角度 0 の向きは +Z。
 * 角度 θ の点は (10 sinθ, 0, 10 cosθ) になり、θ = 0 → (0, 0, 10)、θ = π → (0, 0, −10)。
 * **両端が Z 軸に乗る**ので、Z 軸まわりに全周回すと球面 1 枚になる。
 */
const HALF_ARC_PROFILE: readonly CurveSpec[] = [
  {
    kind: 'arc',
    center: [0, 0, 0],
    normal: [0, 1, 0],
    xAxis: [0, 0, 1],
    radius: 10,
    startAngle: 0,
    endAngle: Math.PI,
  },
];

/** 測った結果をまとめて受け取る入れ物(形は必ず解放してから返す)。 */
interface Measured {
  readonly area: number;
  readonly reportedArea: number;
  readonly volume: number;
  readonly shell: boolean;
  readonly solid: boolean;
  readonly faceCount: number;
  readonly meshFaceCount: number;
  readonly meshTriangleCount: number;
  readonly meshBodyKind: SolidBodyKind | undefined;
  readonly meshArea: number;
  readonly elapsedMs: number;
}

describe('曲面(FR-428、§0.a-0.45、タスク41)', () => {
  let oc: OpenCascadeInstance;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  /** tessellate / extractEdges と同じ形から一覧を作る(実際の使われ方と同じ順序)。 */
  function collectTables(shape: TopoDS_Shape): SubShapeTables {
    const surface = tessellate(oc, shape);
    const lines = extractEdges(oc, shape);
    return collectSubShapes(oc, shape, surface.faceRanges, lines.edgeRanges);
  }

  /** 一覧の面 1 枚から、文書が保存するのと同じ形の指紋を作る。 */
  function faceQuery(face: SolidFaceInfo): SubShapeQuery {
    return {
      kind: 'face',
      index: face.index,
      surfaceKind: face.surfaceKind,
      area: face.area,
      position: face.centroid,
      axis: face.axis,
      radius: face.radius,
    };
  }

  /**
   * 曲面を 1 つ作り、面積・体積・種類・面の数・三角形分割まで測って必ず解放する。
   * **三角形分割は `buildSolidBodyMesh` そのもの**を呼ぶ(殻でも動くことの実測)。
   */
  function measureSurface(
    input: SurfaceInput,
    target: TopoDS_Shape | null = null,
    tables: SubShapeTables | null = null,
  ): Measured {
    const startedAt = performance.now();
    const result = makeSurface(oc, input, target, tables);
    const elapsedMs = performance.now() - startedAt;
    try {
      const mesh = buildSolidBodyMesh(oc, 'surface', result.shape);
      return {
        area: measureArea(oc, result.shape),
        reportedArea: result.area,
        volume: measureVolume(oc, result.shape),
        shell: isShellShape(oc, result.shape),
        solid: hasSolid(oc, result.shape),
        faceCount: collectTables(result.shape).faces.length,
        meshFaceCount: mesh.faceCount,
        meshTriangleCount: mesh.triangleCount,
        meshBodyKind: mesh.bodyKind,
        meshArea: mesh.area ?? 0,
        elapsedMs,
      };
    } finally {
      result.delete();
    }
  }

  /** 箱と、その面・辺・頂点の一覧を用意する(面の取り出しの材料)。 */
  function prepareBox(): { shape: TopoDS_Shape; tables: SubShapeTables; delete(): void } {
    const handle = makeBox(oc, { dx: 40, dy: 30, dz: 10 });
    return {
      shape: handle.shape,
      tables: collectTables(handle.shape),
      delete: () => {
        handle.delete();
      },
    };
  }

  describe('手順1: 使う道具が実行時にあるか(§1.4-15)', () => {
    it('曲面に使う 6 つのクラスが実行時に存在する', () => {
      // 型定義に載っていても embind が wasm 側で登録していなければ実行時には無い。
      // 確かめ方は loadOcct.node.test.ts の toBeTypeOf('function') 方式に揃える。
      expect(oc.BRepPrimAPI_MakePrism_1).toBeTypeOf('function');
      expect(oc.BRepPrimAPI_MakeRevol_1).toBeTypeOf('function');
      expect(oc.BRepOffsetAPI_ThruSections).toBeTypeOf('function');
      expect(oc.BRepBuilderAPI_MakeWire_1).toBeTypeOf('function');
      expect(oc.BRepBuilderAPI_MakeFace_15).toBeTypeOf('function');
      // 面のオフセット(§0.a-0.45)。列挙を取らない PerformBySimple だけを使う。
      expect(oc.BRepOffsetAPI_MakeOffsetShape).toBeTypeOf('function');
    });
  });

  describe('開いた輪郭を押し出した面', () => {
    it('長さ 40 の線分を 10 押し出すと、面積 400・面 1 枚・体積 0 の面だけの形になる', () => {
      const measured = measureSurface({
        kind: 'extrude',
        profile: SEGMENT_PROFILE,
        direction: [0, 0, 1],
        distance: 10,
      });

      expect(measured.area).toBeCloseTo(SEGMENT_EXTRUDE_AREA, 6);
      expect(measured.reportedArea).toBeCloseTo(SEGMENT_EXTRUDE_AREA, 6);
      expect(measured.faceCount).toBe(1);
      // 面が x = 0 の平面に乗るので ∫(1/3)(r·n)dA の被積分関数が面上で 0 になり、
      // 体積の積分値もちょうど 0 になる(この配置に限った性質。下の閉じた輪郭の検査を参照)。
      expect(Math.abs(measured.volume)).toBeLessThan(1e-9);
      // 立体ではない = bodyKind が 'shell'(§0.a-0.45)。
      expect(measured.solid).toBe(false);
      expect(measured.shell).toBe(true);
    });

    it('三角形分割が殻でも動き、bodyKind が shell・面積 > 0 になる', () => {
      const measured = measureSurface({
        kind: 'extrude',
        profile: SEGMENT_PROFILE,
        direction: [0, 0, 1],
        distance: 10,
      });

      expect(measured.meshBodyKind).toBe('shell');
      expect(measured.meshTriangleCount).toBeGreaterThan(0);
      expect(measured.meshFaceCount).toBe(1);
      expect(measured.meshArea).toBeCloseTo(SEGMENT_EXTRUDE_AREA, 6);
    });

    it('所要が単一フィーチャーの上限(NFR-PF-2)の中に収まる', () => {
      const measured = measureSurface({
        kind: 'extrude',
        profile: SEGMENT_PROFILE,
        direction: [0, 0, 1],
        distance: 10,
      });
      console.log(
        `曲面(開いた輪郭の押し出し)1 段: 実測 ${measured.elapsedMs.toFixed(1)} ms(上限 ${String(SINGLE_STEP_BUDGET_MS)} ms)`,
      );
      expectWithinBudget(measured.elapsedMs, SINGLE_STEP_BUDGET_MS, '曲面(押し出し)1 段');
    });
  });

  describe('閉じた輪郭を押し出した面', () => {
    it('40 × 30 の輪郭を 10 押し出すと、側面 4 枚・面積 1400 の面だけの形になる', () => {
      const measured = measureSurface({
        kind: 'extrude',
        profile: rectangle(40, 30, 0),
        direction: [0, 0, 1],
        distance: 10,
      });

      expect(measured.area).toBeCloseTo(CLOSED_EXTRUDE_AREA, 6);
      expect(measured.faceCount).toBe(4);
      // ふたを張らないので、閉じた輪郭からでも立体にはならない
      // (ここが makeSolidSweep.ts の押し出しとの違い。あちらは面を掃くので立体になる)。
      expect(measured.solid).toBe(false);
      expect(measured.shell).toBe(true);
      expect(measured.meshBodyKind).toBe('shell');
    });

    it('面だけの形の体積は 0 とは限らない(だから bodyKind は体積でなく hasSolid で決める)', () => {
      const measured = measureSurface({
        kind: 'extrude',
        profile: rectangle(40, 30, 0),
        direction: [0, 0, 1],
        distance: 10,
      });

      // 導出は OPEN_SHELL_VOLUME_INTEGRAL の注釈。面の向きによって符号が変わりうるので
      // 大きさで比べる。0 でないことが要点で、値そのものに意味は無い。
      expect(Math.abs(measured.volume)).toBeCloseTo(OPEN_SHELL_VOLUME_INTEGRAL, 6);
      expect(measured.shell).toBe(true);
    });
  });

  describe('回転した面', () => {
    it('半径 10 の半円弧を全周回すと球面(面積 4π × 100)になる', () => {
      const measured = measureSurface({
        kind: 'revolve',
        profile: HALF_ARC_PROFILE,
        axisOrigin: [0, 0, 0],
        axisDirection: [0, 0, 1],
        angle: 2 * Math.PI,
      });

      // 相対 1e-4 で見る(球面は解析的に作られるので実際はもっと近い。実測は下のログ)。
      expect(Math.abs(measured.area - SPHERE_AREA) / SPHERE_AREA).toBeLessThan(1e-4);
      expect(measured.solid).toBe(false);
      expect(measured.shell).toBe(true);
      expect(measured.meshBodyKind).toBe('shell');
      expect(measured.meshTriangleCount).toBeGreaterThan(0);
      console.log(
        `回転した球面: 面積 実測 ${String(measured.area)} / 期待 ${String(SPHERE_AREA)}、面 ${String(measured.faceCount)} 枚、所要 ${measured.elapsedMs.toFixed(1)} ms`,
      );
      expectWithinBudget(measured.elapsedMs, SINGLE_STEP_BUDGET_MS, '曲面(回転)1 段');
    });

    it('半周だけ回すと半球面(面積は全周の半分)になる', () => {
      const measured = measureSurface({
        kind: 'revolve',
        profile: HALF_ARC_PROFILE,
        axisOrigin: [0, 0, 0],
        axisDirection: [0, 0, 1],
        angle: Math.PI,
      });

      expect(Math.abs(measured.area - SPHERE_AREA / 2) / (SPHERE_AREA / 2)).toBeLessThan(1e-4);
      expect(measured.shell).toBe(true);
    });
  });

  describe('平らな面', () => {
    it('40 × 30 の閉じた輪郭から面積 1200 の面が 1 枚できる', () => {
      const measured = measureSurface({ kind: 'planar', profile: rectangle(40, 30, 0) });

      expect(measured.area).toBeCloseTo(PLANAR_AREA, 6);
      expect(measured.faceCount).toBe(1);
      // 面が z = 0 の平面に乗るので、体積の積分値はちょうど 0 になる。
      expect(Math.abs(measured.volume)).toBeLessThan(1e-9);
      expect(measured.shell).toBe(true);
      expect(measured.meshBodyKind).toBe('shell');
    });

    it('閉じていない輪郭は平らな面にできない(押し出しの面とはここが違う)', () => {
      expect(() => makeSurface(oc, { kind: 'planar', profile: SEGMENT_PROFILE })).toThrow(
        '輪郭が閉じていないため、面を張れませんでした。',
      );
    });
  });

  describe('ロフトの面', () => {
    it('40 × 30 → 20 × 15(高さ 10)をつなぐと、側面 4 枚の殻になる', () => {
      const measured = measureSurface({
        kind: 'loft',
        sections: [rectangle(40, 30, 0), rectangle(20, 15, 10)],
        ruled: true,
      });

      expect(measured.area).toBeCloseTo(LOFT_SIDE_AREA, 6);
      expect(measured.faceCount).toBe(4);
      expect(measured.solid).toBe(false);
      expect(measured.shell).toBe(true);
      expect(measured.meshBodyKind).toBe('shell');
      console.log(
        `ロフトの殻: 面積 実測 ${String(measured.area)} / 期待 ${String(LOFT_SIDE_AREA)}、所要 ${measured.elapsedMs.toFixed(1)} ms`,
      );
      expectWithinBudget(measured.elapsedMs, SINGLE_STEP_BUDGET_MS, '曲面(ロフト)1 段');
    });
  });

  /** 40 × 30 × 10 の箱の上面(法線が Z 向き・重心の z が 10)。 */
  function topFaceOf(tables: SubShapeTables): SolidFaceInfo | undefined {
    return tables.faces.find(
      (face) => face.axis !== null && Math.abs(face.axis[2]) > 0.999 && face.centroid[2] > 5,
    );
  }

  describe('既存の面の取り出し(指紋)', () => {
    it('40 × 30 × 10 の箱の上面を取り出すと、面積 1200 の面 1 枚になる', () => {
      const box = prepareBox();
      try {
        const top = topFaceOf(box.tables);
        expect(top).toBeDefined();
        if (top === undefined) {
          return;
        }

        const measured = measureSurface({ kind: 'face', face: faceQuery(top) }, box.shape, box.tables);

        expect(measured.area).toBeCloseTo(BOX_FACE_AREA, 6);
        expect(measured.faceCount).toBe(1);
        expect(measured.solid).toBe(false);
        expect(measured.shell).toBe(true);
        expect(measured.meshBodyKind).toBe('shell');
        expectWithinBudget(measured.elapsedMs, SINGLE_STEP_BUDGET_MS, '曲面(面の取り出し)1 段');
      } finally {
        box.delete();
      }
    });

    it('材料の立体は消費しない(取り出したあとも箱は立体のまま)', () => {
      const box = prepareBox();
      try {
        const top = box.tables.faces[0];
        const result = makeSurface(oc, { kind: 'face', face: faceQuery(top) }, box.shape, box.tables);
        result.delete();

        expect(hasSolid(oc, box.shape)).toBe(true);
        expect(measureVolume(oc, box.shape)).toBeCloseTo(12000, 6);
      } finally {
        box.delete();
      }
    });
  });

  /**
   * 面のオフセット(FR-428、§0.a-0.45 の承認、タスク42b)。
   *
   * 選び直した面を `BRepOffsetAPI_MakeOffsetShape.PerformBySimple` で距離だけ離す。
   * 検証は統括の指示のとおり「40×30×10 の上面を +5 → 殻・面積 1200・z = 15」。
   */
  describe('面のオフセット(§0.a-0.45)', () => {
    it('40 × 30 × 10 の上面を +5 ずらすと、面積 1200・z = 15 の殻になる', () => {
      const box = prepareBox();
      try {
        const top = topFaceOf(box.tables);
        expect(top).toBeDefined();
        if (top === undefined) {
          return;
        }
        // もとの上面は z = 10 にある(ずれ幅が 5 であることの基準)。
        expect(top.centroid[2]).toBeCloseTo(10, 9);

        const input: SurfaceInput = { kind: 'offset', face: faceQuery(top), distance: 5 };
        const measured = measureSurface(input, box.shape, box.tables);
        expect(measured.area).toBeCloseTo(BOX_FACE_AREA, 6);
        expect(measured.reportedArea).toBeCloseTo(BOX_FACE_AREA, 6);
        expect(measured.faceCount).toBe(1);
        expect(measured.solid).toBe(false);
        expect(measured.shell).toBe(true);
        expect(measured.meshBodyKind).toBe('shell');

        // 離した先の位置。面 1 枚なので、その重心の z がそのままずらした先になる。
        const result = makeSurface(oc, input, box.shape, box.tables);
        try {
          const faces = collectTables(result.shape).faces;
          expect(faces).toHaveLength(1);
          console.log(
            `面のオフセット: 面積 ${faces[0].area.toFixed(6)} / 重心 z ${faces[0].centroid[2].toFixed(6)}`,
          );
          expect(faces[0].centroid[2]).toBeCloseTo(15, 6);
          expect(faces[0].area).toBeCloseTo(BOX_FACE_AREA, 6);
        } finally {
          result.delete();
        }
        expectWithinBudget(measured.elapsedMs, SINGLE_STEP_BUDGET_MS, '曲面(面のオフセット)1 段');
      } finally {
        box.delete();
      }
    });

    it('負の距離なら逆側(z = 5)へ離れる', () => {
      const box = prepareBox();
      try {
        const top = topFaceOf(box.tables);
        expect(top).toBeDefined();
        if (top === undefined) {
          return;
        }
        const result = makeSurface(
          oc,
          { kind: 'offset', face: faceQuery(top), distance: -5 },
          box.shape,
          box.tables,
        );
        try {
          const faces = collectTables(result.shape).faces;
          expect(faces).toHaveLength(1);
          expect(faces[0].centroid[2]).toBeCloseTo(5, 6);
          expect(faces[0].area).toBeCloseTo(BOX_FACE_AREA, 6);
        } finally {
          result.delete();
        }
      } finally {
        box.delete();
      }
    });

    it('材料の立体は消費しない(ずらしたあとも箱は立体のまま)', () => {
      const box = prepareBox();
      try {
        const top = topFaceOf(box.tables);
        expect(top).toBeDefined();
        if (top === undefined) {
          return;
        }
        const result = makeSurface(
          oc,
          { kind: 'offset', face: faceQuery(top), distance: 5 },
          box.shape,
          box.tables,
        );
        result.delete();

        expect(hasSolid(oc, box.shape)).toBe(true);
        expect(measureVolume(oc, box.shape)).toBeCloseTo(12000, 6);
      } finally {
        box.delete();
      }
    });

    it('距離が 0 や NaN なら日本語で断る', () => {
      const box = prepareBox();
      try {
        const top = topFaceOf(box.tables);
        expect(top).toBeDefined();
        if (top === undefined) {
          return;
        }
        for (const distance of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
          expect(() =>
            makeSurface(
              oc,
              { kind: 'offset', face: faceQuery(top), distance },
              box.shape,
              box.tables,
            ),
          ).toThrow('面をずらす距離は 0 以外の数にしてください。');
        }
      } finally {
        box.delete();
      }
    });

    it('相手の立体が渡されていなければ断る(targetKey が要る段)', () => {
      const box = prepareBox();
      try {
        const top = topFaceOf(box.tables);
        expect(top).toBeDefined();
        if (top === undefined) {
          return;
        }
        expect(() =>
          makeSurface(oc, { kind: 'offset', face: faceQuery(top), distance: 5 }),
        ).toThrow('面を取り出す立体が選ばれていません。');
      } finally {
        box.delete();
      }
    });
  });

  describe('断り(FR-504、NFR-RE-1)', () => {
    it('押し出す長さが 0 以下なら断る', () => {
      expect(() =>
        makeSurface(oc, {
          kind: 'extrude',
          profile: SEGMENT_PROFILE,
          direction: [0, 0, 1],
          distance: 0,
        }),
      ).toThrow('押し出す長さは 0 より大きい数にしてください。');
    });

    it('曲線が 1 本も無ければ断る', () => {
      expect(() =>
        makeSurface(oc, { kind: 'extrude', profile: [], direction: [0, 0, 1], distance: 10 }),
      ).toThrow('面を作るには曲線が 1 本以上必要です。');
    });

    it('回転の角度が 360 度を超えたら断る', () => {
      expect(() =>
        makeSurface(oc, {
          kind: 'revolve',
          profile: HALF_ARC_PROFILE,
          axisOrigin: [0, 0, 0],
          axisDirection: [0, 0, 1],
          angle: 7,
        }),
      ).toThrow('回転の角度は 0 より大きく 360 度以下にしてください。');
    });

    it('回転の軸の向きが 0 なら断る', () => {
      expect(() =>
        makeSurface(oc, {
          kind: 'revolve',
          profile: HALF_ARC_PROFILE,
          axisOrigin: [0, 0, 0],
          axisDirection: [0, 0, 0],
          angle: Math.PI,
        }),
      ).toThrow('回転の軸が決まりません。軸を選び直してください。');
    });

    it('つなぐ断面が 1 つだけなら断る', () => {
      expect(() =>
        makeSurface(oc, { kind: 'loft', sections: [rectangle(40, 30, 0)], ruled: true }),
      ).toThrow('つなぐ面を 2 つ選んでください。');
    });

    it('面積が出ない押し出し(輪郭と同じ向きへ掃く)は「面を作れませんでした。」と断る', () => {
      expect(() =>
        makeSurface(oc, {
          kind: 'extrude',
          profile: SEGMENT_PROFILE,
          // 線分と同じ向きへ掃くと、掃いた跡が線分の上に重なって面積が出ない。
          direction: [0, 1, 0],
          distance: 10,
        }),
      ).toThrow('面を作れませんでした。');
    });

    it('面を取り出す相手の立体が無ければ断る', () => {
      const box = prepareBox();
      try {
        expect(() =>
          makeSurface(oc, { kind: 'face', face: faceQuery(box.tables.faces[0]) }),
        ).toThrow('面を取り出す立体が選ばれていません。立体を選び直してください。');
      } finally {
        box.delete();
      }
    });

    it('辺の指紋を渡したら断る(面以外からは面を作れない)', () => {
      const box = prepareBox();
      try {
        const edge = box.tables.edges[0];
        expect(() =>
          makeSurface(
            oc,
            {
              kind: 'face',
              face: {
                kind: 'edge',
                index: edge.index,
                curveKind: edge.curveKind,
                length: edge.length,
                position: edge.midpoint,
                axis: edge.axis,
                radius: edge.radius,
              },
            },
            box.shape,
            box.tables,
          ),
        ).toThrow('面を選んでください。線や点からは面を作れません。');
      } finally {
        box.delete();
      }
    });

    it('指紋に合う面が無ければ「選び直してください」と断る', () => {
      const box = prepareBox();
      try {
        // 箱に存在しない種類(球面)の指紋。必須の一致条件を外すので誰にも当たらない。
        expect(() =>
          makeSurface(
            oc,
            {
              kind: 'face',
              face: {
                kind: 'face',
                index: 0,
                surfaceKind: 'sphere',
                area: 1200,
                position: [20, 15, 10],
                axis: [0, 0, 1],
                radius: 5,
              },
            },
            box.shape,
            box.tables,
          ),
        ).toThrow('選び直してください。');
      } finally {
        box.delete();
      }
    });
  });

  describe('ソリッドの段の検査を 1 つも緩めていないこと(§0.a-0.45 の条件)', () => {
    it('立体は今までどおり bodyKind が solid になり、面だけの形とは見分けられる', () => {
      const box = prepareBox();
      try {
        expect(hasSolid(oc, box.shape)).toBe(true);
        expect(isShellShape(oc, box.shape)).toBe(false);
        expect(buildSolidBodyMesh(oc, 'box', box.shape).bodyKind).toBe('solid');
      } finally {
        box.delete();
      }
    });

    it('立体の押し出しは、厚みが出なければ今までどおり断る(体積 0 は失敗のまま)', () => {
      // 断面と同じ平面へ押し出す指定。曲面の段を足しても、ここが通るようになってはいけない。
      expect(() =>
        makeExtrudeSolid(oc, {
          kind: 'extrude',
          profile: rectangle(40, 30, 0),
          direction: [1, 0, 0],
          distance: 10,
        }),
      ).toThrow('押し出しても厚みが出ませんでした。長さを大きくしてください。');
    });

    it('立体の押し出しは今までどおり体積 12000 の立体を作る', () => {
      const handle = makeExtrudeSolid(oc, {
        kind: 'extrude',
        profile: rectangle(40, 30, 0),
        direction: [0, 0, 1],
        distance: 10,
      });
      try {
        expect(hasSolid(oc, handle.shape)).toBe(true);
        expect(measureVolume(oc, handle.shape)).toBeCloseTo(12000, 6);
      } finally {
        handle.delete();
      }
    });
  });

  describe('タスク42 への材料', () => {
    it('面だけの形に加工を掛けさせない文言が用意されている', () => {
      // 実際に断りを足すのはタスク42(makeFillet.ts / makeHole.ts など)。
      // ここでは判定と文言が 1 か所にまとまっていることだけを固定する。
      expect(SHELL_NOT_SUPPORTED_MESSAGE).toContain('面だけの形には使えません');
    });

    it('作った面の面積は測り直さなくても結果に添えて返る', () => {
      const result = makeSurface(oc, {
        kind: 'extrude',
        profile: rectangle(40, 30, 0),
        direction: [0, 0, 1],
        distance: 10,
      });
      try {
        expect(result.area).toBeCloseTo(CLOSED_EXTRUDE_AREA, 6);
        expect(result.area).toBeCloseTo(measureArea(oc, result.shape), 9);
      } finally {
        result.delete();
      }
    });
  });

  describe('確保した領域の後始末', () => {
    it('delete() を 2 度呼んでも落ちない(controllers の release と同じ約束)', () => {
      const result = makeSurface(oc, { kind: 'planar', profile: rectangle(40, 30, 0) });
      result.delete();
      expect(() => {
        result.delete();
      }).not.toThrow();
    });

    it('断ったときは自分で確保した領域を返す(控えが残らない)', () => {
      // 控えの中身は外から数えられないので、断りが例外として出ることと、
      // 続けて同じ関数を使っても結果が変わらないことで代用する。
      expect(() =>
        makeSurface(oc, {
          kind: 'extrude',
          profile: SEGMENT_PROFILE,
          direction: [0, 0, 1],
          distance: -1,
        }),
      ).toThrow();
      const measured = measureSurface({
        kind: 'extrude',
        profile: SEGMENT_PROFILE,
        direction: [0, 0, 1],
        distance: 10,
      });
      expect(measured.area).toBeCloseTo(SEGMENT_EXTRUDE_AREA, 6);
    });
  });
});
