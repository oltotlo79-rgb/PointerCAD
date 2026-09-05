/**
 * 選択とその場入力から「平面による切断」を作る純関数
 * (計画書 docs/plans/P5-高度なソリッド・外観と測定.md タスク27e、§2.9b、§0.a-0.56〜0.61)。
 *
 * 対応要件: FR-432(平面による切断)、FR-201/202(式のまま持つ)、FR-502、FR-504、
 * NFR-UX-1(対象を選んでから操作)、NFR-UX-2(その場で聞く)、
 * NFR-UX-4(Enter 連打で意味のある結果)、NFR-UX-5(できない操作は実行前に理由を示す)。
 *
 * **`machiningCommands.ts`(P3 タスク25)と同じ形にしてある。** 文脈・押せる条件・確定の
 * 3 つだけを外へ出し、ストアにも DOM にも触れない。切断だけが別ファイルなのは、
 * ①平面の決め方を `PlaneSpec`(model、FR-328 と共有)で組み立てる、②「反対側も残す」で
 * **履歴を 2 段積む**(§0.a-0.58)という 2 点が他の道具と違うためである。
 *
 * 予告の四角の頂点を作るのは `../viewport/buildCutPreview.ts`(three に触れない純関数)。
 */

import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  appendSolid,
  baseWorkPlane,
  crossVec3,
  DEFAULT_CUT_KEEP,
  DEFAULT_PRIMITIVE_AXIS,
  lengthVec3,
  liveBodyIds,
  nextSolidId,
  nextSolidName,
  resolvePlaneSpec,
  subShapeFromFingerprint,
  subVec3,
  type CutFeature,
  type PartDocument,
  type PlaneResolveContext,
  type PlaneSpec,
  type PointReference,
  type ResolvedPlane,
  type SubShapeRef,
  type Vec3,
} from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';
import type { SolidInputCommit } from '../sketch/numericInput.js';

import type { SolidCommandOutcome, SolidToolReadiness } from './solidCommands.js';
import {
  selectedBodyIds,
  selectedSubShapeRefs,
  type SubShapeBody,
} from './subShapeSelection.js';

/**
 * 切断のコマンドが必要とする文脈(計画書タスク27e)。
 *
 * 計画書の宣言は `selectionKind` と `sketch` も持っていたが、どちらも使わないので置かない。
 * 選ぶ種類は選択の中身(頂点・辺・面の要素 id)から読めるし、いまの作図面は
 * `SketchDocument` が持っていない(作図面の id はストアの持ち物)。何も選んでいないときの
 * 後退先は**段の選択肢**(基準の 3 面)なので、そちらを引数で受け取る。
 */
export interface CutContext {
  readonly document: PartDocument;
  /** カーネルが返した立体の一覧。指紋を作るのに要る(`MachiningContext` と同じ欄)。 */
  readonly bodies: readonly SubShapeBody[];
  /** 選択(順序つき)。部分形状の id も入る。 */
  readonly selection: readonly string[];
}

/** 残す側(§0.a-0.57)。法線の側か、その反対か。 */
export type CutKeep = CutFeature['keep'];

/** 押せる。 */
const READY: SolidToolReadiness = { ready: true, reasonKey: null };

/** 3 点で平面を決めるのに要る点の数。 */
const THREE_POINTS = 3;

/** 傾き角・方位角の既定(度)。§2.15 の段の表の「0 / 0」。 */
export const DEFAULT_CUT_TILT: ExpressionValue = expressionValueFromNumber(0);
export const DEFAULT_CUT_AZIMUTH: ExpressionValue = expressionValueFromNumber(0);

/** 基準の 3 面・作業平面の既定のずらし量(0 = その平面そのもの)。 */
const NO_OFFSET: ExpressionValue = expressionValueFromNumber(0);

/**
 * 3 点が一直線かどうかを見る許容値(mm²)。外積の長さ(= 平行四辺形の面積)で見るので
 * 単位は面積。`SKETCH_TOLERANCE_MM`(1e-6)の 2 乗より少し緩い値にして、
 * 数値誤差だけで「一直線」と言われないようにする。
 */
const COLLINEAR_AREA_EPSILON = 1e-9;

/* ------------------------------------------------------------------ *
 * 選択 → 平面の決め方(NFR-UX-4)
 * ------------------------------------------------------------------ */

/** 頂点の参照を点の参照へ(座標を写さないので、上流が動けば切る面も動く)。 */
function pointOf(ref: SubShapeRef): PointReference {
  return { kind: 'subShape', ref };
}

/** 指紋に入っている頂点の位置。頂点でなければ null。 */
function vertexPosition(ref: SubShapeRef): Vec3 | null {
  return ref.fingerprint.kind === 'vertex' ? ref.fingerprint.position : null;
}

