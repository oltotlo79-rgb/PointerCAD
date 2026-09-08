import { useEffect, useRef, useState } from 'react';

import {
  findComponent,
} from '@pointercad/model';

import { t } from '../i18n/t.js';
import {
  deleteAssemblyComponents,
  duplicateAssemblyComponent,
  toggleAssemblyComponentFixed,
  toggleAssemblyComponentSuppressed,
  toggleAssemblyComponentVisible,
} from '../assembly/placeComponentActions.js';
import { deleteAssemblyMate, editAssemblyMate, flipAssemblyMate } from '../assembly/mateActions.js';
import { activeAssemblyDocument } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import type { AssemblyView } from '../store/assemblySlice.js';
import {
  assemblyTreeRows,
  ASSEMBLY_BADGE_LABEL_KEYS,
  ASSEMBLY_BADGE_TOOLTIP_KEYS,
  type AssemblyRowKind,
  type AssemblyTreeRow,
  type AssemblyTreeSectionKey,
} from './assemblyTreeRows.js';
import {
  AlertIcon,
  AngleConstraintIcon,
  ChevronRightIcon,
  CoincidentConstraintIcon,
  ConcentricConstraintIcon,
  ConstraintGroupIcon,
  CubeIcon,
  CylinderIcon,
  DistanceConstraintIcon,
  EmptyBoxIcon,
  GearIcon,
  LayersIcon,
  ParallelConstraintIcon,
  RevolveIcon,
  ShapeGroupIcon,
  SphereIcon,
  TangentConstraintIcon,
  ThreadShaftIcon,
  TransformIcon,
  type IconProps,
} from './icons.js';

/**
 * 行の頭に出す種類の絵。**道具のボタンと同じ図柄**にして、作ったものと道具を結び付ける
 * (部品の木 `FeatureTree.tsx` の `KIND_ICONS` と同じ考え方)。
 *
 * 分解(部品を向きへ離す)とスライドのジョイントは、どちらも「決めた向きへまっすぐ
 * 動かす」ことなので同じ移動の絵にしてある。どちらの節の行かは束の見出しの絵で分かる。
 */
const KIND_ICONS: Readonly<Record<AssemblyRowKind, (props: IconProps) => React.JSX.Element>> = {
  part: CubeIcon,
  subAssembly: LayersIcon,
  standardPart: ThreadShaftIcon,
  coincident: CoincidentConstraintIcon,
  concentric: ConcentricConstraintIcon,
  distance: DistanceConstraintIcon,
  angle: AngleConstraintIcon,
  parallel: ParallelConstraintIcon,
  tangent: TangentConstraintIcon,
  revolute: RevolveIcon,
  slider: TransformIcon,
  cylindrical: CylinderIcon,
  ball: SphereIcon,
  explode: TransformIcon,
  jointStep: GearIcon,
};

/** 束(節)の頭に出す絵。部品は立体、合致は拘束、ジョイントは可動、分解は形のまとまり。 */
const SECTION_ICONS: Readonly<
  Record<AssemblyTreeSectionKey, (props: IconProps) => React.JSX.Element>
> = {
  component: CubeIcon,
  mate: ConstraintGroupIcon,
  joint: GearIcon,
  step: ShapeGroupIcon,
};

/** 行から開く小さな一覧の位置(画面座標、画素)。作りは `FeatureTree.tsx` と同じ。 */
interface RowMenuState {
  readonly rowId: string;
  readonly kind: 'component' | 'mate';
  readonly x: number;
  readonly y: number;
}

/**
 * 一覧の高さと幅の見込み(画素)。項目は複製・削除・固定・表示・抑制の 5 つ。
 * 画面の端との余白は `FeatureTree` と同じ値にそろえる。
 */
const ROW_MENU_HEIGHT = 168;
const ROW_MENU_WIDTH = 132;
const ROW_MENU_GAP = 4;
const ROW_MENU_MARGIN = 8;

/** 画面の下からはみ出すなら上へ出す(`FeatureTree.tsx` の同名の関数と同じ決め方)。 */
function menuTop(bottom: number, top: number): number {
  const below = bottom + ROW_MENU_GAP;
  const above = top - ROW_MENU_GAP - ROW_MENU_HEIGHT;
  const fits = below + ROW_MENU_HEIGHT <= window.innerHeight - ROW_MENU_MARGIN;
  return Math.max(ROW_MENU_MARGIN, fits ? below : above);
}

/** 一覧の右端の位置。左右の端からははみ出させない。 */
function menuRight(right: number): number {
  const smallest = ROW_MENU_WIDTH + ROW_MENU_MARGIN;
  const largest = window.innerWidth - ROW_MENU_MARGIN;
  return Math.min(Math.max(right, smallest), Math.max(smallest, largest));
}

