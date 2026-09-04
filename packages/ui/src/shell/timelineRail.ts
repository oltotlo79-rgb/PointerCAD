/**
 * タイムラインのつまみ(ロールバック)の判断だけを集めた純関数
 * (計画書 docs/plans/P4b-スケッチの仕上げ.md タスク19、FR-507、FR-506、NFR-PF-3)。
 *
 * **置き場は木の中**(§0.a-0.18 の利用者の決定は案 B)。固定区画は 5 つのまま増やさず、
 * モデルブラウザの「基準」「ソリッド」の行の左端をなぞる細いつまみとして出す。
 * 履歴の順序はすでに木が表しているので、同じ並びを 2 か所へ描かない。
 *
 * `.tsx` は Node の検査で描けないので、どの段がつまみの前か後か・押したら次はどこか、
 * といった判断はすべてここへ置き、`Timeline.tsx` は描くだけにする
 * (`statusText.ts` と同じ切り分け。docs/報告記録.md 2026-09-02 23:09)。
 *
 * つまみの位置は**保存しない**(§0.a-0.19)。ストアの `timelineIndex` だけが持ち、
 * 開き直したときは必ず末尾から始まる。
 */

import { buildTimeline, type PartDocument, type TimelineEntry } from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';

/** 帯の 1 段が、つまみに対してどこにいるか。 */
export type TimelineStopState =
  /** つまみより前(いま形になっている段)。 */
  | 'past'
  /** つまみそのもの(ここまでの形が出ている)。 */
  | 'current'
  /** つまみより後ろ(いまは形になっていない段)。薄く出す。 */
  | 'ahead';

/** 帯の 1 段と、つまみから見た位置。 */
export interface TimelineStop {
  readonly entry: TimelineEntry;
  readonly state: TimelineStopState;
}

/** 途中まで戻しているときの位置。末尾にいるときは作らない。 */
export interface TimelineRollback {
  /** 何段目まで戻しているか。画面には 1 から数えて出す。 */
  readonly position: number;
  /** 帯の総数。 */
  readonly total: number;
}

/** 帯に並ぶ段の数(基準ジオメトリ + 立体)。スケッチは帯に出ない(model の `buildTimeline`)。 */
export function historySize(part: PartDocument): number {
  return part.references.length + part.solids.length;
}

/**
 * つまみが実際に指している通し番号。`null`(末尾)は最後の段の番号に直す。
 * 履歴が空のときだけ null を返す(指せる段が 1 つも無い)。
 *
 * 範囲外の値は端へ丸める。履歴が縮んだ(段を消した)後でも、つまみが宙に浮かないため。
 */
export function resolveTimelineIndex(part: PartDocument, index: number | null): number | null {
  const total = historySize(part);
  if (total === 0) {
    return null;
  }
  if (index === null) {
    return total - 1;
  }
  return Math.min(Math.max(index, 0), total - 1);
}

/**
 * つまみが末尾にいるか。**末尾なら今までと何も変わらない**(`documentUpTo` が同じ文書を
 * そのまま返すので再計算も描画も 1 ミリ秒も変わらない。NFR-PF-3)。
 * 判定の式は model の `documentUpTo` と同じにしてある(食い違わせない)。
 */
export function isTimelineAtEnd(part: PartDocument, index: number | null): boolean {
  return index === null || index >= historySize(part) - 1;
}

/** 帯の全段に、つまみから見た位置を添える。 */
export function buildTimelineStops(
  part: PartDocument,
  index: number | null,
): readonly TimelineStop[] {
  const current = resolveTimelineIndex(part, index);
  return buildTimeline(part).map((entry) => ({
    entry,
    state:
      current === null || entry.index > current
        ? 'ahead'
        : entry.index === current
          ? 'current'
          : 'past',
  }));
}

/** 木の行(フィーチャーの id)から帯の段を引けるようにする。 */
export function timelineStopsById(
  stops: readonly TimelineStop[],
): ReadonlyMap<string, TimelineStop> {
  const byId = new Map<string, TimelineStop>();
  for (const stop of stops) {
    // 同じ id が 2 つ並ぶことは無いが、あれば先に出たほうを採る(model の並びと揃える)。
    if (!byId.has(stop.entry.featureId)) {
      byId.set(stop.entry.featureId, stop);
    }
  }
  return byId;
}

/**
 * 途中まで戻しているときの位置(NFR-UX-7)。末尾にいるなら null。
 * 戻したままだと「作ったはずのものが消えた」と見えるので、帯に常に出す材料にする。
 */
export function timelineRollback(
  part: PartDocument,
  index: number | null,
): TimelineRollback | null {
  return rollbackOf(historySize(part), index);
}

/**
 * `timelineRollback` の、段の数だけを見る版。
 * ステータスバーは部品文書そのものを購読すると打つたびに描き直しになるので、
 * 数 2 つ(段の総数とつまみの位置)だけを取り出してこちらを呼ぶ。
 */
export function rollbackOf(total: number, index: number | null): TimelineRollback | null {
  if (index === null || total <= 0 || index >= total - 1) {
    return null;
  }
  const position = Math.min(Math.max(index, 0), total - 1) + 1;
  return { position, total };
}

/**
 * つまみを押したときに次に置く値。
 *
 * - もう一度同じ段を押したら末尾へ戻す(押した先が今と同じなら戻す、という 1 つの規則で
 *   「置く」と「やめる」を兼ねる。NFR-UX-1)。
 * - いちばん最後の段を選んだときは `null`(末尾)にする。番号で持つと `documentUpTo` は
 *   同じ文書を返すので動きは同じだが、`null` に揃えておくと「戻していない」ことが
 *   ストアの値だけで読めて、検査でも固定できる(§0.a-0.19)。
 */
export function timelineIndexForClick(
  part: PartDocument,
  index: number | null,
  clicked: number,
): number | null {
  const current = resolveTimelineIndex(part, index);
  if (current !== null && clicked === current) {
    return null;
  }
  return clicked >= historySize(part) - 1 ? null : clicked;
}

/**
 * つまみの説明(NFR-UX-7)。押したら何が起きるかを、いまの位置ごとに言い分ける。
 * 図柄だけでは「ここを押すと途中まで戻る」ことが読み取れないため。
 */
export function timelineStopTooltipKey(state: TimelineStopState, atEnd: boolean): MessageKey {
  if (state !== 'current') {
    return 'timeline.stopTooltip';
  }
  return atEnd ? 'timeline.stopEnd' : 'timeline.stopCurrent';
}

/**
 * 履歴が伸びたか(基準ジオメトリか立体が積まれたか)。
 *
 * 途中まで戻したまま新しいものを作ると、それは配列の**末尾**へ積まれるので、
 * 戻したままの画面には出てこない(「作ったものが見えない」。docs/報告記録.md
 * 2026-09-04 11:10 の (a) と同じ形の失敗)。そこでストアはこれが真のときに
 * つまみを末尾へ戻し、帯で一言知らせる。**操作は止めない**(rules/04-設計の規律.md
 * 「止めずに警告する。操作をブロックするゲートも作らない」)。
 *
 * つまみの位置そのものへ差し込む(`insertPositionAt`)のはタスク20 の範囲。
 */
export function historyGrew(previous: PartDocument, next: PartDocument): boolean {
  return (
    next.references.length > previous.references.length ||
    next.solids.length > previous.solids.length
  );
}
