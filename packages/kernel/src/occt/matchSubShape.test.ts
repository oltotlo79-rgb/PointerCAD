import { describe, expect, it } from 'vitest';

import type {
  EdgeCurveKind,
  FaceSurfaceKind,
  SolidEdgeInfo,
  SolidFaceInfo,
  SolidVertexInfo,
  SubShapeQuery,
  Vec3Tuple,
} from '../types.js';
import {
  MATCH_WEIGHT_AXIS,
  MATCH_WEIGHT_INDEX,
  MATCH_WEIGHT_POSITION,
  MATCH_WEIGHT_SIZE,
  MATCH_WEIGHT_VERTEX_INDEX,
  MATCH_WEIGHT_VERTEX_POSITION,
  SUB_SHAPE_MATCH_THRESHOLD,
  matchEdge,
  matchFace,
  matchVertex,
  scoreAxis,
  scoreEdge,
  scoreFace,
  scorePosition,
  scoreSize,
  scoreVertex,
} from './matchSubShape.js';

/**
 * 計画書 P3 §2.2.3 の検算表をそのまま検査にする(タスク5 手順 3)。
 *
 * 場面は「40×30 の面を Z へ 10 押し出した箱の上の面」を指紋に保存したあと、
 * 押し出しの距離や断面の大きさを変えて作り直した形から、同じ面を選び直せるかである。
 *
 * **期待値は計画書の丸めた値を写さず、ここで独立に計算した値を使う**
 * (docs/報告記録.md 2026-09-03 07:58 の②「自分で検算できない数を期待値に書かない」)。
 * 導出は各検査の注釈に式で書いてあり、計画書の丸めた値とも突き合わせている。
 */

/** 指紋(保存側)= 平面・面積 1200・軸 [0,0,1]・位置 [20,15,10]・番号 0。 */
const TOP_FACE_QUERY: Extract<SubShapeQuery, { kind: 'face' }> = {
  kind: 'face',
  index: 0,
  surfaceKind: 'plane',
  area: 1200,
  position: [20, 15, 10],
  axis: [0, 0, 1],
  radius: null,
};

/**
 * 距離を 10 → 20 に変えた箱(40×30×20)の scale。
 * 境界箱の対角長 √(40²+30²+20²) = 53.85164807134504 の半分(§2.2.3)。
 */
const SCALE_TALLER = Math.hypot(40, 30, 20) / 2;

/** 断面を 80×60 へ相似に広げた箱(80×60×10)の scale。対角長 √(80²+60²+10²) の半分。 */
const SCALE_WIDER = Math.hypot(80, 60, 10) / 2;

function faceInfo(
  index: number,
  surfaceKind: FaceSurfaceKind,
  area: number,
  centroid: Vec3Tuple,
  axis: Vec3Tuple | null,
  radius: number | null = null,
): SolidFaceInfo {
  // 三角形の範囲(triangleOffset / triangleCount)は採点に使わないので 0 でよい。
  return { index, surfaceKind, area, centroid, axis, radius, triangleOffset: 0, triangleCount: 0 };
}

function edgeInfo(
  index: number,
  curveKind: EdgeCurveKind,
  length: number,
  midpoint: Vec3Tuple,
  axis: Vec3Tuple | null,
  radius: number | null = null,
): SolidEdgeInfo {
  // start / end と線分の範囲は採点に使わない。中点だけが位置の材料になる。
  return {
    index,
    curveKind,
    length,
    midpoint,
    start: [0, 0, 0],
    end: [0, 0, 0],
    axis,
    radius,
    segmentOffset: 0,
    segmentCount: 0,
  };
}

function vertexInfo(index: number, position: Vec3Tuple): SolidVertexInfo {
  return { index, position };
}

/** 距離を 10 → 20 に変えた箱の、上の面・下の面・側面(x=40)。 */
const TALLER_TOP = faceInfo(0, 'plane', 1200, [20, 15, 20], [0, 0, 1]);
const TALLER_BOTTOM = faceInfo(1, 'plane', 1200, [20, 15, 0], [0, 0, -1]);
const TALLER_SIDE = faceInfo(2, 'plane', 600, [40, 15, 10], [1, 0, 0]);

