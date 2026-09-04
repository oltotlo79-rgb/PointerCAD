/**
 * オフセット(FR-321、計画書 docs/plans/P4-スケッチ拡張.md タスク21)を、その場数値入力の
 * 確定からスケッチの履歴へ積む純関数。
 *
 * `sketchCommands.ts` の `commitFace` と同じ「選択から作る」構図(P3 の流儀)にそろえる。
 * DOM にもストアにも触れず、文書は不変で、作れないときは元の文書をそのまま返して
 * 理由キーだけを返す(FR-504、NFR-UX-5)。
 *
 * **オフセットの実際の形**(丸角・尖り角、内側へずらし過ぎ等)は OCCT に任せてある
 * (model タスク15の `SketchOffsetFeature` / `pendingOffsets` / `recomputeSketch` の
 * カーネル往復)。ここで確かめるのは「対象が選ばれているか」「選んだものが曲線か」だけで、
 * 距離が大きすぎて輪郭が潰れる等の失敗は再計算後に `sketchErrors` へ現れる(§2.9)。
 *
 * トリム・延長・フィレット/面取り・ミラー/複写/配列複写(タスク22〜24)もこのファイルへ集める
 * 想定(計画書ファイル構成)。今回はオフセットだけを実装する。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import {
  appendFeature,
  curveEnd,
  curveStart,
  isSamePoint,
  nextFeatureId,
  nextFeatureName,
  type OffsetCornerKind,
  type OffsetSide,
  type ResolvedCurve,
  type ResolvedSketch,
  type SketchDocument,
  type WorkPlaneId,
} from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';
import type { EditInputCommit } from './numericInput.js';
import { boundaryElementKind, toElementRef } from './sketchCommands.js';

/** オフセットの既定距離(mm、NFR-UX-4)。5mm は板物・ブラケットの縁取りでよく使う値。 */
export const DEFAULT_OFFSET_DISTANCE_MM = 5;

export type OffsetCommitOutcome =
  | { readonly ok: true; readonly document: SketchDocument; readonly featureId: string }
  /** 断った理由。文言は ja.json から引く(NFR-MA-5、NFR-UX-5)。 */
  | { readonly ok: false; readonly reasonKey: MessageKey };

/** 選択肢の文字列値を `OffsetSide` へ。読み取れなければ既定の外側(NFR-UX-4)。 */
function toOffsetSide(value: string | undefined): OffsetSide {
  return value === 'inside' ? 'inside' : 'outside';
}

/** 選択肢の文字列値を `OffsetCornerKind` へ。読み取れなければ既定の丸め。 */
function toOffsetCorner(value: string | undefined): OffsetCornerKind {
  return value === 'sharp' ? 'sharp' : 'round';
}

/**
 * 選んだ要素からオフセットを作る(FR-321)。選んだ順がそのまま `SketchOffsetFeature.source`
 * の並びになり、端点でつながった 1 本の輪郭として扱われる(つながっているかどうかの判定は
 * model 側 `resolveSketch` の役目、`commitFace` と同じ「選ぶ側は種類と個数だけを見る」構図)。
 *
 * 点・面が混ざっていたら断る(オフセットの対象は曲線に限る)。
 */
export function commitOffset(
  document: SketchDocument,
  resolved: ResolvedSketch,
  planeId: WorkPlaneId,
  selection: readonly string[],
  commit: EditInputCommit,
): OffsetCommitOutcome {
  if (selection.length === 0) {
    return { ok: false, reasonKey: 'offset.error.emptySelection' };
  }
  if (selection.some((elementId) => boundaryElementKind(resolved, elementId) !== 'curve')) {
    return { ok: false, reasonKey: 'offset.error.unsupportedElement' };
  }
  const distance =
    commit.values.distance ?? expressionValueFromNumber(DEFAULT_OFFSET_DISTANCE_MM);
  const featureId = nextFeatureId(document, 'offset');
  return {
    ok: true,
    featureId,
    document: appendFeature(document, {
      id: featureId,
      name: nextFeatureName(document, 'offset'),
      planeId,
      kind: 'offset',
      source: selection.map((elementId) => toElementRef(elementId)),
      distance,
      side: toOffsetSide(commit.choices.side),
      corner: toOffsetCorner(commit.choices.corner),
      construction: commit.flags.construction ?? false,
    }),
  };
}

