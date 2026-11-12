/**
 * 左のモデルブラウザ(要件§7.1、FR-501)。状態を読み、責務ごとのファイルへつなぐ。
 *
 * | 責務 | 置き場所 | 確定の時点 | 取消 |
 * |---|---|---|---|
 * | 状態の読み出し(ストア・開閉の状態)と名前の検索 | このファイル | — | — |
 * | 中身の組み立て(節・スケッチの束・タイムラインの段・行の数) | `featureTreeView.ts`(純関数) | — | — |
 * | 木の骨組み(部品の行・フォルダ・節の見出しと開閉・空の状態) | `featureTreeSections.tsx`(描くだけ) | — | — |
 * | 行・スケッチの親行・フォルダの中身・名前の欄・「⋮」 | `featureTreeRows.tsx`(描くだけ) | — | — |
 * | 行の一覧(メニュー)の項目と可否 | `featureTreeRowMenu.tsx`(描くだけ) | 項目を押した 1 回 | Esc・外側の押下 |
 * | 入力の一時状態(一覧・名前の欄・ドラッグ・下書き・ホバー)と寿命 | `useFeatureTreeInput.ts` | — | Esc・外側の押下・文書の差し替え・破棄 |
 * | 窓の listener と、一時状態を結び付ける文書 | `featureTreeLifetime.ts` | 離した 1 回 | pointercancel・Esc・外した後の遅い callback |
 * | ストアの更新(選択・ホバー・編集の確定) | `featureTreeCommands.ts` | 各操作で 1 回 | — |
 *
 * 選択・編集の確定・ドラッグ・取消の4系列が、分ける前と同じ操作で同じ更新を同じ順に起こすことと、
 * 状態ごとに返す要素の木が分ける前と同じことは `FeatureTree.boundary.test.tsx` が記録と照合する。
 */
import { useState } from 'react';
import { featureFolderMemberKey, featureNoteTargetExists } from '@pointercad/model';

import { featureFolderAncestors } from '../history/featureFolderAncestors.js';
import { FeatureFolderDialog } from '../history/FeatureFolderDialog.js';
import { FeatureNoteDialog } from '../history/FeatureNoteDialog.js';
import { t } from '../i18n/t.js';
import { featureIdOf } from '../sketch/featureSummary.js';
import type { TreeSectionKey } from '../solid/solidSummary.js';
import { useAppStore } from '../store/useAppStore.js';
import { DocumentNameSearch } from './DocumentNameSearch.js';
import { noteTargetForRow, renameTreeRow, selectSearchedRow, type RowMenuSection } from './featureTreeCommands.js';
import { renderFeatureTreeRowMenu } from './featureTreeRowMenu.js';
import { renderFeatureTreeBody } from './featureTreeSections.js';
import { buildFeatureTreeView } from './featureTreeView.js';
import { partNameSearchEntries } from './nameSearch.js';
import { useFeatureTreeInput } from './useFeatureTreeInput.js';
import { useRevealNamedTreeRow } from './useRevealNamedTreeRow.js';

/**
 * 左のモデルブラウザ(要件§7.1、FR-501)。
 *
 * 「部品 → 基準 / スケッチ / ソリッドの節 → その中身」の親子で、作った順(履歴の順)に並べる。
 * 行をクリックで選び、Shift+クリックで足す(FR-106)。指を乗せるとビューポート側も光る。
 * 計算できていない行には赤い印を出し、理由をホバーで見せる(FR-504)。
 *
 * どの行も「⋮」ボタンか右クリックで小さな一覧を開く。立体の行は抑制・改名・削除ができ(FR-503)、
 * スケッチにも改名・メモ・フォルダ移動・削除がある。一覧も改名の欄も**モーダルにしない**(NFR-UX-2)
 * ので、開いている間も視点操作は効く。参照していた立体を消しても止めず、後の段が赤い印になるだけに
 * する(FR-504、NFR-RE-1)。
 *
 * ここは状態を読んで、描く関数と入力の一時状態・ストアの更新をつなぐことだけを受け持つ
 * (形の正本はストアの `document` だけ。rules/04-設計の規律.md)。
 */
