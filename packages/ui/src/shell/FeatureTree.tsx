import { useEffect, useRef, useState } from 'react';

import {
  addSketch,
  createSketchFor,
  findFeature,
  findReference,
  findSketch,
  findSolid,
  removeReference,
  removeSketch,
  removeSolid,
  replaceReference,
  replaceSketch,
  replaceSolid,
  setActiveSketch,
  type ReferenceFeatureKind,
  type SolidLabelKey,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import { featureIdOf, renameFeature, type SketchTreeKind } from '../sketch/featureSummary.js';
import { originChangeFor, treeRowTakesOrigin } from '../sketch/originCommands.js';
import {
  buildReferenceSection,
  buildSketchGroups,
  buildTreeSections,
  renameReference,
  renameSketch,
  renameSolid,
  setReferenceVisible,
  setSolidSuppressed,
  type SketchTreeGroup,
  type TreeRow,
  type TreeSectionKey,
} from '../solid/solidSummary.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  AlertIcon,
  ArcToolIcon,
  ChamferIcon,
  ChevronRightIcon,
  CircularArrayToolIcon,
  CircularPatternIcon,
  CoordinateSystemIcon,
  CopyToolIcon,
  CubeIcon,
  EllipseToolIcon,
  EmptyBoxIcon,
  ExtrudeIcon,
  FaceToolIcon,
  FilletIcon,
  HoleIcon,
  IntersectIcon,
  LayersIcon,
  LinearArrayToolIcon,
  LinearPatternIcon,
  LineToolIcon,
  MirrorToolIcon,
  OffsetToolIcon,
  PlaneIcon,
  PlaneSectionIcon,
  PlotPointIcon,
  PointArrayToolIcon,
  PolygonToolIcon,
  ProjectCurveIcon,
  RectangleToolIcon,
  ReferenceAxisIcon,
  ReferenceGroupIcon,
  ReferencePointIcon,
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
 * P4 タスク33 で、タスク32 が用意した図柄(オフセット・ミラー・複写・配列)へ借り物を
 * 差し替え、複製を配置ごとに分け、基準ジオメトリ 4 種と投影・交差の図柄を足した。
 */
const KIND_ICONS: Readonly<
  Record<
    SketchTreeKind | SolidLabelKey | ReferenceFeatureKind,
    (props: IconProps) => React.JSX.Element
  >
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
  offset: OffsetToolIcon,
  // 複製(FR-324)は配置ごとに絵を変える。どの複製かが木の絵だけで分かるようにするため。
  // `copy` そのものは配置の分からない総称なので、いちばん素直な「複写」の絵にする。
  copy: CopyToolIcon,
  copyMirror: MirrorToolIcon,
  copyTranslate: CopyToolIcon,
  copyLinearArray: LinearArrayToolIcon,
  copyCircularArray: CircularArrayToolIcon,
  projectedCurve: ProjectCurveIcon,
  planeSection: PlaneSectionIcon,
  referencePlane: PlaneIcon,
  referenceAxis: ReferenceAxisIcon,
  referencePoint: ReferencePointIcon,
  referenceCoordinateSystem: CoordinateSystemIcon,
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

/** 節の頭に出す絵。基準は軸と点、スケッチは作図面、ソリッドは立体の印。 */
const SECTION_ICONS: Readonly<Record<TreeSectionKey, (props: IconProps) => React.JSX.Element>> = {
  reference: ReferenceGroupIcon,
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
  /**
   * どちらの節の行から開いたか。ソリッドだけ抑制・改名を持つ(P3 §0.a-0.23 ②)。
   * `sketchDocument` はスケッチそのものの親行(P4 仕上げ (g))で、改名と削除を持つ。
   */
  readonly sectionKey: RowMenuSection;
  readonly x: number;
  readonly y: number;
}

/**
 * 一覧を開ける行の種類。節のキー 3 つに、スケッチそのものの親行(P4 仕上げ (g))を足す。
 * 親行は節ではないので `TreeSectionKey` には入れない(節の並びを作る関数の戻りが変わるため)。
 */
type RowMenuSection = TreeSectionKey | 'sketchDocument';

/**
 * 一覧の高さの見込み(画素)。下端からはみ出すときに上へ出すかを決めるのに使う。
 * いちばん項目が多いのは基準点の行(表示の切替・原点にする・改名・削除の 4 つ、P4 タスク35b)。
 */
const ROW_MENU_HEIGHT = 128;
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
  const resolvedReferences = useAppStore((state) => state.resolvedReferences);
  const [isExpanded, setIsExpanded] = useState(true);
  const [collapsed, setCollapsed] = useState<readonly TreeSectionKey[]>([]);
  const [collapsedSketchIds, setCollapsedSketchIds] = useState<readonly string[]>([]);
  const [menu, setMenu] = useState<RowMenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 基準の節(FR-328、FR-329、P4 タスク33)は「作業平面 → スケッチ → 立体」の順で
  // 使うものなので、いちばん上に置く。中身は履歴順のまま。
  const sections = [
    buildReferenceSection(part, resolvedReferences.errors),
    ...buildTreeSections(part, part.activeSketchId, sketchErrors, partErrors),
  ];
  /*
   * スケッチが 2 本以上ある文書のときだけ、スケッチの節を「スケッチ1」「スケッチ2」…の
   * 親行で束ねる(P4 仕上げ (g)、FR-501)。1 本だけのときは親行を出さず、要素をそのまま
   * 節へ並べるこれまでの見え方を保つ(ふつうの部品は 1 本しか使わないので、階層を 1 段
   * 増やすだけの得が無い。NFR-UX-6「はじめの一歩を邪魔しない」)。
   */
  const sketchGroups = buildSketchGroups(part, sketchErrors);
  const grouped = sketchGroups.length > 1;
  // 束ねているときは親行も数に入れる。要素が 1 つも無くても親行は出るので、
  // それだけで「まだ何もありません」の空状態には落とさない。
  const groupedRowCount = sketchGroups.reduce((total, group) => total + group.rows.length + 1, 0);
  const rowCount = sections.reduce(
    (total, section) =>
      total + (grouped && section.key === 'sketch' ? groupedRowCount : section.rows.length),
    0,
  );
  // 抑制はソリッドの行だけが持つ(P3 §0.a-0.23 ②)。
  const menuFeature =
    menu === null || menu.sectionKey !== 'solid' ? undefined : findSolid(part, menu.featureId);
  // 表示・非表示は基準ジオメトリの行だけが持つ(FR-329)。
  const menuReference =
    menu === null || menu.sectionKey !== 'reference'
      ? undefined
      : findReference(part, menu.featureId);
  // スケッチそのものの親行(P4 仕上げ (g))。改名・削除・スケッチの追加を持つ。
  const menuSketchGroup =
    menu === null || menu.sectionKey !== 'sketchDocument'
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
  // 「ここを原点にする」(FR-331)を出せる行かどうかは行の種類だけで決まる(タスク35b)。
  const menuRow =
    menu === null
      ? null
      : (sections
          .find((section) => section.key === menu.sectionKey)
          ?.rows.find((row) => row.id === menu.featureId) ?? null);
  // 節の中身の行だけが対象(スケッチそのものの親行などは点ではない)。ここで型も絞る。
  const canSetOrigin =
    menu !== null &&
    menuRow !== null &&
    (menu.sectionKey === 'sketch' || menu.sectionKey === 'reference') &&
    treeRowTakesOrigin(menu.sectionKey, menuRow);

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

  /**
   * 新しいスケッチを 1 本作り、そこへ作図を切り替える(P4 仕上げ (g)、FR-501)。
   *
   * 投影・断面(FR-325)は「そのスケッチを使う立体より前の立体」しかもとにできないので、
   * 押し出しに使ったスケッチとは別のスケッチが要る。その入口がこれ。
   * 文書は 1 回だけ積むので、取り消し(Ctrl+Z)1 回で元へ戻る(NFR-UX-3)。
   * 作図面はいまのまま(まだ何も置いていないスケッチには面が決まらない)。別の面へ描くには
   * これまでどおりツールバーの作図面を選び直す。
   */
  const addNewSketch = (): void => {
    const store = useAppStore.getState();
    const sketch = createSketchFor(store.document);
    store.applyDocument(setActiveSketch(addSketch(store.document, sketch), sketch.id));
  };

  const removeRow = (featureId: string, sectionKey: RowMenuSection): void => {
    const store = useAppStore.getState();
    if (sectionKey === 'sketchDocument') {
      // 最後の 1 本は model 側(`removeSketch`)が断る。要素を立体が使っているスケッチは
      // 一覧の「削除」を押せなくしてある(`sketchDeleteBlockedKey`)。
      store.applyDocument(removeSketch(store.document, featureId));
      return;
    }
    if (sectionKey === 'sketch') {
      store.removeSketchFeature(featureId);
      return;
    }
    if (sectionKey === 'reference') {
      // 参照していた作業平面や軸が消えても止めず、後の段が赤い印になるだけにする
      // (FR-504、NFR-RE-1。立体の行と同じ扱い)。
      store.applyDocument(removeReference(store.document, featureId));
      return;
    }
    store.applyDocument(removeSolid(store.document, featureId));
  };

  /** 名前を変える(FR-503)。どの節の行でも、スケッチそのものの親行でも変えられる。 */
  const commitRename = (featureId: string, sectionKey: RowMenuSection, name: string): void => {
    const store = useAppStore.getState();
    if (sectionKey === 'sketchDocument') {
      const sketch = findSketch(store.document, featureId);
      if (sketch !== undefined) {
        const next = renameSketch(sketch, name);
        if (next !== sketch) {
          store.applyDocument(replaceSketch(store.document, next));
        }
      }
      setRenamingId(null);
      return;
    }
    if (sectionKey === 'sketch') {
      const feature = findFeature(store.sketch, featureId);
      if (feature !== undefined) {
        const next = renameFeature(feature, name);
        if (next !== feature) {
          store.replaceSketchFeature(featureId, next);
        }
      }
      setRenamingId(null);
      return;
    }
    if (sectionKey === 'reference') {
      const feature = findReference(store.document, featureId);
      if (feature !== undefined) {
        const next = renameReference(feature, name);
        if (next !== feature) {
          store.applyDocument(replaceReference(store.document, featureId, next));
        }
      }
      setRenamingId(null);
      return;
    }
    const feature = findSolid(store.document, featureId);
    if (feature !== undefined) {
      const next = renameSolid(feature, name);
      if (next !== feature) {
        store.applyDocument(replaceSolid(store.document, featureId, next));
      }
    }
    setRenamingId(null);
  };

  /** 基準ジオメトリを画面に出す・隠す(FR-329)。参照はどちらでもできる。 */
  const toggleReferenceVisible = (featureId: string): void => {
    const store = useAppStore.getState();
    const feature = findReference(store.document, featureId);
    if (feature === undefined) {
      return;
    }
    store.applyDocument(
      replaceReference(store.document, featureId, setReferenceVisible(feature, !feature.visible)),
    );
  };

  /**
   * 選んだ点を原点にする(FR-331、タスク35b)。座標の式を書き換えるだけで履歴に段は
   * 増えないので、文書を 1 回積めば Undo 1 回で戻る(利用者の決定 2026-09-04)。
   * 動かした量は帯に一言で出す。位置が計算できていない点は断って何も変えない(FR-504)。
   */
  const setOrigin = (featureId: string): void => {
    const store = useAppStore.getState();
    const change = originChangeFor(store, featureId);
    if (change === null) {
      store.setEditError('originCommand.failed');
      return;
    }
    store.applyDocument(change.document);
    store.setOriginNotice(change.notice);
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

  /**
   * スケッチ 1 本の親行と、その下にぶら下がる要素の行(P4 仕上げ (g)、FR-501)。
   * スケッチが 2 本以上あるときだけ出す。
   *
   * 押すと**作図するスケッチが切り替わり**(作図面の札とビューポートの作図面も追従する。
   * 追従の中身はストアの `setActiveSketch`)、いま作図しているスケッチをもう一度押すと
   * 中身の開閉になる。開閉だけの別のボタンを置かないのは、行の中に押せるものが増えるほど
   * 「どこを押せば切り替わるのか」が読み取りにくくなるため(NFR-UX-1)。
   */
  const renderSketchGroup = (group: SketchTreeGroup): React.JSX.Element => {
    const open = !collapsedSketchIds.includes(group.sketchId);
    const rowClassName =
      'pcad-tree__row pcad-tree__row--child pcad-tree__row--sketch' +
      (group.active ? ' pcad-tree__row--selected' : '');
    return (
      <li key={group.sketchId}>
        <div
          className={rowClassName}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({
              featureId: group.sketchId,
              sectionKey: 'sketchDocument',
              x: menuRight(event.clientX),
              y: menuTop(event.clientY, event.clientY),
            });
          }}
        >
          {renamingId === group.sketchId ? (
            <input
              className="pcad-tree__rename"
              type="text"
              autoComplete="off"
              spellCheck={false}
              defaultValue={group.name}
              aria-label={t('featureTree.renameLabel')}
              title={t('featureTree.renameTooltip')}
              autoFocus
              onFocus={(event) => {
                event.currentTarget.select();
              }}
              onBlur={(event) => {
                commitRename(group.sketchId, 'sketchDocument', event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitRename(group.sketchId, 'sketchDocument', event.currentTarget.value);
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
              className="pcad-tree__select pcad-tree__select--sketch"
              aria-pressed={group.active}
              aria-expanded={open}
              title={t('featureTree.switchSketch')}
              onClick={() => {
                if (!group.active) {
                  useAppStore.getState().setActiveSketch(group.sketchId);
                  setCollapsedSketchIds((ids) => ids.filter((id) => id !== group.sketchId));
                  return;
                }
                setCollapsedSketchIds((ids) =>
                  ids.includes(group.sketchId)
                    ? ids.filter((id) => id !== group.sketchId)
                    : [...ids, group.sketchId],
                );
              }}
            >
              <ChevronRightIcon
                size={12}
                className={'pcad-tree__chevron' + (open ? ' pcad-tree__chevron--open' : '')}
              />
              <PlaneIcon size={14} className="pcad-tree__icon" />
              <span className="pcad-tree__label">{group.name}</span>
            </button>
          )}
          {group.active ? (
            <span className="pcad-tree__badge">{t('featureTree.sketchActive')}</span>
          ) : null}
          <span className="pcad-tree__count">{group.rows.length}</span>
          <button
            type="button"
            className="pcad-tree__more"
            title={t('featureTree.menuTooltip')}
            aria-label={t('featureTree.menuTooltip')}
            aria-haspopup="menu"
            aria-expanded={menu !== null && menu.featureId === group.sketchId}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({
                featureId: group.sketchId,
                sectionKey: 'sketchDocument',
                x: menuRight(rect.right),
                y: menuTop(rect.bottom, rect.top),
              });
            }}
          >
            {t('featureTree.menuMark')}
          </button>
        </div>
        {!open ? null : group.rows.length === 0 ? (
          <p className="pcad-tree__hint pcad-tree__hint--nested">{t('featureTree.sketchEmpty')}</p>
        ) : (
          <ul className="pcad-tree__children pcad-tree__children--nested">
            {group.rows.map((row) => renderRow(row, 'sketch'))}
          </ul>
        )}
      </li>
    );
  };

  const renderRow = (row: TreeRow, sectionKey: TreeSectionKey): React.JSX.Element => {
    const KindIcon = KIND_ICONS[row.kind];
    const selected = selectedIds.has(row.id);
    const rowClassName =
      'pcad-tree__row pcad-tree__row--child' +
      (selected ? ' pcad-tree__row--selected' : '') +
      (hoveredId === row.id ? ' pcad-tree__row--hovered' : '') +
      // 画面に出していない基準(FR-329)は、抑制中の立体と同じ薄さで出して見分ける。
      (row.suppressed || row.hidden ? ' pcad-tree__row--suppressed' : '');
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
                commitRename(row.id, sectionKey, event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitRename(row.id, sectionKey, event.currentTarget.value);
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
          {/*
            平面や軸を決めるためだけに置かれた基準点(`visible: false`)は「補助」の札で示す。
            行そのものは消さない。消すと名前を変える・出し直す・消す(FR-503)ができなくなる。
          */}
          {row.hidden ? (
            <span className="pcad-tree__badge" title={t('featureTree.hiddenTooltip')}>
              {t('featureTree.hidden')}
            </span>
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
                        {/*
                          節の見出し。スケッチの節にだけ「＋」(スケッチを追加)を並べる
                          (P4 仕上げ (g))。入れ子のボタンは作れないので、見出しの
                          折りたたみボタンと「＋」を器の div へ横に並べる。
                        */}
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
                          // スケッチが 2 本以上ある文書だけ、親行で束ねて出す(P4 仕上げ (g))。
                          <ul className="pcad-tree__children">
                            {sketchGroups.map((group) => renderSketchGroup(group))}
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
        一覧の中身は節で決める(P3 §0.a-0.23 ②、P4 タスク33)。
        - ソリッド: 抑制・改名・削除
        - 基準ジオメトリ: 表示の切替・改名・削除(FR-329、FR-503)
        - スケッチの要素: 改名・削除
        - スケッチそのもの(親行、P4 仕上げ (g)): スケッチを追加・改名・削除
        参照先が壊れて(消えて)いる間は開かない(旧来の振る舞いのまま)。
      */}
      {menu === null ||
      (menu.sectionKey === 'solid' && menuFeature === undefined) ||
      (menu.sectionKey === 'reference' && menuReference === undefined) ||
      (menu.sectionKey === 'sketchDocument' && menuSketchGroup === undefined) ? null : (
        <div
          ref={menuRef}
          className="pcad-menu__panel pcad-tree__menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
        >
          {menu.sectionKey === 'solid' && menuFeature !== undefined ? (
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
          ) : null}
          {menu.sectionKey === 'reference' && menuReference !== undefined ? (
            <button
              type="button"
              role="menuitem"
              className="pcad-button pcad-menu__item"
              onClick={() => {
                toggleReferenceVisible(menu.featureId);
                setMenu(null);
              }}
            >
              {t(menuReference.visible ? 'featureTree.hide' : 'featureTree.show')}
            </button>
          ) : null}
          {/* スケッチの親行からも新しいスケッチを作れる(節の頭の「＋」と同じ、仕上げ (g))。 */}
          {menu.sectionKey === 'sketchDocument' ? (
            <button
              type="button"
              role="menuitem"
              className="pcad-button pcad-menu__item"
              title={t('featureTree.addSketchTooltip')}
              onClick={() => {
                addNewSketch();
                setMenu(null);
              }}
            >
              {t('featureTree.addSketch')}
            </button>
          ) : null}
          {/*
            選んだ点を原点にする(FR-331、タスク35b)。スケッチの点と基準点の行にだけ出す。
            ツールバーには道具を増やさない決まりなので、入り口はこの一覧とプロパティの 2 つ。
          */}
          {canSetOrigin ? (
            <button
              type="button"
              role="menuitem"
              className="pcad-button pcad-menu__item"
              title={t('originCommand.tooltip')}
              onClick={() => {
                setOrigin(menu.featureId);
                setMenu(null);
              }}
            >
              {t('originCommand.action')}
            </button>
          ) : null}
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
          {/*
            消せないスケッチ(最後の 1 本、要素を立体が使っているもの)は押せなくし、
            理由を吹き出しで読めるようにする(仕上げ (g)、FR-503、NFR-UX-5)。
            それ以外の行では `sketchDeleteBlockedKey` は必ず null なので従来どおり押せる。
          */}
          <button
            type="button"
            role="menuitem"
            className="pcad-button pcad-menu__item pcad-menu__item--danger"
            disabled={sketchDeleteBlockedKey !== null}
            title={sketchDeleteBlockedKey === null ? undefined : t(sketchDeleteBlockedKey)}
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
