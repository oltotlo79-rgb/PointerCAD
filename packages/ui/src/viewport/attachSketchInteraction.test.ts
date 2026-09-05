/**
 * `attachSketchInteraction.ts` の当たり判定の順序を決める純関数の検査
 * (計画書 docs/plans/P3-加工フィーチャー.md タスク23、§2.3.2)。
 *
 * `attachSketchInteraction` 本体は DOM(PointerEvent・canvas)を直に触るので、この
 * パッケージの方針(jsdom を入れない、P1 §0.8)により Node の単体検査からは外れる。
 * ここでは選択の種類・道具から「何を拾うか」を決める判定と、`pickSolidSubShape` へ渡す
 * 形への詰め替えだけを、DOM に触れない純関数として検査する。実際の pointermove /
 * pointerdown の配線は E2E(タスク30)で確かめる。
 */
import type { Vec3 } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  isDrawingTool,
  isLookTool,
  isSolidTool,
  picksBodies,
  picksSubShapes,
  skipsSketchElements,
  toSubShapeBodies,
} from './attachSketchInteraction.js';
import type { SolidBodyWithSubShapes } from './buildSolidGeometry.js';
import { snapToSphereGrid, type SphereGridSpec } from './buildSphereGrid.js';
import type { ProjectToScreen } from '../sketch/snapMath.js';
import { expectWithinBudget } from '../testUtils/perfBudget.js';

describe('isSolidTool', () => {
  it('P2 の3道具(押し出し・回転・縫合)を拾う', () => {
    expect(isSolidTool('extrude')).toBe(true);
    expect(isSolidTool('revolve')).toBe(true);
    expect(isSolidTool('sew')).toBe(true);
  });

  it('P3 の加工6種とばねも拾う(以前は "extrude"|"revolve"|"sew" の3つしか見ておらず、これらの道具で pointerdown が座標入力へ誤って流れる不具合があった)', () => {
    expect(isSolidTool('hole')).toBe(true);
    expect(isSolidTool('threadHole')).toBe(true);
    expect(isSolidTool('fillet')).toBe(true);
    expect(isSolidTool('chamfer')).toBe(true);
    expect(isSolidTool('linearPattern')).toBe(true);
    expect(isSolidTool('circularPattern')).toBe(true);
    expect(isSolidTool('spring')).toBe(true);
  });

  it('スケッチの道具は拾わない', () => {
    expect(isSolidTool('select')).toBe(false);
    expect(isSolidTool('point')).toBe(false);
    expect(isSolidTool('line')).toBe(false);
    expect(isSolidTool('arc')).toBe(false);
    expect(isSolidTool('pointArray')).toBe(false);
    expect(isSolidTool('face')).toBe(false);
  });
});

describe('isDrawingTool', () => {
  it('位置を数値で決める4道具だけを拾う', () => {
    expect(isDrawingTool('point')).toBe(true);
    expect(isDrawingTool('line')).toBe(true);
    expect(isDrawingTool('arc')).toBe(true);
    expect(isDrawingTool('pointArray')).toBe(true);
  });

  it('選択・面・立体の道具・加工の道具は拾わない', () => {
    expect(isDrawingTool('select')).toBe(false);
    expect(isDrawingTool('face')).toBe(false);
    expect(isDrawingTool('extrude')).toBe(false);
    expect(isDrawingTool('hole')).toBe(false);
  });
});

describe('isLookTool', () => {
  it('外観と測るだけを拾う', () => {
    expect(isLookTool('appearance')).toBe(true);
    expect(isLookTool('measure')).toBe(true);
  });

  it('立体の道具・選択・かき込む道具は拾わない', () => {
    expect(isLookTool('select')).toBe(false);
    expect(isLookTool('extrude')).toBe(false);
    expect(isLookTool('point')).toBe(false);
  });
});

