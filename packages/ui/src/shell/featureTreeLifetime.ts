/**
 * モデルブラウザが窓(`window`)へ付ける listener の寿命と、一時状態を結び付ける文書(R07)。
 *
 * 木が窓へ付ける listener は 2 組だけで、どちらも「付けた本人が必ず外す」形にする。
 * - 行の一覧(`watchRowMenu`): 開いている間だけ。外側の押下と Esc で閉じる。
 * - 並べ替えのドラッグ(`watchTimelineDrag`): 掴んでいる間だけ。文書を変えるのは離した 1 回。
 * 外した後に遅れて届いた古い callback は何もしない(`active` の印)。
 *
 * 一時状態(一覧・改名中・ドラッグ)は、作った時点の文書(id と差し替えの回数)に結び付ける
 * (`DocumentSession`)。開く・Undo・Redo で文書が差し替わったら古い一時状態は使わない。
 * 別の文書の同じ id の行を、前の文書のつもりで消す・改名する・動かすことを防ぐため。
 */
import type { PartDocument } from '@pointercad/model';

import { parseDropIndex, withDropTarget, type TimelineDrag } from './timelineMove.js';
import { historySize } from './timelineRail.js';

/**
 * ここまで動いたら「掴んで動かしている」とみなす距離(画素)。これ未満の動きは押し間違いの
 * 震えとみなし、行の選択にする。26px の行を 1 つ跨ぐより十分に小さく、指の震えより大きい値。
 */
export const DRAG_THRESHOLD_PX = 4;

/** 行に付けた帯の通し番号の印。落とし先を画面の座標から引くのに使う(JSX の属性名と同じ)。 */
export const TIMELINE_INDEX_ATTRIBUTE = 'data-timeline-index';

/**
 * その画面座標の下にある行の、帯の通し番号。行の上に無ければ null。ドラッグ中は指の下の行が
 * 変わり続けるので、行ごとの `onPointerEnter` ではなく画面の座標から引く(押している間は入る・
 * 出るの知らせが届かないことがあるため)。
 */
function dropIndexAtPoint(x: number, y: number, total: number): number | null {
  const found = window.document.elementFromPoint(x, y);
  const row = found === null ? null : found.closest(`[${TIMELINE_INDEX_ATTRIBUTE}]`);
  return parseDropIndex(row?.getAttribute(TIMELINE_INDEX_ATTRIBUTE), total);
}

/** 行の一覧が開いている間だけ窓を見張る。外した後の古い callback は新しい一覧を閉じない。 */
export function watchRowMenu(
  menuNode: () => HTMLDivElement | null,
  close: () => void,
  restoreFocus: () => void,
): () => void {
  let active = true;
  const onPointerDown = (event: PointerEvent): void => {
    if (!active) return;
    const node = menuNode();
    if (node !== null && event.target instanceof Node && node.contains(event.target)) return;
    close();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!active || event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return;
    close();
    restoreFocus();
  };
  window.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('keydown', onKeyDown);
  return () => {
    active = false;
    window.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('keydown', onKeyDown);
  };
}

/**
 * 並べ替えのドラッグ 1 回ぶんだけ窓を見張る。落とせるかどうかは動かすたびに文書を作らずに
 * 引き直し(`withDropTarget`)、文書を変えるのは離した 1 回の `commit` だけ(NFR-UX-3)。
 * Esc・pointercancel・外したことは確定せずに終わる。
 *
 * HTML5 のドラッグ&ドロップは使わず、pointer の押す・動く・離すで組む。①落とせない位置を
 * 離す前に赤い線で予告できる(NFR-UX-5)、②行の中に押せるもの(つまみ・「⋮」)があっても
 * 掴む場所を選り分けられる、③ペンや指でも同じに動く、の 3 つが要るため(依存は足さない)。
 */
export function watchTimelineDrag(
  part: PartDocument,
  drag: TimelineDrag,
  origin: () => { readonly x: number; readonly y: number } | null,
  markMoved: () => void,
  update: (next: TimelineDrag | null) => void,
  clearOrigin: () => void,
  commit: (featureId: string, toIndex: number) => void,
): () => void {
  let active = true;
  const total = historySize(part);
  const onPointerMove = (event: PointerEvent): void => {
    if (!active) return;
    const start = origin();
    if (!drag.moved && start !== null &&
      Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_THRESHOLD_PX) return;
    markMoved();
    const index = dropIndexAtPoint(event.clientX, event.clientY, total);
    // 帯の外(スケッチの行や区画の余白)では落とし先を変えず、掴んでいることだけ示す。
    const next = index === null ? { ...drag, moved: true } : withDropTarget(part, drag, index);
    if (next.toIndex !== drag.toIndex || next.moved !== drag.moved) update(next);
  };
  const onPointerUp = (): void => {
    if (!active) return;
    active = false;
    update(null);
    clearOrigin();
    if (drag.moved && drag.toIndex !== drag.fromIndex) commit(drag.featureId, drag.toIndex);
  };
  const onCancel = (): void => {
    if (!active) return;
    active = false;
    update(null);
    clearOrigin();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') onCancel();
  };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKeyDown);
  return () => {
    active = false;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKeyDown);
  };
}

/** 一時状態を作った時点の文書。id と、丸ごとの差し替え(開く・Undo・Redo)の回数の組。 */
export interface DocumentSession {
  readonly documentId: string;
  readonly documentVersion: number;
}

/** 一時状態と、それを作った文書の組。 */
export interface SessionBound<T> extends DocumentSession {
  readonly value: T;
}

/** 今の文書で作った一時状態なら中身を、差し替わる前の文書のものなら null を返す。 */
export function currentSessionValue<T>(entry: SessionBound<T> | null, session: DocumentSession): T | null {
  return entry !== null && entry.documentId === session.documentId && entry.documentVersion === session.documentVersion
    ? entry.value : null;
}
