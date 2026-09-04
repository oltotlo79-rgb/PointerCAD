/**
 * 投影・交差(FR-325、計画書 docs/plans/P4-スケッチ拡張.md タスク27)を、選んだ・押した
 * 立体の面・辺・立体からスケッチの履歴へ積む純関数。
 *
 * `editCommands.ts` / `copyCommands.ts` と同じ流儀にそろえる。DOM にもストアにも触れず、
 * 文書は不変で、作れないときは理由の鍵だけを返す(FR-504、NFR-UX-5)。
 *
 * **形はここでは決まらない。** 投影した曲線・断面の輪郭は立体の B-rep が要るので、実際の形を
 * 作るのはカーネル(`makeProjection.ts` / `makeSection.ts`)で、その往復を回すのは model の
 * `recomputePart`(タスク25)である。ここでするのは「どの立体の何を、どの作図面へ取り込むか」を
 * 履歴の 1 行にすることだけで、幾何の判断は 1 つも持たない。交わらない・投影しても線に
 * ならないといった断りは、再計算のあとに `sketchErrors` として帯へ出る(§2.9)。
 *
 * **順序の制約(§0.a-0.11)は道具の側でも先に案内する。** 取り込めるのは「このスケッチを使う
 * 立体より前に作られた立体」だけで、後の立体を指すと model が `missingBody` で断る。断りが
 * 再計算のあとにしか出ないと「押したのに何も起きない」ように見えるので、押した時点で同じ判定
 * (`projectionOrderRejection`)を行って帯へ理由を出す(NFR-UX-5「実行してから失敗させない」)。
 * 判定の材料は model の `referencedSketchIds` で、model 側(`resolvePart.ts` の
 * `planProjection`)と同じ数え方をそのまま使う(同じ判断を 2 通りに書かないため)。
 */

import {
  appendFeature,
  nextFeatureId,
  nextFeatureName,
  projectionBodyFeatureId,
  referencedSketchIds,
  type PartDocument,
  type ProjectionSource,
  type SketchDocument,
  type SubShapeRef,
  type WorkPlaneId,
} from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';
import { parseSubShapeId, subShapeRefOf, type SubShapeBody } from '../solid/subShapeSelection.js';
import type { PickEditToolId } from './numericInput.js';

/**
 * その道具が対象にするのが部分形状(面・辺)かどうか。
 * 投影は立体の面の外周・辺を写す道具、断面は立体そのものと作図面の交わりを取る道具。
 */
export function projectionTakesSubShape(tool: PickEditToolId): boolean {
  return tool === 'projectedCurve';
}

/** 対象が押されていないときの断り(NFR-UX-5)。道具ごとに「何を押せばよいか」を出す。 */
export function projectionMissingTargetKey(tool: PickEditToolId): MessageKey {
  return projectionTakesSubShape(tool)
    ? 'projection.error.needFaceOrEdge'
    : 'projection.error.needBody';
}

/**
 * 押した(選んだ)要素 id から、投影・交差のもと(`ProjectionSource`)を作る。
 *
 * 投影は面・辺だけを受け取る(頂点は線にならない)。断面は立体そのものだけを受け取り、面・辺の
 * id は受け取らない(作図面と交わるのは立体で、面 1 枚ではないため)。指紋は選んだ瞬間の値を
 * そのまま保存し(`referenceCommands.ts` と同じ流儀)、上流が変わったときの選び直しは
 * model の `subShapeCache`(タスク25)が受け持つ。
 */
export function projectionSourceOf(
  tool: PickEditToolId,
  bodies: readonly SubShapeBody[],
  elementId: string,
): ProjectionSource | null {
  const parsed = parseSubShapeId(elementId);
  if (projectionTakesSubShape(tool)) {
    if (parsed === null || parsed.kind === 'vertex') {
      return null;
    }
    const ref = subShapeRefOf(bodies, elementId);
    return ref === null ? null : { kind: 'subShape', ref };
  }
  if (parsed !== null) {
    return null;
  }
  const found = bodies.some((body) => body.featureId === elementId);
  return found ? { kind: 'body', bodyFeatureId: elementId } : null;
}

/**
 * いまの選択から、投影・交差のもとを選んだ順に拾う(NFR-UX-1「対象を選んでから操作」)。
 * その道具の対象にならないもの(頂点・スケッチの要素)は黙って飛ばす。
 */
