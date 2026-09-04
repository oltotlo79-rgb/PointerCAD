/**
 * タイムラインの「途中への差し込み」と「順序の入れ替え」の判断だけを集めた純関数
 * (計画書 docs/plans/P4b-スケッチの仕上げ.md タスク20、FR-507、FR-504、NFR-UX-3、NFR-UX-5)。
 *
 * つまみの位置そのもの(どこまで戻しているか)は `timelineRail.ts` が受け持つ。
 * こちらは**履歴の並びを変える側**で、
 *
 * - つまみを途中に置いたまま新しいものを作ったら、その位置へ差し込む(`placeNewFeatures`)、
 * - 木の行を上下へ動かして順序を入れ替える(`timelineDropCheck` / `timelineMoveOffer`)、
 *
 * の 2 つを扱う。可否の判定そのものは model の `canMoveHistoryItem` / `moveHistoryItem` /
 * `insertPositionAt` が正本で、ここではそれを画面の都合(どの行に予告線を描くか、
 * 「⋮」の項目を押せるようにするか)へ翻訳するだけにする。**同じ規約を 2 か所に書かない。**
 *
 * `.tsx` は Node の検査で描けないので、判断はここへ置いて `FeatureTree.tsx` は描くだけにする
 * (`statusText.ts` / `timelineRail.ts` と同じ切り分け。docs/報告記録.md 2026-09-02 23:09)。
 */

import {
  canMoveHistoryItem,
  insertPositionAt,
  timelineIndexOf,
  type PartDocument,
} from '@pointercad/model';

import { historyGrew, historySize, isTimelineAtEnd } from './timelineRail.js';

/**
 * 断りの中身(FR-504)。理由の文は model の日本語をそのまま使う。
 * `ja.json` に置くのは入れ物の文言(「順序を変えられません:」等)だけで、
 * 「R面取り1は穴1を使っているので…」のように相手の名前が入る文は model が組み立てる
 * (同じ文言を 2 か所に書かない。NFR-MA-5 の分離は入れ物の側で守る)。
 */
export interface TimelineRefusal {
  readonly message: string;
  /** 断りの原因になったフィーチャー(**壊れる側**)の id。木のその行へ印を出す。 */
  readonly blockingFeatureId: string;
}

/**
 * 途中まで戻したまま新しいものを作ったときの置き場所(FR-507)。
 * `document` は差し込んだ後の文書、`timelineIndex` は差し込んだ段を指す新しいつまみの位置。
 */
export interface TimelinePlacement {
  readonly document: PartDocument;
  readonly timelineIndex: number | null;
  /** 途中へ差し込んだか(帯で一言知らせるかの判断に使う。NFR-UX-7)。 */
  readonly inserted: boolean;
}

/**
 * 配列の末尾へ積まれた件数。**先頭から前の並びがそのまま残っている**ときだけ数え、
 * そうでなければ null(積んだのではない差し替え)を返す。
 *
 * 比較を `===` で行うのは、`appendSolid` / `appendReference` が
 * 「前の配列を展開して末尾に 1 つ足す」形で作るため、前半の要素は同じ物のまま残るから。
 * 中身が 1 つでも差し替わっていたら「積んだ」とは呼べないので、差し込みを試みない。
 */
function appendedCount<T>(previous: readonly T[], next: readonly T[]): number | null {
  if (next.length < previous.length) {
    return null;
  }
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) {
      return null;
    }
  }
  return next.length - previous.length;
}

/** 末尾の `count` 件を抜き出して、残りの `at` の位置へ差し込んだ新しい配列。 */
function moveTailInto<T>(items: readonly T[], count: number, at: number): readonly T[] {
  const head = items.slice(0, items.length - count);
  const tail = items.slice(items.length - count);
  const position = Math.min(Math.max(at, 0), head.length);
  if (position === head.length) {
    // 末尾のままでよい。並びが変わらないので元の配列をそのまま返す(参照を保つ)。
    return items;
  }
  return [...head.slice(0, position), ...tail, ...head.slice(position)];
}

