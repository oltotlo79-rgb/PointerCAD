/**
 * 左のモデルブラウザ(要件§7.1、FR-501)の表示(R07、レビュー F07 の責務の分離)。
 *
 * | 責務 | 置き場所 | 確定の時点 | 取消 |
 * |---|---|---|---|
 * | 表示(節・行・フォルダ・札・一覧の中身・名前の欄) | このファイル(描くだけ) | — | — |
 * | 入力の一時状態(一覧・名前の欄・ドラッグ・下書き・ホバー)と寿命 | `useFeatureTreeInput.ts` | — | Esc・外側の押下・文書の差し替え・破棄 |
 * | 窓の listener と、一時状態を結び付ける文書 | `featureTreeLifetime.ts` | 離した 1 回 | pointercancel・Esc・外した後の遅い callback |
 * | ストアの更新(選択・ホバー・編集の確定) | `featureTreeCommands.ts` | 各操作で 1 回 | — |
 *
 * 選択・編集の確定・ドラッグ・取消の4系列が、分ける前と同じ操作で同じ更新を同じ順に起こすことは
 * `FeatureTree.boundary.test.tsx` が分ける前の記録と照合する。
 */
import { useRevealNamedTreeRow } from './useRevealNamedTreeRow.js';
import { featureFolderAncestors } from '../history/featureFolderAncestors.js';
import { FeatureFolderTree } from '../history/FeatureFolderTree.js';
import { FeatureFolderDialog } from '../history/FeatureFolderDialog.js';
import { featureFolderMemberKey } from '@pointercad/model';
import { FeatureNoteDialog } from '../history/FeatureNoteDialog.js';
import { featureNoteOf, featureNoteTargetExists, type FeatureNoteTarget } from '@pointercad/model';
import { useState } from 'react';
import { DocumentNameSearch } from './DocumentNameSearch.js';
import { partNameSearchEntries } from './nameSearch.js';
import { nextHighlightIndex } from './menus/menuItem.js';
import { SheetBaseIcon, SheetFlangeIcon, SheetLineBendIcon, SheetReliefIcon } from './icons.js';