describe('部分形状の指紋の採点(計画書 §2.2.3、FR-502、FR-504)', () => {
  describe('検算表の 4 例(§2.2.3)', () => {
    it('距離を 10 → 20 に変えても、上の面は 0.9257 で選び直せる', () => {
      const parts = scoreFace(TALLER_TOP, TOP_FACE_QUERY, SCALE_TALLER);

      // 軸 [0,0,1]・面積 1200・番号 0 は変わらず、重心だけが z=10 → z=20 へ 10 動く。
      // 0.35·1 + 0.25·1 + 0.2·1 + 0.2·(1 − 10/26.92582403567252) = 0.9257218647291793
      expect(parts.axis).toBe(1);
      expect(parts.size).toBe(1);
      expect(parts.index).toBe(1);
      expect(parts.position).toBeCloseTo(0.6286093236458963, 9);
      expect(parts.total).toBeCloseTo(0.9257218647291793, 9);
      // 計画書の丸めた値(0.9257)とも一致する。
      expect(parts.total).toBeCloseTo(0.9257, 3);
      expect(parts.total).toBeGreaterThanOrEqual(SUB_SHAPE_MATCH_THRESHOLD);
    });

    it('裏の面(下の面)は 0.3757 でしきい値に届かない', () => {
      const parts = scoreFace(TALLER_BOTTOM, TOP_FACE_QUERY, SCALE_TALLER);

      // 法線が真逆なので内積 −1 → max(0, −1) = 0。番号も 0 → 1 へずれている。
      // 0.35·0 + 0.25·1 + 0.2·0 + 0.2·0.6286093236458963 = 0.37572186472917923
      expect(parts.axis).toBe(0);
      expect(parts.index).toBe(0);
      expect(parts.total).toBeCloseTo(0.37572186472917923, 9);
      expect(parts.total).toBeCloseTo(0.3757, 3);
      expect(parts.total).toBeLessThan(SUB_SHAPE_MATCH_THRESHOLD);
    });

    it('側面は 0.1764 でしきい値に届かない(計画書の 0.1589 は距離の取り違え)', () => {
      const parts = scoreFace(TALLER_SIDE, TOP_FACE_QUERY, SCALE_TALLER);

      // 軸は直交で 0、面積は 600/1200 = 0.5、番号は 2 でずれている。
      // 位置は [20,15,10] と [40,15,10] の距離 20(z は同じ)。
      // 0.35·0 + 0.25·0.5 + 0.2·0 + 0.2·(1 − 20/26.92582403567252) = 0.1764437294583585
      //
      // **計画書 §2.2.3 とタスク5 の検証表は 0.1589 と書いているが、これは
      // 距離を √(20²+0²+10²) = 22.361 として計算したもので、表に併記された
      // 重心 [40,15,10] と指紋の位置 [20,15,10] からは z の差 10 が出てこない。
      // 距離は 20 が正しく、点は 0.1764437294583585 になる。**
      // 「側面は選ばれない」という結論は変わらない(どちらもしきい値 0.6 を大きく下回る)。
      expect(parts.axis).toBe(0);
      expect(parts.size).toBe(0.5);
      expect(parts.position).toBeCloseTo(0.25721864729179256, 9);
      expect(parts.total).toBeCloseTo(0.1764437294583585, 9);
      expect(parts.total).toBeLessThan(SUB_SHAPE_MATCH_THRESHOLD);
    });

    it('3 つを並べて選び直すと、上の面(番号 0)が選ばれる', () => {
      const match = matchFace([TALLER_TOP, TALLER_BOTTOM, TALLER_SIDE], TOP_FACE_QUERY, SCALE_TALLER);

      expect(match).not.toBeNull();
      expect(match?.index).toBe(0);
      expect(match?.score).toBeCloseTo(0.9257218647291793, 9);
    });

    it('断面を 40×30 → 80×60 と相似に広げても、上の面は 0.713 で選び直せる', () => {
      // 面積が 4 倍(1200 → 4800)になっても、大きさの重みが 0.25 に抑えてあるので通る。
      const wider = faceInfo(0, 'plane', 4800, [40, 30, 10], [0, 0, 1]);
      const parts = scoreFace(wider, TOP_FACE_QUERY, SCALE_WIDER);

      // 0.35·1 + 0.25·(1200/4800) + 0.2·1 + 0.2·(1 − 25/50.24937810560445)
      //   = 0.35 + 0.0625 + 0.2 + 0.10049628097900111 = 0.7129962809790011
      expect(parts.size).toBe(0.25);
      expect(parts.position).toBeCloseTo(0.5024814048950055, 9);
      expect(parts.total).toBeCloseTo(0.7129962809790011, 9);
      expect(parts.total).toBeCloseTo(0.713, 3);

      const match = matchFace([wider], TOP_FACE_QUERY, SCALE_WIDER);
      expect(match?.index).toBe(0);
    });
  });

  describe('面の選び直しの断り方', () => {
    it('候補が空なら null', () => {
      expect(matchFace([], TOP_FACE_QUERY, SCALE_TALLER)).toBeNull();
    });

    it('種類が違う候補しか無ければ null(種類は必須の条件)', () => {
      // 面積も軸も位置も番号もぴったり同じだが、円柱面なので候補にならない。
      const cylinder = faceInfo(0, 'cylinder', 1200, [20, 15, 10], [0, 0, 1], 10);

      expect(matchFace([cylinder], TOP_FACE_QUERY, SCALE_TALLER)).toBeNull();
    });

    it('全部の点がしきい値未満なら null', () => {
      expect(matchFace([TALLER_BOTTOM, TALLER_SIDE], TOP_FACE_QUERY, SCALE_TALLER)).toBeNull();
    });

    it('点がちょうど 0.6 の候補は採る(しきい値は「未満」で断る)', () => {
      // 軸と大きさが満点、番号と位置が 0 点。0.35 + 0.25 = 0.6 ちょうど。
      const far = faceInfo(7, 'plane', 1200, [1020, 15, 10], [0, 0, 1]);
      const parts = scoreFace(far, TOP_FACE_QUERY, 10);

      expect(parts.position).toBe(0);
      expect(parts.total).toBe(SUB_SHAPE_MATCH_THRESHOLD);
      expect(matchFace([far], TOP_FACE_QUERY, 10)?.index).toBe(7);
    });
  });

  describe('決定性(§2.2.3「同点なら通し番号が小さいほう」)', () => {
    /** 上下に同じだけずれた 2 枚。番号だけが違い、点は完全に同じになる。 */
    const above = faceInfo(5, 'plane', 1200, [20, 15, 15], [0, 0, 1]);
    const below = faceInfo(9, 'plane', 1200, [20, 15, 5], [0, 0, 1]);

    it('同点の候補が 2 つあれば通し番号が小さいほうを採る', () => {
      const first = scoreFace(above, TOP_FACE_QUERY, SCALE_TALLER).total;
      const second = scoreFace(below, TOP_FACE_QUERY, SCALE_TALLER).total;

      // どちらも距離 5 で、点が 1 ビットも違わないことを先に確かめる。
      expect(first).toBe(second);
      expect(first).toBeCloseTo(0.7628609323645896, 9);
      expect(matchFace([above, below], TOP_FACE_QUERY, SCALE_TALLER)?.index).toBe(5);
    });

    it('候補の並びを逆にしても同じ答えになる', () => {
      expect(matchFace([below, above], TOP_FACE_QUERY, SCALE_TALLER)?.index).toBe(5);
    });

    it('同じ入力を 2 回渡すと同じ結果になり、渡した配列は変わらない', () => {
      const candidates = [TALLER_TOP, TALLER_BOTTOM, TALLER_SIDE];
      const snapshot = [...candidates];

      const first = matchFace(candidates, TOP_FACE_QUERY, SCALE_TALLER);
      const second = matchFace(candidates, TOP_FACE_QUERY, SCALE_TALLER);

      expect(second).toEqual(first);
      expect(candidates).toEqual(snapshot);
    });
  });

  describe('軸の点(scoreAxis)', () => {
    it('同じ向きなら 1、直交なら 0、真逆なら 0(負の内積は切り上げない)', () => {
      expect(scoreAxis([0, 0, 1], [0, 0, 1])).toBe(1);
      expect(scoreAxis([0, 0, 1], [1, 0, 0])).toBe(0);
      expect(scoreAxis([0, 0, 1], [0, 0, -1])).toBe(0);
    });

    it('片方に軸が無ければ 0.5(球や自由曲面を軸だけで門前払いしない)', () => {
      expect(scoreAxis([0, 0, 1], null)).toBe(0.5);
      expect(scoreAxis(null, [0, 0, 1])).toBe(0.5);
      expect(scoreAxis(null, null)).toBe(0.5);
    });

    it('長さが 1 でないベクトルは正規化してから内積を取る', () => {
      expect(scoreAxis([0, 0, 5], [0, 0, 2])).toBe(1);
      // 45 度ずれた向き。cos45° = 0.7071067811865476。
      expect(scoreAxis([1, 0, 0], [3, 0, 3])).toBeCloseTo(Math.SQRT1_2, 9);
    });

    it('長さの取れない向き(0 ベクトル・非数)は軸が無いのと同じ 0.5', () => {
      expect(scoreAxis([0, 0, 0], [0, 0, 1])).toBe(0.5);
      expect(scoreAxis([Number.NaN, 0, 0], [0, 0, 1])).toBe(0.5);
    });

    it('内積が丸め誤差で 1 を超えても 1 で頭打ちになる', () => {
      const tilted: Vec3Tuple = [0.1, 0.2, 0.97];
      expect(scoreAxis(tilted, tilted)).toBeLessThanOrEqual(1);
      expect(scoreAxis(tilted, tilted)).toBeCloseTo(1, 12);
    });
  });

  describe('大きさの点(scoreSize)', () => {
    it('両方 0 なら 1、片方だけ 0 なら 0', () => {
      expect(scoreSize(0, 0)).toBe(1);
      expect(scoreSize(0, 1200)).toBe(0);
      expect(scoreSize(1200, 0)).toBe(0);
    });

    it('比が小さいほうから見た割合になる(順番によらない)', () => {
      expect(scoreSize(600, 1200)).toBe(0.5);
      expect(scoreSize(1200, 600)).toBe(0.5);
      expect(scoreSize(1200, 4800)).toBe(0.25);
    });

    it('面積・長さになりえない値(負・非数)は 0', () => {
      expect(scoreSize(-1, 1)).toBe(0);
      expect(scoreSize(Number.NaN, 1)).toBe(0);
      expect(scoreSize(Number.POSITIVE_INFINITY, 1)).toBe(0);
    });
  });

  describe('位置の点(scorePosition)', () => {
    it('scale が 0 以下なら 1(距離を正規化しようがないので判断材料から外す)', () => {
      expect(scorePosition([1, 2, 3], [1, 2, 3], 0)).toBe(1);
      expect(scorePosition([1, 2, 3], [9, 9, 9], -5)).toBe(1);
    });

    it('距離 0 なら 1、距離が scale と同じなら 0、それより遠ければ 0 で底を打つ', () => {
      expect(scorePosition([1, 2, 3], [1, 2, 3], 10)).toBe(1);
      expect(scorePosition([0, 0, 0], [10, 0, 0], 10)).toBe(0);
      expect(scorePosition([0, 0, 0], [30, 0, 0], 10)).toBe(0);
      // 負の 0 を作らない(鍵の文字列が揺れないようにする、subShapes.ts と同じ約束)。
      expect(Object.is(scorePosition([0, 0, 0], [30, 0, 0], 10), 0)).toBe(true);
    });
  });

  describe('辺の選び直し(matchEdge)', () => {
    /** 40×30×10 の板の、x に沿った長さ 40 の辺。中点 [20,0,0]、向き [1,0,0]、番号 3。 */
    const edgeQuery: Extract<SubShapeQuery, { kind: 'edge' }> = {
      kind: 'edge',
      index: 3,
      curveKind: 'line',
      length: 40,
      position: [20, 0, 0],
      axis: [1, 0, 0],
      radius: null,
    };

    it('高さが変わって中点が 10 動いても、同じ辺を選び直せる', () => {
      const moved = edgeInfo(3, 'line', 40, [20, 0, 10], [1, 0, 0]);
      const parts = scoreEdge(moved, edgeQuery, SCALE_TALLER);

      // 面と同じ重み。0.35·1 + 0.25·1 + 0.2·1 + 0.2·(1 − 10/26.92582403567252)
      expect(parts.total).toBeCloseTo(0.9257218647291793, 9);
      expect(matchEdge([moved], edgeQuery, SCALE_TALLER)?.index).toBe(3);
    });

    it('曲線の種類が違う辺は候補にならない', () => {
      const circle = edgeInfo(3, 'circle', 40, [20, 0, 0], [1, 0, 0], 6.366);

      expect(matchEdge([circle], edgeQuery, SCALE_TALLER)).toBeNull();
    });

    it('長さが 10 倍・位置も番号も離れた辺はしきい値に届かない', () => {
      // 上流が作り直されて別の辺になった場合。向きだけが同じでも通らない。
      // 0.35·1 + 0.25·(40/400) + 0.2·0 + 0.2·max(0, 1 − 200/26.92582403567252) = 0.375
      const stretched = edgeInfo(9, 'line', 400, [220, 0, 0], [1, 0, 0]);

      expect(scoreEdge(stretched, edgeQuery, SCALE_TALLER).total).toBeCloseTo(0.375, 9);
      expect(matchEdge([stretched], edgeQuery, SCALE_TALLER)).toBeNull();
    });
  });

  describe('頂点の選び直し(matchVertex、重みは 0.5 + 0.5)', () => {
    const vertexQuery: Extract<SubShapeQuery, { kind: 'vertex' }> = {
      kind: 'vertex',
      index: 2,
      position: [40, 30, 10],
    };

    it('通し番号が同じなら、位置が多少ずれても通る', () => {
      const moved = vertexInfo(2, [40, 30, 15]);
      const parts = scoreVertex(moved, vertexQuery, SCALE_TALLER);

      // 0.5·1 + 0.5·(1 − 5/26.92582403567252) = 0.9071523309114741
      expect(parts.axis).toBe(0);
      expect(parts.size).toBe(0);
      expect(parts.total).toBeCloseTo(0.9071523309114741, 9);
      expect(matchVertex([moved], vertexQuery, SCALE_TALLER)?.index).toBe(2);
    });

    it('通し番号が変わると、位置がぴったり同じでも 0.5 で届かない(既知の限界)', () => {
      // 頂点には軸も大きさも無いので、番号の 0.5 を落とすと最高でも 0.5 にしかならない。
      const renumbered = vertexInfo(6, [40, 30, 10]);

      expect(scoreVertex(renumbered, vertexQuery, SCALE_TALLER).total).toBe(0.5);
      expect(matchVertex([renumbered], vertexQuery, SCALE_TALLER)).toBeNull();
    });

    it('番号が同じ候補が優先され、番号違いは点で負ける', () => {
      const renumbered = vertexInfo(0, [40, 30, 10]);
      const same = vertexInfo(2, [40, 30, 12]);

      expect(matchVertex([renumbered, same], vertexQuery, SCALE_TALLER)?.index).toBe(2);
    });
  });

  describe('重みとしきい値(§0.a-0.4 の統括の決定)', () => {
    it('面・辺の重みは 0.35 / 0.25 / 0.2 / 0.2 で合計 1', () => {
      expect(MATCH_WEIGHT_AXIS).toBe(0.35);
      expect(MATCH_WEIGHT_SIZE).toBe(0.25);
      expect(MATCH_WEIGHT_INDEX).toBe(0.2);
      expect(MATCH_WEIGHT_POSITION).toBe(0.2);
      expect(
        MATCH_WEIGHT_AXIS + MATCH_WEIGHT_SIZE + MATCH_WEIGHT_INDEX + MATCH_WEIGHT_POSITION,
      ).toBeCloseTo(1, 12);
    });

    it('頂点の重みは 0.5 / 0.5 で合計 1、しきい値は面・辺と同じ 0.6', () => {
      expect(MATCH_WEIGHT_VERTEX_INDEX + MATCH_WEIGHT_VERTEX_POSITION).toBe(1);
      expect(SUB_SHAPE_MATCH_THRESHOLD).toBe(0.6);
    });

    it('すべての点は 0 以上 1 以下に収まる', () => {
      const parts = scoreFace(TALLER_TOP, TOP_FACE_QUERY, SCALE_TALLER);

      for (const value of [parts.axis, parts.size, parts.index, parts.position, parts.total]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    });
  });
});
