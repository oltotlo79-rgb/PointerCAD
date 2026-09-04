import { useEffect, useRef, useState } from 'react';

import {
  findSolid,
  removeSolid,
  replaceSolid,
  type SketchFeatureKind,
  type SolidLabelKey,
} from '@pointercad/model';

import { t } from '../i18n/t.js';
import { featureIdOf } from '../sketch/featureSummary.js';
import {
  buildTreeSections,
  renameSolid,
  setSolidSuppressed,
  type TreeRow,
  type TreeSectionKey,
} from '../solid/solidSummary.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  AlertIcon,
  ArcToolIcon,
  ChamferIcon,
  ChevronRightIcon,
  CircularPatternIcon,
  CubeIcon,
  EllipseToolIcon,
  EmptyBoxIcon,
  ExtrudeIcon,
  FaceToolIcon,
  FilletIcon,
  HoleIcon,
  IntersectIcon,
  LayersIcon,
  LinearPatternIcon,
  LineToolIcon,
  PlaneIcon,
  PlotPointIcon,
  PointArrayToolIcon,
  PolygonToolIcon,
  RectangleToolIcon,
  RevolveIcon,
  SewIcon,
  SlotToolIcon,
  SplineToolIcon,
  SpringIcon,
  SubtractIcon,
  ThreadHoleIcon,
  UnionIcon,
  type IconProps,
} from './icons.js';

/**
 * 行の頭に出す種類の絵。道具のアイコンと同じ図柄にして、作ったものと道具を結び付ける
 * (計画書 docs/plans/P3-加工フィーチャー.md タスク27)。
 *
 * P3 のタスク13 で種類が13個に増え、タスク26 が加工6種+ばねの図柄(`icons.tsx`)を足した。
 * タスク27 でその7つをここへ差し替え、CubeIcon の仮置き(タスク13〜22 の暫定)を終わらせた。
 */
const KIND_ICONS: Readonly<
  Record<SketchFeatureKind | SolidLabelKey, (props: IconProps) => React.JSX.Element>
> = {
  point: PlotPointIcon,
  line: LineToolIcon,
  arc: ArcToolIcon,
  pointArray: PointArrayToolIcon,
  face: FaceToolIcon,
  rectangle: RectangleToolIcon,
  polygon: PolygonToolIcon,
  slot: SlotToolIcon,
  ellipse: EllipseToolIcon,
  spline: SplineToolIcon,
  // オフセット(FR-321、P4 タスク15)。専用の図柄はツールバーを組み直すタスク32 で足すので、
  // それまでは「線をずらす」ことが分かる線分の図柄を借りる(型の網羅のため)。
  offset: LineToolIcon,
  // 複製(ミラー・複写・配列複写、FR-324、P4 タスク20)。専用の図柄はツールバーを組み直す
  // タスク32 で足すので、それまでは「並べて増やす」ことが分かる直線パターンの図柄を借りる。
  copy: LinearPatternIcon,
  // 投影・交差(FR-325、P4 タスク25)。専用の図柄は道具を足すタスク27 で用意するので、
  // それまでは「立体から線を取り込む」ことが伝わる図柄を借りる(型の網羅のため)。
  projectedCurve: FaceToolIcon,
  planeSection: FaceToolIcon,
  extrude: ExtrudeIcon,
  revolve: RevolveIcon,
  sew: SewIcon,
  union: UnionIcon,
  subtract: SubtractIcon,
  intersect: IntersectIcon,
  hole: HoleIcon,
  threadHole: ThreadHoleIcon,
  fillet: FilletIcon,
  chamfer: ChamferIcon,
  linearPattern: LinearPatternIcon,
  circularPattern: CircularPatternIcon,
  spring: SpringIcon,
};

/** 節の頭に出す絵。スケッチは作図面、ソリッドは立体の印。 */
const SECTION_ICONS: Readonly<Record<TreeSectionKey, (props: IconProps) => React.JSX.Element>> = {
  sketch: PlaneIcon,
  solid: CubeIcon,
};

/**
 * 行から開く小さな一覧の位置(画面座標、画素)。
 *
 * 一覧はモデルブラウザの中に置くと区画の縁で切り取られてしまうので、画面に対して
 * 固定して出す(位置は開いた瞬間のボタンかカーソルの場所)。
 */
interface RowMenuState {
  readonly featureId: string;
  /** どちらの節の行から開いたか。ソリッドだけ抑制・改名を持つ(P3 §0.a-0.23 ②)。 */
  readonly sectionKey: TreeSectionKey;
  readonly x: number;
  readonly y: number;
}

/** 一覧の高さの見込み(画素)。下端からはみ出すときに上へ出すかを決めるのに使う。 */
const ROW_MENU_HEIGHT = 96;
/** 一覧の幅の見込み(画素)。css の .pcad-menu__item の min-width と左右の余白から。 */
const ROW_MENU_WIDTH = 132;
/** ボタンやカーソルと一覧の間の隙間、および画面の端との余白(画素)。 */
const ROW_MENU_GAP = 4;
const ROW_MENU_MARGIN = 8;

