/**
 * つまみのスライス(FR-507。どこまでの段を見せるか、その知らせと断りの理由)。
 * 分け方の約束は `viewSlice.ts` の冒頭にある(P6 タスク52)。
 */

import { moveHistoryItem } from '@pointercad/model';
import type { StateCreator } from 'zustand';
import type { MessageKey } from '../i18n/t.js';
import type { TimelineRefusal } from '../shell/timelineMove.js';
import type { AppState } from './appState.js';

/** つまみ(時をまたぐ表示)のスライスが持つ欄と操作。 */
export interface TimelineSlice {
  /**
   * タイムラインのつまみの位置(FR-507、FR-506、P4b タスク19)。帯の通し番号で、
   * `null` が末尾(全部作られた状態)。**保存しない**(§0.a-0.19)ので `.pcad` には
   * 入らず、開く・新規・復元・Undo / Redo のたびに `null` へ戻す。
   *
   * 形の正本はあくまで `document`(全体)で、ここが変わっても `document` は 1 バイトも
   * 変わらない。3D へ出す形だけが `documentUpTo(document, timelineIndex)` で切られる。
   * `null` のときは `documentUpTo` が同じ文書をそのまま返す(`===`)ので、これまでの
   * 経路も性能も何も変わらない(NFR-PF-3)。
   */
  readonly timelineIndex: number | null;
  /**
   * つまみについての知らせの文言キー(P4b タスク19)。断りではないので帯を赤くしない。
   * いまの使い道は 1 つで、途中まで戻したまま新しいものを作ったときに
   * 「新しく作ったものを出すため、最後まで戻しました」と伝える。
   * 文書が次に変われば用済みなので `applyDocument` が落とす。
   */
  readonly timelineNoticeKey: MessageKey | null;
  /**
   * 順序の入れ替えを断った理由(FR-504、FR-507。P4b タスク20)。断らなかったときは null。
   *
   * 理由の文は model(`moveHistoryItem` の `reason`)が相手の名前つきで組み立てたものを
   * そのまま持つ。`blockingFeatureId` は**壊れる側**(指している方)なので、木のその行に
   * 印を出す。文書が次に変われば用済みなので `applyDocument` が落とす。
   */
  readonly timelineRefusal: TimelineRefusal | null;
  /**
   * タイムラインのつまみを置き直す(FR-507、FR-506)。`null` で末尾へ戻す。
   * **文書は変えない**ので Undo の段も作らない(つまみを動かすのは形を変える操作ではない)。
   * 3D へ出す形の切り直しは `attachPartRecompute` がこの値の変化に気づいて行う。
   */
  readonly setTimelineIndex: (index: number | null) => void;
  /**
   * 履歴の順序を入れ替える(FR-507、FR-504。P4b タスク20)。`toIndex` は帯の通し番号。
   *
   * 動かせるなら文書を 1 回だけ積むので、取り消し(Ctrl+Z)1 回で元の順序に戻る
   * (NFR-UX-3)。依存を壊すなら**文書は 1 バイトも変えず**、理由を `timelineRefusal` へ
   * 置いて帯と木の行で知らせる(rules/04-設計の規律.md「止めずに警告する」)。
   */
  readonly moveTimelineItem: (featureId: string, toIndex: number) => void;
  /** 順序の入れ替えの断りを出す・消す(FR-504)。 */
  readonly setTimelineRefusal: (refusal: TimelineRefusal | null) => void;
}

/**
 * 部品を作り直すたびに初期値へ戻す欄(つまみ(時をまたぐ表示))。
 * 実体は `initialDocumentState.ts` の `createInitialDocumentState` が 1 か所で作る。
 */
export type TimelineInitialState = Pick<
  TimelineSlice,
  | 'timelineIndex'
  | 'timelineNoticeKey'
  | 'timelineRefusal'
>;

export const createTimelineSlice: StateCreator<
  AppState,
  [],
  [],
  Omit<TimelineSlice, keyof TimelineInitialState>
> = (set, get) => ({
  setTimelineIndex: (timelineIndex) => {
    set((state) =>
      state.timelineIndex === timelineIndex
        ? {}
        : {
            timelineIndex,
            // 3D へ出す形を切り直すので、計算中の札は素直に立てる。つまみを動かした
            // だけなら段の鍵が変わらず全段がキャッシュに当たるので、すぐ下りる
            // (NFR-PF-3。§2.7「巻き戻しても再計算が起きない」)。
            isComputing: true,
            // つまみを動かしたら、前の位置についての知らせは用済み。
            timelineNoticeKey: null,
          },
    );
  },
  moveTimelineItem: (featureId, toIndex) => {
    const state = get();
    const outcome = moveHistoryItem(state.document, featureId, toIndex);
    if (!outcome.ok) {
      // 断りは文書を変えずに理由だけ置く(FR-504、NFR-RE-1)。壊れる側の行に印が出る。
      set({
        timelineRefusal: {
          message: outcome.reason,
          blockingFeatureId: outcome.blockingFeatureId,
        },
      });
      return;
    }
    // 動かす必要が無かった(同じ位置)ときは `applyDocument` が何もしないので、
    // 前の断りをここで先に落としておく。
    set({ timelineRefusal: null });
    // 文書を 1 回だけ積む。取り消し 1 回で元の順序へ戻る(NFR-UX-3)。
    state.applyDocument(outcome.document);
  },
  setTimelineRefusal: (timelineRefusal) => {
    set({ timelineRefusal });
  },
});