import {
  findReference,
  findSolid,
  type PartDocument,
  type ReferenceFeatureKind,
  type SolidLabelKey,
} from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import { featureIdOf, type SketchTreeKind } from '../sketch/featureSummary.js';
import { treeRowTakesOrigin } from '../sketch/originCommands.js';
import {
  buildReferenceSection,
  buildSketchGroups,
  buildTreeSections,
  type SketchTreeGroup,
  type TreeRow,
  type TreeSection,
  type TreeSectionKey,
} from '../solid/solidSummary.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  addNewSketch,
  moveTreeRow,
  noteTargetForRow,
  removeTreeRow,
  renameTreeRow,
  selectRowForMenu,
  selectSearchedRow,
  selectTreeRow,
  setTreeOrigin,
  switchSketch,
  toggleReferenceVisible,
  toggleSolidSuppressed,
  type RowMenuSection,
} from './featureTreeCommands.js';
import { useFeatureTreeInput } from './useFeatureTreeInput.js';
import {
  AlertIcon,
  ArcToolIcon,
  BoxIcon,
  ChamferIcon,
  ChevronRightIcon,
  CircularArrayToolIcon,
  CircularPatternIcon,
  ConeIcon,
  CoordinateSystemIcon,
  CopyToolIcon,
  CubeIcon,
  CutIcon,
  CylinderIcon,
  DraftIcon,
  EllipseToolIcon,
  EmbossIcon,
  EmptyBoxIcon,
  ExtrudeIcon,
  FaceToolIcon,
  FilletIcon,
  HoleIcon,
  ImportedMeshIcon,
  ImportedSolidIcon,
  IntersectIcon,
  LayersIcon,
  LineToolIcon,
  LinearArrayToolIcon,
  LinearPatternIcon,
  LoftIcon,
  MirrorSolidIcon,
  MirrorToolIcon,
  OffsetToolIcon,
  PlaneIcon,
  PlaneSectionIcon,
  PlotPointIcon,
  PointArrayToolIcon,
  PointPatternIcon,
  PolygonToolIcon,
  ProjectCurveIcon,
  RectangleToolIcon,
  ReferenceAxisIcon,
  ReferenceGroupIcon,
  ReferencePointIcon,
  RevolveIcon,
  RibIcon,
  RuledIcon,
  ScaleIcon,
  SewIcon,
  ShellIcon,
  SlotToolIcon,
  SphereIcon,
  SplineToolIcon,
  SpringIcon,
  SubtractIcon,
  SurfaceIcon,
  SweepIcon,
  ThreadHoleIcon,
  ThreadShaftIcon,
  TorusIcon,
  TransformIcon,
  UnionIcon,
  type IconProps,
} from './icons.js';
import { TimelineStopHandle } from './Timeline.js';
import {
  beginTimelineDrag,
  dropMarkerFor,
  timelineMoveOffer,
  type TimelineMoveOffer,
} from './timelineMove.js';
import {
  buildTimelineStops,
  consumedIdsUpToTimeline,
  isTimelineAtEnd,
  timelineStopsById,
  type TimelineStop,
} from './timelineRail.js';

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
  sheetBase: SheetBaseIcon,
  sheetFlange: SheetFlangeIcon,
  sheetBend: SheetLineBendIcon,
  sheetRelief: SheetReliefIcon,
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
  functionCurve: SplineToolIcon,
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
  // 基本形状5種(FR-429、P5 タスク15)。タスク51 が用意した道具の図柄へ差し替えた
  // (タスク52。木の行と「作る」の一覧のボタンが同じ絵になる)。
  sphere: SphereIcon,
  box: BoxIcon,
  cylinder: CylinderIcon,
  cone: ConeIcon,
  torus: TorusIcon,
  // 面をつなぐ(FR-430)とロフト(FR-410)。P5 タスク27 で専用の図柄を入れた
  // (直線で結ぶ / なめらかに結ぶの違いが絵でも分かる。`icons.tsx` の注釈)。
  ruled: RuledIcon,
  loft: LoftIcon,
  /*
    P5 の Should 群(§2.11、P5 タスク43)。タスク50・51 が道具の図柄を用意したので、
    タスク52 で借り物(`CubeIcon` ほか)から専用の図柄へ差し替えた。木の行と
    「作る」「加工」の一覧のボタンが同じ絵になり、作ったものと道具が結び付く。
  */
  mirror: MirrorSolidIcon,
  draft: DraftIcon,
  // 平らな面の移動(EX-18 の限られた一段)。面を押し出して足す / 削る操作なので、
  // 専用の図柄ができるまで押し出しの絵を借りる(木の名前は「面の移動」で見分けられる)。
  faceOffset: ExtrudeIcon,
  transform: TransformIcon,
  scale: ScaleIcon,
  sweep: SweepIcon,
  rib: RibIcon,
  emboss: EmbossIcon,
  threadShaft: ThreadShaftIcon,
  surface: SurfaceIcon,
  functionSurface: SurfaceIcon,
  // 点パターン(FR-425)。直線・円形パターンと同じ絵では見分けが付かない。
  pointPattern: PointPatternIcon,
  // くり抜き(FR-418、P5 タスク46)。タスク55 で道具と同じ図柄へ差し替えた。
  shell: ShellIcon,
  // 平面による切断(FR-432、P5 タスク27c)。タスク27f で道具と同じ図柄へ差し替えた。
  cut: CutIcon,
  surfaceCut: CutIcon,
  // 読み込んだ形のベースボディ 2 種(FR-802、P6 タスク20)。木の行がそのまま道具の絵になる。
  importedSolid: ImportedSolidIcon,
  importedMesh: ImportedMeshIcon,
};

/** 節の頭に出す絵。基準は軸と点、スケッチは作図面、ソリッドは立体の印。 */
const SECTION_ICONS: Readonly<Record<TreeSectionKey, (props: IconProps) => React.JSX.Element>> = {
  reference: ReferenceGroupIcon,
  sketch: PlaneIcon,
  solid: CubeIcon,
};

