/**
 * 合致の対象の解決(計画書 docs/plans/P7-アセンブリ.md タスク12、§2.5.2、§2.12。
 * FR-603 / FR-609 / FR-329)。
 *
 * 合致(`Mate`)とジョイント(`Joint`)が指しているのは「どのインスタンスの、どの部分形状か」
 * (`MateTarget`)だけである。残差とヤコビアン(タスク14)が要るのは**世界座標の代表点 `p` と
 * 代表の向き `n`**(§2.5.2)なので、その 2 つ(と円筒の半径)へ直すのがこのファイルの役目。
 *
 * **部品の中の座標を、配置を掛けて世界座標へ直す**(§2.3 の⑥)。掛けるのはタスク2 の純関数
 * (`applyPlacementToPoint` / `applyPlacementToDirection`)で、回転行列の式をここへ書き写さない。
 *
 * **例外を投げない**(FR-504、NFR-RE-1「止めずに警告する」)。曲面(球面など)・軸の取れない形・
 * 見つからない部品は、**対象を消さずに理由(日本語の文言)を返す**——P3 §6.10-1(部分形状の
 * 指紋の誤選択)の教訓で、選び直せなかった対象を黙って捨てると利用者が合致を作り直す羽目になる。
 * 文言は §2.12 の表から 1 字も変えずに使う。
 *
 * **カーネルを呼ばない純関数。** 部分形状の位置・軸・半径は**保存された指紋**
 * (`SubShapeRef.fingerprint`)から取れる(下の「指紋から何が取れるか」)ので、既定では
 * カーネルへ問い合わせない。上流が変わった後の**選び直し**(P4 と同じ流儀)が要るときだけ、
 * 呼び出し側が `ResolveMateTargetOptions.subShape` に「選び直した指紋を返す関数」を渡す
 * (`geometry/planeSpec.ts` の `PlaneResolveContext.subShape` とまったく同じ約束)。
 *
 * **指紋から何が取れるか(2026-09-06 実測。`geometry/subShapeRef.ts:47`、
 * `packages/kernel/src/occt/subShapes.ts:97-153, 165-217`):**
 *   - 面: 種類(`surfaceKind`)・面積・**重心**(`position`)・**軸**(`axis`。平らな面は法線、
 *     円柱・円錐・トーラスは軸。球と自由曲面は null)・半径(円柱・円錐・球のみ)。
 *     **平らな面の法線も円筒の軸も指紋から取れる**ので、カーネルへの往復は要らない。
 *   - 辺: 種類(`curveKind`)・長さ・**重心**(`position`。直線なら中点、**全周の円ならその中心**)・
 *     軸(直線は向き、円・楕円は軸)・半径(円のみ)。
 *   - 頂点: 位置だけ。
 *
 * **頂点の限界(記録):** 頂点の指紋は位置しか持たない。カーネルの選び直し
 * (`matchSubShape.ts` の `scoreVertex`)も**通し番号と位置の 2 つだけ**で採点するため、
 * 上流を変えて番号が動き、かつ頂点そのものも動いた場合は、面・辺(軸・大きさ・種類でも
 * 照合できる)より届きにくい。**頂点どうしの一致(FR-609)を使う合致は、部品の形を大きく
 * 変えると外れやすい**——外れたときは対象を消さずに理由を返す(この関数の約束)。
 */

import type { SubShapeFingerprint, SubShapeRef } from '../../geometry/subShapeRef.js';
import { WORK_PLANES, WORLD_AXIS_DIRECTIONS } from '../../sketch/planeMath.js';
import { lengthVec3, normalizeVec3, ORIGIN, type Vec3 } from '../../sketch/vec3.js';
import {
  applyPlacementToDirection,
  applyPlacementToPoint,
  type RigidPlacement,
} from '../placementMath.js';
import { MISSING_PART_MESSAGE, type ResolvedAssembly } from '../resolveAssembly.js';
import type { MateTarget, OriginElement } from '../types.js';

/**
 * 合致の対象を、残差の側から見た 4 種類へ畳んだもの(§2.5.2 の `p` と `n`)。
 *
 * `cylinder` を `axis` と分けているのは、**接線合致(§2.5.2 の tangent)が半径を要る**ため。
 * 半径を持たない軸(直線の辺・部品の 3 軸・円錐の軸)と同じ種類にすると、残差の側で
 * 「半径があるか」を毎回見ることになる。
 */
export type MateTargetKind = 'plane' | 'axis' | 'point' | 'cylinder';

