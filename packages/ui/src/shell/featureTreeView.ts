/**
 * モデルブラウザに出す中身を文書から組み立てる責務(FR-501、FR-507)。
 *
 * 節(基準・スケッチ・ソリッド)、スケッチの束、タイムラインの段、行の数を、React にもストアにも
 * 触れない純関数で作る。描く側(`FeatureTree.tsx`・`featureTreeRows.tsx`・`featureTreeSections.tsx`)は
 * 結果を読むだけにする(形の正本はストアの `document` だけ。rules/04-設計の規律.md)。
 */
import type { PartDocument, PartRecomputeError } from '@pointercad/model';

import { buildReferenceSection, buildSketchGroups, buildTreeSections, type TreeSection } from '../solid/solidSummary.js';
import { buildTimelineStops, consumedIdsUpToTimeline, isTimelineAtEnd, timelineStopsById } from './timelineRail.js';

interface FeatureTreeViewInput {
  readonly part: PartDocument;
  readonly sketchErrors: Parameters<typeof buildTreeSections>[2];
  readonly partErrors: readonly PartRecomputeError[];
  readonly referenceErrors: Parameters<typeof buildReferenceSection>[1];
  readonly timelineIndex: number | null;
}

/**
 * 「統合済み」の札を、つまみより前の段だけの消費関係に合わせ直す。
 *
 * `buildTreeSections` の `consumed` は文書全体から導くため、途中まで戻しても後ろの段
 * (穴・パターン等)の消費がそのまま残って見える。ソリッド節の行だけ、`consumedIdsUpToTimeline`
 * (`timelineRail.ts`)で作り直した消費の表へ差し替える。
 */
function withTimelineConsumed(
  sections: readonly TreeSection[],
  part: PartDocument,
  timelineIndex: number | null,
  partErrors: readonly PartRecomputeError[],
): readonly TreeSection[] {
  const consumed = consumedIdsUpToTimeline(part, timelineIndex, partErrors);
  return sections.map((section) =>
    section.key === 'solid'
      ? { ...section, rows: section.rows.map((row) => ({ ...row, consumed: consumed.has(row.id) })) }
      : section,
  );
}

/** 1 回の描画で使う中身。どれも文書と再計算の結果だけから決まる。 */
export function buildFeatureTreeView(input: FeatureTreeViewInput) {
  const { part, sketchErrors, partErrors, referenceErrors, timelineIndex } = input;
  const folders = part.featureFolders ?? [];
  // 基準の節(FR-328、FR-329)は「作業平面 → スケッチ → 立体」の順で
  // 使うものなので、いちばん上に置く。中身は履歴順のまま。
  const sections = [
    buildReferenceSection(part, referenceErrors),
    ...withTimelineConsumed(
      buildTreeSections(part, part.activeSketchId, sketchErrors, partErrors),
      part,
      timelineIndex,
      partErrors,
    ),
  ];
  /*
   * スケッチが 2 本以上ある文書(またはスケッチをフォルダへ入れた文書)のときだけ、スケッチの節を
   * 「スケッチ1」「スケッチ2」…の親行で束ねる(FR-501)。1 本だけのときは親行を出さず、要素をそのまま
   * 節へ並べる(ふつうの部品は 1 本しか使わないので、階層を 1 段増やすだけの得が無い。NFR-UX-6)。
   */
  const sketchGroups = buildSketchGroups(part, sketchErrors);
  const grouped = sketchGroups.length > 1 || folders.some(folder => folder.children.some(child => child.kind === 'sketch'));
  /*
   * タイムラインの段(FR-507)。並びは model の `buildTimeline` が正本で、
   * 「基準(順)→ ソリッド(順)」の 1 本の通し。木の行の id はフィーチャーの id
   * (`buildReferenceSection` / `buildTreeSections`)なので、そのまま引ける。
   * スケッチの要素の行は帯に出ないので引けず、つまみも付かない。
   */
  const timelineStops = timelineStopsById(buildTimelineStops(part, timelineIndex));
  const timelineAtEnd = isTimelineAtEnd(part, timelineIndex);
  // 束ねているときは親行も数に入れる。要素が 1 つも無くても親行は出るので、
  // それだけで「まだ何もありません」の空状態には落とさない。
  const groupedRowCount = sketchGroups.reduce((total, group) => total + group.rows.length + 1, 0);
  const rowCount = sections.reduce(
    (total, section) =>
      total + (grouped && section.key === 'sketch' ? groupedRowCount : section.rows.length),
    0,
  );
  return { folders, sections, sketchGroups, grouped, timelineStops, timelineAtEnd, rowCount };
}
