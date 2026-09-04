/**
 * 選択の要素 id から、スケッチをまたいでも取り違えない参照を作る(P4 仕上げ (g))。
 *
 * 対応要件: FR-401〜404(押し出し・回転・縫合・ブーリアン)、FR-405/406(穴・ねじ穴の中心)、
 * FR-414(ばねの始点)、FR-502(参照は id で持つ)。
 *
 * **なぜ要るか。** スケッチの要素 id(`face-1`・`line-2`・`point-3`)は**スケッチ 1 本の中で
 * だけ**一意で、別のスケッチには同じ id の要素がふつうにある(`nextFeatureId` はスケッチ
 * ごとに 1 から数え直す)。ところが立体の参照は `{ sketchId, featureId }` の対で持つ
 * (`SketchFaceRef` 等)ので、選択の id からこの対を作るとき「どのスケッチの `face-1` か」を
 * 決めなければならない。文書の並び順に前から探すと、スケッチ 2 の `face-1` を押し出した
 * つもりでスケッチ 1 の `face-1` が使われる(P4 タスク27 の報告 (B))。
 *
 * **決め方。** 選べるのは**編集中のスケッチ(`activeSketchId`)の要素だけ**である。
 * ビューポートが描くのも、ストア(`useAppStore.ts` の `documentPatch`)が選択に残すのも
 * 編集中のスケッチの要素と立体だけだから。したがって編集中のスケッチを最初に見れば
 * 必ず当たる。念のため見つからなかったときだけ、残りを文書の並び順で探す(古いファイルや
 * 検査から、編集中でないスケッチの id を渡された場合の後退路)。
 *
 * DOM にもストアにも触れない純関数だけを置く(`solidCommands.ts` と同じ流儀)。
 * `solidCommands.ts` と `machiningCommands.ts` の両方から使うので、どちらにも属さない
 * このファイルへ置く(`solidCommands.ts` は `machiningCommands.ts` を import しているため、
 * そちらへ置くと循環になる)。
 */

import { findFeature, type PartDocument, type SketchFeature } from '@pointercad/model';

import { featureIdOf } from '../sketch/featureSummary.js';

/** 要素 id が指していたスケッチのフィーチャーと、それが入っているスケッチ。 */
export interface SketchFeatureLocation {
  /** そのフィーチャーを持つスケッチの id。参照の `sketchId` になる。 */
  readonly sketchId: string;
  /** 元の要素の id(点列の 1 点 `point-1#3` なら `point-1`)。参照の `featureId` になる。 */
  readonly featureId: string;
  readonly feature: SketchFeature;
}

/**
 * スケッチを探す順序。**編集中のスケッチが先頭**で、残りは文書の並び順(冒頭の説明のとおり)。
 * 編集中の id が指すスケッチが無い文書では、そのまま文書の並び順になる。
 */
export function sketchLookupOrder(document: PartDocument): readonly string[] {
  const active = document.activeSketchId;
  const rest = document.sketches
    .filter((sketch) => sketch.id !== active)
    .map((sketch) => sketch.id);
  return document.sketches.some((sketch) => sketch.id === active) ? [active, ...rest] : rest;
}

/**
 * 選択の要素 id が指すスケッチのフィーチャーを探す。見つからなければ undefined。
 * `kinds` を渡すと、その種類のフィーチャーだけを当たりとする(種類が違うスケッチは読み飛ばし、
 * 次のスケッチを探す)。
 */
export function findSketchFeatureAt(
  document: PartDocument,
  elementId: string,
  kinds?: ReadonlySet<SketchFeature['kind']>,
): SketchFeatureLocation | undefined {
  const featureId = featureIdOf(elementId);
  for (const sketchId of sketchLookupOrder(document)) {
    const sketch = document.sketches.find((candidate) => candidate.id === sketchId);
    if (sketch === undefined) {
      continue;
    }
    const feature = findFeature(sketch, featureId);
    if (feature !== undefined && (kinds === undefined || kinds.has(feature.kind))) {
      return { sketchId, featureId, feature };
    }
  }
  return undefined;
}
