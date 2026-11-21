import type { NumericInputState } from '../sketch/numericInput.js';
import { parseSubShapeId, subShapeElementId, type SubShapeBody } from './subShapeSelection.js';

/**
 * 辺からの距離の穴(M-02)の辺を、欄を開いたまま 3D で選んでいる間か。
 * 穴・ねじ穴の大きさの段で、置き方が「辺からの距離」、円筒の側面のつまみが切の時だけ。
 * この間は 3D の当たり判定が辺を先に拾い(光るのも同じ判定)、押した辺は面を残したまま選択へ足す。
 */
export function picksHoleEdges(input: NumericInputState | null): boolean {
  return input !== null && (input.toolId === 'hole' || input.toolId === 'threadHole')
    && (input.step === 'holeSize' || input.step === 'threadSize')
    && input.choices.some(choice => choice.key === 'holePlacement' && choice.value === 'edge-distance')
    && !input.toggles.some(toggle => toggle.key === 'cylinderFace' && toggle.value);
}

/**
 * 押した辺を選択へ入れた後の選択。面・点など辺でない選択はそのまま残し、辺は押した順に 2 本まで持つ
 * (確定で選んだ順が辺 1・辺 2 になる。3 本目を押すと最も古い辺を外す)。選んである辺をもう一度押すと外す。
 */
export function withHoleEdge(selection: readonly string[], edgeId: string): readonly string[] {
  if (selection.includes(edgeId)) return selection.filter(id => id !== edgeId);
  const edges = selection.filter(id => parseSubShapeId(id)?.kind === 'edge');
  const dropped = edges.length >= 2 ? edges[0] : undefined;
  return [...selection.filter(id => id !== dropped), edgeId];
}

/**
 * 面を選ばずに辺 2 本だけを選んで穴・ねじ穴を押した時の、穴をあける面の要素 id(M-10 ③)。
 * 選択がちょうど同じ立体のまっすぐな辺 2 本で、平らな面 1 枚の縁(`boundaryEdgeIndices`)に両方が入る時だけ返す。
 * 縁が分からない面・曲面だけ・当たる面が 0 枚か 2 枚以上の時は null。平行な 2 本は面を返し、確定の時に今までの理由で断る
 * (辺が面の縁か・平行かは、計算部が今の形で確かめる。`machiningCommands.ts` の `edgeDistancePlacement` の注釈)。
 */
export function faceOfEdgePair(bodies: readonly SubShapeBody[], selection: readonly string[]): string | null {
  const [first, second] = selection.map(id => parseSubShapeId(id));
  if (selection.length !== 2 || first?.kind !== 'edge' || second?.kind !== 'edge'
    || first.bodyFeatureId !== second.bodyFeatureId || first.index === second.index) {
    return null;
  }
  const bodyId = first.bodyFeatureId, edge1 = first.index, edge2 = second.index;
  const matches = bodies.filter(candidate => candidate.featureId === bodyId);
  const body = matches.length === 1 ? matches[0] : undefined;
  const straight = (index: number): boolean => body?.edges.find(edge => edge.index === index)?.curveKind === 'line';
  if (body === undefined || !straight(edge1) || !straight(edge2)) {
    return null;
  }
  const faces = body.faces.filter(face => face.surfaceKind === 'plane'
    && face.boundaryEdgeIndices?.includes(edge1) === true && face.boundaryEdgeIndices.includes(edge2));
  return faces.length === 1 ? subShapeElementId(bodyId, 'face', faces[0].index) : null;
}
