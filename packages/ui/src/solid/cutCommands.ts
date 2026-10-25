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
  affectsShape,
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
  resolveSketch,
  isPlanar,
  SKETCH_TOLERANCE_MM,
  subShapeFromFingerprint,
  subVec3,
  type CutFeature,
  type BooleanFeature,
  type ExtrudeFeature,
  type ResolvedCurve,
  type ResolvedFace,
  type ResolvedSketch,
  type SketchFaceRef,
  type SketchFeature,
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

import {
  collectCutMaterials,
  cutPlaneMaterialRejection,
  placeAxisPoint,
  placeCoordinatePoint,
  type CutAxis,
  type CutMaterials,
} from './cutPlaneMaterials.js';
import type { SolidCommandOutcome, SolidToolReadiness } from './solidCommands.js';
import {
  selectedBodyIds,
  subShapeFrameOrigin,
  type SubShapeBody,
} from './subShapeSelection.js';
import { findSketchFeatureAt } from './sketchRefs.js';

/**
 * 切断のコマンドが必要とする文脈(計画書タスク27e)。
 *
 * 計画書の宣言は `selectionKind` と `sketch` も持っていたが、どちらも使わないので置かない。
 * 選ぶ種類は選択の中身(頂点・辺・面の要素 id)から読めるし、いまの作図面は
 * `SketchDocument` が持っていない(作図面の id はストアの持ち物)。何も選んでいないときの
 * 後退先は**段の選択肢**(基準の 3 面)なので、そちらを引数で受け取る。
 */
export interface ResolvedCutSketches {
  readonly document: PartDocument;
  readonly sketches: readonly { readonly sketchId: string; readonly resolved: ResolvedSketch }[];
}