export function assemblyRowMenuTarget(section: AssemblyTreeSectionKey, rowId: string):
{ readonly kind: 'component' | 'mate'; readonly rowId: string } | null {
  return section === 'component' || section === 'mate' ? { kind: section, rowId } : null;
}

/** メニューを開いた行だけを展開状態として読み上げる。 */
export function assemblyRowMenuExpanded(
  menu: Pick<RowMenuState, 'kind' | 'rowId'> | null,
  section: AssemblyTreeSectionKey,
  rowId: string,
): boolean {
  return menu !== null && menu.kind === section && menu.rowId === rowId;
}

/** 実診断を行IDで引く。部品が残っている場合の部分形状消失も理由として残す。 */
export function assemblyMateRowDetails(rowId: string, view: AssemblyView | null | undefined): {
  readonly missing: boolean; readonly suspected: boolean; readonly unresolved: boolean; readonly message: string | null;
} {
  const errors = view?.mateTargetErrors.get(rowId) ?? [];
  const messages = view?.diagnosis?.messages.filter((message) => message.mateIds.includes(rowId)).map((message) => message.text) ?? [];
  return { missing: errors.length > 0, suspected: view?.diagnosis?.suspectedConflictMateIds.includes(rowId) ?? false,
    unresolved: view?.diagnosis?.unresolvedMateIds.includes(rowId) ?? false,
    message: errors.length + messages.length === 0 ? null : [...new Set([...errors, ...messages])].join(' ') };
}

/**
 * 左のモデルブラウザの**アセンブリ版**(要件§7.1、FR-501。計画書 P7 タスク9)。
 *
 * 「アセンブリ → 部品 / 合致 / ジョイント / 分解ステップの 4 つの束 → その中身」の親子で、
 * 置いた順(文書の順)に並べる。**区画は増やさない**(`rules/04-設計の規律.md`)——
 * 部品を開いているときの `FeatureTree` と同じ場所に、同じ見た目で入れ替わって出る
 * (どちらを出すかは `AppShell.tsx` が文書の種類で決める。§0.a-0.10)。
 *
 * **行の組み立ては純関数**(`assemblyTreeRows.ts`)に置き、ここは並べるだけにしてある。
 * 行をクリックで選び、Shift+クリックで足す(FR-106)。指を乗せるとビューポート側も光る
 * (アセンブリの層がストアの `selection` / `hoveredElementId` をそのまま読む)。
 *
 * 部品の行は「⋮」ボタンか右クリックで小さな一覧を開き、固定(FR-602)・表示(FR-605)・
 * 抑制(FR-503)を切り替えられる。合致・ジョイント・分解ステップの行の操作は、
 * それぞれを作る段(P7 タスク17・35 ほか)が同じ一覧へ足す。
 *
 * 開いているかどうか・一覧を出しているかどうかは見た目だけの一時状態なのでコンポーネントに
 * 持つ(`FeatureTree` と同じ)。形の正本はストアの `assembly` だけ。
 */