/**
 * 解決した合致の対象(**世界座標**)。長さは mm、向きは長さ 1。
 *
 * `point` は代表点(面なら重心、軸なら軸の上の点、頂点ならその点)、`direction` は代表の向き
 * (面なら法線、軸なら軸の向き)で、`point` に向きが無い(`kind === 'point'`)ときだけ null。
 * `radius` は円筒面と円の辺だけが持つ。
 */
export interface ResolvedMateTarget {
  readonly kind: MateTargetKind;
  readonly point: Vec3;
  readonly direction: Vec3 | null;
  readonly radius: number | null;
}

/** 対象を解決できなかった理由の区別(FR-504)。**利用者へは `message` をそのまま見せる。** */
export type MateTargetErrorCode =
  /** 指しているインスタンスが無い(消された・抑制された・部品の中身が引けない)。 */
  | 'missingComponent'
  /** 部分形状が選び直せない(ボディが消えた、指紋が壊れている)。 */
  | 'missingSubShape'
  /** 合致に使えない面(球面などの曲面)。 */
  | 'unusableFace'
  /** 軸の取れない形(楕円・自由曲線の辺、欠けた円弧)。 */
  | 'missingAxis';

/** 解決の結果。**投げずに戻り値で断る**(FR-504)。 */
export type MateTargetOutcome =
  | { readonly ok: true; readonly target: ResolvedMateTarget }
  | { readonly ok: false; readonly code: MateTargetErrorCode; readonly message: string };

/** 解決に添える設定。 */
export interface ResolveMateTargetOptions {
  /**
   * 部分形状の選び直し(P4 と同じ流儀)。**部品の鍵**(`ResolvedAssembly.partKeys` の値)と
   * 保存された参照を受け取り、**いまの形での指紋**を返す。選び直せなければ null。
   *
   * 鍵で渡すのはインスタンスの id ではない——同じ部品を 5 個置いても形は 1 つ(§0.a-0.4)で、
   * 選び直しの答えも 1 つだからである(インスタンスごとに呼ぶと同じ照合を 5 回することになる)。
   *
   * 返す型を `geometry/planeSpec.ts` の `ResolvedSubShape` ではなく**指紋そのもの**にしてある。
   * `ResolvedSubShape` は半径・面積・長さを落とすので、円筒の半径(§2.5.2 の接線合致)と
   * 円の辺が全周かどうかの判定(下の `isFullCircle`)が作れないためである。
   * 画面の側は選んだ瞬間に同じ形を組み立てている(`ui/src/solid/subShapeSelection.ts`)ので、
   * 渡す側に新しい詰め替えは要らない。
   */
  readonly subShape?: (partKey: string, reference: SubShapeRef) => SubShapeFingerprint | null;
}

/** 曲面(球面など)を合致の対象にした(§2.12 の断りの文言)。 */
export const UNUSABLE_FACE_MESSAGE =
  'この面は合致に使えません。平らな面か円筒の面を選んでください。';

/** 軸の取れない形を対象にした(§2.12 の断りの文言)。 */
export const MISSING_AXIS_MESSAGE = 'この形からは軸が決まりません。';

/**
 * 部分形状が選び直せない(FR-504)。**§2.12 の表に無い場面**なので、同じ意味を既に持っている
 * `geometry/planeSpec.ts` の `missingSubShape`(「…が見つかりません。形が大きく変わったため、
 * 選び直してください。」)と同じ言い回しにそろえた(同じ状況を 2 通りの文で説明しない)。
 */
export const MISSING_MATE_TARGET_MESSAGE =
  '合致の対象が見つかりません。形が大きく変わったため、選び直してください。';

/**
 * 向きが定まったとみなす最小の長さ(mm)。`geometry/planeSpec.ts` の `DIRECTION_EPSILON` と
 * 同じ値で、外積・正規化の退化を見る線引きをそろえてある。
 */
const DIRECTION_EPSILON = 1e-9;

/**
 * 円の辺が「全周」かどうかを見るときの、長さの相対誤差。
 *
 * 円の辺の指紋の位置は**重心**(`subShapes.ts` の `buildEdgeInfo`)なので、
 * **全周のときだけ円の中心と一致する**(半円なら中心から `2r/π` ずれる)。ずれた点を軸の上の
 * 点として返すと、同心合致が黙って違う場所へ収束してしまうため、全周でない円弧は断る。
 * OCCT の長さは厳密な曲線の積分(`BRepGProp.LinearProperties`)で相対誤差は 1e-9 の桁、
 * 一方で欠けた円弧は 4 分の 1 でも `0.25` ずれるので、1e-6 は両者をはっきり分ける。
 */
