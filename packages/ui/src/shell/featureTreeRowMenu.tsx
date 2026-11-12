/**
 * モデルブラウザの行から開く小さな一覧(「⋮」・右クリック)の責務(FR-329、FR-331、FR-503、FR-507)。
 *
 * どの項目を出すか・押せるかを開いた行から決め、一覧を描く。一覧は**モーダルにしない**
 * (NFR-UX-2)ので、開いている間も視点操作は効く。削除の前に確認を出さないのは、元に戻す(Ctrl+Z)で
 * 戻せるため(NFR-UX-3)。項目を押したときのストアの更新は `featureTreeCommands.ts`、開閉と焦点は
 * `useFeatureTreeInput.ts` が持つ。
 */
import { featureNoteOf, findReference, findSolid, type PartDocument } from '@pointercad/model';

import type { FeatureFolderDraft } from '../history/FeatureFolderDialog.js';
import { t, type MessageKey } from '../i18n/t.js';
import { treeRowTakesOrigin } from '../sketch/originCommands.js';
import type { SketchTreeGroup, TreeSection } from '../solid/solidSummary.js';
import { addNewSketch, moveTreeRow, noteTargetForRow, removeTreeRow, setTreeOrigin, toggleReferenceVisible,
  toggleSolidSuppressed } from './featureTreeCommands.js';
import { nextHighlightIndex } from './menus/menuItem.js';
import { timelineMoveOffer, type TimelineMoveOffer } from './timelineMove.js';
import type { FeatureTreeInput, RowMenuState } from './useFeatureTreeInput.js';

interface FeatureTreeRowMenuContext {
  readonly part: PartDocument;
  readonly documentVersion: number;
  readonly input: FeatureTreeInput;
  readonly sections: readonly TreeSection[];
  readonly sketchGroups: readonly SketchTreeGroup[];
  /** フォルダの窓に渡す、開いた時点の文書の控え。 */
  readonly folderContext: () => Pick<FeatureFolderDraft, 'documentId' | 'documentVersion' | 'originalFolders'>;
}

/** 開いた行から決まる、一覧の相手と項目の可否。 */
function rowMenuTargets(part: PartDocument, menu: RowMenuState, sections: readonly TreeSection[],
  sketchGroups: readonly SketchTreeGroup[]) {
  // 抑制はソリッドの行だけが持つ。
  const menuFeature = menu.sectionKey !== 'solid' ? undefined : findSolid(part, menu.featureId);
  // 表示・非表示は基準ジオメトリの行だけが持つ(FR-329)。
  const menuReference = menu.sectionKey !== 'reference' ? undefined : findReference(part, menu.featureId);
  // スケッチそのものの親行。改名・削除・スケッチの追加を持つ。
  const menuSketchGroup = menu.sectionKey !== 'sketchDocument'
    ? undefined
    : sketchGroups.find((group) => group.sketchId === menu.featureId);
  /*
   * スケッチの「削除」を断る理由(FR-503、NFR-UX-5)。断らないときは null。
   * 断るのは 2 つ。①最後の 1 本(消すと作図する場所が無くなる)。②そのスケッチの要素を
   * 立体が使っている(消すと参照先の無い立体だけが残る)。理由は消せない項目の吹き出しで
   * 読めるようにし、押せてしまってから帯で断る形にはしない。
   */
  const sketchDeleteBlockedKey: MessageKey | null =
    menuSketchGroup === undefined
      ? null
      : part.sketches.length <= 1
        ? 'featureTree.sketchDeleteLast'
        : menuSketchGroup.inUse
          ? 'featureTree.sketchDeleteBlocked'
          : null;
  /*
   * 「1 つ上へ」「1 つ下へ」(FR-507、NFR-UX-3)は帯に出る行(基準ジオメトリ・立体)にだけ出す。
   * マウスのドラッグが苦手でも同じことができるようにするための入り口で、押せるかどうか・断りの理由は
   * ドラッグと同じ判定(`timelineMoveOffer` → `canMoveHistoryItem`)から引く(同じ規約を 2 か所に書かない)。
   */
  const menuInTimeline = menu.sectionKey === 'solid' || menu.sectionKey === 'reference';
  const menuMoveUp = menuInTimeline ? timelineMoveOffer(part, menu.featureId, -1) : null;
  const menuMoveDown = menuInTimeline ? timelineMoveOffer(part, menu.featureId, 1) : null;
  // 「ここを原点にする」(FR-331)を出せる行かどうかは行の種類だけで決まる。
  // 節の中身の行だけが対象(スケッチそのものの親行などは点ではない)。
  const menuRow = sections.find((section) => section.key === menu.sectionKey)
    ?.rows.find((row) => row.id === menu.featureId) ?? null;
  const canSetOrigin = menuRow !== null && (menu.sectionKey === 'sketch' || menu.sectionKey === 'reference')
    && treeRowTakesOrigin(menu.sectionKey, menuRow);
  return { menuFeature, menuReference, menuSketchGroup, sketchDeleteBlockedKey, menuMoveUp, menuMoveDown, canSetOrigin };
}

