/**
 * スケッチの再計算(計画書 docs/plans/P1-式とスケッチ.md タスク12、要件§6.3)。
 *
 * 履歴を解決し、面があればカーネルで三角形にする。点・線・円弧の表示に必要な情報は
 * 解決結果(ResolvedSketch)に入っているので、カーネルは面のときだけ呼ぶ
 * (マウス操作のたびに Worker を往復させないため、NFR-PF-1、計画書 §2.7)。
 * どこで失敗しても例外を投げず、理由を errors へ入れて返す(FR-504、NFR-RE-1)。
 */

import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';

import type {
  KernelBridge,
  SketchOffsetEntry,
  SketchOffsetRequestItem,
} from '../kernelBridge.js';
import type { ConstraintDiagnosis } from './constraints/diagnose.js';
import { resolveConstrainedSketch } from './constraints/solveSketch.js';
import { mapSketchExpressions } from './mapExpressions.js';
import {
  closedOffsetDistance,
  createOffsetCache,
  offsetDisplacement,
  offsetSideOf,
  type OffsetCache,
} from './offsetMath.js';
import { curveEnd, curveStart } from './resolveSketch.js';
import type {
  PendingOffset,
  ResolvedCurve,
  ResolvedSketch,
  SketchDocument,
  SketchError,
  SketchMesh,
} from './types.js';

export interface SketchRecomputeResult {
  readonly resolved: ResolvedSketch;
  /** 面が 1 枚も無いとき(カーネルを呼ばないとき)と、呼び出しごと失敗したときは null。 */
  readonly mesh: SketchMesh | null;
  /** 解決の失敗・拘束の失敗・カーネルの失敗を合わせたもの(FR-504)。 */
  readonly errors: readonly SketchError[];
  /**
   * 拘束の診断(自由度・足しすぎ・矛盾。FR-313、P4b タスク8)。拘束が無ければ null。
   * 部品文書の経路は `PartSketchResult.diagnosis` が同じものを持つ。
   */
  readonly diagnosis: ConstraintDiagnosis | null;
}

/** 再計算に添える設定。 */
export interface SketchRecomputeOptions {
  /**
   * 計算済みのオフセット(FR-321、タスク15)を覚えておく入れ物。
   *
   * 渡さないと呼び出しのたびに新しく作るので、毎回カーネルへ頼み直すことになる。
   * 画面から繰り返し呼ぶ側(ui、タスク21)は 1 つ作って持ち回る(NFR-PF-2)。
   */
  readonly offsets?: OffsetCache;
}

/** カーネルの失敗を利用者向けの一文にする。理由はカーネルが日本語で返す。 */
function kernelFailed(featureId: string, message: string): SketchError {
  return { featureId, code: 'kernelFailed', message: `面を作れませんでした: ${message}` };
}

/** オフセットの失敗。面とは別の言い回しにして、どの操作で失敗したかを分かるようにする。 */
function offsetFailed(featureId: string, message: string): SketchError {
  return { featureId, code: 'kernelFailed', message: `ずらした線を作れませんでした: ${message}` };
}

/**
 * 1 回目に頼む符号つき距離。
 *
 * 閉じた輪郭は「正が外側」で確定している(`offsetMath.ts` 冒頭の実測)。
 * 開いた曲線は OCCT がどちらを左と見るか外から分からないので、まず正で頼み、
 * 出来上がりを見て違っていれば反対で頼み直す。
 */
function firstDistanceOf(pending: PendingOffset): number {
  return pending.contour.closed
    ? closedOffsetDistance(pending.distance, pending.side)
    : pending.distance;
}

function toOffsetRequest(pending: PendingOffset, distance: number): SketchOffsetRequestItem {
  return {
    featureId: pending.featureId,
    curves: pending.curves,
    distance,
    corner: pending.corner,
  };
}