const CIRCLE_LENGTH_TOLERANCE_RATIO = 1e-6;

function refuse(code: MateTargetErrorCode, message: string): MateTargetOutcome {
  return { ok: false, code, message };
}

function accept(
  kind: MateTargetKind,
  point: Vec3,
  direction: Vec3 | null,
  radius: number | null,
): MateTargetOutcome {
  return { ok: true, target: { kind, point, direction, radius } };
}

/** 長さ 1 へ揃えた向き。null・長さ 0・NaN は「向きが取れない」として null。 */
function usableDirection(axis: Vec3 | null): Vec3 | null {
  if (axis === null || !axis.every((value) => Number.isFinite(value))) {
    return null;
  }
  return lengthVec3(axis) <= DIRECTION_EPSILON ? null : normalizeVec3(axis);
}

/** 半径として使える数か(0 と負の数は形にならない)。 */
function usableRadius(radius: number | null): radius is number {
  return radius !== null && Number.isFinite(radius) && radius > 0;
}

function isFinitePoint(point: Vec3): boolean {
  return point.every((value) => Number.isFinite(value));
}

/** 円の辺が全周か(重心が中心と一致するのは全周のときだけ)。 */
function isFullCircle(length: number, radius: number): boolean {
  const full = 2 * Math.PI * radius;
  return Math.abs(length - full) <= CIRCLE_LENGTH_TOLERANCE_RATIO * full;
}

/**
 * 面 1 枚を対象へ直す(部品の中の座標のまま)。
 *
 * 取れるのは**平らな面・円筒面・円錐面の軸**(§0.a-0.13 の「対象に取れるもの」)で、
 * **球面・トーラス・自由曲面は断る**(§0.a-0.13「曲面は取れない」)。円錐は半径が場所で
 * 変わる(指紋の `radius` は基準位置の半径)ので、**半径を持たない `axis`** として返す。
 */
function faceTarget(fingerprint: Extract<SubShapeFingerprint, { kind: 'face' }>): MateTargetOutcome {
  const direction = usableDirection(fingerprint.axis);
  switch (fingerprint.surfaceKind) {
    case 'plane':
      return direction === null
        ? refuse('unusableFace', UNUSABLE_FACE_MESSAGE)
        : accept('plane', fingerprint.position, direction, null);
    case 'cylinder':
      return direction === null || !usableRadius(fingerprint.radius)
        ? refuse('unusableFace', UNUSABLE_FACE_MESSAGE)
        : accept('cylinder', fingerprint.position, direction, fingerprint.radius);
    case 'cone':
      return direction === null
        ? refuse('unusableFace', UNUSABLE_FACE_MESSAGE)
        : accept('axis', fingerprint.position, direction, null);
    case 'sphere':
    case 'torus':
    case 'other':
      return refuse('unusableFace', UNUSABLE_FACE_MESSAGE);
  }
}

/**
 * 辺 1 本を対象へ直す(部品の中の座標のまま)。
 *
 * 取れるのは**まっすぐな辺**(向きが軸になる)と**全周の円の辺**(中心と軸が取れる)だけ。
 * 楕円・自由曲線と欠けた円弧は「この形からは軸が決まりません。」と断る(§2.12)。
 */
function edgeTarget(fingerprint: Extract<SubShapeFingerprint, { kind: 'edge' }>): MateTargetOutcome {
  const direction = usableDirection(fingerprint.axis);
  switch (fingerprint.curveKind) {
    case 'line':
      return direction === null
        ? refuse('missingAxis', MISSING_AXIS_MESSAGE)
        : accept('axis', fingerprint.position, direction, null);
    case 'circle':
      if (direction === null || !usableRadius(fingerprint.radius)) {
        return refuse('missingAxis', MISSING_AXIS_MESSAGE);
      }
      return isFullCircle(fingerprint.length, fingerprint.radius)
        ? accept('axis', fingerprint.position, direction, fingerprint.radius)
        : refuse('missingAxis', MISSING_AXIS_MESSAGE);
    case 'ellipse':
    case 'other':
      return refuse('missingAxis', MISSING_AXIS_MESSAGE);
  }
}

