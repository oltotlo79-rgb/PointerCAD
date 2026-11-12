/**
 * モデルブラウザの木の骨組みを描く責務(FR-501): 部品の行、フォルダ、基準・スケッチ・ソリッドの節の
 * 見出しと開閉、スケッチの節の「＋」、空の状態。
 *
 * 節の中の行は `featureTreeRows.tsx` が描き、開閉の状態は `FeatureTree.tsx` が持つ。ここは描くだけ。
 */
import type { Dispatch, SetStateAction } from 'react';
import { featureFolderMemberKey, type FeatureFolder } from '@pointercad/model';

import { FeatureFolderTree } from '../history/FeatureFolderTree.js';
import type { FeatureFolderDraft } from '../history/FeatureFolderDialog.js';
import { t } from '../i18n/t.js';
import type { TreeSection, TreeSectionKey } from '../solid/solidSummary.js';
import { addNewSketch } from './featureTreeCommands.js';
import { renderFeatureTreeFolderMember, renderFeatureTreeRow, renderFeatureTreeSketchGroup } from './featureTreeRows.js';
import { ChevronRightIcon, CubeIcon, EmptyBoxIcon, LayersIcon, PlaneIcon, ReferenceGroupIcon, type IconProps } from './icons.js';

type RowContext = Parameters<typeof renderFeatureTreeRow>[0];

/** 節の頭に出す絵。基準は軸と点、スケッチは作図面、ソリッドは立体の印。 */
const SECTION_ICONS: Readonly<Record<TreeSectionKey, (props: IconProps) => React.JSX.Element>> = {
  reference: ReferenceGroupIcon,
  sketch: PlaneIcon,
  solid: CubeIcon,
};

/** 木の骨組みを描くのに要るもの(行を描くのに要るものを含む)。1 回の描画のあいだ変わらない。 */
interface FeatureTreeSectionsContext extends RowContext {
  readonly folders: readonly FeatureFolder[];
  readonly grouped: boolean;
  readonly rowCount: number;
  readonly isExpanded: boolean;
  readonly setIsExpanded: Dispatch<SetStateAction<boolean>>;
  readonly collapsed: readonly TreeSectionKey[];
  readonly setCollapsed: Dispatch<SetStateAction<readonly TreeSectionKey[]>>;
  readonly collapsedFolderIds: ReadonlySet<string>;
  readonly setCollapsedFolderIds: Dispatch<SetStateAction<ReadonlySet<string>>>;
  /** フォルダの窓に渡す、開いた時点の文書の控え。 */
  readonly folderContext: () => Pick<FeatureFolderDraft, 'documentId' | 'documentVersion' | 'originalFolders'>;
}

/**
 * 節 1 つ。見出しのボタンで開閉し、スケッチの節にだけ「＋」(スケッチを追加)を並べる。
 * スケッチが 2 本以上ある文書だけ、スケッチの節の中身を親行で束ねて出す。
 */
