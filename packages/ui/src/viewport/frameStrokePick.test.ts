import type { Vec3, WorkPlane } from '@pointercad/model';
import { describe, expect, it, vi } from 'vitest';

import type { SubShapeBody } from '../solid/subShapeSelection.js';
import { frameStrokeHitAt } from './frameStrokePick.js';

type FrameStrokePickSource = Parameters<typeof frameStrokeHitAt>[0];

/* 一筆書きの配置(E-08)の押下: 見えている部品の頂点(画面で 6px 以内の一番近い物)、無ければ前の点の高さの面の上の点。 */
const plate = (vertices: readonly Vec3[]): SubShapeBody => ({
  featureId: 'plate', mesh: { edgePositions: new Float32Array() }, faces: [], edges: [],
  vertices: vertices.map((position, index) => ({ index, position })),
});

function source(options: { readonly visible?: boolean; readonly suppressed?: boolean } = {}): FrameStrokePickSource {
  return {
    components: [{ id: 'c1', suppressed: options.suppressed ?? false, visible: options.visible ?? true }],
    // 部品は X へ 100 動かして置く(頂点はワールドの点で返す)。
    placements: new Map([['c1', { position: [100, 0, 0], rotation: [0, 0, 0, 1] }]]),
    partKeys: new Map([['c1', 'part']]),
    bodies: new Map([['part', [plate([[0, 0, 10], [50, 0, 10]])]]]),
  };
}

/** 画面の写し方: ワールドの X・Y をそのまま画素にする(上から見た形)。面の上の点は渡された面の高さで返す。 */
const scene = {
  worldToScreen: (point: Vec3): readonly [number, number] => [point[0], point[1]],
  screenToPlanePoint: vi.fn((x: number, y: number, plane: WorkPlane): Vec3 => [x, y, plane.origin[2]]),
};
const STROKE = { points: [[0, 0, 40]] as const, closed: false, up: 'z' } as const;

describe('一筆書きの押下の当たり', () => {
  it('画面で 6px 以内の頂点はワールドの点(置いた位置を含む)、二つあれば近い方', () => {
    expect(frameStrokeHitAt(source(), scene, [104, 3], STROKE)).toEqual({ kind: 'vertex', point: [100, 0, 10] });
    expect(frameStrokeHitAt(source(), scene, [147, 0], STROKE)).toEqual({ kind: 'vertex', point: [150, 0, 10] });
  });

  it('頂点が遠い・隠した・抑制した部品なら、前の点の高さの面の上の点', () => {
    expect(frameStrokeHitAt(source(), scene, [120, 30], STROKE)).toEqual({ kind: 'level', point: [120, 30, 40] });
    expect(frameStrokeHitAt(source({ visible: false }), scene, [100, 0], STROKE)).toEqual({ kind: 'level', point: [100, 0, 40] });
    expect(frameStrokeHitAt(source({ suppressed: true }), scene, [100, 0], STROKE)).toEqual({ kind: 'level', point: [100, 0, 40] });
  });

  it('面と視線が平行(面の上の点が無い)・面の口が無い時は null', () => {
    expect(frameStrokeHitAt(source(), { ...scene, screenToPlanePoint: () => null }, [120, 30], STROKE)).toBeNull();
    expect(frameStrokeHitAt(source(), { worldToScreen: scene.worldToScreen }, [120, 30], STROKE)).toBeNull();
  });
});