/** 画面の下からはみ出すなら上へ出す。上下どちらでも収まらないときは端に寄せる。 */
function menuTop(bottom: number, top: number): number {
  const below = bottom + ROW_MENU_GAP;
  const above = top - ROW_MENU_GAP - ROW_MENU_HEIGHT;
  const fits = below + ROW_MENU_HEIGHT <= window.innerHeight - ROW_MENU_MARGIN;
  return Math.max(ROW_MENU_MARGIN, fits ? below : above);
}

/**
 * 一覧の右端の位置。指定した場所へ右端をそろえるが、左右の端からははみ出させない。
 * モデルブラウザは画面のいちばん左にあるので、そのままでは左へはみ出すことがある。
 */
function menuRight(right: number): number {
  const smallest = ROW_MENU_WIDTH + ROW_MENU_MARGIN;
  const largest = window.innerWidth - ROW_MENU_MARGIN;
  return Math.min(Math.max(right, smallest), Math.max(smallest, largest));
}

/**
 * 左のモデルブラウザ(要件§7.1、FR-501)。
 *
 * 「部品 → スケッチ / ソリッドの 2 節 → その中身」の親子で、作った順(履歴の順)に並べる。
 * 行をクリックで選び、Shift+クリックで足す(FR-106)。指を乗せるとビューポート側も光る。
 * 計算できていない行には赤い印を出し、理由をホバーで見せる(FR-504)。
 *
 * どの行も「⋮」ボタンか右クリックで小さな一覧を開く(P3 §0.a-0.23 ②)。立体の行は
 * 抑制・改名・削除ができ(FR-503)、スケッチの行は削除だけを持つ。
 * 一覧も改名の欄も**モーダルにしない**(NFR-UX-2)ので、開いている間も視点操作は効く。
 * 削除の前に確認を出さないのは、元に戻す(Ctrl+Z)で戻せるため(NFR-UX-3)。参照していた
 * 立体を消しても止めず、後の段が赤い印になるだけにする(FR-504、NFR-RE-1)。
 *
 * 開いているかどうか・一覧を出しているかどうか・改名中かどうかは見た目だけの一時状態なので
 * コンポーネントに持つ(rules/04-設計の規律.md)。形の正本はストアの `document` だけ。
 */