/** 輪郭が 2 本以上に分かれた場合も、たどる順に 1 本の列へつなげて覚える。 */
function flattenContours(entry: SketchOffsetEntry): readonly ResolvedCurve[] {
  return entry.contours.flatMap((contour) => contour.curves);
}

/**
 * 出来上がった開いた曲線が、頼んだ側と逆に乗っていないかを見る。
 *
 * 輪郭が 2 本以上に分かれたときと、ずれの向きが左右のどちらとも言えないとき
 * (距離 0 など)は判定しない(頼み直さない)。
 */
function isWrongSide(pending: PendingOffset, entry: SketchOffsetEntry): boolean {
  if (pending.contour.closed || entry.contours.length !== 1) {
    return false;
  }
  const curves = entry.contours[0].curves;
  if (curves.length === 0) {
    return false;
  }
  const displacement = offsetDisplacement(
    pending.contour.startPoint,
    curveStart(curves[0]),
    curveEnd(curves[curves.length - 1]),
  );
  const side = offsetSideOf(
    displacement,
    pending.contour.startDirection,
    pending.contour.normal,
  );
  return side !== null && side !== pending.side;
}

/**
 * まだ形の無いオフセットをカーネルへ頼み、結果を覚え書きへ入れる(FR-321、タスク15)。
 *
 * 往復は最大 2 回。1 回目で全件をまとめて頼み、開いた曲線が逆側に出たものだけを
 * 2 回目でまとめて頼み直す。返すのは失敗の一覧だけで、成功したものは覚え書きに入る
 * (呼び出し側が解決をやり直すと、そこから曲線が入る)。
 */
/**
 * `recomputePart.ts`(タスク21)が、部品の中の複数スケッチぶんの `pendingOffsets` を
 * まとめて 1 回のカーネル往復で埋めるのにも使うため、この関数だけは輸出する。
 * 他はスケッチ単体の再計算(`recomputeSketch`)の内側だけで完結させる。
 */