export function FeatureTree(): React.JSX.Element {
  const searchReveal = useRevealNamedTreeRow();
  const part = useAppStore((state) => state.document);
  const documentVersion = useAppStore((state) => state.documentVersion);
  const input = useFeatureTreeInput(part, documentVersion);
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<ReadonlySet<string>>(() => new Set());
  const selection = useAppStore((state) => state.selection);
  const hoveredElementId = useAppStore((state) => state.hoveredElementId);
  const sketchErrors = useAppStore((state) => state.sketchErrors);
  const partErrors = useAppStore((state) => state.partErrors);
  const resolvedReferences = useAppStore((state) => state.resolvedReferences);
  // タイムラインのつまみ(FR-507、FR-506)。区画は増やさず、履歴の行の
  // 左端をなぞる細いレールとして木の中に出す(利用者の決定)。
  const timelineIndex = useAppStore((state) => state.timelineIndex);
  // 順序の入れ替えを断った理由(FR-507、FR-504)。壊れる側の行に印を出す。
  const timelineRefusal = useAppStore((state) => state.timelineRefusal);
  const [isExpanded, setIsExpanded] = useState(true);
  const [collapsed, setCollapsed] = useState<readonly TreeSectionKey[]>([]);
  const [collapsedSketchIds, setCollapsedSketchIds] = useState<readonly string[]>([]);

  const view = buildFeatureTreeView({ part, sketchErrors, partErrors, referenceErrors: resolvedReferences.errors,
    timelineIndex });
  const { folders, sections, sketchGroups } = view;
  const folderContext = () => ({ documentId: part.id, documentVersion, originalFolders: JSON.stringify(folders) });
  const owned = new Set(folders.flatMap(folder => folder.children.map(featureFolderMemberKey)));
  const context = {
    ...view, part, documentVersion, input, folderContext, timelineRefusal,
    selectedIds: new Set(selection.map((id) => featureIdOf(id))),
    hoveredId: hoveredElementId === null ? null : featureIdOf(hoveredElementId),
    isExpanded, setIsExpanded, collapsed, setCollapsed, collapsedFolderIds, setCollapsedFolderIds,
    collapsedSketchIds, setCollapsedSketchIds,
    ownedRow: (id: string, section: RowMenuSection, sketchId?: string) =>
      owned.has(featureFolderMemberKey(noteTargetForRow(part, id, section, sketchId))),
    /** 名前の欄の確定(Enter・欄を離れる)。名前を変えて、欄を閉じる。 */
    commitRename: (featureId: string, sectionKey: RowMenuSection, name: string): void => {
      renameTreeRow(featureId, sectionKey, name);
      input.stopRename();
    },
  };

  return (
    <section ref={searchReveal.ref} className="pcad-panel pcad-panel--left">
      <h2 className="pcad-panel__title">{t('featureTree.title')}</h2>
      <DocumentNameSearch key={part.id} helpTopic="feature-tree" getEntries={() => partNameSearchEntries(sections, sketchGroups)}
        onSelect={entry => {
          searchReveal.reveal(entry.key);
          setIsExpanded(true);
          if (entry.historyTarget !== undefined) {
            const target = entry.historyTarget;
            const section = target.kind === 'sketch-feature' ? 'sketch' : target.kind;
            setCollapsed(previous => previous.filter(key => key !== section));
            const ancestors = featureFolderAncestors(folders, target);
            setCollapsedFolderIds(previous => new Set([...previous].filter(id => !ancestors.has(id))));
          }
          if (entry.sketchId !== undefined) setCollapsedSketchIds(previous => previous.filter(id => id !== entry.sketchId));
          selectSearchedRow(entry.selectionId, entry.sketchId);
        }} />
      <div className="pcad-panel__body">
        <button type="button" className="pcad-button" data-help-topic="history-notes" title={t('historyFolder.create')} onClick={() => input.setFolderDraft({ ...folderContext(), mode: 'create' })}>{t('historyFolder.create')}</button>
        {renderFeatureTreeBody(context)}
      </div>

      {renderFeatureTreeRowMenu(context)}
      {input.folderDraft !== null && input.folderDraft.documentId === part.id && input.folderDraft.documentVersion === documentVersion
        ? <FeatureFolderDialog draft={input.folderDraft} onClose={() => input.setFolderDraft(null)} /> : null}
      {input.noteDraft !== null && input.noteDraft.documentId === part.id && input.noteDraft.documentVersion === documentVersion
        && featureNoteTargetExists(part, input.noteDraft.target) ? <FeatureNoteDialog draft={input.noteDraft} onClose={() => input.setNoteDraft(null)} /> : null}
    </section>
  );
}