describe('picksBodies(P5 仕上げ (j): 外観・測るのあいだ立体を押しても選べなかった)', () => {
  it('選択・立体の道具・断面は今までどおり立体を拾う', () => {
    expect(picksBodies('select')).toBe(true);
    expect(picksBodies('extrude')).toBe(true);
    expect(picksBodies('linearPattern')).toBe(true);
    expect(picksBodies('planeSection')).toBe(true);
  });

  it('外観と測るも立体を拾う(外観は `4` キーで立体ごとに色を付ける道、測るは体積・質量特性・立体 2 つの隙間)', () => {
    expect(picksBodies('appearance')).toBe(true);
    expect(picksBodies('measure')).toBe(true);
  });

  it('かき込む道具と面の道具は拾わない(押した場所が座標そのもの / 面の境界の順が壊れる)', () => {
    expect(picksBodies('point')).toBe(false);
    expect(picksBodies('line')).toBe(false);
    expect(picksBodies('rectangle')).toBe(false);
    expect(picksBodies('face')).toBe(false);
  });
});

describe('picksSubShapes', () => {
  it('選択の種類が body なら道具に関わらず拾わない(立体の経路を使う)', () => {
    expect(picksSubShapes('body', 'hole')).toBe(false);
    expect(picksSubShapes('body', 'select')).toBe(false);
  });

  it('選択の種類が face / edge / vertex で、かき込む道具でなければ拾う', () => {
    expect(picksSubShapes('face', 'hole')).toBe(true);
    expect(picksSubShapes('edge', 'fillet')).toBe(true);
    expect(picksSubShapes('vertex', 'fillet')).toBe(true);
    // 選択・面の道具でも、選択の種類を手動で部分形状へ切り替えていれば拾う
    // (onPointerDown 側は select / face を選択の種類より先に判定するので、
    // クリックの振る舞いそのものは変わらない。ここは判定関数だけの検査)。
    expect(picksSubShapes('edge', 'select')).toBe(true);
  });

  it('かき込む道具(点・線・円弧・点列)は、選択の種類が部分形状でも拾わない', () => {
    expect(picksSubShapes('face', 'point')).toBe(false);
    expect(picksSubShapes('edge', 'line')).toBe(false);
    expect(picksSubShapes('vertex', 'arc')).toBe(false);
    expect(picksSubShapes('edge', 'pointArray')).toBe(false);
  });
});

describe('skipsSketchElements(タスク30 不具合(c): 押し出したもとのスケッチ面が立体の面より先に当たる)', () => {
  it('選択の種類が body のときはスケッチ要素の当たり判定を飛ばさない(従来どおり)', () => {
    expect(skipsSketchElements('body')).toBe(false);
  });

  it('選択の種類が face / edge / vertex のときはスケッチ要素の当たり判定を飛ばす', () => {
    expect(skipsSketchElements('face')).toBe(true);
    expect(skipsSketchElements('edge')).toBe(true);
    expect(skipsSketchElements('vertex')).toBe(true);
  });
});

