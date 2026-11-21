/**
 * フレームの一括配置(J-01 包み 4a): 選んだ部品のまっすぐな辺の一覧(世界の座標の線・長さ・向き・中点)と、長さの順・向きの絞り込み。
 * 辺の指紋は普通の部分形状の選択と同じ道(`subShapeRefOf`)で作り、世界の線は model の `frameLineFromEdge`。
 * 一覧の行の鍵は、ビューの強調(選択・ホバー)に使う部分形状の対象の id(`assemblyTargetId`)。
 */
import { magnitudeAtLeast, frameLineFromEdge, type AssemblyDocument, type FrameLine, type Vec3 } from '@pointercad/model';

import { subShapeElementId, subShapeRefOf } from '../solid/subShapeSelection.js';
import type { AssemblyView } from '../store/assemblySlice.js';
import { assemblyTargetId } from './mateCommands.js';

type FrameEdgeDirection = 'x' | 'y' | 'z' | 'other';

/** 一覧の 1 行(通し番号は 1 から、部品の辺の順)。 */
export interface FrameEdgeChoice {
  readonly targetId: string;
  readonly number: number;
  readonly line: FrameLine;
  readonly lengthMm: number;
  readonly direction: FrameEdgeDirection;
  readonly midpoint: Vec3;
}

/** 軸に平行とみなす向きの内積の大きさ。 */
const AXIS_TOLERANCE = 1e-9;
const round = (value: number): number => Math.round(value * 1e6) / 1e6;

function directionOf(line: FrameLine, length: number): FrameEdgeDirection {
  const along = (axis: 0 | 1 | 2): boolean => magnitudeAtLeast((line.end[axis] - line.start[axis]) / length, 1 - AXIS_TOLERANCE);
  return along(0) ? 'x' : along(1) ? 'y' : along(2) ? 'z' : 'other';
}

/** 置いた部品のまっすぐな辺の一覧(世界の座標)。部品が無い・抑制・形がまだ無い時は null。 */
export function frameEdgeChoices(document: AssemblyDocument, view: AssemblyView, componentId: string): readonly FrameEdgeChoice[] | null {
  const component = document.components.find((candidate) => candidate.id === componentId);
  const placement = view.resolved.placements.get(componentId);
  const partKey = view.resolved.partKeys.get(componentId);
  const bodies = partKey === undefined ? undefined : view.bodies.get(partKey);
  if (component === undefined || component.suppressed || placement === undefined || bodies === undefined) return null;
  const choices: FrameEdgeChoice[] = [];
  for (const body of bodies) {
    for (const edge of body.edges) {
      const ref = subShapeRefOf(bodies, subShapeElementId(body.featureId, 'edge', edge.index));
      const line = ref === null ? null : frameLineFromEdge(ref, placement);
      if (ref === null || line === null) continue;
      const length = Math.hypot(line.end[0] - line.start[0], line.end[1] - line.start[1], line.end[2] - line.start[2]);
      const mid = (axis: 0 | 1 | 2): number => round((line.start[axis] + line.end[axis]) / 2);
      choices.push({ targetId: assemblyTargetId({ kind: 'subShape', componentId, ref }), number: choices.length + 1, line,
        lengthMm: round(length), direction: directionOf(line, length), midpoint: [mid(0), mid(1), mid(2)] });
    }
  }
  return choices;
}

export type FrameEdgeOrder = 'number' | 'length';
export type FrameEdgeFilter = 'all' | FrameEdgeDirection;

/** 長さの順(長い順、同じ長さは番号の順)と向きで絞った一覧。 */
export function filterFrameEdges(choices: readonly FrameEdgeChoice[], order: FrameEdgeOrder, filter: FrameEdgeFilter):
readonly FrameEdgeChoice[] {
  const shown = filter === 'all' ? [...choices] : choices.filter((choice) => choice.direction === filter);
  return order === 'length' ? shown.sort((a, b) => b.lengthMm - a.lengthMm || a.number - b.number) : shown;
}
