import type { WorkPlane } from '../sketch/planeMath.js';
import { projectionCacheKey } from '../sketch/projectionMath.js';
import { projectionBodyFeatureId, type PendingProjection, type ProjectionSource, type ResolvedSketch } from '../sketch/types.js';
import { firstSketchUseIndexes } from './solidSketchReferences.js';
import type { PartDocument } from './types.js';

interface ProjectionSketch {
  readonly sketchId: string;
  readonly resolved: Pick<ResolvedSketch, 'pendingProjections'>;
}

/**
 * まだ形の無い投影・交差を、カーネルへ頼める形まで組み立てたもの(FR-325)。
 *
 * スケッチ側の `PendingProjection` は「どの立体の何を、どの作図面へ」までしか知らない。
 * ここでその立体の**段の鍵**(`ResolvedSolidStep.key`)を足すことで、
 * ①覚え書きの鍵が作れる(上流が変われば必ず変わる)、②カーネルが形状キャッシュから
 * もとの立体を引ける、の 2 つがそろう。頼むのは `recomputePart` の役目。
 */
export interface ResolvedProjection {
  /** この投影・交差を持つスケッチの id。 */
  readonly sketchId: string;
  /** 投影・交差フィーチャーの id。結果の対応づけに使う。 */
  readonly featureId: string;
  /** 覚え書き(`ProjectionCache`)の鍵。 */
  readonly key: string;
  /** もとの立体の段の鍵。 */
  readonly bodyKey: string;
  readonly source: ProjectionSource;
  readonly plane: WorkPlane;
}

/* ------------------------------------------------------------------ *
 * 投影・交差の解決順序(FR-325)
 * ------------------------------------------------------------------ */

/** 参照先の立体が見つからない(未作成・抑制中・上流が失敗・削除された)。 */
function missingProjectionBodyMessage(source: ProjectionSource): string {
  return source.kind === 'subShape'
    ? '投影のもとになるソリッドが見つかりません。ソリッドを選び直してください。'
    : '断面をとるソリッドが見つかりません。ソリッドを選び直してください。';
}

/** 順序違反(自分より後に作られる立体を指した)。順序の制約。 */
function laterProjectionBodyMessage(source: ProjectionSource): string {
  const what = source.kind === 'subShape' ? '投影' : '断面';
  return `${what}のもとにできるのは、このスケッチを使うソリッドより前に作られたソリッドだけです。履歴の順序を見直してください。`;
}

/**
 * まだ形の無い投影・交差を、カーネルへ頼める形(`ResolvedProjection`)へ組み立てる。
 * 参照先が見つからない・順序違反のものは頼まず、呼出し側へ理由を返す(FR-504)。
 */
export function collectProjections(
  document: PartDocument,
  sketches: readonly ProjectionSketch[],
  bodyKeys: ReadonlyMap<string, string>,
  onMissingBody: (featureId: string, message: string) => void,
): readonly ResolvedProjection[] {
  const anyPending = sketches.some((entry) => entry.resolved.pendingProjections.length > 0);
  if (!anyPending) {
    // 投影・交差を持たない部品(ほとんどの部品)では、表も作らず素通りする(NFR-PF-3)。
    return [];
  }
  const bodyOrder = new Map<string, number>();
  document.solids.forEach((feature, index) => {
    if (!bodyOrder.has(feature.id)) {
      bodyOrder.set(feature.id, index);
    }
  });
  // 点の参照からスケッチを引けるように、スケッチの一覧も渡す(FR-425・FR-424)。
  const firstUse = firstSketchUseIndexes(document.solids, document.sketches);

  const requests: ResolvedProjection[] = [];
  for (const entry of sketches) {
    for (const pending of entry.resolved.pendingProjections) {
      const request = planProjection(
        entry.sketchId,
        pending,
        bodyKeys,
        bodyOrder,
        firstUse.get(entry.sketchId),
      );
      if (!request.ok) {
        onMissingBody(pending.featureId, request.message);
        continue;
      }
      requests.push(request.projection);
    }
  }
  return requests;
}

type ProjectionOutcome =
  | { readonly ok: true; readonly projection: ResolvedProjection }
  | { readonly ok: false; readonly message: string };

/** 1 件の投影・交差について、参照先と順序を確かめてから鍵を作る。 */
function planProjection(
  sketchId: string,
  pending: PendingProjection,
  bodyKeys: ReadonlyMap<string, string>,
  bodyOrder: ReadonlyMap<string, number>,
  firstUseIndex: number | undefined,
): ProjectionOutcome {
  const bodyFeatureId = projectionBodyFeatureId(pending.source);
  const bodyKey = bodyKeys.get(bodyFeatureId);
  if (bodyKey === undefined) {
    return {
      ok: false,
      message: missingProjectionBodyMessage(pending.source),
    };
  }
  // 順序の制約。そのスケッチをどの立体も使っていなければ制約は無い。
  const bodyIndex = bodyOrder.get(bodyFeatureId);
  if (
    firstUseIndex !== undefined &&
    bodyIndex !== undefined &&
    bodyIndex >= firstUseIndex
  ) {
    return {
      ok: false,
      message: laterProjectionBodyMessage(pending.source),
    };
  }
  return {
    ok: true,
    projection: {
      sketchId,
      featureId: pending.featureId,
      key: projectionCacheKey({ bodyKey, source: pending.source, plane: pending.plane }),
      bodyKey,
      source: pending.source,
      plane: pending.plane,
    },
  };
}