export interface CutContext {
  readonly document: PartDocument;
  /** カーネルが返した立体の一覧。指紋を作るのに要る(`MachiningContext` と同じ欄)。 */
  readonly bodies: readonly SubShapeBody[];
  /** 選択(順序つき)。部分形状の id も入る。 */
  readonly selection: readonly string[];
  /** Current, document-paired recomputation; never saved into a feature. */
  readonly resolvedSketches?: ResolvedCutSketches;
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

/**
 * 段の選択肢 `cutPlaneKind` のうち、EX-04 W1 で足した決め方の値。
 *
 * - `axisX` / `axisY` / `axisZ` … その軸に垂直な面。位置は欄「位置」の式で決める
 *   (`cutPlaneMaterials.ts` の `placeAxisPoint`。法線は軸の向き)。
 * - `workPlane` … モデルブラウザで選んだ作業平面そのもの。
 * - `pointAndEdgeContaining` … 辺と点の両方を含む面(既存の `pointAndEdge` は辺に垂直な面)。
 */
export const WORK_PLANE_CUT_KIND = 'workPlane';
export const EDGE_CONTAINING_CUT_KIND = 'pointAndEdgeContaining';

/** 決め方の値が「軸に垂直な面」なら、その軸。 */
export function cutAxisOf(planeKind: string | undefined): CutAxis | null {
  switch (planeKind) {
    case 'axisX':
      return 'x';
    case 'axisY':
      return 'y';
    case 'axisZ':
      return 'z';
    default:
      return null;
  }
}

/** 作業平面(基準の 3 面・任意の作業平面)そのもの。 */
function workPlaneSpec(planeId: string): PlaneSpec {
  return { kind: 'workPlane', planeId, offset: NO_OFFSET };
}

/**
 * 選んでいるものから平面の決め方を推測する(NFR-UX-4「Enter 連打で意味のある結果」)。
 *
 * 点は立体の頂点と編集中のスケッチの点を、選んだ順に数える(`cutPlaneMaterials.ts`)。
 *
 * | 選んでいるもの | 決め方 |
 * |---|---|
 * | 点 3 つ以上 | `threePoints`(選んだ順の先頭 3 つ) |
 * | 点 1 つ + 辺 1 本 | `pointAndEdge`(辺に垂直) |
 * | 点 1 つ + 面 1 枚 | `pointAndParallelFace` |
 * | 点 1 つだけ | `pointAndAxis`(Z 軸・傾き 0) |
 * | 点が無く、作業平面 | `workPlane`(その作業平面そのもの) |
 * | どれでもない | null(呼び出し側が基準の 3 面へ後退する) |
 *
 * **利用者は「点を作って切る」だけで済む。** 辺と面のどちらも選んでいるときは辺を優先する
 * (「この辺に直角に切る」のほうが指示として強いため)。スケッチの点が使えない(別のスケッチに
 * 同じ名前の点がある等)ときも null(理由は `cutToolReadiness` と確定が返す)。
 */
export function inferPlaneSpec(
  context: CutContext,
  tilt: ExpressionValue = DEFAULT_CUT_TILT,
): PlaneSpec | null {
  const collected = collectCutMaterials(context);
  return collected.ok ? inferFromMaterials(collected.materials, tilt) : null;
}

function inferFromMaterials(materials: CutMaterials, tilt: ExpressionValue): PlaneSpec | null {
  const [first, second, third] = materials.points;
  if (first === undefined) {
    const planeId = materials.workPlaneIds[0];
    return planeId === undefined ? null : workPlaneSpec(planeId);
  }
  if (second !== undefined && third !== undefined) {
    return { kind: 'threePoints', p1: first, p2: second, p3: third };
  }
  const edge = materials.edges[0];
  if (edge !== undefined) {
    return { kind: 'pointAndEdge', point: first, edge, mode: 'perpendicular' };
  }
  const face = materials.faces[0];
  if (face !== undefined) {
    return { kind: 'pointAndParallelFace', point: first, face };
  }
  return pointAndZAxis(first, tilt);
}

/** 点を通り、Z 軸に垂直な面を傾き角だけ倒した面(方位角は 0)。 */
function pointAndZAxis(point: PointReference, tilt: ExpressionValue): PlaneSpec {
  return { kind: 'pointAndAxis', point, axis: DEFAULT_PRIMITIVE_AXIS, tilt, azimuth: DEFAULT_CUT_AZIMUTH };
}

/**
 * 段の選択肢(`cutPlaneKind`)と選択から、実際に使う平面の決め方を組み立てる。
 *
 * - 基準の 3 面(`xy` / `xz` / `yz`)と省略 … **選んでいるものからの推測を優先**し、
 *   材料が無ければその基準面にする(NFR-UX-4。点を作って押すだけで切れる)。
 * - `face` … 選んだ平らな面そのもの。面が無ければ null。
 * - `threePoints` / `pointAndEdge` / `pointAndEdgeContaining` / `pointAndAxis` / `workPlane` …
 *   **その決め方に必要な材料だけ**を見る。足りなければ null(利用者が明示的に選んだ決め方を、
 *   別の決め方へすり替えない)。
 * - `axisX` / `axisY` / `axisZ` … 位置の式が要るので、選択だけでは決まらず null
 *   (確定は `commitCutInput` が欄の値から組み立てる)。
 */
export function cutPlaneSpecFor(
  context: CutContext,
  planeKind: string | undefined,
  tilt: ExpressionValue = DEFAULT_CUT_TILT,
): PlaneSpec | null {
  const collected = collectCutMaterials(context);
  return collected.ok ? planeSpecFromMaterials(collected.materials, planeKind, tilt) : null;
}

function planeSpecFromMaterials(
  materials: CutMaterials,
  planeKind: string | undefined,
  tilt: ExpressionValue,
): PlaneSpec | null {
  const [first, second, third] = materials.points;
  const edge = materials.edges[0];
  switch (planeKind) {
    case 'threePoints':
      return first === undefined || second === undefined || third === undefined
        ? null
        : { kind: 'threePoints', p1: first, p2: second, p3: third };
    case 'pointAndEdge':
    case EDGE_CONTAINING_CUT_KIND:
      return first === undefined || edge === undefined
        ? null
        : {
            kind: 'pointAndEdge',
            point: first,
            edge,
            mode: planeKind === 'pointAndEdge' ? 'perpendicular' : 'containing',
          };
    case 'pointAndAxis':
      return first === undefined ? null : pointAndZAxis(first, tilt);
    case 'face': {
      const face = materials.faces[0];
      return face === undefined ? null : { kind: 'face', face, offset: NO_OFFSET };
    }
    case WORK_PLANE_CUT_KIND: {
      const planeId = materials.workPlaneIds[0];
      return planeId === undefined ? null : workPlaneSpec(planeId);
    }
    case undefined:
    case 'xy':
    case 'xz':
    case 'yz':
      return inferFromMaterials(materials, tilt) ?? workPlaneSpec(planeKind ?? 'xy');
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

/** 指紋に入っている頂点の位置。頂点でなければ null。 */
function vertexPosition(ref: SubShapeRef): Vec3 | null {
  return ref.fingerprint.kind === 'vertex' ? ref.fingerprint.position : null;
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
  // 選んだスケッチの点が使えない(別のスケッチに同じ名前の点がある等)ときは、その理由で止める。
  const collected = collectCutMaterials(context);
  if (!collected.ok) {
    return { ready: false, reasonKey: collected.reasonKey };
  }
  // 材料を何も選んでいない(推測が null)のは「足りない」ではなく「基準の 3 面で切る」
  // という意味なので、そのときは平面の中身を確かめない。スケッチの点・作業平面のように
  // 指紋に位置を持たない材料は、model の平面の解き方で押す前に確かめる(EX-04 W1)。
  const inferred = inferFromMaterials(collected.materials, DEFAULT_CUT_TILT);
  const rejection = inferred === null
    ? null
    : cutPlaneRejection(inferred) ?? cutPlaneMaterialRejection(context, inferred);
  return rejection === null ? READY : { ready: false, reasonKey: rejection };
}

/* ------------------------------------------------------------------ *
 * 閉じた輪郭による貫通切断(EX04)
 * ------------------------------------------------------------------ */

/**
 * 段の選択肢 `cutPlaneKind` のうち、平面ではなく**選んだ閉じた輪郭**で切る値。
 *
 * ## 表し方(新しい保存形を作らない)
 *
 * 確定すると、既存の 2 つのフィーチャーを**1 回の文書の変更**で積む。
 *
 * 1. 押し出し(`ExtrudeFeature`)— 選んだ作図の面(`SketchFaceRef`)を両側へ、対象を必ず
 *    貫く長さで押し出す。輪郭は参照のまま持つので、作図の円の半径などを直せば
 *    再計算で切り口も変わる(式・参照のまま持つ FR-201/202)。
 * 2. 差(`BooleanFeature`, `subtract`)— 対象から 1. を引く。1. はここで消費される。
 *    輪郭の内側を残すときは積(`intersect`)、両方を残すときは差と積の対(2 つ目が `pairedWith` で
 *    1 つ目を指す。対象と 1. は対で 1 度だけ消費される)を積む(EX-04 W3、`commitProfileCut`)。
 *
 * 保存・読み込み・形状キャッシュの鍵・再計算・元に戻すは、どちらも既存の押し出しと
 * ブーリアンの経路をそのまま通る(新しい OCCT の分割や保存形を足さない)。
 * 手作業の「押し出し → 差」はそのまま残り、ここはそれを 1 回の操作にまとめた入口である。
 *
 * ## 貫く長さ
 *
 * 押し出しの終端は `throughTarget`(対象の立体を名指し、消費しない)。長さは**再計算のたびに**
 * カーネルが対象の厳密な境界箱から両側へ決める(`makeSolidSweep.ts` の `throughTargetRange`)
 * ので、後で上流の対象が大きくなっても途中で止まった切断にならない。対象の鍵は押し出しの鍵に
 * 混ざる(上流が変われば計算し直す)。
 *
 * 押す前の確かめ(`profileCutGeometry`)で求める長さ(境界箱の 8 隅と輪郭を包む点の最大距離 H の
 * 4 倍)は、必須の欄 `distance` に確定時の値として入るだけで、形には使われない。
 */
export const PROFILE_CUT_KIND = 'profile';

/** 輪郭として拾う作図の要素の種類(閉じた面だけ)。 */
const PROFILE_KINDS: ReadonlySet<SketchFeature['kind']> = new Set(['face']);

/** 両側押し出しの長さ = 最大距離 H のこの倍数(片側 2H。上の注釈)。 */
const THROUGH_LENGTH_FACTOR = 4;

/**
 * 選択から切る輪郭(作図の閉じた面)を 1 つ拾う。選んだ順に見て最初の面。
 * 面の探し方は押し出し・回転と同じ `findSketchFeatureAt`(編集中のスケッチを先に見る)。
 */
export function cutProfileOf(context: CutContext): SketchFaceRef | null {
  for (const elementId of context.selection) {
    const found = findSketchFeatureAt(context.document, elementId, PROFILE_KINDS);
    if (found !== undefined) {
      return { sketchId: found.sketchId, faceFeatureId: found.featureId };
    }
  }
  return null;
}

/** 輪郭による切断の形の下ごしらえ(押す前に確かめる。NFR-UX-5)。 */
export type ProfileCutGeometry =
  | { readonly ok: true; readonly normal: Vec3; readonly throughDistance: number }
  | { readonly ok: false; readonly reasonKey: MessageKey };

function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale3(a: Vec3, factor: number): Vec3 {
  return [a[0] * factor, a[1] * factor, a[2] * factor];
}

function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function unit3(a: Vec3): Vec3 | null {
  const length = lengthVec3(a);
  return length > 0 && Number.isFinite(length) ? scale3(a, 1 / length) : null;
}

/** 円弧・楕円の角度 t の点(`ResolvedArc` / `ResolvedEllipse` の向きの約束どおり)。 */
function conicPoint(center: Vec3, normal: Vec3, axis: Vec3, a: number, b: number, t: number): Vec3 {
  const second = crossVec3(normal, axis);
  return add3(center, add3(scale3(axis, a * Math.cos(t)), scale3(second, b * Math.sin(t))));
}

/**
 * 輪郭の曲線の上の代表点(平らかどうかの確認に使う)。円弧・楕円は始点・中間・終点に
 * 始点から 1/4 周の点を足す——全周の円では始点と終点が同じ点になり、中心と合わせても
 * 平面が定まらないため(`isPlanar` が一直線として断ってしまう)。
 */
function curveSamples(curve: ResolvedCurve): Vec3[] {
  switch (curve.kind) {
    case 'segment':
      return [curve.from, curve.to];
    case 'arc':
    case 'ellipse': {
      const axis = curve.kind === 'arc' ? curve.xAxis : curve.majorAxis;
      const a = curve.kind === 'arc' ? curve.radius : curve.majorRadius;
      const b = curve.kind === 'arc' ? curve.radius : curve.minorRadius;
      const angles = [curve.startAngle, (curve.startAngle + curve.endAngle) / 2, curve.endAngle,
        curve.startAngle + Math.PI / 2];
      return [curve.center, ...angles.map((t) => conicPoint(curve.center, curve.normal, axis, a, b, t))];
    }
    case 'spline':
      return [...curve.points];
  }
}

/**
 * 曲線を包む点。円弧・楕円は中心から半径(長いほう)だけ各軸へ離した立方体の 8 隅で包む
 * (曲線は必ずその中にある)。スプラインは与えられた点を使う(補間のスプラインは点の外へ
 * 少し膨らみうる。4 倍の長さの余裕で受け止める前提で、制限として報告する)。
 */
function curveBounds(curve: ResolvedCurve): Vec3[] {
  switch (curve.kind) {
    case 'segment':
      return [curve.from, curve.to];
    case 'arc':
    case 'ellipse': {
      const radius = curve.kind === 'arc' ? curve.radius : Math.max(curve.majorRadius, curve.minorRadius);
      const corners: Vec3[] = [];
      for (const dx of [-radius, radius]) {
        for (const dy of [-radius, radius]) {
          for (const dz of [-radius, radius]) corners.push(add3(curve.center, [dx, dy, dz]));
        }
      }
      return corners;
    }
    case 'spline':
      return [...curve.points];
  }
}

/**
 * 輪郭の向き。円弧・楕円があればその法線、無ければ輪郭の点から**一直線に並ばない 3 点**を選んで
 * 決める(最初の点・そこから最も遠い点・その 2 点を結ぶ線から最も離れた点)。
 *
 * 閉ループの面積ベクトルは使わない——自分自身と交わる輪郭(蝶ネクタイ形)では左右の面積が
 * 打ち消して 0 になり、「平らでない」と取り違えて本当の理由(自己交差)を隠すため。
 * 押し出しは両側なので、向きの符号はどちらでもよい。
 */
function profileNormal(face: ResolvedFace): Vec3 | null {
  for (const curve of face.curves) {
    if (curve.kind === 'arc' || curve.kind === 'ellipse') return unit3(curve.normal);
  }
  const points = face.curves.flatMap(curveSamples);
  const first = points[0];
  if (first === undefined) return null;
  let far = first, farDistance = 0;
  for (const point of points) {
    const distance = lengthVec3(subVec3(point, first));
    if (distance > farDistance) { far = point; farDistance = distance; }
  }
  const axis = subVec3(far, first);
  let best: Vec3 = [0, 0, 0], bestLength = 0;
  for (const point of points) {
    const candidate = crossVec3(axis, subVec3(point, first));
    const length = lengthVec3(candidate);
    if (length > bestLength) { best = candidate; bestLength = length; }
  }
  return unit3(best);
}

/** 平面上の 2 本の線分が、端を共有する以外で交わるか(輪郭の自己交差の確認)。 */
function segmentsCross(a: readonly [number, number], b: readonly [number, number],
  c: readonly [number, number], d: readonly [number, number]): boolean {
  const orient = (p: readonly [number, number], q: readonly [number, number], r: readonly [number, number]): number =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = orient(c, d, a), d2 = orient(c, d, b), d3 = orient(a, b, c), d4 = orient(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * 輪郭による切断が成り立つかを**押す前に**確かめ、成り立てば向きと貫く長さを返す。
 *
 * 断るのは次のとき(どれも文書を変えないので、いまの形はそのまま残る)。
 * - 輪郭の面が解決できない・作図の誤りがある・平らでない(`cutError.profileInvalid` /
 *   `cutError.profileNotPlanar`)
 * - 直線だけの区間が自分自身と交わる(`cutError.profileSelfIntersects`。曲線どうしの交差は
 *   ここでは見ず、再計算の押し出しが理由つきで断る)
 * - 対象の形が読めない(`shapeError.noTargetBody`)
 * - 輪郭の平面へ写した輪郭の範囲と対象の範囲が重ならない(`cutError.profileMissesTarget`。
 *   重ならなければ何も削れないので、何も変わらない切断を積まない)
 *
 * 範囲が重なっても実際に削れるとは限らない(例: 穴の開いた立体の穴の中の輪郭)。それは確定後の
 * 再計算で、差に立てた `requireRemoval` が実際の形どうしの共通部分から判定して断る。
 */
export function profileCutGeometry(context: CutContext, targetFeatureId: string,
  profile: SketchFaceRef): ProfileCutGeometry {
  const sketch = context.document.sketches.find((candidate) => candidate.id === profile.sketchId);
  if (sketch === undefined) return { ok: false, reasonKey: 'cutError.noProfile' };
  const snapshot = context.resolvedSketches;
  const current = snapshot !== undefined && snapshot.document.id === context.document.id
    && !affectsShape(snapshot.document, context.document);
  const evaluated = current ? snapshot.sketches.find(entry => entry.sketchId === sketch.id)?.resolved : undefined;
  const functionIds = new Set(sketch.features.filter(feature => feature.kind === 'functionCurve').map(feature => feature.id));
  const evaluatedFace = evaluated?.faces.find(face => face.featureId === profile.faceFeatureId);
  // Formula profiles need the same resolved frame and dependent boundary as the successful recompute.
  // Keep the original path for ordinary profiles, including other faces in this same sketch.
  const formulaProfile = evaluatedFace?.curves.some(curve => functionIds.has(curve.featureId)) === true;
  const resolved = formulaProfile && evaluated !== undefined ? evaluated : resolveSketch(sketch);
  const face = resolved.faces.find((candidate) => candidate.featureId === profile.faceFeatureId);
  if (face === undefined || face.curves.length === 0
    || resolved.errors.some((error) => error.featureId === profile.faceFeatureId)) {
    return { ok: false, reasonKey: 'cutError.profileInvalid' };
  }
  const samples = face.curves.flatMap(curveSamples);
  const normal = profileNormal(face);
  if (normal === null || !isPlanar(samples)
    || face.curves.some((curve) => (curve.kind === 'arc' || curve.kind === 'ellipse')
      && lengthVec3(crossVec3(normal, unit3(curve.normal) ?? [0, 0, 0])) > SKETCH_TOLERANCE_MM)) {
    return { ok: false, reasonKey: 'cutError.profileNotPlanar' };
  }
  // 平面上の 2 軸(どちらも法線に直交する単位ベクトル)。
  const helper: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = unit3(crossVec3(normal, helper));
  if (u === null) return { ok: false, reasonKey: 'cutError.profileNotPlanar' };
  const v = crossVec3(normal, u);
  const flat = (point: Vec3): readonly [number, number] => [dot3(point, u), dot3(point, v)];
  const straight = face.curves.filter((curve) => curve.kind === 'segment');
  for (let i = 0; i < straight.length; i += 1) {
    for (let j = i + 2; j < straight.length; j += 1) {
      if (i === 0 && j === straight.length - 1) continue;
      const first = straight[i], second = straight[j];
      if (first.kind === 'segment' && second.kind === 'segment'
        && segmentsCross(flat(first.from), flat(first.to), flat(second.from), flat(second.to))) {
        return { ok: false, reasonKey: 'cutError.profileSelfIntersects' };
      }
    }
  }
  const corners = targetCorners(context, targetFeatureId);
  if (corners === null) return { ok: false, reasonKey: 'shapeError.noTargetBody' };
  const bounds = face.curves.flatMap(curveBounds);
  const range = (points: readonly Vec3[], axis: Vec3): readonly [number, number] => {
    const values = points.map((point) => dot3(point, axis));
    return [Math.min(...values), Math.max(...values)];
  };
  // 押す前に「届かない」と断るのは、対象と輪郭の両方の範囲が本当の形を必ず含むと証明できるときだけ
  // (`polyhedralTargetVertices` / `conservativeProfilePoints`)。証明できない組み合わせ(曲面・曲線を持つ
  // 立体、通過点のスプライン)は押す前には断らず、再計算の差の `requireRemoval` が実際の形どうしの
  // 共通部分で判定する(直前の正しい形を残す)。表示用の稜線の点の箱では断らない——球の稜線は継ぎ目の
  // 子午線だけで球面を囲まず、球の中の輪郭を「届かない」と取り違える。
  const targetHull = polyhedralTargetVertices(context, targetFeatureId);
  const profileHull = conservativeProfilePoints(face);
  if (targetHull !== null && profileHull !== null) {
    for (const axis of [u, v]) {
      const [targetMin, targetMax] = range(targetHull, axis);
      const [profileMin, profileMax] = range(profileHull, axis);
      // 作図の許容差より離れているときだけ。接するだけの配置は削れる量が 0 なので、再計算が断る。
      if (profileMax < targetMin - SKETCH_TOLERANCE_MM || profileMin > targetMax + SKETCH_TOLERANCE_MM) {
        return { ok: false, reasonKey: 'cutError.profileMissesTarget' };
      }
    }
  }
  let farthest = 0;
  for (const corner of corners) {
    for (const point of bounds) farthest = Math.max(farthest, lengthVec3(subVec3(corner, point)));
  }
  const throughDistance = Math.ceil(THROUGH_LENGTH_FACTOR * farthest);
  if (!Number.isFinite(throughDistance) || throughDistance <= 0) {
    return { ok: false, reasonKey: 'cutError.profileInvalid' };
  }
  return { ok: true, normal, throughDistance };
}

/**
 * 対象のボディが多面体(面がすべて平面、稜線がすべて直線)なら、その頂点(稜線の両端。カーネルが元の形から
 * double で測った部品座標)を返す。有界な多面体は頂点の凸包に必ず含まれるので、この点の範囲は対象の
 * 本当の外枠になる。曲面・曲線を 1 つでも持つ(球は継ぎ目の子午線しか稜線を持たず、稜線が球面を囲まない)、
 * 面や稜線が無い、数でない値がある、のどれかなら null(押す前には「届かない」と断らない)。
 */
function polyhedralTargetVertices(context: CutContext, targetFeatureId: string): Vec3[] | null {
  const body = context.bodies.find((candidate) => candidate.featureId === targetFeatureId);
  if (body === undefined || body.faces.length === 0 || body.edges.length === 0) return null;
  if (!body.faces.every((face) => face.surfaceKind === 'plane')) return null;
  if (!body.edges.every((edge) => edge.curveKind === 'line')) return null;
  const points: Vec3[] = body.edges.flatMap((edge) => [edge.start, edge.end]);
  return points.every((point) => point.every(Number.isFinite)) ? points : null;
}

/**
 * 輪郭の本当の形を必ず含む点(`curveBounds`)。線分の両端、円弧・楕円を包む立方体の隅、制御点のスプライン
 * (B スプラインは制御点の凸包に収まる)は必ず含む。通過点のスプライン(`mode: 'interpolate'`)は点の外へ
 * 膨らみうるので、1 本でもあれば null(押す前には断らない)。
 */
function conservativeProfilePoints(face: ResolvedFace): Vec3[] | null {
  const points: Vec3[] = [];
  for (const curve of face.curves) {
    if (curve.kind === 'spline' && curve.mode !== 'control') return null;
    points.push(...curveBounds(curve));
  }
  return points;
}

/**
 * 対象のボディの表示用の稜線の点の箱の 8 隅(世界座標、double)。原点を足し、Float32 の丸めのぶんだけ
 * 外へ広げる。読めなければ null。**本当の形の外枠ではない**(球など曲面の稜線は面を囲まない)ので、
 * 必須の欄 `distance` に入れる確定時の長さ(`throughTarget` では形に使われない)にだけ使い、
 * 「届かない」の判定には使わない(`polyhedralTargetVertices`)。
 */
function targetCorners(context: CutContext, targetFeatureId: string): Vec3[] | null {
  const body = context.bodies.find((candidate) => candidate.featureId === targetFeatureId);
  const positions = body?.mesh.edgePositions;
  if (body === undefined || positions === undefined || positions.length < 3) return null;
  const origin = subShapeFrameOrigin(body);
  if (origin === null) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index + 2 < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = (positions[index + axis] ?? 0) + origin[axis];
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  const largest = Math.max(...min.map(Math.abs), ...max.map(Math.abs));
  const slack = body.coordinateFrame?.maximumFloat32ErrorMm ?? largest * 2 ** -23;
  if (![...min, ...max, slack].every(Number.isFinite)) return null;
  const corners: Vec3[] = [];
  for (const x of [min[0] - slack, max[0] + slack]) {
    for (const y of [min[1] - slack, max[1] + slack]) {
      for (const z of [min[2] - slack, max[2] + slack]) corners.push([x, y, z]);
    }
  }
  return corners;
}

/**
 * 閉じた輪郭で切るときに残す側(EX-04 W3)。`outside` = 輪郭の外側(既定。従来の「内側を差し引く」差)、
 * `inside` = 輪郭の内側(積)。平面の切断と同じ入口のつまみで選ぶ: 「反対側を残す」で内側、
 * 「反対側も残す(2 つに分ける)」で両方(`commitCutInput`)。
 */
export type ProfileCutKeep = 'outside' | 'inside';

/** 残す側のブーリアンの演算。外側 = 差、内側 = 積(`BooleanFeature.pairedWith` の注釈)。 */
function profileCutOperation(keep: ProfileCutKeep): 'subtract' | 'intersect' {
  return keep === 'outside' ? 'subtract' : 'intersect';
}

/** 閉じた輪郭の切断のブーリアン 1 つ(対象と押し出しを名指しし、何も切れなければ再計算が断る)。 */
function profileCutFeatureOf(
  document: PartDocument,
  targetFeatureId: string,
  toolFeatureId: string,
  keep: ProfileCutKeep,
  pairedWith: string | null,
): BooleanFeature {
  const operation = profileCutOperation(keep);
  return {
    id: nextSolidId(document, operation),
    name: nextSolidName(document, operation),
    suppressed: false,
    kind: 'boolean',
    operation,
    targetFeatureId,
    toolFeatureId,
    // 押す前の境界箱の確かめは必要条件にすぎない。実際の形どうしで何も切れなければ、
    // 再計算が理由つきで断り、直前の正しい形を残す(`BooleanFeature.requireRemoval`)。
    requireRemoval: true,
    ...(pairedWith === null ? {} : { pairedWith }),
  };
}

/**
 * 選んだ閉じた輪郭で対象を貫いて切る(EX04)。押し出しと差(または積)の 2 段を 1 回の変更で積む
 * (上の `PROFILE_CUT_KIND` の注釈)。断ったときは文書を変えない。
 * `featureId` は切り口を持つ最終のボディ(1 つ目のブーリアン)の id。
 *
 * 残す側(EX-04 W3): `keep` が外側なら差、内側なら積を積む。`keepBoth` が真のときは平面の切断の
 * 「反対側も残す」と同じく**ブーリアンを 2 つ**積み、2 つ目は残す側が逆で `pairedWith` に 1 つ目の
 * id を入れる(対象と押し出しは対で 1 度だけ消費される。押し出しも 1 つを共有する)。
 * 押し出し・ブーリアン 1〜2 は 1 回の文書の変更なので、元に戻す 1 回で全て消える。
 */
export function commitProfileCut(
  context: CutContext,
  keep: ProfileCutKeep = 'outside',
  keepBoth = false,
): SolidCommandOutcome {
  const target = cutTargetOf(context);
  if (target === null) {
    return { ok: false, reasonKey: 'shapeError.noTargetBody' };
  }
  const profile = cutProfileOf(context);
  if (profile === null) {
    return { ok: false, reasonKey: 'cutError.noProfile' };
  }
  const geometry = profileCutGeometry(context, target, profile);
  if (!geometry.ok) {
    return { ok: false, reasonKey: geometry.reasonKey };
  }
  const tool: ExtrudeFeature = {
    id: nextSolidId(context.document, 'extrude'),
    name: nextSolidName(context.document, 'extrude'),
    suppressed: false,
    kind: 'extrude',
    profile,
    // 長さは再計算のたびにカーネルが対象の厳密な境界箱から決める(`end.throughTarget`)。
    // `distance` は必須の欄なので確定時の長さを入れておくが、この終端では使われない。
    distance: expressionValueFromNumber(geometry.throughDistance),
    reversed: false,
    symmetric: false,
    end: { kind: 'throughTarget', targetFeatureId: target },
  };
  const withTool = appendSolid(context.document, tool);
  const first = profileCutFeatureOf(withTool, target, tool.id, keep, null);
  const withFirst = appendSolid(withTool, first);
  if (!keepBoth) {
    return { ok: true, document: withFirst, featureId: first.id };
  }
  const second = profileCutFeatureOf(withFirst, target, tool.id, keep === 'outside' ? 'inside' : 'outside', first.id);
  return { ok: true, document: appendSolid(withFirst, second), featureId: first.id };
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
 *
 * 座標の式の点(「点を座標で入れる」)と軸の位置(「X / Y / Z 軸に垂直な面」)は、補助の基準点を
 * 積んでから名指しする(EX-04 W1、`cutPlaneMaterials.ts`)。基準点と切断は**1 回の文書の変更**で
 * 積むので、元に戻す 1 回で両方が消える。断るときは文書を変えない。
 */
export function commitCutInput(
  context: CutContext,
  commit: SolidInputCommit,
): SolidCommandOutcome {
  const planeKind = commit.shapeChoices?.cutPlaneKind;
  if (planeKind === PROFILE_CUT_KIND) {
    // 閉じた輪郭で貫いて切る(EX04)。平面の決め方・傾きは使わない。残す側は平面の切断と同じ
    // つまみで選ぶ(EX-04 W3): 「反対側を残す」で輪郭の内側、「反対側も残す」で両方。
    return commit.flags.cutPointByCoordinate === true
      ? { ok: false, reasonKey: 'cutError.coordinatePointUnused' }
      : commitProfileCut(context, commit.flags.cutKeepOpposite === true ? 'inside' : 'outside',
        commit.flags.cutKeepBoth === true);
  }
  const prepared = prepareCutPlane(context, commit);
  if (!prepared.ok) {
    return prepared;
  }
  return commitCut(prepared.context, prepared.plane, prepared.keep, prepared.keepBoth);
}

/** 確定する平面の切断の中身(切る面・残す側・2 つに分けるか)と、補助の点を積んだ後の文脈。 */
export type PreparedCutPlane =
  | {
      readonly ok: true;
      /** 座標の式の点・軸の位置を補助の基準点として積んだ後の文書を持つ文脈(積む点が無ければ元のまま)。 */
      readonly context: CutContext;
      readonly plane: PlaneSpec;
      readonly keep: CutKeep;
      readonly keepBoth: boolean;
    }
  | { readonly ok: false; readonly reasonKey: MessageKey };

/**
 * その場入力の確定結果から、平面で切る中身を組み立てて押す前に確かめる(EX-04 W2)。
 *
 * **確定(`commitCutInput`)と予告(`cutPlanePreview.ts`)の共通の入口**で、材料の拾い方・決め方の
 * 組み立て・補助の点の積み方・断る順序と理由を 1 か所にまとめる(予告が確定と別の面を出さないため)。
 * 閉じた輪郭の切断(`profile`)は平面を作らないので、呼び出し側が先に分ける。文書は書き換えず、
 * 補助の点を積んだ文書は戻り値の文脈にだけ入れる。
 */
export function prepareCutPlane(context: CutContext, commit: SolidInputCommit): PreparedCutPlane {
  if (cutTargetOf(context) === null) {
    return { ok: false, reasonKey: 'shapeError.noTargetBody' };
  }
  const collected = collectCutMaterials(context);
  if (!collected.ok) {
    return { ok: false, reasonKey: collected.reasonKey };
  }
  const draft = cutPlaneDraft(context, collected.materials, commit.shapeChoices?.cutPlaneKind, commit);
  if (!draft.ok) {
    return draft;
  }
  const drafted: CutContext = { ...context, document: draft.document };
  const rejection = cutPlaneRejection(draft.plane) ?? cutPlaneMaterialRejection(drafted, draft.plane);
  if (rejection !== null) {
    return { ok: false, reasonKey: rejection };
  }
  const keep: CutKeep = commit.flags.cutKeepOpposite === true ? 'negative' : DEFAULT_CUT_KEEP;
  return { ok: true, context: drafted, plane: draft.plane, keep, keepBoth: commit.flags.cutKeepBoth ?? false };
}

/** 確定する切る面と、補助の点を積んだ後の文書。 */
type CutPlaneDraft =
  | { readonly ok: true; readonly document: PartDocument; readonly plane: PlaneSpec }
  | { readonly ok: false; readonly reasonKey: MessageKey };

/**
 * 座標の式の点を足せる決め方と、その決め方に要る点の数。点を使わない決め方は null。
 * 座標の点は選んだ点の**後ろ**に並ぶ(3 点なら、選んだ 2 点の次の 3 点目)。
 */
function coordinatePointSlots(planeKind: string | undefined): number | null {
  switch (planeKind) {
    case 'threePoints':
      return THREE_POINTS;
    case 'pointAndEdge':
    case EDGE_CONTAINING_CUT_KIND:
    case 'pointAndAxis':
      return 1;
    default:
      return null;
  }
}

/**
 * 確定の入力から切る面を組み立てる。軸の位置・座標の式の点は補助の基準点として積む。
 *
 * 座標の点は**決め方を選んだときだけ**使う。基準の 3 面(選んだものからの推測)・面・作業平面・
 * 軸に垂直な面では使わないので、入にしたまま決めたら理由を出して止める(黙って捨てない、
 * NFR-UX-5)。選んだ点と合わせて決め方に要る数を超えるときも止める。
 */
function cutPlaneDraft(
  context: CutContext,
  materials: CutMaterials,
  planeKind: string | undefined,
  commit: SolidInputCommit,
): CutPlaneDraft {
  const byCoordinate = commit.flags.cutPointByCoordinate === true;
  const axis = cutAxisOf(planeKind);
  if (axis !== null) {
    if (byCoordinate) {
      return { ok: false, reasonKey: 'cutError.coordinatePointUnused' };
    }
    const placed = placeAxisPoint(context.document, axis, commit.values.cutPosition);
    return placed.ok
      ? {
          ok: true,
          document: placed.document,
          plane: {
            kind: 'pointAndAxis',
            point: placed.point,
            axis: { kind: 'world', axis },
            tilt: DEFAULT_CUT_TILT,
            azimuth: DEFAULT_CUT_AZIMUTH,
          },
        }
      : placed;
  }
  const tilt = commit.values.cutTilt ?? DEFAULT_CUT_TILT;
  if (!byCoordinate) {
    const plane = planeSpecFromMaterials(materials, planeKind, tilt);
    return plane === null
      ? { ok: false, reasonKey: 'shapeError.noCutPlane' }
      : { ok: true, document: context.document, plane };
  }
  const slots = coordinatePointSlots(planeKind);
  if (slots === null) {
    return { ok: false, reasonKey: 'cutError.coordinatePointUnused' };
  }
  if (materials.points.length >= slots) {
    return { ok: false, reasonKey: 'cutError.tooManyPoints' };
  }
  const placed = placeCoordinatePoint(
    context.document,
    commit.values.cutPointX,
    commit.values.cutPointY,
    commit.values.cutPointZ,
  );
  if (!placed.ok) {
    return placed;
  }
  const plane = planeSpecFromMaterials(
    { ...materials, points: [...materials.points, placed.point] },
    planeKind,
    tilt,
  );
  return plane === null
    ? { ok: false, reasonKey: 'shapeError.noCutPlane' }
    : { ok: true, document: placed.document, plane };
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
 *
 * EX-04 W2 から、切断の道具の予告はこれを使わず `cutPlanePreview.ts`(確定と同じ式の評価・材料の
 * 解決)を通る。ここはビューの断面表示(FR-111)のように、文脈を持たずに指紋と基準の面だけで解く呼び出し用。
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