/**
 * 選んでいるものから平面の決め方を推測する(NFR-UX-4「Enter 連打で意味のある結果」)。
 *
 * | 選んでいるもの | 決め方 |
 * |---|---|
 * | 頂点 3 つ以上 | `threePoints`(選んだ順の先頭 3 つ) |
 * | 頂点 1 つ + 辺 1 本 | `pointAndEdge`(辺に垂直) |
 * | 頂点 1 つ + 面 1 枚 | `pointAndParallelFace` |
 * | 頂点 1 つだけ | `pointAndAxis`(Z 軸・傾き 0) |
 * | どれでもない | null(呼び出し側が基準の 3 面へ後退する) |
 *
 * **利用者は「点を作って切る」だけで済む。** 辺と面のどちらも選んでいるときは辺を優先する
 * (「この辺に直角に切る」のほうが指示として強いため)。
 */
export function inferPlaneSpec(
  context: CutContext,
  tilt: ExpressionValue = DEFAULT_CUT_TILT,
): PlaneSpec | null {
  const vertices = selectedSubShapeRefs(context.bodies, context.selection, 'vertex');
  const first = vertices[0];
  if (first === undefined) {
    return null;
  }
  if (vertices.length >= THREE_POINTS) {
    const [p1, p2, p3] = vertices;
    if (p1 !== undefined && p2 !== undefined && p3 !== undefined) {
      return { kind: 'threePoints', p1: pointOf(p1), p2: pointOf(p2), p3: pointOf(p3) };
    }
  }
  const edge = selectedSubShapeRefs(context.bodies, context.selection, 'edge')[0];
  if (edge !== undefined) {
    return { kind: 'pointAndEdge', point: pointOf(first), edge, mode: 'perpendicular' };
  }
  const face = selectedSubShapeRefs(context.bodies, context.selection, 'face')[0];
  if (face !== undefined) {
    return { kind: 'pointAndParallelFace', point: pointOf(first), face };
  }
  return {
    kind: 'pointAndAxis',
    point: pointOf(first),
    axis: DEFAULT_PRIMITIVE_AXIS,
    tilt,
    azimuth: DEFAULT_CUT_AZIMUTH,
  };
}

/**
 * 段の選択肢(`cutPlaneKind`)と選択から、実際に使う平面の決め方を組み立てる。
 *
 * - 基準の 3 面(`xy` / `xz` / `yz`)と省略 … **選んでいるものからの推測を優先**し、
 *   材料が無ければその基準面にする(NFR-UX-4。点を作って押すだけで切れる)。
 * - `face` … 選んだ平らな面そのもの。面が無ければ null。
 * - `threePoints` / `pointAndEdge` / `pointAndAxis` … **その決め方に必要な材料だけ**を見る。
 *   足りなければ null(利用者が明示的に選んだ決め方を、別の決め方へすり替えない)。
 */