/** ツールバーのボタンが押せる条件(§0.a-0.6 と同じ「対象を選んでから」の判定)。 */
export interface EditToolReadiness {
  readonly ready: boolean;
  readonly reasonKey: MessageKey | null;
}

/**
 * オフセットの道具が押せる条件。曲線が 1 つ以上選ばれていること(`commitOffset` の
 * 断り方と同じ判定を先に見せる。NFR-UX-5「実行してから失敗させない」)。
 */
export function offsetToolReadiness(
  resolved: ResolvedSketch,
  selection: readonly string[],
): EditToolReadiness {
  if (selection.length === 0) {
    return { ready: false, reasonKey: 'offset.error.emptySelection' };
  }
  if (selection.some((elementId) => boundaryElementKind(resolved, elementId) !== 'curve')) {
    return { ready: false, reasonKey: 'offset.error.unsupportedElement' };
  }
  return { ready: true, reasonKey: null };
}

/**
 * 選択中の id から曲線の列を引く。矩形・正多角形・長穴のように 1 フィーチャーが複数の曲線を
 * 生むものは、`index` を指定すれば `featureId#n` で n 番目だけ、省略すれば全周(§0.a-0.8)。
 * `pickMath.ts` の当たり判定はいまのところ多曲線フィーチャーを 1 クリックでまとめて選ぶ
 * (`elementId` が常に素の `featureId`)ので、実際にはほぼ「省略」側を通る。
 */
function curvesForElementId(resolved: ResolvedSketch, elementId: string): readonly ResolvedCurve[] {
  const ref = toElementRef(elementId);
  const group = resolved.curvesByFeature.get(ref.featureId);
  if (group !== undefined) {
    if (ref.index === undefined) {
      return group;
    }
    const selected = group[ref.index];
    return selected === undefined ? [] : [selected];
  }
  // 1 フィーチャー = 1 曲線(線分・円弧・楕円・スプライン)は curvesByFeature に入らない。
  const segment = resolved.segments.find((candidate) => candidate.featureId === ref.featureId);
  if (segment !== undefined) {
    return [segment];
  }
  const arc = resolved.arcs.find((candidate) => candidate.featureId === ref.featureId);
  if (arc !== undefined) {
    return [arc];
  }
  const ellipse = resolved.ellipses.find((candidate) => candidate.featureId === ref.featureId);
  if (ellipse !== undefined) {
    return [ellipse];
  }
  const spline = resolved.splines.find((candidate) => candidate.featureId === ref.featureId);
  return spline === undefined ? [] : [spline];
}

/**
 * 選んだ曲線が開いた輪郭かどうかの見込み(FR-321、タスク21)。オフセットの側の見出しを
 * 「外/内」(閉じた輪郭)か「左/右」(開いた曲線)かに切り替えるためだけに使う軽い判定で、
 * 実際の閉/開の確定判定(端点のつながり)は model 側 `resolveSketch`(タスク15)が行う
 * (`types.ts` の `OffsetSide` の注釈どおり、値そのものは常に `'outside' | 'inside'`)。
 *
 * 選んだ要素を並び順に曲線へ展開し(矩形などは全周の曲線列に広がる)、1 本だけなら始点と
 * 終点が同じ位置かどうか(全周の円・楕円・閉じたスプライン)、複数本なら最初の曲線の始点と
 * 最後の曲線の終点が同じ位置かどうかで見る。ここでの見誤りは表示する言葉が変わるだけで、
 * 実際の計算・エラー判定には影響しない(そちらは model 側が別途判定する)。
 */
export function offsetContourIsOpen(
  resolved: ResolvedSketch,
  selection: readonly string[],
): boolean {
  const curves = selection.flatMap((elementId) => curvesForElementId(resolved, elementId));
  if (curves.length === 0) {
    return false;
  }
  const first = curves[0];
  const last = curves[curves.length - 1];
  return !isSamePoint(curveStart(first), curveEnd(last));
}