/**
 * 「1 つ上へ」「1 つ下へ」1 項目ぶん(FR-507)。
 *
 * 動かせないときは**押せなくして理由を吹き出しで読める**ようにする(NFR-UX-5)。
 * 押してから断る形にしないのは、ドラッグの予告(赤い線)と同じ考え方。
 */
function renderMoveItem(
  input: FeatureTreeInput,
  offer: TimelineMoveOffer | null,
  featureId: string,
  labelKey: MessageKey,
  tooltipKey: MessageKey,
  edgeKey: MessageKey,
): React.JSX.Element | null {
  if (offer === null) {
    return null;
  }
  return (
    <button
      type="button"
      role="menuitem"
      className="pcad-button pcad-menu__item"
      disabled={offer.kind !== 'ready'}
      title={
        offer.kind === 'ready'
          ? t(tooltipKey)
          : offer.kind === 'edge'
            ? t(edgeKey)
            : offer.refusal.message
      }
      onClick={() => {
        if (offer.kind === 'ready') {
          moveTreeRow(featureId, offer.toIndex);
        }
        input.closeMenu();
      }}
    >
      {t(labelKey)}
    </button>
  );
}

/** 一覧の中で矢印・Home・End は押せる項目の間を移り、Esc は閉じて開いたボタンへ焦点を戻す。 */
function onRowMenuKeyDown(input: FeatureTreeInput, event: React.KeyboardEvent<HTMLDivElement>): void {
  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    input.closeMenu();
    input.menuTriggerRef.current?.focus();
    return;
  }
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)'));
  const current = Math.max(0, items.findIndex(item => item === event.currentTarget.ownerDocument.activeElement));
  const next = nextHighlightIndex(current, event.key, items.length);
  if (next !== null) {
    event.preventDefault();
    event.stopPropagation();
    items[next]?.focus();
  }
}

/**
 * 開いている一覧。中身は節で決める。
 * - ソリッド: 抑制・改名・削除
 * - 基準ジオメトリ: 表示の切替・改名・削除(FR-329、FR-503)
 * - スケッチの要素: 改名・削除
 * - スケッチそのもの(親行): スケッチを追加・改名・削除
 * 参照先が壊れて(消えて)いる間は開かない。
 */