export function cutPlaneSpecFor(
  context: CutContext,
  planeKind: string | undefined,
  tilt: ExpressionValue = DEFAULT_CUT_TILT,
): PlaneSpec | null {
  const vertices = selectedSubShapeRefs(context.bodies, context.selection, 'vertex');
  const first = vertices[0];
  switch (planeKind) {
    case 'threePoints': {
      const [p1, p2, p3] = vertices;
      return p1 === undefined || p2 === undefined || p3 === undefined
        ? null
        : { kind: 'threePoints', p1: pointOf(p1), p2: pointOf(p2), p3: pointOf(p3) };
    }
    case 'pointAndEdge': {
      const edge = selectedSubShapeRefs(context.bodies, context.selection, 'edge')[0];
      return first === undefined || edge === undefined
        ? null
        : { kind: 'pointAndEdge', point: pointOf(first), edge, mode: 'perpendicular' };
    }
    case 'pointAndAxis':
      return first === undefined
        ? null
        : {
            kind: 'pointAndAxis',
            point: pointOf(first),
            axis: DEFAULT_PRIMITIVE_AXIS,
            tilt,
            azimuth: DEFAULT_CUT_AZIMUTH,
          };
    case 'face': {
      const face = selectedSubShapeRefs(context.bodies, context.selection, 'face')[0];
      return face === undefined ? null : { kind: 'face', face, offset: NO_OFFSET };
    }
    case undefined:
    case 'xy':
    case 'xz':
    case 'yz':
      return (
        inferPlaneSpec(context, tilt) ?? {
          kind: 'workPlane',
          planeId: planeKind ?? 'xy',
          offset: NO_OFFSET,
        }
      );
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * 先出し検査(NFR-UX-5「実行してから失敗させない」)
 * ------------------------------------------------------------------ */

/** 3 点が一直線かどうか。外積の長さ(平行四辺形の面積)で見る。 */
function isCollinear(a: Vec3, b: Vec3, c: Vec3): boolean {
  return lengthVec3(crossVec3(subVec3(b, a), subVec3(c, a))) <= COLLINEAR_AREA_EPSILON;
}

/**
 * その平面の決め方が、いまの材料で成り立つかを**押す前に**確かめる(NFR-UX-5)。
 * 成り立てば null。文言は `resolvePlaneSpec`(model)と同じ内容を UI の鍵で持つ。
 */
export function cutPlaneRejection(plane: PlaneSpec | null): MessageKey | null {
  if (plane === null) {
    return 'shapeError.noCutPlane';
  }
  switch (plane.kind) {
    case 'threePoints': {
      const a = pointPositionOf(plane.p1);
      const b = pointPositionOf(plane.p2);
      const c = pointPositionOf(plane.p3);
      if (a === null || b === null || c === null) {
        // 座標が読めない点(スケッチの点など)は解決に任せる。押す前には断らない。
        return null;
      }
      return isCollinear(a, b, c) ? 'cutError.collinear' : null;
    }
    case 'pointAndEdge':
      return plane.edge.fingerprint.kind === 'edge' &&
        plane.edge.fingerprint.curveKind !== 'line'
        ? 'cutError.notStraightEdge'
        : null;
    case 'pointAndParallelFace':
      return flatFaceRejection(plane.face);
    case 'face':
      return flatFaceRejection(plane.face);
    case 'pointAndAxis':
    case 'workPlane':
    case 'tilted':
      return null;
  }
}

/** 平らでない面は切る面の基準にできない(円柱面などの指紋をここで弾く)。 */
function flatFaceRejection(face: SubShapeRef): MessageKey | null {
  return face.fingerprint.kind === 'face' && face.fingerprint.surfaceKind !== 'plane'
    ? 'cutError.curvedFace'
    : null;
}

/** 点の参照から座標を読む。立体の頂点だけが指紋に座標を持つ。 */
function pointPositionOf(reference: PointReference): Vec3 | null {
  return reference.kind === 'subShape' ? vertexPosition(reference.ref) : null;
}

/** 切る対象の立体を 1 つ決める。ちょうど 1 つでなければ null。 */
export function cutTargetOf(context: CutContext): string | null {
  const bodyIds = selectedBodyIds(context.selection, liveBodyIds(context.document));
  if (bodyIds.length === 1) {
    return bodyIds[0];
  }
  return null;
}

/**
 * 切断がいま押せるか(NFR-UX-5)。
 *
 * 押せるのは「切る立体がちょうど 1 つ選ばれていて、平面の材料が成り立っている」とき。
 * 平面の材料を何も選んでいなくても、基準の 3 面へ後退できるので押せる(NFR-UX-4)。
 */
export function cutToolReadiness(context: CutContext): SolidToolReadiness {
  if (cutTargetOf(context) === null) {
    return { ready: false, reasonKey: 'shapeError.noTargetBody' };
  }
  // 材料を何も選んでいない(推測が null)のは「足りない」ではなく「基準の 3 面で切る」
  // という意味なので、そのときは平面の中身を確かめない。
  const inferred = inferPlaneSpec(context);
  const rejection = inferred === null ? null : cutPlaneRejection(inferred);
  return rejection === null ? READY : { ready: false, reasonKey: rejection };
}

/* ------------------------------------------------------------------ *
 * 確定(§0.a-0.58「反対側も残す」は履歴を 2 段積む)
 * ------------------------------------------------------------------ */

/** 反対側(`keep` の裏返し)。 */
function opposite(keep: CutKeep): CutKeep {
  return keep === 'positive' ? 'negative' : 'positive';
}

function cutFeatureOf(
  document: PartDocument,
  targetFeatureId: string,
  plane: PlaneSpec,
  keep: CutKeep,
  pairedWith: string | null,
): CutFeature {
  return {
    id: nextSolidId(document, 'cut'),
    name: nextSolidName(document, 'cut'),
    suppressed: false,
    kind: 'cut',
    targetFeatureId,
    plane,
    keep,
    pairedWith,
  };
}

/**
 * 切断を確定する(FR-432)。
 *
 * `keepBoth` が真のときは **`appendSolid` を 2 回**呼び、2 つ目は残す側が逆で
 * `pairedWith` に 1 つ目の id を入れる(§0.a-0.58。「1 フィーチャー = 最大 1 ボディ」の
 * 規約を曲げずに「反対側も残す」を満たす)。平面の中身は 2 つとも同じものを渡す。
 *
 * `featureId` に返すのは **1 つ目**の id(利用者が押した操作の主役で、ツリーの選択も
 * こちらへ移すのが自然なため)。
 */
export function commitCut(
  context: CutContext,
  plane: PlaneSpec,
  keep: CutKeep,
  keepBoth: boolean,
): SolidCommandOutcome {
  const target = cutTargetOf(context);
  if (target === null) {
    return { ok: false, reasonKey: 'shapeError.noTargetBody' };
  }
  const rejection = cutPlaneRejection(plane);
  if (rejection !== null) {
    return { ok: false, reasonKey: rejection };
  }
  const first = cutFeatureOf(context.document, target, plane, keep, null);
  const withFirst = appendSolid(context.document, first);
  if (!keepBoth) {
    return { ok: true, document: withFirst, featureId: first.id };
  }
  const second = cutFeatureOf(withFirst, target, plane, opposite(keep), first.id);
  return { ok: true, document: appendSolid(withFirst, second), featureId: first.id };
}

/**
 * その場入力の確定結果から切断を作る(タスク24 の `SolidInputCommit`)。
 * 平面の決め方は段の選択肢と選択から組み立て、残す側はつまみ 2 つで決める(§0.a-0.57)。
 */
export function commitCutInput(
  context: CutContext,
  commit: SolidInputCommit,
): SolidCommandOutcome {
  const plane = cutPlaneSpecFor(
    context,
    commit.shapeChoices?.cutPlaneKind,
    commit.values.cutTilt ?? DEFAULT_CUT_TILT,
  );
  if (plane === null) {
    return { ok: false, reasonKey: 'shapeError.noCutPlane' };
  }
  const keep: CutKeep = commit.flags.cutKeepOpposite === true ? 'negative' : DEFAULT_CUT_KEEP;
  return commitCut(context, plane, keep, commit.flags.cutKeepBoth ?? false);
}

/* ------------------------------------------------------------------ *
 * 予告表示のための解決(タスク27e 手順6、§0.a-0.61)
 * ------------------------------------------------------------------ */

/**
 * 予告の四角を出すために、平面の決め方をその場で解いて向きと位置を得る。
 *
 * **カーネルへは行かない。** 指紋(選んだ瞬間の位置・向き)をそのまま使う——予告は
 * 「いま選んでいるものから、こう切れます」を見せるだけで、確定後の形は
 * `resolvePart`(model)が選び直した部分形状で解き直すためである。
 * スケッチの点は座標を持たないので解けず、そのときは予告を出さない(null)。
 *
 * 文脈(`CutContext`)を取らないのは、指紋だけで解けるためである。呼び出し側は
 * `cutPlaneSpecFor` で組み立てた決め方をそのまま渡せばよい。
 */
export function resolveCutPlane(plane: PlaneSpec): ResolvedPlane | null {
  const resolveContext: PlaneResolveContext = {
    point: (reference) =>
      reference.kind === 'subShape' ? subShapeFromFingerprint(reference.ref).position : null,
    subShape: (reference) => subShapeFromFingerprint(reference),
    axis: (spec) =>
      spec.kind === 'world'
        ? { origin: [0, 0, 0], direction: worldAxisDirection(spec.axis) }
        : null,
    workPlane: (planeId) => {
      const base = baseWorkPlane(planeId);
      return base === null
        ? null
        : { origin: base.origin, axisU: base.axisU, axisV: base.axisV, normal: base.normal };
    },
  };
  const outcome = resolvePlaneSpec(plane, resolveContext);
  return outcome.ok ? outcome.plane : null;
}

/** ワールドの軸の向き。`AxisSpec` の `world` の 3 通りだけ。 */
function worldAxisDirection(axis: 'x' | 'y' | 'z'): Vec3 {
  switch (axis) {
    case 'x':
      return [1, 0, 0];
    case 'y':
      return [0, 1, 0];
    case 'z':
      return [0, 0, 1];
  }
}

/**
 * 予告の四角の大きさ(= 対象のボディの境界箱の対角長、§0.a-0.61)。
 *
 * 稜線の端点(`mesh.edgePositions`)から境界箱を測る。稜線は形の端まで届いているので、
 * 三角形の頂点を全部見なくても同じ大きさになる。ボディが見つからない・稜線が 1 本も
 * 無いときは 0(呼び出し側は予告を出さない)。
 */
export function cutPreviewDiagonal(context: CutContext, targetFeatureId: string): number {
  const body = context.bodies.find((candidate) => candidate.featureId === targetFeatureId);
  const positions = body?.mesh.edgePositions;
  if (positions === undefined || positions.length < 3) {
    return 0;
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index + 2 < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis] ?? 0;
      min[axis] = Math.min(min[axis] ?? Infinity, value);
      max[axis] = Math.max(max[axis] ?? -Infinity, value);
    }
  }
  const dx = (max[0] ?? 0) - (min[0] ?? 0);
  const dy = (max[1] ?? 0) - (min[1] ?? 0);
  const dz = (max[2] ?? 0) - (min[2] ?? 0);
  return Math.hypot(dx, dy, dz);
}