export function projectionSourcesFromSelection(
  tool: PickEditToolId,
  bodies: readonly SubShapeBody[],
  selection: readonly string[],
): readonly ProjectionSource[] {
  const sources: ProjectionSource[] = [];
  for (const elementId of selection) {
    const source = projectionSourceOf(tool, bodies, elementId);
    if (source !== null) {
      sources.push(source);
    }
  }
  return sources;
}

/**
 * 投影を 1 つ履歴へ積む(FR-325)。作図面(`planeId`)がそのまま投影先になる。
 *
 * 構築線にはしない。取り込んだ輪郭は面の境界にも押し出しの材料にも使えるのが既定の姿で
 * (計画書 §2「結果の曲線は…使える」)、参照専用にしたいときは後からプロパティで
 * 構築線に変えられる(FR-320、タスク33)。
 */
export function commitProjectedCurve(
  document: SketchDocument,
  planeId: WorkPlaneId,
  ref: SubShapeRef,
): SketchDocument {
  return appendFeature(document, {
    id: nextFeatureId(document, 'projectedCurve'),
    name: nextFeatureName(document, 'projectedCurve'),
    planeId,
    kind: 'projectedCurve',
    source: ref,
    construction: false,
  });
}

/** 断面(交差)を 1 つ履歴へ積む(FR-325)。作図面がそのまま切り口の面になる。 */
export function commitPlaneSection(
  document: SketchDocument,
  planeId: WorkPlaneId,
  targetFeatureId: string,
): SketchDocument {
  return appendFeature(document, {
    id: nextFeatureId(document, 'planeSection'),
    name: nextFeatureName(document, 'planeSection'),
    planeId,
    kind: 'planeSection',
    targetFeatureId,
    construction: false,
  });
}

/**
 * まとめて履歴へ積む。**文書の差し替えは 1 回**なので、面を 3 枚選んでから押しても
 * 取り消し(Ctrl+Z)は 1 回で全部戻る(NFR-UX-3)。
 */
export function commitProjectionSources(
  document: SketchDocument,
  planeId: WorkPlaneId,
  sources: readonly ProjectionSource[],
): SketchDocument {
  let current = document;
  for (const source of sources) {
    current =
      source.kind === 'subShape'
        ? commitProjectedCurve(current, planeId, source.ref)
        : commitPlaneSection(current, planeId, source.bodyFeatureId);
  }
  return current;
}

/**
 * 順序の制約(§0.a-0.11)の先読み。取り込めないときだけ理由の鍵を返す。
 *
 * ①もとになる立体が履歴に無い(消された・まだ作っていない)。②もとの立体が「このスケッチを
 * 使う最初の立体」と同じか後にある(そのまま入れると、立体がスケッチを使い、そのスケッチが
 * 同じ立体を見る循環になる)。どちらも model の `planProjection` が `missingBody` で断るのと
 * 同じ条件で、こちらは押した瞬間に出す。そのスケッチをどの立体も使っていなければ制約は無い
 * (どの立体でも取り込める)。抑制されたフィーチャー(FR-503)はボディを作らないので、
 * 「使う立体」としては数えない(model の `firstSketchUseIndexes` と同じ)。
 */
export function projectionOrderRejection(
  document: PartDocument,
  sketchId: string,
  source: ProjectionSource,
): MessageKey | null {
  const bodyFeatureId = projectionBodyFeatureId(source);
  const bodyIndex = document.solids.findIndex((feature) => feature.id === bodyFeatureId);
  if (bodyIndex < 0) {
    return 'projection.error.missingBody';
  }
  const firstUseIndex = document.solids.findIndex(
    (feature) => !feature.suppressed && referencedSketchIds(feature).includes(sketchId),
  );
  if (firstUseIndex >= 0 && bodyIndex >= firstUseIndex) {
    return 'projection.error.laterBody';
  }
  return null;
}

/**
 * 取り込めない理由を、選んだ順に 1 つだけ返す(帯は 1 本しかないため)。
 * すべて取り込めるなら null。
 */
export function projectionSourcesRejection(
  document: PartDocument,
  sketchId: string,
  sources: readonly ProjectionSource[],
): MessageKey | null {
  for (const source of sources) {
    const rejection = projectionOrderRejection(document, sketchId, source);
    if (rejection !== null) {
      return rejection;
    }
  }
  return null;
}
