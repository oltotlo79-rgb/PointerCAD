/**
 * 基準ジオメトリの解決器が持つ「履歴の順」「解いた結果の記憶」「解いている途中の印」。
 *
 * 基準ジオメトリとそれを作図面に使うスケッチは互いを呼び合うので、頼まれたときに解いて覚える
 * (遅延+記憶)。解いている途中にもう一度頼まれたら循環、自分より後に作られたものを指したら
 * 履歴順の違反として、どちらも日本語の理由で断る(FR-504。止めずに理由を出す)。
 * 種類ごとの解き方は外から渡す(`resolveReferences.ts` の `resolveFeature`)。
 */

import type { AxisFrame, ResolvedPlane } from '../geometry/planeSpec.js';
import type { Vec3 } from '../sketch/vec3.js';
import type { ReferenceError, ReferenceErrorCode } from './resolveReferences.js';
import type { PartDocument, ReferenceFeature } from './types.js';

export type ReferenceOutcome =
  | { readonly ok: true; readonly value: ResolvedReferenceValue }
  | { readonly ok: false; readonly error: ReferenceError };

type ResolvedReferenceValue =
  | { readonly kind: 'referencePlane'; readonly plane: ResolvedPlane }
  | { readonly kind: 'referenceAxis'; readonly frame: AxisFrame }
  | { readonly kind: 'referencePoint'; readonly position: Vec3 }
  | {
      readonly kind: 'referenceCoordinateSystem';
      readonly origin: Vec3;
      readonly xAxis: Vec3;
      readonly yAxis: Vec3;
      readonly zAxis: Vec3;
    };

function referenceError(
  featureId: string,
  code: ReferenceErrorCode,
  message: string,
): ReferenceError {
  return { featureId, code, message };
}

export function failed(featureId: string, code: ReferenceErrorCode, message: string): ReferenceOutcome {
  return { ok: false, error: referenceError(featureId, code, message) };
}

interface ReferenceMemo {
  /**
   * 参照先が「頼んだ側より前」かを見る。後ろ・自分自身なら断る。
   * 文書には在るのに後ろだった場合は、断りの文言を変えられるよう名前を覚えておく。
   */
  readonly withinHistory: (featureId: string, limit: number) => boolean;
  /**
   * 1 つを解いて覚える。解いている途中にもう一度頼まれたら循環として断る。
   * `limit` は「頼んだ側の履歴上の位置」で、参照先はそれより前でなければならない。
   */
  readonly resolve: (featureId: string, limit: number) => ReferenceOutcome;
}

/**
 * 解決器 1 つ分の記憶を作る。`solve` は 1 つの基準を解く関数で、自分より前だけを参照できる
 * ように、上限として自分の履歴上の位置を受け取る。
 */
export function createReferenceMemo(
  document: PartDocument,
  solve: (feature: ReferenceFeature, limit: number) => ReferenceOutcome,
): ReferenceMemo {
  const order = new Map<string, number>();
  const byId = new Map<string, ReferenceFeature>();
  document.references.forEach((feature, index) => {
    // 同じ id が 2 つあるときは先に出たほうを正とする(履歴の一意性は生成側が守る)。
    if (!byId.has(feature.id)) {
      byId.set(feature.id, feature);
      order.set(feature.id, index);
    }
  });

  const cache = new Map<string, ReferenceOutcome>();
  const active = new Set<string>();
  /** いま解いている途中で循環に当たったか(`resolve` が拾い直すための印)。 */
  let cycleSeen = false;
  /** いま解いている途中で「後から作られたもの」を参照したか。その名前を覚える。 */
  let laterReference: string | null = null;

  /**
   * いま立っている印を読み出す。**関数越しに読む**のは、印を立てるのが入れ子の呼び出しの
   * 中なのに、型検査の流れ解析からは「直前に入れた値のまま」に見えてしまうため
   * (関数の境界をまたぐと絞り込みが解ける)。
   */
  function currentMarks(): { readonly cycle: boolean; readonly later: string | null } {
    return { cycle: cycleSeen, later: laterReference };
  }

  function withinHistory(featureId: string, limit: number): boolean {
    const index = order.get(featureId);
    if (index === undefined) {
      return false;
    }
    if (index < limit) {
      return true;
    }
    laterReference = byId.get(featureId)?.name ?? featureId;
    return false;
  }

  function resolve(featureId: string, limit: number): ReferenceOutcome {
    const feature = byId.get(featureId);
    if (feature === undefined) {
      return failed(featureId, 'missingPlane', `基準ジオメトリが見つかりません: ${featureId}`);
    }
    if (!withinHistory(featureId, limit)) {
      return failed(
        featureId,
        'missingPlane',
        `${feature.name}は後から作られたので、ここからは参照できません。先に作ってください。`,
      );
    }
    if (active.has(featureId)) {
      cycleSeen = true;
      return failed(
        featureId,
        'circularReference',
        `${feature.name}の指定が循環しています。参照をたどると自分自身に戻ってきます。`,
      );
    }
    const remembered = cache.get(featureId);
    if (remembered !== undefined) {
      return remembered;
    }
    active.add(featureId);
    // 自分より前だけを参照できるので、上限は自分の位置になる。
    const own = order.get(featureId) ?? 0;
    // 循環はスケッチを経由して起きる(作業平面 → スケッチの点 → その作業平面)。
    // 途中で見つけた循環は「点が見つからない」に化けてしまうので、印を立てて拾い直す。
    const outer = currentMarks();
    cycleSeen = false;
    laterReference = null;
    const outcome = solve(feature, own);
    const seen = currentMarks();
    cycleSeen = outer.cycle;
    laterReference = outer.later;
    active.delete(featureId);
    let settled: ReferenceOutcome = outcome;
    if (!outcome.ok && seen.cycle) {
      settled = failed(
        featureId,
        'circularReference',
        `${feature.name}の指定が循環しています。参照をたどると自分自身に戻ってきます。`,
      );
    } else if (!outcome.ok && seen.later !== null) {
      settled = failed(
        featureId,
        outcome.error.code,
        `${seen.later}は${feature.name}より後から作られたので、参照できません。先に作ってください。`,
      );
    }
    cache.set(featureId, settled);
    return settled;
  }

  return { withinHistory, resolve };
}
