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
import { describe, expect, it } from 'vitest';

import {
  isDrawingTool,
  isSolidTool,
  picksSubShapes,
  toSubShapeBodies,
} from './attachSketchInteraction.js';
import type { SolidBodyWithSubShapes } from './buildSolidGeometry.js';

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