export function renderFeatureTreeRowMenu(context: FeatureTreeRowMenuContext): React.JSX.Element | null {
  const { part, documentVersion, input, sections, sketchGroups, folderContext } = context;
  const { menu } = input;
  if (menu === null) return null;
  const { menuFeature, menuReference, menuSketchGroup, sketchDeleteBlockedKey, menuMoveUp, menuMoveDown,
    canSetOrigin } = rowMenuTargets(part, menu, sections, sketchGroups);
  if ((menu.sectionKey === 'solid' && menuFeature === undefined) ||
    (menu.sectionKey === 'reference' && menuReference === undefined) ||
    (menu.sectionKey === 'sketchDocument' && menuSketchGroup === undefined)) return null;
  return (
    <div
      ref={input.menuRef}
      className="pcad-menu__panel pcad-tree__menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onKeyDown={(event) => { onRowMenuKeyDown(input, event); }}
    >
      {menu.sectionKey === 'solid' && menuFeature !== undefined ? (
        <button title={t('controlGuide.button.featureSuppress')}
          type="button"
          role="menuitem"
          className="pcad-button pcad-menu__item"
          onClick={() => {
            toggleSolidSuppressed(menu.featureId);
            input.closeMenu();
          }}
        >
          {t(menuFeature.suppressed ? 'featureTree.unsuppress' : 'featureTree.suppress')}
        </button>
      ) : null}
      {menu.sectionKey === 'reference' && menuReference !== undefined ? (
        <button title={t('controlGuide.button.referenceVisible')}
          type="button"
          role="menuitem"
          className="pcad-button pcad-menu__item"
          onClick={() => {
            toggleReferenceVisible(menu.featureId);
            input.closeMenu();
          }}
        >
          {t(menuReference.visible ? 'featureTree.hide' : 'featureTree.show')}
        </button>
      ) : null}
      {/* 作る順序を 1 段ずつ入れ替える(FR-507)。帯に出る行にだけ出す。 */}
      {renderMoveItem(input, menuMoveUp, menu.featureId, 'timeline.moveUp', 'timeline.moveUpTooltip', 'timeline.moveAtTop')}
      {renderMoveItem(input, menuMoveDown, menu.featureId, 'timeline.moveDown', 'timeline.moveDownTooltip',
        'timeline.moveAtBottom')}
      {/* スケッチの親行からも新しいスケッチを作れる(節の頭の「＋」と同じ)。 */}
      {menu.sectionKey === 'sketchDocument' ? (
        <button
          type="button"
          role="menuitem"
          className="pcad-button pcad-menu__item"
          title={t('featureTree.addSketchTooltip')}
          onClick={() => {
            addNewSketch();
            input.closeMenu();
          }}
        >
          {t('featureTree.addSketch')}
        </button>
      ) : null}
      {/*
        選んだ点を原点にする(FR-331)。スケッチの点と基準点の行にだけ出す。
        ツールバーには道具を増やさない決まりなので、入り口はこの一覧とプロパティの 2 つ。
      */}
      {canSetOrigin ? (
        <button
          type="button"
          role="menuitem"
          className="pcad-button pcad-menu__item"
          title={t('originCommand.tooltip')}
          onClick={() => {
            setTreeOrigin(menu.featureId);
            input.closeMenu();
          }}
        >
          {t('originCommand.action')}
        </button>
      ) : null}
      <button title={t('controlGuide.button.featureRename')}
        type="button"
        role="menuitem"
        className="pcad-button pcad-menu__item"
        onClick={() => {
          input.startRename(menu.featureId);
          input.closeMenu();
        }}
      >
        {t('featureTree.rename')}
      </button>
      <button type="button" role="menuitem" className="pcad-button pcad-menu__item" data-help-topic="history-notes" title={t('historyNote.edit')} onClick={() => {
        const target = noteTargetForRow(part, menu.featureId, menu.sectionKey, menu.sketchId);
        input.setNoteDraft({ target, name: menu.name, documentId: part.id, documentVersion, original: featureNoteOf(part, target) });
        input.closeMenu();
      }}>{t('historyNote.edit')}</button>
      <button type="button" role="menuitem" className="pcad-button pcad-menu__item" data-help-topic="history-notes" title={t('historyFolder.moveTitle')} onClick={() => {
        input.setFolderDraft({ ...folderContext(), mode: 'move', target: noteTargetForRow(part, menu.featureId, menu.sectionKey, menu.sketchId), name: menu.name });
        input.closeMenu();
      }}>{t('historyFolder.moveTitle')}</button>
      {/*
        消せないスケッチ(最後の 1 本、要素を立体が使っているもの)は押せなくし、
        理由を吹き出しで読めるようにする(FR-503、NFR-UX-5)。
        それ以外の行では `sketchDeleteBlockedKey` は必ず null なので押せる。
      */}
      <button
        type="button"
        role="menuitem"
        className="pcad-button pcad-menu__item pcad-menu__item--danger"
        disabled={sketchDeleteBlockedKey !== null}
        title={t(sketchDeleteBlockedKey ?? 'controlGuide.button.featureDelete')}
        onClick={() => {
          removeTreeRow(menu.featureId, menu.sectionKey);
          input.closeMenu();
        }}
      >
        {t('featureTree.delete')}
      </button>
    </div>
  );
}