export function AssemblyTree(): React.JSX.Element {
  const assembly = useAppStore(activeAssemblyDocument);
  const view = useAppStore((state) => state.assemblyView);
  const selection = useAppStore((state) => state.selection);
  const hoveredElementId = useAppStore((state) => state.hoveredElementId);
  const [isExpanded, setIsExpanded] = useState(true);
  const [collapsed, setCollapsed] = useState<readonly AssemblyTreeSectionKey[]>([]);
  const [collapsedComponents, setCollapsedComponents] = useState<readonly string[]>([]);
  const [menu, setMenu] = useState<RowMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 一覧の外を押したとき・Esc を押したときに閉じる。開いている間だけ見張る。
  useEffect(() => {
    if (menu === null) {
      return undefined;
    }
    const onPointerDown = (event: PointerEvent): void => {
      const node = menuRef.current;
      if (node !== null && event.target instanceof Node && node.contains(event.target)) {
        return;
      }
      setMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenu(null);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menu]);

  // 開いた直後は先頭の項目へ焦点を移し、キーボードだけでも選べるようにする(NFR-UX-7)。
  useEffect(() => {
    if (menu === null) {
      return;
    }
    menuRef.current?.querySelector('button')?.focus();
  }, [menu]);

  if (assembly === null) {
    /*
      アセンブリを開いていないときは出さない(`AppShell` が部品の木の側を出す)。
      それでも空の区画を返すのは、種類が入れ替わる一瞬に区画そのものが消えて
      幅が動かないようにするため。
    */
    return (
      <section className="pcad-panel pcad-panel--left">
        <h2 className="pcad-panel__title">{t('featureTree.title')}</h2>
        <div className="pcad-panel__body">
          <div className="pcad-panel__empty">
            <EmptyBoxIcon size={28} />
            <p className="pcad-panel__empty-text">{t('featureTree.empty')}</p>
          </div>
        </div>
      </section>
    );
  }

  const conflictingIds = new Set([
    ...(view?.diagnosis?.provenConflictMateIds ?? []),
  ]);
  const sections = assemblyTreeRows(assembly, view === null || view === undefined ? undefined : {
    ...view.resolved,
    conflictingIds,
  });
  const selectedIds = new Set(selection);
  const menuComponent = menu?.kind === 'component' ? findComponent(assembly, menu.rowId) : undefined;
  const menuMate = menu?.kind === 'mate' ? assembly.mates.find((mate) => mate.id === menu.rowId) : undefined;
  const chevronClassName = 'pcad-tree__chevron' + (isExpanded ? ' pcad-tree__chevron--open' : '');

  const renderRow = (row: AssemblyTreeRow, sectionKey: AssemblyTreeSectionKey, depth = 0): React.JSX.Element => {
    const details = sectionKey === 'mate' ? assemblyMateRowDetails(row.id, view) : null;
    const errorMessage = details?.message ?? row.errorMessage;
    const KindIcon = KIND_ICONS[row.kind];
    const selected = selectedIds.has(row.id);
    const hasChildren = (row.children?.length ?? 0) > 0;
    const childrenOpen = !collapsedComponents.includes(row.id);
    const rootRow = !row.id.includes('/');
    const rowClassName =
      'pcad-tree__row pcad-tree__row--child' +
      (selected ? ' pcad-tree__row--selected' : '') +
      (hoveredElementId === row.id ? ' pcad-tree__row--hovered' : '') +
      // 抑制中・指し先が引けない行は薄く出す(部品の木の抑制と同じ薄さ)。
      (row.dimmed || details?.missing === true ? ' pcad-tree__row--suppressed' : '');
    return (
      <li key={row.key}>
        <div
          className={rowClassName}
          onPointerEnter={() => {
            useAppStore.getState().setHovered(row.id);
          }}
          onPointerLeave={() => {
            const store = useAppStore.getState();
            if (store.hoveredElementId === row.id) {
              store.setHovered(null);
            }
          }}
          onContextMenu={(event) => {
            if (!rootRow) return;
            const target = assemblyRowMenuTarget(sectionKey, row.id);
            if (target === null) return;
            event.preventDefault();
            useAppStore.getState().setSelection([row.id]);
            setMenu({
              ...target,
              x: menuRight(event.clientX),
              y: menuTop(event.clientY, event.clientY),
            });
          }}
        >
          {hasChildren ? (
            <button
              type="button"
              className="pcad-tree__branch-toggle"
              style={{ paddingLeft: 26 + depth * 12 }}
              title={t('featureTree.toggleTooltip')}
              aria-label={t('featureTree.toggleTooltip')}
              aria-expanded={childrenOpen}
              onClick={() => {
                setCollapsedComponents((ids) => ids.includes(row.id)
                  ? ids.filter((id) => id !== row.id)
                  : [...ids, row.id]);
              }}
            >
              <ChevronRightIcon size={12} className={'pcad-tree__chevron' + (childrenOpen ? ' pcad-tree__chevron--open' : '')} />
            </button>
          ) : null}
          <button
            type="button"
            className="pcad-tree__select"
            style={hasChildren ? { paddingLeft: 0 } : { paddingLeft: 44 + depth * 12 }}
            aria-pressed={selected}
            title={t(row.kindLabelKey)}
            onClick={(event) => {
              const store = useAppStore.getState();
              if (event.shiftKey) {
                store.toggleSelection(row.id);
                return;
              }
              store.setSelection([row.id]);
            }}
          >
            <KindIcon size={14} className="pcad-tree__icon" />
            <span className="pcad-tree__label">{row.name}</span>
          </button>
          {row.badges.map((badge) => (
            <span
              key={`${row.key}/${badge}`}
              className="pcad-tree__badge"
              title={t(ASSEMBLY_BADGE_TOOLTIP_KEYS[badge])}
            >
              {t(ASSEMBLY_BADGE_LABEL_KEYS[badge])}
            </span>
          ))}
          {details?.missing === true && !row.badges.includes('unresolved') ?
            <span className="pcad-tree__badge" title={errorMessage ?? undefined}>{t('assembly.tree.unresolved')}</span> : null}
          {details?.suspected === true ? <span className="pcad-tree__badge" title={t('assembly.mate.suspectedTooltip')}>{t('assembly.mate.suspected')}</span> : null}
          {details?.unresolved === true ? <span className="pcad-tree__badge" title={errorMessage ?? undefined}>{t('assembly.mate.unresolved')}</span> : null}
          {errorMessage === null ? null : (
            <span
              className="pcad-tree__alert"
              title={`${errorMessage} ${t('featureTree.errorTooltip')}`}
            >
              <AlertIcon size={12} />
            </span>
          )}
          {!rootRow || (sectionKey !== 'component' && sectionKey !== 'mate') ? null : (
            <button
              type="button"
              className="pcad-tree__more"
              title={t('featureTree.menuTooltip')}
              aria-label={t('featureTree.menuTooltip')}
              aria-haspopup="menu"
              aria-expanded={assemblyRowMenuExpanded(menu, sectionKey, row.id)}
              onClick={(event) => {
                const target = assemblyRowMenuTarget(sectionKey, row.id);
                if (target === null) return;
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({
                  ...target,
                  x: menuRight(rect.right),
                  y: menuTop(rect.bottom, rect.top),
                });
              }}
            >
              {t('featureTree.menuMark')}
            </button>
          )}
        </div>
        {!hasChildren || !childrenOpen ? null : (
          <ul className="pcad-tree__children pcad-tree__children--assembly-nested">
            {row.children?.map((child) => renderRow(child, sectionKey, depth + 1))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <section className="pcad-panel pcad-panel--left">
      <h2 className="pcad-panel__title">{t('featureTree.title')}</h2>
      <div className="pcad-panel__body">
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
              <span className="pcad-tree__label">{assembly.name}</span>
            </button>
            {isExpanded ? (
              <ul className="pcad-tree__sections">
                {sections.map((section) => {
                  const SectionIcon = SECTION_ICONS[section.key];
                  const open = !collapsed.includes(section.key);
                  return (
                    <li key={section.key}>
                      <div className="pcad-tree__section">
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
                          <span className="pcad-tree__count">{section.rows.length}</span>
                        </button>
                      </div>
                      {!open ? null : section.rows.length === 0 ? (
                        /*
                          束ごとの短い案内。部品を 1 つも置いていないアセンブリ全体の案内
                          (`assembly.emptyState`)はビューポートの側に `AppShell` が出すので、
                          ここでは二重に出さない(P7 タスク5 の申し送り)。
                        */
                        <p className="pcad-tree__hint">{t(section.emptyKey)}</p>
                      ) : (
                        <ul className="pcad-tree__children">
                          {section.rows.map((row) => renderRow(row, section.key))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </li>
        </ul>
      </div>

      {/*
        部品の行の一覧(FR-602、FR-605、FR-503)。指し先が消えている間は開かない
        (部品の木の「⋮」と同じ約束)。
      */}
      {menu === null || (menuComponent === undefined && menuMate === undefined) ? null : (
        <div
          ref={menuRef}
          className="pcad-menu__panel pcad-tree__menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
        >
          {menuComponent === undefined ? null : <><button
            type="button"
            role="menuitem"
            className="pcad-button pcad-menu__item"
            onClick={() => {
              duplicateAssemblyComponent(menu.rowId);
              setMenu(null);
            }}
          >
            {t('assembly.tool.duplicate')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="pcad-button pcad-menu__item"
            onClick={() => {
              deleteAssemblyComponents([menu.rowId]);
              setMenu(null);
            }}
          >
            {t('assembly.tool.delete')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="pcad-button pcad-menu__item"
            onClick={() => {
              toggleAssemblyComponentFixed(menu.rowId);
              setMenu(null);
            }}
          >
            {t(menuComponent.fixed ? 'assembly.tree.unfix' : 'assembly.tool.fixComponent')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="pcad-button pcad-menu__item"
            onClick={() => {
              toggleAssemblyComponentVisible(menu.rowId);
              setMenu(null);
            }}
          >
            {t(menuComponent.visible ? 'featureTree.hide' : 'featureTree.show')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="pcad-button pcad-menu__item"
            onClick={() => {
              toggleAssemblyComponentSuppressed(menu.rowId);
              setMenu(null);
            }}
          >
            {t(menuComponent.suppressed ? 'featureTree.unsuppress' : 'featureTree.suppress')}
          </button></>}
          {menuMate === undefined ? null : <>
            <button type="button" role="menuitem" className="pcad-button pcad-menu__item"
              onClick={() => { editAssemblyMate(menu.rowId); setMenu(null); }}>
              {t('assembly.mate.edit')}
            </button>
            <button type="button" role="menuitem" className="pcad-button pcad-menu__item"
              onClick={() => { flipAssemblyMate(menu.rowId); setMenu(null); }}>
              {t('assembly.mate.flip')}
            </button>
            <button type="button" role="menuitem" className="pcad-button pcad-menu__item"
              onClick={() => { deleteAssemblyMate(menu.rowId); setMenu(null); }}>
              {t('assembly.mate.delete')}
            </button>
          </>}
        </div>
      )}
    </section>
  );
}