/**
 * つまみを途中に置いたまま作ったものを、**つまみの位置へ差し込む**(FR-507、タスク20)。
 *
 * タスク19 では、戻したまま作ると新しいものが配列の末尾へ積まれて画面に出てこないので、
 * つまみを末尾へ戻して知らせていた(`historyGrew` の分岐)。タスク20 でその分岐を
 * `insertPositionAt` へ差し替え、**つまみの位置へ入れて、つまみを差し込んだ段へ進める。**
 * 差し込んだ後ろの段(穴・面取りなど)は、新しい立体の上で再計算される(`resolvePart` が
 * 並びのとおりに作り直すので、ここで面倒を見ることは無い)。
 *
 * 次の場合は並びを変えず、これまでどおり末尾へ積んだままにする。
 *
 * - つまみが末尾(`null`)…… 差し込む先が末尾なので、そもそも動かす必要が無い。
 * - つまみが実質いちばん下の段…… 同上。つまみは `null` へそろえて「戻していない」状態にする。
 * - 履歴が伸びていない…… 名前の変更・削除・順序の入れ替えなど。つまみはそのまま。
 * - 末尾へ積んだのではない差し替え…… ファイルを開く等。判断がつかないので触らない。
 */
export function placeNewFeatures(
  previous: PartDocument,
  next: PartDocument,
  timelineIndex: number | null,
): TimelinePlacement {
  const unchanged: TimelinePlacement = { document: next, timelineIndex, inserted: false };
  if (timelineIndex === null || !historyGrew(previous, next)) {
    return unchanged;
  }
  if (isTimelineAtEnd(previous, timelineIndex)) {
    // つまみはもういちばん下を指している。差し込む先が末尾なので並びは変えず、
    // つまみだけ `null`(末尾)へそろえる(§0.a-0.19。位置は番号ではなく null で持つ)。
    return { document: next, timelineIndex: null, inserted: false };
  }
  const addedReferences = appendedCount(previous.references, next.references);
  const addedSolids = appendedCount(previous.solids, next.solids);
  if (addedReferences === null || addedSolids === null) {
    return unchanged;
  }
  let references = next.references;
  let solids = next.solids;
  /** 差し込んだものの、帯の中での通し番号。つまみをここへ進める。 */
  let landed: number | null = null;
  if (addedReferences > 0) {
    const at = insertPositionAt(previous, timelineIndex, 'reference');
    references = moveTailInto(next.references, addedReferences, at);
    landed = at + addedReferences - 1;
  }
  if (addedSolids > 0) {
    const at = insertPositionAt(previous, timelineIndex, 'solid');
    solids = moveTailInto(next.solids, addedSolids, at);
    // 帯は「基準(順)→ 立体(順)」の通しなので、立体の番号には基準の件数を足す。
    landed = references.length + at + addedSolids - 1;
  }
  if (landed === null) {
    return unchanged;
  }
  return {
    document:
      references === next.references && solids === next.solids
        ? next
        : { ...next, references, solids },
    timelineIndex: landed,
    inserted: true,
  };
}

/* ------------------------------------------------------------------ *
 * 順序の入れ替え(ドラッグと「⋮」の上へ/下へ)
 * ------------------------------------------------------------------ */

/** ドラッグ中の状態(表示専用の一時状態)。落とせるかどうかを毎フレーム持ち歩く。 */
export interface TimelineDrag {
  /** 掴んでいるフィーチャーの id。 */
  readonly featureId: string;
  /** 掴んだときの帯の通し番号。 */
  readonly fromIndex: number;
  /** いま指している落とし先の帯の通し番号。まだどの行も指していなければ `fromIndex` のまま。 */
  readonly toIndex: number;
  /** そこへは落とせない理由(NFR-UX-5。落とせるなら null)。 */
  readonly refusal: TimelineRefusal | null;
  /** 実際に指が動いたか。押しただけ(＝選択)と区別する。 */
  readonly moved: boolean;
}

