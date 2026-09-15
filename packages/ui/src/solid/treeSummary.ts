/** 部品の各履歴を、選択見出しとツリーの行へ変換する。加工の数値編集は持たない。 */
import {
  findSketch, findSolid, referencedSketchIds,
  type PartDocument, type PartRecomputeError, type ReferenceError, type ReferenceFeatureKind,
  type SketchDocument, type SketchError, type SketchFeature, type SolidLabelKey,
} from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';
import { FEATURE_KIND_LABEL_KEYS, sketchTreeKindOf, type SketchTreeKind } from '../sketch/featureSummary.js';
import { findSketchFeatureAt } from './sketchRefs.js';
import { SOLID_KIND_LABEL_KEYS, solidKindOf } from './solidLabels.js';
import { consumedIds, partErrorMessage } from './solidHistoryState.js';
import { REFERENCE_KIND_LABEL_KEYS } from './referenceSummary.js';

/** 選んでいるものの種類の見出しキー(重なりを除き、選んだ順)。複数選択のときに出す。 */
export function selectionKindLabelKeys(
  document: PartDocument,
  selection: readonly string[],
): readonly MessageKey[] {
  const keys: MessageKey[] = [];
  for (const id of selection) {
    const solid = findSolid(document, id);
    const key =
      solid === undefined
        ? sketchKindLabelKey(document, id)
        : SOLID_KIND_LABEL_KEYS[solidKindOf(solid)];
    if (key !== null && !keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}

/**
 * スケッチの要素 id から種類の見出しキーを引く。見つからなければ null。
 * 探す順は `findSketchFeatureAt`(`sketchRefs.ts`)に任せ、**編集中のスケッチを先に**見る。
 * 要素 id はスケッチをまたいで重なるため(P4 仕上げ (g))。
 */
function sketchKindLabelKey(document: PartDocument, elementId: string): MessageKey | null {
  const found = findSketchFeatureAt(document, elementId);
  return found === undefined ? null : FEATURE_KIND_LABEL_KEYS[sketchTreeKindOf(found.feature)];
}

/**
 * ツリーの節(FR-501)。スケッチ・ソリッドに加え、P4 タスク33 で基準ジオメトリの節
 * (作業平面・基準軸・基準点・座標系。FR-328、FR-329)を足した。
 *
 * 基準の節は `buildTreeSections` ではなく `buildReferenceSection` が別に作る。
 * `buildTreeSections` の戻り(スケッチ・ソリッドの 2 節)を変えると、その並びを
 * 前提にした既存の検査が意味を失うため。並べる順は呼び出し側(`FeatureTree.tsx`)が決める。
 */
export type TreeSectionKey = 'sketch' | 'solid' | 'reference';

/** ツリーの行。スケッチの要素・基準ジオメトリ・立体を同じ形で並べる。 */
export interface TreeRow {
  readonly id: string;
  readonly name: string;
  /**
   * 行の頭の絵と種類の名前を決める種類。立体のブーリアンは演算ごとに、
   * スケッチの複製は配置ごとに分かれる(`sketchTreeKindOf` / `solidKindOf`)。
   */
  readonly kind: SketchTreeKind | SolidLabelKey | ReferenceFeatureKind;
  readonly kindLabelKey: MessageKey;
  /** 計算できていない(FR-504)。 */
  readonly hasError: boolean;
  /** 計算できていない理由。ホバーの吹き出しに出す。無ければ null。 */
  readonly errorMessage: string | null;
  /** 抑制中(FR-503)。スケッチの要素と基準ジオメトリは常に false。 */
  readonly suppressed: boolean;
  /** ほかの立体と組み合わさって単独では表示されない(§0.a-0.5)。 */
  readonly consumed: boolean;
  /**
   * 画面に出していない基準ジオメトリ(`visible: false`、FR-329)。
   * 平面や軸を決めるためだけに置かれた点がこれになる(`appendCoordinatePoints`)。
   * 行は消さずに薄く出し、「補助」の札を添える。消してしまうと、名前を変える・
   * 出し直す・消すの操作(FR-503)がどこからもできなくなるため。
   */
  readonly hidden: boolean;
}

export interface TreeSection {
  readonly key: TreeSectionKey;
  readonly titleKey: MessageKey;
  readonly rows: readonly TreeRow[];
}

/**
 * ツリーの並びを作る(FR-501)。節は必ず「スケッチ」「ソリッド」の2つを返す。
 * 中身が空でも節は返し、呼び手が空のときの案内を出せるようにする(NFR-UX-6)。
 */
export function buildTreeSections(
  document: PartDocument,
  activeSketchId: string,
  sketchErrors: readonly SketchError[],
  partErrors: readonly PartRecomputeError[],
): readonly TreeSection[] {
  // 指し先が消えていたら先頭のスケッチを使う(ストアの activeSketchOf と同じ決め方)。
  const sketch = findSketch(document, activeSketchId) ?? document.sketches[0];
  const sketchRows: readonly TreeRow[] = sketch.features.map((feature) =>
    sketchFeatureRow(feature, sketchErrors),
  );

  const consumed = consumedIds(document, partErrors);
  const solidRows: TreeRow[] = document.solids.map((feature) => {
    const message = partErrorMessage(partErrors, feature.id);
    const kind = solidKindOf(feature);
    return {
      id: feature.id,
      name: feature.name,
      kind,
      kindLabelKey: SOLID_KIND_LABEL_KEYS[kind],
      hasError: message !== null,
      errorMessage: message,
      suppressed: feature.suppressed,
      consumed: consumed.has(feature.id),
      hidden: false,
    };
  });

  return [
    { key: 'sketch', titleKey: 'featureTree.sketchGroup', rows: sketchRows },
    { key: 'solid', titleKey: 'featureTree.solidGroup', rows: solidRows },
  ];
}

/**
 * スケッチ 1 本ぶんの節の中身(P4 仕上げ (g)、FR-501)。
 *
 * 部品文書はもともと**複数のスケッチ**を持てる形だったが(`PartDocument.sketches`)、
 * ツリーは編集中の 1 本しか出していなかったので、新しいスケッチを作る・切り替える入口が
 * 画面のどこにも無かった(P4 タスク27 の報告 (A))。ここで文書内の全スケッチを親行として
 * 並べられるようにする。
 *
 * `buildTreeSections` の戻り(スケッチ・ソリッドの 2 節)は 1 行も変えない。あの形を
 * 前提にした既存の検査と、**スケッチが 1 本だけのときの見え方**(親行を出さない従来どおりの
 * 平らな並び)をそのまま残すため。親行を出すかどうかは呼び出し側(`FeatureTree.tsx`)が
 * 本数で決める。
 */
export interface SketchTreeGroup {
  readonly sketchId: string;
  readonly name: string;
  /** いま作図しているスケッチか(親行を太字にし、押すと切り替える)。 */
  readonly active: boolean;
  /** そのスケッチの要素の行。履歴順のまま。 */
  readonly rows: readonly TreeRow[];
  /**
   * このスケッチの要素を参照している立体があるか(FR-504)。
   * true のときは消せない(消すと参照先が消えた立体だけが残る)ので、一覧の「削除」を断る。
   */
  readonly inUse: boolean;
}

/** スケッチの要素 1 つを木の行へ直す。`buildTreeSections` と同じ組み立て。 */
function sketchFeatureRow(feature: SketchFeature, errors: readonly SketchError[]): TreeRow {
  const message = partErrorMessage(errors, feature.id);
  // 複製(FR-324)は配置ごとに絵と名前を変える(P4 タスク33、タスク20 の申し送り)。
  const kind = sketchTreeKindOf(feature);
  return {
    id: feature.id,
    name: feature.name,
    kind,
    kindLabelKey: FEATURE_KIND_LABEL_KEYS[kind],
    hasError: message !== null,
    errorMessage: message,
    suppressed: false,
    consumed: false,
    hidden: false,
  };
}

/**
 * 文書内の全スケッチを、木に出せる形へ並べる(P4 仕上げ (g)、FR-501)。
 *
 * 失敗の理由(`sketchErrors`)を添えるのは**編集中のスケッチだけ**。ストアが持っている
 * `sketchErrors` は編集中の 1 本ぶんしかないため(`useAppStore.ts` の `activeSketchErrors`)、
 * 他のスケッチへ当てはめると、たまたま同じ要素 id を持つ行に他人の理由が出てしまう。
 */
export function buildSketchGroups(
  document: PartDocument,
  sketchErrors: readonly SketchError[] = [],
): readonly SketchTreeGroup[] {
  const usedSketchIds = new Set(document.solids.flatMap((feature) => referencedSketchIds(feature)));
  return document.sketches.map((sketch) => {
    const active = sketch.id === document.activeSketchId;
    return {
      sketchId: sketch.id,
      name: sketch.name,
      active,
      rows: sketch.features.map((feature) =>
        sketchFeatureRow(feature, active ? sketchErrors : []),
      ),
      inUse: usedSketchIds.has(sketch.id),
    };
  });
}

/** 名前を変えたスケッチを作る(FR-503)。空白だけの名前は受け付けず元のまま返す。 */
export function renameSketch(sketch: SketchDocument, name: string): SketchDocument {
  const trimmed = name.trim();
  return trimmed.length === 0 || trimmed === sketch.name ? sketch : { ...sketch, name: trimmed };
}

/**
 * 基準ジオメトリの節(FR-328、FR-329、P4 タスク33)。
 *
 * 履歴順にそのまま並べ、`visible: false` のものも薄く(`hidden`)出す。
 * 節を `buildTreeSections` の戻りへ足さず別に作るのは、既に固定してある
 * 「スケッチ・ソリッドの 2 節」という約束を崩さないため(並べる順は呼び出し側が決める)。
 */
export function buildReferenceSection(
  document: PartDocument,
  errors: readonly ReferenceError[] = [],
): TreeSection {
  const rows: TreeRow[] = document.references.map((feature) => {
    const found = errors.find((error) => error.featureId === feature.id);
    const message = found === undefined ? null : found.message;
    return {
      id: feature.id,
      name: feature.name,
      kind: feature.kind,
      kindLabelKey: REFERENCE_KIND_LABEL_KEYS[feature.kind],
      hasError: message !== null,
      errorMessage: message,
      suppressed: false,
      consumed: false,
      hidden: !feature.visible,
    };
  });
  return { key: 'reference', titleKey: 'featureTree.referenceGroup', rows };
}