describe('toSubShapeBodies', () => {
  const withSubShapes: SolidBodyWithSubShapes = {
    featureId: 'hole-1',
    mesh: {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
      edgePositions: new Float32Array([0, 0, 0, 1, 0, 0]),
      triangleCount: 0,
    },
    volume: 1,
    isValid: true,
    faces: [
      {
        index: 0,
        surfaceKind: 'plane',
        area: 10,
        centroid: [0, 0, 0],
        axis: [0, 0, 1],
        radius: null,
        triangleOffset: 0,
        triangleCount: 2,
      },
    ],
    edges: [],
    vertices: [],
    threadMarks: [],
  };

  /** 面・辺の一覧が無い(押し出し等、部分形状が空の)ボディ。空の一覧として詰め替わる。 */
  const withoutSubShapes: SolidBodyWithSubShapes = {
    featureId: 'extrude-1',
    mesh: {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
      edgePositions: new Float32Array([1, 1, 1, 2, 2, 2]),
      triangleCount: 0,
    },
    volume: 1,
    isValid: true,
    faces: [],
    edges: [],
    vertices: [],
    threadMarks: [],
  };

  it('faces / edges / vertices をそのまま持ち越す', () => {
    const [result] = toSubShapeBodies([withSubShapes]);
    expect(result.featureId).toBe('hole-1');
    expect(result.mesh.edgePositions).toBe(withSubShapes.mesh.edgePositions);
    expect(result.faces).toBe(withSubShapes.faces);
    expect(result.edges).toEqual([]);
    expect(result.vertices).toEqual([]);
  });

  it('部分形状の一覧が空のボディは空の一覧として詰め替える', () => {
    const [result] = toSubShapeBodies([withoutSubShapes]);
    expect(result.featureId).toBe('extrude-1');
    expect(result.faces).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.vertices).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 球面上の点の吸着の費用(FR-431、NFR-PF-1、P5 タスク21 手順6)
 * ------------------------------------------------------------------ */

/** 実測に使う球面の案内線(既定の 5°、半径 10 の球)。 */
const SPHERE_GRID_SPEC: SphereGridSpec = { center: [0, 0, 0], radius: 10, stepDegrees: 5 };

/** 5° の交点の数(緯線 35 × 経線 72 + 極 2、計画書 §2.8.3)。 */
const SPHERE_GRID_POINT_COUNT = 35 * 72 + 2;

/**
 * `pointermove` 1 回ぶんの予算(ミリ秒)。1 コマ 16ms(60fps、NFR-PF-1)のうち、
 * 吸着に使ってよいのはごく一部なので **1ms** を上限にする(P4b の向きの吸着と同じ考え方)。
 */
const POINTER_MOVE_BUDGET_MS = 1;

/** 実測の平均を取る回数。1 回だけだと計測の揺れがそのまま出る。 */
const SNAP_ROUNDS = 2000;

/**
 * ワールド → 画面のいちばん素朴な写し。**判定半径(12 画素)の中に必ず入る倍率**にして、
 * 吸い付いた側(いちばん重い経路)の所要を測る。実測で効くのは変換の回数だけで、
 * 倍率そのものは費用に関係しない。
 */
const projectForTest: ProjectToScreen = (point) => [point[0] * 0.1 + 400, point[1] * 0.1 + 300];

describe('球面の案内線の交点への吸着の費用(FR-431、NFR-PF-1、§1.5-13)', () => {
  it(`交点 ${String(SPHERE_GRID_POINT_COUNT)} 個でも pointermove 1 回が 1ms に収まる`, () => {
    // 球の中心へ向かう光線(必ず当たる = いちばん重い経路)を少しずつ振りながら測る。
    const started = performance.now();
    let hits = 0;
    for (let round = 0; round < SNAP_ROUNDS; round += 1) {
      const angle = (round / SNAP_ROUNDS) * Math.PI * 2;
      const origin: Vec3 = [Math.cos(angle) * 100, Math.sin(angle) * 100, 30];
      const direction: Vec3 = [-Math.cos(angle), -Math.sin(angle), -0.3];
      const point = snapToSphereGrid(SPHERE_GRID_SPEC, { origin, direction }, projectForTest, [
        400,
        300,
      ]);
      if (point !== null) {
        hits += 1;
      }
    }
    const elapsed = (performance.now() - started) / SNAP_ROUNDS;
    // どの回も交点に吸い付いている(いちばん重い経路を測っている)。
    expect(hits).toBe(SNAP_ROUNDS);
    console.log(
      `[実測] 球面の案内線の吸着(交点 ${String(SPHERE_GRID_POINT_COUNT)} 個): ${elapsed.toFixed(5)} ms / pointermove(吸い付いた回数 ${String(hits)})`,
    );
    expectWithinBudget(elapsed, POINTER_MOVE_BUDGET_MS, '球面の案内線の交点への吸着');
  });
});
