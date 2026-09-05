/**
 * タイムラインのつまみ(FR-507)の初回の案内
 * (利用者の決定①(2026-09-05)、計画書 docs/plans/P4b-スケッチの仕上げ.md タスク22b)。
 *
 * 利用者の決定は「つまみは控えめのまま+**初回だけ帯に案内**(レイアウトは変えない)」。
 * つまみは木の行の左端をなぞる細いレール(タスク19)で、気づかれにくい。区画も飾りも
 * 増やさずに存在を知らせるため、**履歴が 2 段以上になった最初の一度だけ**帯へ 1 文を出す
 * (NFR-UX-7「操作ガイドを全ツールで欠かさない」)。
 *
 * 「見せたか」は端末に覚える(`settings.ts` の `timelineHintSeen`)。同じ人に二度は出さない。
 * ここは判定だけを持つ純関数で、帯へ出すのは `statusText.ts`、覚えるのはストア。
 */

/** 案内を出し始める段数。1 段では戻す先が無いので、2 段になってから知らせる。 */
export const TIMELINE_HINT_MIN_SOLIDS = 2;

/**
 * いま案内を出すべきか(FR-507)。
 *
 * **段数が初めて `TIMELINE_HINT_MIN_SOLIDS` に届いた瞬間だけ** true。すでに 2 段以上
 * だった文書の中で段が増えても出さない(2 度目以降は既読になっているので実際には
 * 起きないが、既読を書き損ねても帯が毎回騒がしくならないようにしておく)。
 *
 * @param previousSolidCount 変わる前のソリッドの段数。
 * @param nextSolidCount 変わった後のソリッドの段数。
 * @param seen もう案内を見せたか(`DisplaySettings.timelineHintSeen`)。
 */
export function shouldShowTimelineHint(
  previousSolidCount: number,
  nextSolidCount: number,
  seen: boolean,
): boolean {
  if (seen) {
    return false;
  }
  return previousSolidCount < TIMELINE_HINT_MIN_SOLIDS && nextSolidCount >= TIMELINE_HINT_MIN_SOLIDS;
}