/**
 * 一覧の高さの見込み(画素)。下端からはみ出すときに上へ出すかを決めるのに使う。
 * いちばん項目が多いのは基準点の行で、表示の切替・1 つ上へ・1 つ下へ・原点にする・改名・
 * 設計メモ・フォルダ移動・削除の 8 つ。
 */
const ROW_MENU_HEIGHT = 256;
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
 * 「統合済み」の札を、つまみより前の段だけの消費関係に合わせ直す(P4b タスク22a-(3))。
 *
 * `buildTreeSections` の `consumed` は文書全体から導くため、途中まで戻しても後ろの段
 * (穴・パターン等)の消費がそのまま残って見える(表示上の既知差、`docs/報告記録.md`
 * 2026-09-05 実時計 01:05 の申し送り②)。ソリッド節の行だけ、`consumedIdsUpToTimeline`
 * (`timelineRail.ts`)で作り直した消費の表へ差し替える。
 */
function withTimelineConsumed(
  sections: readonly TreeSection[],
  part: PartDocument,
  timelineIndex: number | null,
): readonly TreeSection[] {
  const consumed = consumedIdsUpToTimeline(part, timelineIndex);
  return sections.map((section) =>
    section.key === 'solid'
      ? { ...section, rows: section.rows.map((row) => ({ ...row, consumed: consumed.has(row.id) })) }
      : section,
  );
}

/**
 * 左のモデルブラウザ(要件§7.1、FR-501)。
 *
 * 「部品 → スケッチ / ソリッドの 2 節 → その中身」の親子で、作った順(履歴の順)に並べる。
 * 行をクリックで選び、Shift+クリックで足す(FR-106)。指を乗せるとビューポート側も光る。
 * 計算できていない行には赤い印を出し、理由をホバーで見せる(FR-504)。
 *
 * どの行も「⋮」ボタンか右クリックで小さな一覧を開く(P3 §0.a-0.23 ②)。立体の行は
 * 抑制・改名・削除ができ(FR-503)、スケッチにも改名・メモ・フォルダ移動・削除がある。
 * 一覧も改名の欄も**モーダルにしない**(NFR-UX-2)ので、開いている間も視点操作は効く。
 * 削除の前に確認を出さないのは、元に戻す(Ctrl+Z)で戻せるため(NFR-UX-3)。参照していた
 * 立体を消しても止めず、後の段が赤い印になるだけにする(FR-504、NFR-RE-1)。
 *
 * 一覧・名前の欄・並べ替えのドラッグなど入力の一時状態と、その寿命は `useFeatureTreeInput`、
 * ストアの更新は `featureTreeCommands` が持つ。ここは描くことと、入力を両者へつなぐことだけ
 * (形の正本はストアの `document` だけ。rules/04-設計の規律.md)。
 */
