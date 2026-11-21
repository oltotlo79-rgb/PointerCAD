/**
 * 押し引き(M-05 4-1a・4-1b)。選んである物の**種類だけ**で、行き先を 1 つ選ぶ。
 *
 * - 作図の面(何も選ばずに押せる閉じた領域を含む)→ 押し出し
 * - 立体の面 → 面の移動。ただし計算部が「穴の壁」と名付けた面(下の 4-1b)は、その穴の径の欄
 * - 立体の辺 → R 面取り
 *
 * 選んだ面が平らか・枚数が合うかなど、その道具が受け付けるかどうかは、振り分け先の道具の
 * 押せる条件(`solidCommands.ts` の `solidToolReadiness`)がそのまま決める。同じ判定を 2 か所に書かない。
 * 押し引きは道具の id ではない(振り分ける前に開く入力欄が無いので、段の表 `SOLID_TOOL_STEPS` に
 * 偽の段を作らない)。確定と元に戻すは、振り分け先の道具のまま。
 *
 * 穴の面(4-1b): 計算部が面ごとに返す出どころ(`SolidBody.origins`)から、model の `holeWallOriginAt` が
 * 「その面を名乗る出どころがちょうど 1 つで、下穴の壁」の時だけ穴の id を返す。径・位置・番号では選ばない
 * (別の穴に当たる恐れがあるため)。出どころが無い・曖昧な面は、今までどおり面の移動へ回す。
 *
 * DOM にもストアにも触れない純関数だけを置く。
 */

import { findSolid, holeWallOriginAt, type PartDocument } from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';

import { activeSketchHasRegions } from './regionFace.js';
import { faceRefById } from './sketchRefs.js';
import { parseSubShapeId, type SubShapeBody, type SubShapeId } from './subShapeSelection.js';

/** 「加工」の一覧の押し引きの項目の id(道具の id ではない)。 */
export type PushPullActionId = 'pushPull';

/** 押し引きが振り分ける先の道具。 */
type PushPullTool = 'extrude' | 'faceOffset' | 'fillet';

/** 振り分けた結果。道具か、穴の径の欄か。決まらない時は、帯に出す理由を返す。 */
type PushPullTarget =
  | { readonly kind: 'tool'; readonly tool: PushPullTool }
  | { readonly kind: 'holeField'; readonly featureId: string; readonly fieldKey: 'diameter' | 'drillDiameter' }
  | { readonly kind: 'refused'; readonly reasonKey: MessageKey };

const UNSUPPORTED: PushPullTarget = { kind: 'refused', reasonKey: 'solidError.pushPullUnsupported' };

/** 選んだ要素 1 つの振り分け先。どれにも当たらない物(立体そのもの・頂点・作図の線や点)は null。 */
function toolOfElement(document: PartDocument, elementId: string): PushPullTool | null {
  const subShape = parseSubShapeId(elementId);
  if (subShape !== null) {
    if (subShape.kind === 'face') return 'faceOffset';
    return subShape.kind === 'edge' ? 'fillet' : null;
  }
  return faceRefById(document, elementId) === undefined ? null : 'extrude';
}

/** 選んだ面が、計算部の名付けた穴(穴・ねじ穴)の下穴の壁なら、その穴の径の欄。そうでなければ null。 */
function holeFieldOf(document: PartDocument, face: SubShapeId, bodies: readonly SubShapeBody[]): PushPullTarget | null {
  const body = bodies.find((candidate) => candidate.featureId === face.bodyFeatureId);
  const wall = holeWallOriginAt(body?.origins, face.index);
  if (wall.status !== 'hole') return null;
  const kind = findSolid(document, wall.origin.featureId)?.kind;
  if (kind === 'hole') return { kind: 'holeField', featureId: wall.origin.featureId, fieldKey: 'diameter' };
  return kind === 'threadHole' ? { kind: 'holeField', featureId: wall.origin.featureId, fieldKey: 'drillDiameter' } : null;
}

/**
 * 選んである物から、行き先を決める。
 * 何も選んでいない時は、押せる閉じた領域があれば押し出し(領域を押して選ぶ。M-01)。
 * 種類が混ざっている時と、どれにも当たらない物を選んでいる時は、振り分けずに理由を返す。
 */
export function pushPullTarget(
  document: PartDocument, selection: readonly string[], bodies: readonly SubShapeBody[] = [],
): PushPullTarget {
  if (selection.length === 0) {
    return activeSketchHasRegions(document) ? { kind: 'tool', tool: 'extrude' } : UNSUPPORTED;
  }
  const tools = new Set(selection.map((elementId) => toolOfElement(document, elementId)));
  const tool = tools.size === 1 ? toolOfElement(document, selection[0]) : null;
  if (tool === null) return UNSUPPORTED;
  const face = tool === 'faceOffset' && selection.length === 1 ? parseSubShapeId(selection[0]) : null;
  return (face === null ? null : holeFieldOf(document, face, bodies)) ?? { kind: 'tool', tool };
}