function renderSection(context: FeatureTreeSectionsContext, section: TreeSection): React.JSX.Element {
  const { part, grouped, sketchGroups, collapsed, setCollapsed } = context;
  const SectionIcon = SECTION_ICONS[section.key];
  const open = !collapsed.includes(section.key);
  return (
    <li key={section.key}>
      {/*
        入れ子のボタンは作れないので、見出しの折りたたみボタンと「＋」を器の div へ横に並べる。
      */}
      <div className="pcad-tree__section" data-name-search-key={!grouped && section.key === 'sketch' ? featureFolderMemberKey({ kind: 'sketch', id: part.activeSketchId }) : undefined}>
        <button
          type="button"
          className="pcad-tree__row pcad-tree__row--section"
          title={t('featureTree.toggleTooltip')}
          aria-expanded={open}
          onClick={() => {
            setCollapsed((keys) =>
              keys.includes(section.key)
                ? keys.filter((key) => key !== section.key)
                : [...keys, section.key],
            );
          }}
        >
          <ChevronRightIcon
            size={12}
            className={
              'pcad-tree__chevron' + (open ? ' pcad-tree__chevron--open' : '')
            }
          />
          <SectionIcon size={14} className="pcad-tree__icon" />
          <span className="pcad-tree__label">{t(section.titleKey)}</span>
          <span className="pcad-tree__count">
            {grouped && section.key === 'sketch'
              ? sketchGroups.length
              : section.rows.length}
          </span>
        </button>
        {section.key === 'sketch' ? (
          <button
            type="button"
            className="pcad-tree__add"
            title={t('featureTree.addSketchTooltip')}
            aria-label={t('featureTree.addSketch')}
            onClick={() => {
              addNewSketch();
            }}
          >
            {t('featureTree.addSketchMark')}
          </button>
        ) : null}
      </div>
      {!open ? null : grouped && section.key === 'sketch' ? (
        <ul className="pcad-tree__children">
          {sketchGroups.filter(group => !context.ownedRow(group.sketchId, 'sketchDocument'))
            .map((group) => renderFeatureTreeSketchGroup(context, group))}
        </ul>
      ) : section.rows.length === 0 ? (
        <p className="pcad-tree__hint">
          {t(
            section.key === 'solid'
              ? 'featureTree.solidEmpty'
              : section.key === 'reference'
                ? 'featureTree.referenceEmpty'
                : 'featureTree.empty',
          )}
        </p>
      ) : (
        <ul className="pcad-tree__children">
          {section.rows.filter(row => !context.ownedRow(row.id, section.key)).map((row) =>
            renderFeatureTreeRow(context, row, section.key, section.key === 'sketch' ? part.activeSketchId : undefined))}
        </ul>
      )}
    </li>
  );
}

/** フォルダの木。フォルダへ入れた行は節ではなくここに出る。 */
function renderFolders(context: FeatureTreeSectionsContext): React.JSX.Element | null {
  const { part, folders, collapsedFolderIds, setCollapsedFolderIds, input, folderContext } = context;
  return folders.length === 0 ? null : <FeatureFolderTree key={part.id} folders={folders} collapsed={collapsedFolderIds}
    renderMember={member => renderFeatureTreeFolderMember(context, member)}
    onToggle={id => setCollapsedFolderIds(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; })}
    onEdit={folder => input.setFolderDraft({ ...folderContext(), mode: 'edit', folderId: folder.id })} />;
}

/**
 * 部品 → 節 → その中身の親子の木(FR-501)。行もフォルダも 1 つも無いときは空の状態を出す。
 * 部品の行を押すと木全体を開閉する。
 */
export function renderFeatureTreeBody(context: FeatureTreeSectionsContext): React.JSX.Element {
  const { part, rowCount, folders, sections, isExpanded, setIsExpanded } = context;
  const chevronClassName = 'pcad-tree__chevron' + (isExpanded ? ' pcad-tree__chevron--open' : '');
  return rowCount === 0 && folders.length === 0 ? (
    <div className="pcad-panel__empty">
      <EmptyBoxIcon size={28} />
      <p className="pcad-panel__empty-text">{t('featureTree.empty')}</p>
    </div>
  ) : (
    <ul className="pcad-tree">
      <li>
        <button
          type="button"
          className="pcad-tree__row"
          title={t('featureTree.toggleTooltip')}
          aria-expanded={isExpanded}
          onClick={() => {
            setIsExpanded((expanded) => !expanded);
          }}
        >
          <ChevronRightIcon size={12} className={chevronClassName} />
          <LayersIcon size={14} className="pcad-tree__icon" />
          <span className="pcad-tree__label">{part.name}</span>
        </button>
        {isExpanded ? (
          <ul className="pcad-tree__sections">
            {renderFolders(context)}
            {sections.map((section) => renderSection(context, section))}
          </ul>
        ) : null}
      </li>
    </ul>
  );
}