export function FeatureTree(): React.JSX.Element {
  const part = useAppStore((state) => state.document);
  const selection = useAppStore((state) => state.selection);
  const hoveredElementId = useAppStore((state) => state.hoveredElementId);
  const sketchErrors = useAppStore((state) => state.sketchErrors);
  const partErrors = useAppStore((state) => state.partErrors);
  const [isExpanded, setIsExpanded] = useState(true);
  const [collapsed, setCollapsed] = useState<readonly TreeSectionKey[]>([]);
  const [menu, setMenu] = useState<RowMenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const sections = buildTreeSections(part, part.activeSketchId, sketchErrors, partErrors);
  const rowCount = sections.reduce((total, section) => total + section.rows.length, 0);
  // 抑制・改名はソリッドの行だけが持つ(スケッチの行の一覧は削除だけ、P3 §0.a-0.23 ②)。
  const menuFeature =
    menu === null || menu.sectionKey !== 'solid' ? undefined : findSolid(part, menu.featureId);

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

  const selectedIds = new Set(selection.map((id) => featureIdOf(id)));
  const hoveredId = hoveredElementId === null ? null : featureIdOf(hoveredElementId);
  const chevronClassName = 'pcad-tree__chevron' + (isExpanded ? ' pcad-tree__chevron--open' : '');

  const removeRow = (featureId: string, sectionKey: TreeSectionKey): void => {
    const store = useAppStore.getState();
    if (sectionKey === 'sketch') {
      store.removeSketchFeature(featureId);
      return;
    }
    store.applyDocument(removeSolid(store.document, featureId));
  };

  const commitRename = (featureId: string, name: string): void => {
    const store = useAppStore.getState();
    const feature = findSolid(store.document, featureId);
    if (feature !== undefined) {
      const next = renameSolid(feature, name);
      if (next !== feature) {
        store.applyDocument(replaceSolid(store.document, featureId, next));
      }
    }
    setRenamingId(null);
  };

  const toggleSuppressed = (featureId: string): void => {
    const store = useAppStore.getState();
    const feature = findSolid(store.document, featureId);
    if (feature === undefined) {
      return;
    }
    store.applyDocument(
      replaceSolid(store.document, featureId, setSolidSuppressed(feature, !feature.suppressed)),
    );
  };

  const renderRow = (row: TreeRow, sectionKey: TreeSectionKey): React.JSX.Element => {
    const KindIcon = KIND_ICONS[row.kind];
    const selected = selectedIds.has(row.id);
    const rowClassName =
      'pcad-tree__row pcad-tree__row--child' +
      (selected ? ' pcad-tree__row--selected' : '') +
      (hoveredId === row.id ? ' pcad-tree__row--hovered' : '') +
      (row.suppressed ? ' pcad-tree__row--suppressed' : '');
    return (
      <li key={row.id}>
        <div
          className={rowClassName}
          onPointerEnter={() => {
            useAppStore.getState().setHovered(row.id);
          }}
          onPointerLeave={() => {
            const store = useAppStore.getState();
            const current = store.hoveredElementId;
            if (current !== null && featureIdOf(current) === row.id) {
              store.setHovered(null);
            }
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            useAppStore.getState().setSelection([row.id]);
            setMenu({
              featureId: row.id,
              sectionKey,
              x: menuRight(event.clientX),
              y: menuTop(event.clientY, event.clientY),
            });
          }}
        >
          {renamingId === row.id ? (
            <input
              className="pcad-tree__rename"
              type="text"
              autoComplete="off"
              spellCheck={false}
              defaultValue={row.name}
              aria-label={t('featureTree.renameLabel')}
              title={t('featureTree.renameTooltip')}
              autoFocus
              onFocus={(event) => {
                event.currentTarget.select();
              }}
              onBlur={(event) => {
                commitRename(row.id, event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitRename(row.id, event.currentTarget.value);
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setRenamingId(null);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="pcad-tree__select"
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
              onKeyDown={(event) => {
                if (event.key !== 'Delete') {
                  return;
                }
                // 参照していたものが壊れても消させる。理由は帯と赤い印で伝える(FR-504)。
                event.preventDefault();
                removeRow(row.id, sectionKey);
              }}
            >
              <KindIcon size={14} className="pcad-tree__icon" />
              <span className="pcad-tree__label">{row.name}</span>
            </button>
          )}
          {row.suppressed ? (
            <span className="pcad-tree__badge">{t('featureTree.suppressed')}</span>
          ) : null}
          {row.consumed && !row.suppressed ? (
            <span className="pcad-tree__badge" title={t('featureTree.consumedTooltip')}>
              {t('featureTree.consumed')}
            </span>
          ) : null}
          {row.errorMessage === null ? null : (
            <span
              className="pcad-tree__alert"
              title={`${row.errorMessage} ${t('featureTree.errorTooltip')}`}
            >
              <AlertIcon size={12} />
            </span>
          )}
          {/*
            スケッチ・ソリッドどちらの行も同じ「⋮」の非モーダル一覧を開く(P3 §0.a-0.23 ②)。
            一覧の中身(抑制・改名の有無)は sectionKey で決める。
          */}
          <button
            type="button"
            className="pcad-tree__more"
            title={t('featureTree.menuTooltip')}
            aria-label={t('featureTree.menuTooltip')}
            aria-haspopup="menu"
            aria-expanded={menu !== null && menu.featureId === row.id}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({
                featureId: row.id,
                sectionKey,
                x: menuRight(rect.right),
                y: menuTop(rect.bottom, rect.top),
              });
            }}
          >
            {t('featureTree.menuMark')}
          </button>
        </div>
      </li>
    );
  };

  return (
    <section className="pcad-panel pcad-panel--left">
      <h2 className="pcad-panel__title">{t('featureTree.title')}</h2>
      <div className="pcad-panel__body">
        {rowCount === 0 ? (
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
                  {sections.map((section) => {
                    const SectionIcon = SECTION_ICONS[section.key];
                    const open = !collapsed.includes(section.key);
                    return (
                      <li key={section.key}>
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
                        {!open ? null : section.rows.length === 0 ? (
                          <p className="pcad-tree__hint">
                            {t(
                              section.key === 'solid'
                                ? 'featureTree.solidEmpty'
                                : 'featureTree.empty',
                            )}
                          </p>
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
        )}
      </div>

      {/*
        スケッチの行は削除だけの一覧(ソリッドと違い抑制も改名も持たない、P3 §0.a-0.23 ②)。
        ソリッドの行が壊れて(消えて)いる間は開かない(旧来の振る舞いのまま)。
      */}
      {menu === null || (menu.sectionKey === 'solid' && menuFeature === undefined) ? null : (
        <div
          ref={menuRef}
          className="pcad-menu__panel pcad-tree__menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
        >
          {menu.sectionKey === 'solid' && menuFeature !== undefined ? (
            <>
              <button
                type="button"
                role="menuitem"
                className="pcad-button pcad-menu__item"
                onClick={() => {
                  toggleSuppressed(menu.featureId);
                  setMenu(null);
                }}
              >
                {t(menuFeature.suppressed ? 'featureTree.unsuppress' : 'featureTree.suppress')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="pcad-button pcad-menu__item"
                onClick={() => {
                  setRenamingId(menu.featureId);
                  setMenu(null);
                }}
              >
                {t('featureTree.rename')}
              </button>
            </>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="pcad-button pcad-menu__item pcad-menu__item--danger"
            onClick={() => {
              removeRow(menu.featureId, menu.sectionKey);
              setMenu(null);
            }}
          >
            {t('featureTree.delete')}
          </button>
        </div>
      )}
    </section>
  );
}