/**
 * その落とし先へ動かせるか(ドラッグ中の予告。NFR-UX-5「実行してから失敗させない」)。
 * 文書を作らない `canMoveHistoryItem` を呼ぶので、指が動くたびに何度呼んでもよい。
 * 同じ位置(動かさない)は断りではないので null を返す。
 */
export function timelineDropCheck(
  document: PartDocument,
  featureId: string,
  toIndex: number,
): TimelineRefusal | null {
  const check = canMoveHistoryItem(document, featureId, toIndex);
  return check.ok
    ? null
    : { message: check.reason, blockingFeatureId: check.blockingFeatureId };
}

/** ドラッグを始める(掴んだだけの状態)。履歴に無い行は掴めないので null を返す。 */
export function beginTimelineDrag(
  document: PartDocument,
  featureId: string,
): TimelineDrag | null {
  const fromIndex = timelineIndexOf(document, featureId);
  if (fromIndex === null) {
    return null;
  }
  return { featureId, fromIndex, toIndex: fromIndex, refusal: null, moved: false };
}

/** 落とし先を差し替える。可否もここで引き直す(予告の色が指の動きに遅れないように)。 */
export function withDropTarget(
  document: PartDocument,
  drag: TimelineDrag,
  toIndex: number,
): TimelineDrag {
  if (drag.moved && drag.toIndex === toIndex) {
    return drag;
  }
  return {
    ...drag,
    toIndex,
    refusal: toIndex === drag.fromIndex ? null : timelineDropCheck(document, drag.featureId, toIndex),
    moved: true,
  };
}

/** 行の `data-timeline-index` から落とし先の通し番号を読む。読めなければ null。 */
export function parseDropIndex(value: string | null | undefined, total: number): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    return null;
  }
  return index;
}

/** 予告の線を、その行のどちら側に描くか(NFR-UX-5)。描かない行は null。 */
export type TimelineDropMarker = 'above' | 'below';

/**
 * この行に予告の線を描くか。上へ動かすなら行の上、下へ動かすなら行の下に引く
 * (落ちる場所をそのまま線で示す)。同じ位置へ落とすときは何も描かない。
 */
export function dropMarkerFor(
  drag: TimelineDrag | null,
  rowIndex: number,
): TimelineDropMarker | null {
  if (drag === null || !drag.moved || drag.toIndex !== rowIndex || drag.toIndex === drag.fromIndex) {
    return null;
  }
  return drag.toIndex < drag.fromIndex ? 'above' : 'below';
}

/**
 * 「⋮」の一覧に出す「上へ」「下へ」の行き先(NFR-UX-3)。
 *
 * マウスのドラッグが苦手でも同じことができるように、1 段ずつ動かす入り口を一覧にも置く。
 * 端にいる・依存を壊す、のどちらでも**押せなくして理由を吹き出しで読める**ようにするので、
 * 押してから断られることはない(NFR-UX-5。スケッチの「削除」と同じ流儀)。
 */
export type TimelineMoveOffer =
  /** 押せる。`toIndex` へ動かす。 */
  | { readonly kind: 'ready'; readonly toIndex: number }
  /** すでに帯の端にいるので、その向きへは動かせない。 */
  | { readonly kind: 'edge' }
  /** 依存を壊すので動かせない。理由は model の日本語をそのまま出す(FR-504)。 */
  | { readonly kind: 'refused'; readonly refusal: TimelineRefusal };

/** 上へ 1 段(`-1`)・下へ 1 段(`+1`)動かせるかを調べる。 */
export function timelineMoveOffer(
  document: PartDocument,
  featureId: string,
  direction: -1 | 1,
): TimelineMoveOffer {
  const from = timelineIndexOf(document, featureId);
  if (from === null) {
    return { kind: 'edge' };
  }
  const toIndex = from + direction;
  if (toIndex < 0 || toIndex >= historySize(document)) {
    return { kind: 'edge' };
  }
  const refusal = timelineDropCheck(document, featureId, toIndex);
  return refusal === null ? { kind: 'ready', toIndex } : { kind: 'refused', refusal };
}
