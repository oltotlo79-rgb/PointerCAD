/**
 * `pickSolidSubShape`(立体の部分形状の当たり判定、`packages/ui/src/solid/pickSubShape.ts`)の
 * pointermove 費用の実測(計画書 docs/plans/P3-加工フィーチャー.md タスク23 手順6)。
 *
 * `attachSketchInteraction.ts` の当たり判定を配線するこのタスクで、辺・頂点の当たり判定は
 * 画面座標(`pickSolidSubShape`)で行うことになった。辺・頂点の判定は「そのボディの辺の線分の
 * 総数」に比例するので、辺200本・線分800本のボディに対して1000回呼び、1回あたり1ms未満
 * (60fps = 16.7ms/フレームの中で余裕を持たせるため)であることを確かめる。
 *
 * 対象の関数は `packages/ui/src/solid/` にあるが、そのディレクトリはタスク25b(ばねの
 * コマンドと配線)が並行して触っているため、このタスクの新規ファイルは触ってよい
 * `packages/ui/src/viewport/` へ置く(このタスク自身の合格条件を検査するテストなので、
 * ここに置いても対象の関数を変更するわけではない)。
 */
import type { Vec3 } from '@pointercad/model';
import { describe, it } from 'vitest';

import { pickSolidSubShape } from '../solid/pickSubShape.js';
import type { SolidEdgeEntry, SolidVertexEntry, SubShapeBody } from '../solid/subShapeSelection.js';
import { expectWithinBudget } from '../testUtils/perfBudget.js';

const EDGE_COUNT = 200;
const SEGMENTS_PER_EDGE = 4;
const CALL_COUNT = 1000;
/** 60fps(16.7ms/フレーム)の中で余裕を持たせるための上限(計画書タスク23 の合格条件)。 */
const MAX_MS_PER_CALL = 1;

/** 辺200本・線分800本(1辺あたり4本)のボディを作る。頂点は辺の始点を流用する。 */
function buildLargeBody(): SubShapeBody {
  const edgePositionValues: number[] = [];
  const edges: SolidEdgeEntry[] = [];
  const vertices: SolidVertexEntry[] = [];

  for (let edgeIndex = 0; edgeIndex < EDGE_COUNT; edgeIndex += 1) {
    const segmentOffset = edgeIndex * SEGMENTS_PER_EDGE;
    const baseX = edgeIndex * 10;
    for (let segment = 0; segment < SEGMENTS_PER_EDGE; segment += 1) {
      const fromX = baseX + segment * 2;
      const toX = fromX + 2;
      edgePositionValues.push(fromX, 0, 0, toX, 0, 0);
    }
    const start: Vec3 = [baseX, 0, 0];
    const end: Vec3 = [baseX + SEGMENTS_PER_EDGE * 2, 0, 0];
    edges.push({
      index: edgeIndex,
      curveKind: 'line',
      length: SEGMENTS_PER_EDGE * 2,
      midpoint: [(start[0] + end[0]) / 2, 0, 0],
      start,
      end,
      axis: [1, 0, 0],
      radius: null,
      segmentOffset,
      segmentCount: SEGMENTS_PER_EDGE,
    });
    vertices.push({ index: edgeIndex, position: start });
  }

  return {
    featureId: 'perf-body',
    mesh: { edgePositions: Float32Array.from(edgePositionValues) },
    faces: [],
    edges,
    vertices,
  };
}

/** カメラの射影の代わりに x・y をそのまま画面座標として使う(判定そのものの費用だけを測る)。 */
const project = (point: Vec3): readonly [number, number] => [point[0], point[1]];

describe('pickSolidSubShape の性能(計画書タスク23 手順6)', () => {
  it('辺200本・線分800本のボディに対して1000回呼んでも1回あたり1ms未満', () => {
    const bodies = [buildLargeBody()];
    // 呼ぶたびに違う場所を押し、当たり(頂点・辺の近く)と外れの両方を混ぜる。
    const start = performance.now();
    for (let call = 0; call < CALL_COUNT; call += 1) {
      const pointer: readonly [number, number] = [(call * 7) % 2000, call % 5];
      pickSolidSubShape(bodies, project, pointer, 'edge');
    }
    const elapsedMs = performance.now() - start;
    const perCallMs = elapsedMs / CALL_COUNT;
    // 実測値を報告できるよう出力に残す(合否に関わらず。kernel の solidPerformance.test.ts と同じ流儀)。
    console.log(
      `pickSolidSubShape: 合計 ${elapsedMs.toFixed(2)}ms / ${CALL_COUNT}回 = ${perCallMs.toFixed(4)}ms/回`,
    );

    expectWithinBudget(perCallMs, MAX_MS_PER_CALL, 'pickSolidSubShape 1回あたり');
  });
});
