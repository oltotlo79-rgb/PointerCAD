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
  type PartDocument,
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
  type TreeSection,
  type TreeSectionKey,
} from '../solid/solidSummary.js';
import { useAppStore } from '../store/useAppStore.js';
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
  parseDropIndex,
  timelineMoveOffer,
  withDropTarget,
  type TimelineDrag,
  type TimelineMoveOffer,
} from './timelineMove.js';
import {
  buildTimelineStops,
  consumedIdsUpToTimeline,
  historySize,
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
  transform: TransformIcon,
  scale: ScaleIcon,
  sweep: SweepIcon,
  rib: RibIcon,
  emboss: EmbossIcon,
  threadShaft: ThreadShaftIcon,
  surface: SurfaceIcon,
  // 点パターン(FR-425)。直線・円形パターンと同じ絵では見分けが付かない。
  pointPattern: PointPatternIcon,
  // くり抜き(FR-418、P5 タスク46)。タスク55 で道具と同じ図柄へ差し替えた。
  shell: ShellIcon,
  // 平面による切断(FR-432、P5 タスク27c)。タスク27f で道具と同じ図柄へ差し替えた。
  cut: CutIcon,
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
 * いちばん項目が多いのは基準点の行で、表示の切替・1 つ上へ・1 つ下へ・原点にする・改名・
 * 削除の 6 つ(P4b タスク20 で並べ替えの 2 つが増えた)。
 */
const ROW_MENU_HEIGHT = 192;
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
 * ここまで動いたら「掴んで動かしている」とみなす距離(画素)。
 * これ未満の動きは押し間違いの震えとみなし、これまでどおり行の選択にする。
 * 26px の行を 1 つ跨ぐより十分に小さく、指の震えより大きい値として 4 を採る。
 */
const DRAG_THRESHOLD_PX = 4;

/** 行に付けた通し番号の印。落とし先を画面の座標から引くのに使う。 */
const TIMELINE_INDEX_ATTRIBUTE = 'data-timeline-index';

/**
 * その画面座標の下にある行の、帯の通し番号。行の上に無ければ null。
 * ドラッグ中は指の下の行が変わり続けるので、行ごとの `onPointerEnter` ではなく
 * 画面の座標から引く(押している間は入る・出るの知らせが届かないことがあるため)。
 */
function dropIndexAtPoint(x: number, y: number, total: number): number | null {
  const found = window.document.elementFromPoint(x, y);
  const row = found === null ? null : found.closest(`[${TIMELINE_INDEX_ATTRIBUTE}]`);
  return parseDropIndex(row?.getAttribute(TIMELINE_INDEX_ATTRIBUTE), total);
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
  // タイムラインのつまみ(FR-507、FR-506、P4b タスク19)。区画は増やさず、履歴の行の
  // 左端をなぞる細いレールとして木の中に出す(§0.a-0.18 の利用者の決定は案 B)。
  const timelineIndex = useAppStore((state) => state.timelineIndex);
  // 順序の入れ替えを断った理由(FR-507、FR-504。タスク20)。壊れる側の行に印を出す。
  const timelineRefusal = useAppStore((state) => state.timelineRefusal);
  const [isExpanded, setIsExpanded] = useState(true);
  const [collapsed, setCollapsed] = useState<readonly TreeSectionKey[]>([]);
  const [collapsedSketchIds, setCollapsedSketchIds] = useState<readonly string[]>([]);
  const [menu, setMenu] = useState<RowMenuState | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /*
   * 順序を入れ替えるドラッグ(FR-507、タスク20)。掴んでいるものと落とし先、そこへ
   * 落とせるかどうかを持つ。見た目だけの一時状態なのでコンポーネントに持つ
   * (rules/04-設計の規律.md。一覧・改名中と同じ扱い)。形の正本はストアの `document` だけ。
   *
   * 依存(HTML5 のドラッグ&ドロップ)は使わず、pointer の押す・動く・離すで自前に組む。
   * ①落とせない位置を**離す前**に赤い線で予告できる(NFR-UX-5)、②行の中に押せるもの
   * (つまみ・「⋮」)があっても掴む場所を選り分けられる、③ペンや指でも同じに動く、
   * の 3 つが要るため。ライブラリは足さない(rules/02-禁止事項.md)。
   */
  const [drag, setDrag] = useState<TimelineDrag | null>(null);
  /** 掴んだ場所(画面座標)。ここから離れて初めて「動かした」とみなす。 */
  const dragOriginRef = useRef<{ readonly x: number; readonly y: number } | null>(null);
  /**
   * 直前の押し下げがドラッグだったか。ドラッグの後には `click` も飛んでくるので、
   * 行の選択が起きないようにここで見分ける(過去の失敗: docs/報告記録.md 2026-09-04 11:10
   * の (a) と同じ「確定と選択の順序」の話)。
   */
  const draggedRef = useRef(false);

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
  const grouped = sketchGroups.length > 1;
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

  /*
   * 順序を入れ替えるドラッグの見張り(FR-507、タスク20)。掴んでいる間だけ窓に付ける。
   *
   * 落とせるかどうかは `canMoveHistoryItem`(文書を作らない)で毎回引き直すので、
   * 指を動かすたびに呼んでも形の計算は 1 回も起きない。離した瞬間にだけ
   * `moveTimelineItem`(= `moveHistoryItem`)で文書を 1 回積む(NFR-UX-3、NFR-UX-5)。
   */
  useEffect(() => {
    if (drag === null) {
      return undefined;
    }
    const total = historySize(part);
    const onPointerMove = (event: PointerEvent): void => {
      const origin = dragOriginRef.current;
      if (
        !drag.moved &&
        origin !== null &&
        Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < DRAG_THRESHOLD_PX
      ) {
        // まだ震えの範囲。掴んだだけとみなし、行の選択(click)を邪魔しない。
        return;
      }
      draggedRef.current = true;
      const index = dropIndexAtPoint(event.clientX, event.clientY, total);
      const next =
        index === null
          ? // 帯の外(スケッチの行や区画の余白)。落とし先は変えず、掴んでいることだけ示す。
            { ...drag, moved: true }
          : withDropTarget(part, drag, index);
      if (next.toIndex !== drag.toIndex || next.moved !== drag.moved) {
        setDrag(next);
      }
    };
    const onPointerUp = (): void => {
      setDrag(null);
      dragOriginRef.current = null;
      if (!drag.moved || drag.toIndex === drag.fromIndex) {
        return;
      }
      // 断られたら文書は 1 バイトも変わらず、理由が帯と壊れる側の行に出る(FR-504)。
      useAppStore.getState().moveTimelineItem(drag.featureId, drag.toIndex);
    };
    const onCancel = (): void => {
      // 窓の外へ出た・Esc を押した。並べ替えはやめて元の順序のままにする(NFR-UX-3)。
      setDrag(null);
      dragOriginRef.current = null;
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onCancel();
      }
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [drag, part]);

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
            useAppStore.getState().moveTimelineItem(featureId, offer.toIndex);
          }
          setMenu(null);
        }}
      >
        {t(labelKey)}
      </button>
    );
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
            {group.rows.map((row) => renderRow(row, 'sketch', group.sketchId))}
          </ul>
        )}
      </li>
    );
  };

  /**
   * 木でスケッチの要素を選ぶと、その要素を持つスケッチを作図中に切り替える(P4 仕上げ (h))。
   *
   * `PropertyPanel` は編集中のスケッチ(`state.sketch`)からしか要素を探さないため、
   * 編集中でないスケッチの要素を選んでもプロパティが空になっていた。編集中のスケッチだけを
   * 読み取り専用で出す代わりに、選んだ時点でそのスケッチへ切り替える方を採る(利用者には
   * 「選んだものが編集できる状態になる」ほうが分かりやすい)。作図面の追従は
   * `useAppStore.ts` の `setActiveSketch` が既に行う。
   *
   * `sketchId` は呼び出し側(`renderSketchGroup`)が `group.sketchId` として渡す。要素 id は
   * スケッチをまたいで重なる(`buildSketchGroups` の注釈)ため、id だけから逆引きすると
   * 編集中のスケッチが偶然持つ同じ id と取り違える(`sketchRefs.ts` の `findSketchFeatureAt` が
   * 編集中のスケッチを先に見るのと同じ理由)。木はどの行がどの親(スケッチ)の下にあるかを
   * 描画時にすでに知っているので、その所属をそのまま渡してもらう。
   */
  const activateRowSketch = (sketchId: string | undefined): void => {
    if (sketchId === undefined) {
      return;
    }
    const store = useAppStore.getState();
    if (store.document.activeSketchId !== sketchId) {
      store.setActiveSketch(sketchId);
    }
  };

  const renderRow = (
    row: TreeRow,
    sectionKey: TreeSectionKey,
    sketchId?: string,
  ): React.JSX.Element => {
    const KindIcon = KIND_ICONS[row.kind];
    const selected = selectedIds.has(row.id);
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
          data-timeline-index={stop === undefined ? undefined : stop.entry.index}
          title={stop === undefined ? undefined : t('timeline.dragTooltip')}
          onPointerDown={(event) => {
            /*
             * 掴む(FR-507、タスク20)。帯に出る行だけが掴める。左ボタン以外・つまみ・
             * 「⋮」・名前の欄の上では掴まない(それぞれ別の役目を持つため)。
             * この時点ではまだ「押しただけ」で、`DRAG_THRESHOLD_PX` を超えて動いて
             * 初めて並べ替えになる(押しただけなら今までどおり行の選択)。
             */
            draggedRef.current = false;
            if (stop === undefined || event.button !== 0 || renamingId === row.id) {
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
            dragOriginRef.current = { x: event.clientX, y: event.clientY };
            setDrag(started);
          }}
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
            activateRowSketch(sketchId);
            useAppStore.getState().setSelection([row.id]);
            setMenu({
              featureId: row.id,
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
                // 並べ替えのために掴んで動かした後にも `click` は飛んでくる。その 1 回だけは
                // 選択にしない(掴んで動かしたのに選択が入れ替わると読み取れないため)。
                if (draggedRef.current) {
                  draggedRef.current = false;
                  return;
                }
                const store = useAppStore.getState();
                if (event.shiftKey) {
                  store.toggleSelection(row.id);
                  return;
                }
                activateRowSketch(sketchId);
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
