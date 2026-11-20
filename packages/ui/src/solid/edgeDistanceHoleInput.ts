import type { NumericInputState } from '../sketch/numericInput.js';
import { parseSubShapeId } from './subShapeSelection.js';

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
