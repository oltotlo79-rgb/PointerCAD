/**
 * モデルブラウザの入力の一時状態と、その寿命(R07、レビュー F07 の責務の分離)。
 *
 * | 一時状態 | 始まり | 終わり(確定) | 終わり(取消) |
 * |---|---|---|---|
 * | 行の一覧 | 「⋮」・右クリック | 項目を押す(`featureTreeCommands`) | Esc・外側の押下・文書の差し替え・破棄 |
 * | 名前の欄 | 一覧の「名前を変える」 | Enter・欄を離れる | Esc・文書の差し替え・破棄 |
 * | 並べ替えのドラッグ | 帯の行を押して 4px 動かす | 離した 1 回 | Esc・pointercancel・文書の差し替え・破棄 |
 * | メモ・フォルダの下書き | 一覧の項目 | 窓の確定 | 窓の取消・文書の差し替え(描く側が照合) |
 * | 木が出したホバー | 行に指を乗せる | — | 指が離れる・破棄 |
 *
 * どれも見た目と入力だけの一時状態なのでコンポーネント側に持つ(rules/04。形の正本はストアの
 * `document` だけ)。一覧・名前の欄・ドラッグは作った時点の文書に結び付け
 * (`featureTreeLifetime.ts` の `SessionBound`)、開く・Undo・Redo で文書が差し替わったら使わない。
 * 窓の listener は一覧とドラッグが続いている間だけ付け、破棄で必ず外す。
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { PartDocument } from '@pointercad/model';

import type { FeatureFolderDraft } from '../history/FeatureFolderDialog.js';
import type { FeatureNoteDraft } from '../history/FeatureNoteDialog.js';
import { createTreeHoverOwner, moveTreeRow, type RowMenuSection } from './featureTreeCommands.js';
import { currentSessionValue, watchRowMenu, watchTimelineDrag, type DocumentSession, type SessionBound } from './featureTreeLifetime.js';
import type { TimelineDrag } from './timelineMove.js';

/**
 * 行から開く小さな一覧(画面座標、画素)。一覧はモデルブラウザの中に置くと区画の縁で
 * 切り取られるので、画面に対して固定して出す(位置は開いた瞬間のボタンかカーソルの場所)。
 */
export interface RowMenuState {
  readonly name: string;
  readonly sketchId?: string;
  readonly featureId: string;
  /** どの節の行から開いたか。ソリッドだけ抑制、スケッチの親行は追加・改名・削除を持つ。 */
  readonly sectionKey: RowMenuSection;
  readonly x: number;
  readonly y: number;
}

export interface FeatureTreeInput {
  readonly menu: RowMenuState | null;
  readonly menuRef: RefObject<HTMLDivElement | null>;
  readonly menuTriggerRef: RefObject<HTMLButtonElement | null>;
  readonly openMenu: (menu: RowMenuState) => void;
  readonly closeMenu: () => void;
  readonly renamingId: string | null;
  readonly startRename: (featureId: string) => void;
  readonly stopRename: () => void;
  readonly drag: TimelineDrag | null;
  /** 帯の行を押した。押しただけでは並べ替えず、動いて初めて掴んだことになる。 */
  readonly beginDrag: (drag: TimelineDrag, x: number, y: number) => void;
  /** 押し下げのたびに「直前はドラッグだった」の印を下ろす。 */
  readonly resetDragClick: () => void;
  /** ドラッグの後に届く click を 1 回だけ選択にしない。選択にしないなら true。 */
  readonly consumeDragClick: () => boolean;
  readonly noteDraft: FeatureNoteDraft | null;
  readonly setNoteDraft: (draft: FeatureNoteDraft | null) => void;
  readonly folderDraft: FeatureFolderDraft | null;
  readonly setFolderDraft: (draft: FeatureFolderDraft | null) => void;
  readonly hoverRow: (rowId: string) => void;
  readonly leaveRow: (rowId: string) => void;
}

export function useFeatureTreeInput(part: PartDocument, documentVersion: number): FeatureTreeInput {
  const session: DocumentSession = { documentId: part.id, documentVersion };
  const bind = <T,>(value: T): SessionBound<T> => ({ value, ...session });
  const [noteDraft, setNoteDraft] = useState<FeatureNoteDraft | null>(null);
  const [folderDraft, setFolderDraft] = useState<FeatureFolderDraft | null>(null);
  const [menuEntry, setMenuEntry] = useState<SessionBound<RowMenuState> | null>(null);
  const [renamingEntry, setRenamingEntry] = useState<SessionBound<string> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [dragEntry, setDragEntry] = useState<SessionBound<TimelineDrag> | null>(null);
  /** 掴んだ場所(画面座標)。ここから離れて初めて「動かした」とみなす。 */
  const dragOriginRef = useRef<{ readonly x: number; readonly y: number } | null>(null);
  /** 直前の押し下げがドラッグだったか。ドラッグの後にも click が届くので、選択と見分ける。 */
  const draggedRef = useRef(false);
  /** 木が出したホバーの持ち主。破棄で、それがまだ出ていれば取り下げる。 */
  const [hoverOwner] = useState(createTreeHoverOwner);

  // 差し替わる前の文書で作った一時状態は使わない(値の同一性は保つので、見張りは作り直さない)。
  const menu = currentSessionValue(menuEntry, session);
  const renamingId = currentSessionValue(renamingEntry, session);
  const drag = currentSessionValue(dragEntry, session);

  // 一覧の外を押したとき・Esc を押したときに閉じる。開いている間だけ見張る。
  useEffect(() => {
    if (menu === null) return undefined;
    return watchRowMenu(() => menuRef.current, () => setMenuEntry(null), () => menuTriggerRef.current?.focus());
  }, [menu]);

  // 開いた直後は先頭の項目へ焦点を移し、キーボードだけでも選べるようにする(NFR-UX-7)。
  useEffect(() => {
    if (menu === null) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus();
  }, [menu]);

  // 並べ替えのドラッグ(FR-507)。掴んでいる間だけ窓を見張り、離した 1 回だけ文書を積む。
  useEffect(() => {
    if (drag === null) return undefined;
    return watchTimelineDrag(part, drag, () => dragOriginRef.current,
      () => { draggedRef.current = true; },
      // 動かした後も、掴んだ時点の文書に結び付けたままにする。
      (next) => { setDragEntry((previous) => (previous === null || next === null ? null : { ...previous, value: next })); },
      () => { dragOriginRef.current = null; }, moveTreeRow);
  }, [drag, part]);

  // 破棄のとき、木が出したホバーがまだ出ていれば取り下げる(ビューポートの光らせ方を残さない)。
  useEffect(() => () => { hoverOwner.dispose(); }, [hoverOwner]);

  return {
    menu, menuRef, menuTriggerRef,
    openMenu: (next) => { setMenuEntry(bind(next)); },
    closeMenu: () => { setMenuEntry(null); },
    renamingId,
    startRename: (featureId) => { setRenamingEntry(bind(featureId)); },
    stopRename: () => { setRenamingEntry(null); },
    drag,
    beginDrag: (started, x, y) => {
      dragOriginRef.current = { x, y };
      setDragEntry(bind(started));
    },
    resetDragClick: () => { draggedRef.current = false; },
    consumeDragClick: () => {
      if (!draggedRef.current) return false;
      draggedRef.current = false;
      return true;
    },
    noteDraft, setNoteDraft, folderDraft, setFolderDraft,
    hoverRow: (rowId) => { hoverOwner.publish(rowId); },
    leaveRow: (rowId) => { hoverOwner.leave(rowId); },
  };
}