/** 部分形状 1 つを対象へ直す(部品の中の座標のまま)。 */
function subShapeTarget(fingerprint: SubShapeFingerprint): MateTargetOutcome {
  if (!isFinitePoint(fingerprint.position)) {
    // 壊れた指紋(NaN・∞)。ここで断らないと NaN がそのままソルバの残差へ流れる。
    return refuse('missingSubShape', MISSING_MATE_TARGET_MESSAGE);
  }
  switch (fingerprint.kind) {
    case 'face':
      return faceTarget(fingerprint);
    case 'edge':
      return edgeTarget(fingerprint);
    case 'vertex':
      return accept('point', fingerprint.position, null, null);
  }
}

/**
 * 部品の原点・3 軸・3 平面(基準ジオメトリ、FR-329)を対象へ直す(部品の中の座標のまま)。
 *
 * どれも**部品の原点を通る**ので点は原点。軸の向きと面の法線は既存の固定表
 * (`sketch/planeMath.ts` の `WORLD_AXIS_DIRECTIONS` / `WORK_PLANES`)から引く——
 * 基準の 3 面の法線(`xz` は `(0, −1, 0)`)を 2 か所に書かないため。
 */
function originTarget(element: OriginElement): MateTargetOutcome {
  switch (element) {
    case 'origin':
      return accept('point', ORIGIN, null, null);
    case 'x':
    case 'y':
    case 'z':
      return accept('axis', ORIGIN, WORLD_AXIS_DIRECTIONS[element], null);
    case 'xy':
    case 'xz':
    case 'yz':
      return accept('plane', ORIGIN, WORK_PLANES[element].normal, null);
  }
}

/** 部品の中の座標を、配置を掛けて世界座標へ直す(§2.3 の⑥)。 */
function inWorld(placement: RigidPlacement, local: ResolvedMateTarget): ResolvedMateTarget {
  return {
    kind: local.kind,
    point: applyPlacementToPoint(placement, local.point),
    // 平行移動は向きを変えない(`placementMath.ts` の約束)。長さ 1 は回転で保たれる。
    direction:
      local.direction === null ? null : applyPlacementToDirection(placement, local.direction),
    radius: local.radius,
  };
}

/**
 * 合致の対象 1 つを世界座標の「点と向き」へ解決する(FR-603、FR-609、FR-329)。
 *
 * 第 2 引数はタスク6 の解決結果まるごと。計画書のタスク12 は
 * `resolveMateTarget(target, resolvedParts, placements)` の 3 つ組で書いているが、
 * **対象の `componentId` から形へ届くには `partKeys`(インスタンス → 部品の鍵)が要る**
 * (タスク6 の申し送り)。3 つに割ると呼び出し側が組を作り直すことになり、
 * 別々の解決結果を取り違えて渡せてしまうので、1 つの `ResolvedAssembly` を受け取る形にした。
 *
 * **抑制された部品・消された部品は `placements` に入らない**ので、そのまま「部品が
 * 見つかりません。」になる(投げない。FR-504)。
 */
export function resolveMateTarget(
  target: MateTarget,
  resolved: ResolvedAssembly,
  options: ResolveMateTargetOptions = {},
): MateTargetOutcome {
  const placement = resolved.placements.get(target.componentId);
  if (placement === undefined) {
    return refuse('missingComponent', MISSING_PART_MESSAGE);
  }
  if (target.kind === 'origin') {
    // 基準ジオメトリは部品の中身を見ない(原点と 3 軸は文書が無くても決まる)。
    // 部品文書が引けなかったインスタンスでも、置いた場所は分かっているので合致を付けられる。
    const local = originTarget(target.element);
    return local.ok ? { ok: true, target: inWorld(placement, local.target) } : local;
  }

  const partKey = resolved.partKeys.get(target.componentId);
  const part = partKey === undefined ? undefined : resolved.parts.get(partKey);
  if (partKey === undefined || part === undefined) {
    // 置いてはあるが中身が引けない(`partKeys` に入らないのはこの場合だけ。タスク6)。
    return refuse('missingComponent', MISSING_PART_MESSAGE);
  }
  if (!part.liveBodyIds.includes(target.ref.bodyFeatureId)) {
    // 指しているボディが画面に無い(消された・ブーリアンに食われた・上流が失敗した)。
    // ここで断らないと、古い指紋の位置がそのまま世界座標として残差へ流れる。
    return refuse('missingSubShape', MISSING_MATE_TARGET_MESSAGE);
  }
  const fingerprint =
    options.subShape === undefined
      ? target.ref.fingerprint
      : options.subShape(partKey, target.ref);
  if (fingerprint === null) {
    return refuse('missingSubShape', MISSING_MATE_TARGET_MESSAGE);
  }
  const local = subShapeTarget(fingerprint);
  return local.ok ? { ok: true, target: inWorld(placement, local.target) } : local;
}