export function FeatureTree(): React.JSX.Element {
  const searchReveal = useRevealNamedTreeRow();
  const part = useAppStore((state) => state.document);
  const documentVersion = useAppStore((state) => state.documentVersion);
  const input = useFeatureTreeInput(part, documentVersion);
  const { menu, renamingId, drag } = input;
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<ReadonlySet<string>>(() => new Set());
  const folders = part.featureFolders ?? [];
  const folderContext = () => ({ documentId: part.id, documentVersion, originalFolders: JSON.stringify(folders) });
  const owned = new Set(folders.flatMap(folder => folder.children.map(featureFolderMemberKey)));
  const ownedRow = (id: string, section: RowMenuSection, sketchId?: string) => owned.has(featureFolderMemberKey(noteTargetForRow(part, id, section, sketchId)));
  const selection = useAppStore((state) => state.selection);
  const hoveredElementId = useAppStore((state) => state.hoveredElementId);
  const sketchErrors = useAppStore((state) => state.sketchErrors);
  const partErrors = useAppStore((state) => state.partErrors);
  const resolvedReferences = useAppStore((state) => state.resolvedReferences);
  // タイムラインのつまみ(FR-507、FR-506、P4b タスク19)。区画は増やさず、履歴の行の
  // 左端をなぞる細いレールとして木の中に出す(§0.a-0.18 の利用者の決定は案 B)。
  const timelineIndex = useAppStore((state) => state.timelineIndex);
  // 順序の入れ替えを断った理由(FR-507、FR-504。タスク20)。壊れる側の行に印を出す。
  const timelineRefusal = useAppStore((state) => state.timelineRefusal);
  const [isExpanded, setIsExpanded] = useState(true);
  const [collapsed, setCollapsed] = useState<readonly TreeSectionKey[]>([]);
  const [collapsedSketchIds, setCollapsedSketchIds] = useState<readonly string[]>([]);

  // 基準の節(FR-328、FR-329、P4 タスク33)は「作業平面 → スケッチ → 立体」の順で
  // 使うものなので、いちばん上に置く。中身は履歴順のまま。
  const sections = [
    buildReferenceSection(part, resolvedReferences.errors),
    ...withTimelineConsumed(
      buildTreeSections(part, part.activeSketchId, sketchErrors, partErrors),
      part,
      timelineIndex,
    ),
  ];
  /*
   * スケッチが 2 本以上ある文書のときだけ、スケッチの節を「スケッチ1」「スケッチ2」…の
   * 親行で束ねる(P4 仕上げ (g)、FR-501)。1 本だけのときは親行を出さず、要素をそのまま
   * 節へ並べるこれまでの見え方を保つ(ふつうの部品は 1 本しか使わないので、階層を 1 段
   * 増やすだけの得が無い。NFR-UX-6「はじめの一歩を邪魔しない」)。
   */
  const sketchGroups = buildSketchGroups(part, sketchErrors);
  const grouped = sketchGroups.length > 1 || folders.some(folder => folder.children.some(child => child.kind === 'sketch'));
  /*
   * タイムラインの段(FR-507)。並びは model の `buildTimeline` が正本で、
   * 「基準(順)→ ソリッド(順)」の 1 本の通し。木の行の id はフィーチャーの id
   * (`buildReferenceSection` / `buildTreeSections`)なので、そのまま引ける。
   * スケッチの要素の行は帯に出ないので引けず、つまみも付かない。
   */
  const timelineStops = timelineStopsById(buildTimelineStops(part, timelineIndex));
  const timelineAtEnd = isTimelineAtEnd(part, timelineIndex);
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
  /*
   * 「⋮」の一覧に出す「1 つ上へ」「1 つ下へ」(FR-507、タスク20、NFR-UX-3)。
   * 帯に出る行(基準ジオメトリ・立体)にだけ出す。マウスのドラッグが苦手でも同じことが
   * できるようにするための入り口で、押せるかどうか・断りの理由はドラッグと同じ判定
   * (`timelineMoveOffer` → `canMoveHistoryItem`)から引く(同じ規約を 2 か所に書かない)。
   */
  const menuInTimeline =
    menu !== null && (menu.sectionKey === 'solid' || menu.sectionKey === 'reference');
  const menuMoveUp = menuInTimeline && menu !== null ? timelineMoveOffer(part, menu.featureId, -1) : null;
  const menuMoveDown = menuInTimeline && menu !== null ? timelineMoveOffer(part, menu.featureId, 1) : null;
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

  const selectedIds = new Set(selection.map((id) => featureIdOf(id)));
  const hoveredId = hoveredElementId === null ? null : featureIdOf(hoveredElementId);
  const chevronClassName = 'pcad-tree__chevron' + (isExpanded ? ' pcad-tree__chevron--open' : '');

  /** 名前の欄の確定(Enter・欄を離れる)。名前を変えて、欄を閉じる。 */
  const commitRename = (featureId: string, sectionKey: RowMenuSection, name: string): void => {
    renameTreeRow(featureId, sectionKey, name);
    input.stopRename();
  };

  /**
   * 「⋮」の一覧の「1 つ上へ」「1 つ下へ」1 項目ぶん(FR-507、タスク20)。
   *
   * 動かせないときは**押せなくして理由を吹き出しで読める**ようにする(NFR-UX-5)。
   * 押してから断る形にしないのは、ドラッグの予告(赤い線)と同じ考え方。
   */
  const renderMoveItem = (
    offer: TimelineMoveOffer | null,
    featureId: string,
    labelKey: MessageKey,
    tooltipKey: MessageKey,
    edgeKey: MessageKey,
  ): React.JSX.Element | null => {
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
          data-name-search-key={featureFolderMemberKey({ kind: 'sketch', id: group.sketchId })}
          onContextMenu={(event) => {
            event.preventDefault();
            input.menuTriggerRef.current = event.currentTarget.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
            input.openMenu({
              featureId: group.sketchId,
              name: group.name,
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
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitRename(group.sketchId, 'sketchDocument', event.currentTarget.value);
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  input.stopRename();
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
                  switchSketch(group.sketchId);
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
          {featureNoteOf(part, { kind: 'sketch', id: group.sketchId }) === '' ? null : <span className="pcad-tree__badge" title={t('historyNote.edit')}>{t('historyNote.badge')}</span>}
          <button
            type="button"
            className="pcad-tree__more"
            title={t('featureTree.menuTooltip')}
            aria-label={t('featureTree.menuTooltip')}
            aria-haspopup="menu"
            aria-expanded={menu !== null && menu.featureId === group.sketchId}
            onClick={(event) => {
              input.menuTriggerRef.current = event.currentTarget;
              const rect = event.currentTarget.getBoundingClientRect();
              input.openMenu({
                featureId: group.sketchId,
              name: group.name,
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
            {group.rows.filter(row => !ownedRow(row.id, 'sketch', group.sketchId)).map((row) => renderRow(row, 'sketch', group.sketchId))}
          </ul>
        )}
      </li>
    );
  };

  const renderRow = (
    row: TreeRow,
    sectionKey: TreeSectionKey,
    sketchId?: string,
  ): React.JSX.Element => {
    const KindIcon = KIND_ICONS[row.kind];
    const selected = selectedIds.has(row.id) && (sectionKey !== 'sketch' || (sketchId ?? part.activeSketchId) === part.activeSketchId);
    /*
     * タイムラインのつまみが付く行か(FR-507)。付くのは帯に出る行、つまり基準
     * ジオメトリと立体の行だけ。つまみより後ろの行は「いまは形になっていない」ので
     * 薄く出す(抑制とは別の薄さ。抑制は保存されるが、つまみの位置は保存されない)。
     */
    const stop: TimelineStop | undefined = timelineStops.get(row.id);
    const ahead = stop !== undefined && stop.state === 'ahead';
    /*
     * 順序を入れ替えるドラッグの予告(FR-507、タスク20、NFR-UX-5)。
     * 落ちる場所に線を引き、落とせない位置では赤くする。離してから断るのではなく、
     * 離す前に見て分かるようにするため。
     */
    const marker = stop === undefined ? null : dropMarkerFor(drag, stop.entry.index);
    const dragging = drag !== null && drag.moved && drag.featureId === row.id;
    // 断りの向け先は「壊れる側」の行(model の `blockingFeatureId`)。
    const refused = timelineRefusal !== null && timelineRefusal.blockingFeatureId === row.id;
    const rowClassName =
      'pcad-tree__row pcad-tree__row--child' +
      (stop === undefined ? '' : ' pcad-tree__row--timeline') +
      (selected ? ' pcad-tree__row--selected' : '') +
      (hoveredId === row.id ? ' pcad-tree__row--hovered' : '') +
      (ahead ? ' pcad-tree__row--ahead' : '') +
      (dragging ? ' pcad-tree__row--dragging' : '') +
      (marker === null ? '' : ` pcad-tree__row--drop-${marker}`) +
      (marker !== null && drag !== null && drag.refusal !== null
        ? ' pcad-tree__row--drop-refused'
        : '') +
      // 画面に出していない基準(FR-329)は、抑制中の立体と同じ薄さで出して見分ける。
      (row.suppressed || row.hidden ? ' pcad-tree__row--suppressed' : '');
    return (
      <li key={row.id}>
        <div
          className={rowClassName}
          // 落とし先は指の下の行から引く(`dropIndexAtPoint`)。帯に出る行だけが持つ。
          data-name-search-key={featureFolderMemberKey(noteTargetForRow(part, row.id, sectionKey, sketchId))}
          data-timeline-index={stop === undefined ? undefined : stop.entry.index}
          title={stop === undefined ? undefined : t('timeline.dragTooltip')}
          onPointerDown={(event) => {
            /*
             * 掴む(FR-507、タスク20)。帯に出る行だけが掴める。左ボタン以外・つまみ・
             * 「⋮」・名前の欄の上では掴まない(それぞれ別の役目を持つため)。
             * この時点ではまだ「押しただけ」で、`DRAG_THRESHOLD_PX` を超えて動いて
             * 初めて並べ替えになる(押しただけなら今までどおり行の選択)。
             */
            input.resetDragClick();
            if (stop === undefined || event.button !== 0 || event.shiftKey || event.ctrlKey || renamingId === row.id) {
              return;
            }
            if (
              event.target instanceof Element &&
              event.target.closest('.pcad-timeline__stop, .pcad-tree__more') !== null
            ) {
              return;
            }
            const started = beginTimelineDrag(part, row.id);
            if (started === null) {
              return;
            }
            input.beginDrag(started, event.clientX, event.clientY);
          }}
          onPointerEnter={() => {
            input.hoverRow(row.id);
          }}
          onPointerLeave={() => {
            input.leaveRow(row.id);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            input.menuTriggerRef.current = event.currentTarget.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
            selectRowForMenu(row.id, sketchId);
            input.openMenu({
              featureId: row.id,
              name: row.name,
              sketchId,
              sectionKey,
              x: menuRight(event.clientX),
              y: menuTop(event.clientY, event.clientY),
            });
          }}
        >
          {/*
            行の左端のつまみ(FR-507、FR-506)。行の高さも字下げも変えないよう、行の
            余白の上へ重ねて置く(過去の失敗: docs/報告記録.md 2026-09-04 20:30 で
            画面へ足したものが区画を 1 段分押し広げた)。
          */}
          {stop === undefined ? null : <TimelineStopHandle stop={stop} atEnd={timelineAtEnd} />}
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
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitRename(row.id, sectionKey, event.currentTarget.value);
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  input.stopRename();
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
                // 並べ替えのために掴んで動かした後にも `click` は飛んでくる。その 1 回だけは
                // 選択にしない(掴んで動かしたのに選択が入れ替わると読み取れないため)。
                if (input.consumeDragClick()) {
                  return;
                }
                selectTreeRow(row.id, sketchId, event.shiftKey || event.ctrlKey);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Delete') {
                  return;
                }
                // 参照していたものが壊れても消させる。理由は帯と赤い印で伝える(FR-504)。
                event.preventDefault();
                removeTreeRow(row.id, sectionKey);
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
            並べ替えを断った理由(FR-507、FR-504。タスク20)。出す先は動かした行ではなく
            **壊れる側の行**(model の `blockingFeatureId`)。「どれが困るのか」がその場で
            分かるようにするため。同じ文はステータスバーの帯にも 1 行で出る。
          */}
          {!refused || timelineRefusal === null ? null : (
            <span
              className="pcad-tree__alert"
              title={`${timelineRefusal.message} ${t('timeline.refusalTooltip')}`}
            >
              <AlertIcon size={12} />
            </span>
          )}
          {/*
            スケッチ・ソリッドどちらの行も同じ「⋮」の非モーダル一覧を開く(P3 §0.a-0.23 ②)。
            一覧の中身(抑制・改名の有無)は sectionKey で決める。
          */}
          {featureNoteOf(part, noteTargetForRow(part, row.id, sectionKey, sketchId)) === '' ? null : <span className="pcad-tree__badge" title={t('historyNote.edit')}>{t('historyNote.badge')}</span>}
          <button
            type="button"
            className="pcad-tree__more"
            title={t('featureTree.menuTooltip')}
            aria-label={t('featureTree.menuTooltip')}
            aria-haspopup="menu"
            aria-expanded={menu !== null && menu.featureId === row.id}
            onClick={(event) => {
              input.menuTriggerRef.current = event.currentTarget;
              const rect = event.currentTarget.getBoundingClientRect();
              input.openMenu({
                featureId: row.id,
                name: row.name,
                sketchId,
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

  const renderFolderMember = (member: FeatureNoteTarget): React.JSX.Element => {
    if (member.kind === 'sketch') {
      const group = sketchGroups.find(item => item.sketchId === member.id);
      if (group !== undefined) return renderSketchGroup(group);
    } else if (member.kind === 'sketch-feature') {
      const group = sketchGroups.find(item => item.sketchId === member.sketchId);
      const row = group?.rows.find(item => item.id === member.id);
      if (row !== undefined) return renderRow(row, 'sketch', member.sketchId);
    } else {
      const row = sections.find(section => section.key === member.kind)?.rows.find(item => item.id === member.id);
      if (row !== undefined) return renderRow(row, member.kind);
    }
    return <li className="pcad-tree__hint">{t('historyFolder.missing').replace('{name}', member.id)}</li>;
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
        {rowCount === 0 && folders.length === 0 ? (
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
                  {folders.length === 0 ? null : <FeatureFolderTree key={part.id} folders={folders} collapsed={collapsedFolderIds} renderMember={renderFolderMember}
                    onToggle={id => setCollapsedFolderIds(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; })}
                    onEdit={folder => input.setFolderDraft({ ...folderContext(), mode: 'edit', folderId: folder.id })} />}
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
                          // スケッチが 2 本以上ある文書だけ、親行で束ねて出す(P4 仕上げ (g))。
                          <ul className="pcad-tree__children">
                            {sketchGroups.filter(group => !ownedRow(group.sketchId, 'sketchDocument')).map((group) => renderSketchGroup(group))}
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
                            {section.rows.filter(row => !ownedRow(row.id, section.key)).map((row) =>
                              renderRow(row, section.key, section.key === 'sketch' ? part.activeSketchId : undefined))}
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
          ref={input.menuRef}
          className="pcad-menu__panel pcad-tree__menu"
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onKeyDown={(event) => {
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
          }}
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
          {/*
            作る順序を 1 段ずつ入れ替える(FR-507、タスク20)。帯に出る行にだけ出す。
            ドラッグと同じことができる入り口で、マウスの操作が苦手でも使える(NFR-UX-3)。
          */}
          {renderMoveItem(
            menuMoveUp,
            menu.featureId,
            'timeline.moveUp',
            'timeline.moveUpTooltip',
            'timeline.moveAtTop',
          )}
          {renderMoveItem(
            menuMoveDown,
            menu.featureId,
            'timeline.moveDown',
            'timeline.moveDownTooltip',
            'timeline.moveAtBottom',
          )}
          {/* スケッチの親行からも新しいスケッチを作れる(節の頭の「＋」と同じ、仕上げ (g))。 */}
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
            理由を吹き出しで読めるようにする(仕上げ (g)、FR-503、NFR-UX-5)。
            それ以外の行では `sketchDeleteBlockedKey` は必ず null なので従来どおり押せる。
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
      )}
      {input.folderDraft !== null && input.folderDraft.documentId === part.id && input.folderDraft.documentVersion === documentVersion
        ? <FeatureFolderDialog draft={input.folderDraft} onClose={() => input.setFolderDraft(null)} /> : null}
      {input.noteDraft !== null && input.noteDraft.documentId === part.id && input.noteDraft.documentVersion === documentVersion
        && featureNoteTargetExists(part, input.noteDraft.target) ? <FeatureNoteDialog draft={input.noteDraft} onClose={() => input.setNoteDraft(null)} /> : null}
    </section>
  );
}