export async function fillOffsets(
  bridge: KernelBridge,
  pendingOffsets: readonly PendingOffset[],
  offsets: OffsetCache,
): Promise<readonly SketchError[]> {
  const byFeature = new Map(pendingOffsets.map((pending) => [pending.featureId, pending]));
  const errors: SketchError[] = [];
  const retries: SketchOffsetRequestItem[] = [];

  try {
    const outcome = await bridge.offsetSketchCurves(
      pendingOffsets.map((pending) => toOffsetRequest(pending, firstDistanceOf(pending))),
    );
    for (const failure of outcome.failures) {
      errors.push(offsetFailed(failure.featureId, failure.message));
    }
    for (const entry of outcome.results) {
      const pending = byFeature.get(entry.featureId);
      if (pending === undefined) {
        continue;
      }
      if (isWrongSide(pending, entry)) {
        retries.push(toOffsetRequest(pending, -firstDistanceOf(pending)));
        continue;
      }
      offsets.set(pending.key, flattenContours(entry));
    }
  } catch (error) {
    // Worker との通信ごと失敗した場合。頼んだオフセットはすべて作れていない。
    const message = error instanceof Error ? error.message : String(error);
    return pendingOffsets.map((pending) => offsetFailed(pending.featureId, message));
  }

  if (retries.length === 0) {
    return errors;
  }

  try {
    const outcome = await bridge.offsetSketchCurves(retries);
    for (const failure of outcome.failures) {
      errors.push(offsetFailed(failure.featureId, failure.message));
    }
    for (const entry of outcome.results) {
      const pending = byFeature.get(entry.featureId);
      if (pending !== undefined) {
        offsets.set(pending.key, flattenContours(entry));
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const retry of retries) {
      errors.push(offsetFailed(retry.featureId, message));
    }
  }

  return errors;
}

/**
 * スケッチを解決し、面があればカーネルで三角形にする(要件§6.3)。
 * 面が 1 枚失敗しても残りは描けるので、mesh と errors を両方返す(FR-504、NFR-RE-1)。
 *
 * オフセット(FR-321、タスク15)があるときは、**解決 → カーネルで形を作る → 解決し直す**
 * の順で進む。解決そのものは OCCT を呼ばない純関数のままで、形は覚え書き越しに差し込む。
 */
export async function recomputeSketch(
  document: SketchDocument,
  bridge: KernelBridge,
  options: SketchRecomputeOptions = {},
): Promise<SketchRecomputeResult> {
  const offsets = options.offsets ?? createOffsetCache();
  const offsetCurves = (key: string): readonly ResolvedCurve[] | null => offsets.get(key);
  // 拘束(FR-313、P4b タスク8)も解く。拘束が 1 つも無ければ
  // `resolveConstrainedSketch` は `resolveSketch` を 1 回呼ぶだけなので費用は変わらない。
  let constrained = resolveConstrainedSketch(document, { offsetCurves });
  let resolved = constrained.resolved;
  const offsetErrors: SketchError[] = [];

  if (resolved.pendingOffsets.length > 0) {
    offsetErrors.push(...(await fillOffsets(bridge, resolved.pendingOffsets, offsets)));
    // 形が入ったので解決し直す。オフセットの曲線が面の境界にも使えるようになる。
    constrained = resolveConstrainedSketch(document, { offsetCurves });
    resolved = constrained.resolved;
  }
  const diagnosis = constrained.diagnosis;
  const beforeKernel = [...resolved.errors, ...constrained.errors, ...offsetErrors];

  if (resolved.faces.length === 0) {
    return { resolved, mesh: null, errors: beforeKernel, diagnosis };
  }

  try {
    const outcome = await bridge.tessellateSketchFaces(resolved.faces);
    const failures = outcome.failures.map((failure) =>
      kernelFailed(failure.featureId, failure.message),
    );
    return {
      resolved,
      mesh: outcome.mesh,
      errors: [...beforeKernel, ...failures],
      diagnosis,
    };
  } catch (error) {
    // Worker との通信ごと失敗した場合。頼んだ面はすべて作れていない。
    const message = error instanceof Error ? error.message : String(error);
    const failures = resolved.faces.map((face) => kernelFailed(face.featureId, message));
    return { resolved, mesh: null, errors: [...beforeKernel, ...failures], diagnosis };
  }
}

/**
 * 1 つの式を評価し直す。評価できなくなったら元の値を残す。
 *
 * 値も表示も変わらなければ**元のオブジェクトをそのまま返す**。こうしておくと、
 * `mapSketchExpressions` が「1 つも変わらなかった」ことを参照の比較だけで判定でき、
 * 中身が同じ文書を作り直して下流の鍵を無駄に変えることがなくなる(P4b タスク3)。
 */
function reevaluate(value: ExpressionValue, variables: ReadonlyMap<string, number>): ExpressionValue {
  const result = evaluateExpression(value.source, { variables });
  if (!result.ok) {
    // 評価できない式で文書を壊さない。解決の段で invalidValue として拾われる(FR-504)。
    return value;
  }
  const next = result.value;
  return next.value === value.value && next.display === value.display ? value : next;
}

/**
 * すべての式を評価し直す(FR-206 の変数変更、FR-502 の下流再計算の土台)。
 * 式文字列は変えない。変わるのは評価値と表示用の文字列だけ(FR-202)。
 *
 * 「スケッチのどこに式があるか」を知っているのは `mapExpressions.ts` の 1 か所だけ。
 * 部品文書の全域(立体・基準ジオメトリ)を回す `part/reevaluatePart.ts` も**同じ歩き方**
 * (`mapSketchExpressions`)を通るので、要素の種類が増えても両方が同時に追従する
 * (同じ規則を 2 か所に書かない。P4b タスク3)。
 */
export function reevaluateDocument(
  document: SketchDocument,
  variables: ReadonlyMap<string, number>,
): SketchDocument {
  return mapSketchExpressions(document, (value) => reevaluate(value, variables));
}
