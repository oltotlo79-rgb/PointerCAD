import { useEffect, useRef, useState } from 'react';

import type { BooleanOperation, PartDocument, SolidBody, WorkPlaneId } from '@pointercad/model';

import { hasFileSystemAccess } from '../file/fileGateway.js';
import { createDefaultPartFileDeps, newPart, openPart, savePart } from '../file/partFile.js';
import { t, type MessageKey } from '../i18n/t.js';
import { SettingsPanel } from '../settings/SettingsPanel.js';
import {
  createNumericInput,
  REFERENCE_TOOL_STEPS,
  SHAPE_TOOL_STEPS,
  SOLID_TOOL_STEPS,
  type NumericInputStep,
  type NumericInputToolId,
  type ReferenceToolId,
  type ShapeToolId,
  type SketchToolId,
  type SolidToolId,
} from '../sketch/numericInput.js';
import {
  referenceAxisOptionsOf,
  workPlaneEntries,
  type WorkPlaneEntry,
} from '../sketch/referenceCommands.js';
import type { SnapKind } from '../sketch/snapMath.js';
import type { MachiningToolId } from '../solid/machiningCommands.js';
import {
  commitBooleanFromSelection,
  selectedLineRef,
  solidToolReadiness,
  type SolidActionId,
} from '../solid/solidCommands.js';
import type {
  SolidEdgeEntry,
  SolidFaceEntry,
  SolidVertexEntry,
  SubShapeBody,
} from '../solid/subShapeSelection.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  ArcToolIcon,
  ChainIcon,
  ChamferIcon,
  ChevronRightIcon,
  CircularPatternIcon,
  CubeIcon,
  CursorIcon,
  ExtrudeIcon,
  FaceToolIcon,
  FilletIcon,
  GridIcon,
  HoleIcon,
  HomeIcon,
  IntersectIcon,
  LinearPatternIcon,
  LineToolIcon,
  MatchViewIcon,
  NewFileIcon,
  OpenFileIcon,
  OrthographicIcon,
  PerspectiveIcon,
  PlotPointIcon,
  PointArrayToolIcon,
  RedoIcon,
  RevolveIcon,
  SaveIcon,
  SewIcon,
  ShadedIcon,
  ShadedWithEdgesIcon,
  SnapCenterIcon,
  SnapEndpointIcon,
  SnapGridIcon,
  SnapIcon,
  SnapIntersectionIcon,
  SnapMidpointIcon,
  SpringIcon,
  SubtractIcon,
  ThreadHoleIcon,
  UndoIcon,
  UnionIcon,
  WireframeIcon,
  type IconProps,
} from './icons.js';

/** 図柄のボタン 1 つぶんの定義。区画ごとの表はすべてこの形に揃える。 */
interface ButtonEntry {
  readonly labelKey: MessageKey;
  readonly tooltipKey: MessageKey;
  readonly Icon: (props: IconProps) => React.JSX.Element;
}

/**
 * ファイルの操作(FR-806)。図柄だけのボタンで、名前は読み上げ名とツールチップが担う。
 *
 * ボタンは 3 つのまま増やさない(§0.a-0.15)。「名前を付けて保存」は保存ボタンを
 * Shift を押しながら押すか、Ctrl+Shift+S で行う。その旨はツールチップに書く(NFR-UX-7)。
 */
const FILE_ACTIONS = [
  {
    id: 'new',
    labelKey: 'toolbar.file.new',
    tooltipKey: 'toolbar.file.newTooltip',
    Icon: NewFileIcon,
  },
  {
    id: 'open',
    labelKey: 'toolbar.file.open',
    tooltipKey: 'toolbar.file.openTooltip',
    Icon: OpenFileIcon,
  },
  {
    id: 'save',
    labelKey: 'toolbar.file.save',
    tooltipKey: 'toolbar.file.saveTooltip',
    Icon: SaveIcon,
  },
] as const satisfies readonly (ButtonEntry & { readonly id: FileActionId })[];

/** ファイルのボタン 3 つ。 */
type FileActionId = 'new' | 'open' | 'save';

/** 行を分ける改行。ツールチップに 2 行以上を出すときに使う。 */
const TOOLTIP_LINE_BREAK = '\n';

/**
 * ファイルのボタンのツールチップ。保存のときは「名前を付けて保存」の出し方も添える。
 * 場所を選べない環境(File System Access API の無いブラウザ)では、ダウンロードで
 * 保存されることも添える(NFR-UX-5「できないことは理由とともに」)。
 */
function fileTooltip(id: FileActionId, tooltipKey: MessageKey): string {
  if (id !== 'save') {
    return t(tooltipKey);
  }
  const lines = [t(tooltipKey), t('toolbar.file.saveAsHint')];
  if (!hasFileSystemAccess()) {
    lines.push(t('file.fsaUnavailable'));
  }
  return lines.join(TOOLTIP_LINE_BREAK);
}

/**
 * ファイルのボタンを押したときの処理(FR-806)。
 * 保存は Shift を押しながらだと「名前を付けて保存」になる(ボタンを増やさないため)。
 */
function runFileAction(id: FileActionId, saveAs: boolean): void {
  const deps = createDefaultPartFileDeps();
  switch (id) {
    case 'new':
      void newPart(deps);
      return;
    case 'open':
      void openPart(deps);
      return;
    case 'save':
      void savePart(deps, saveAs);
      return;
  }
}

/** スケッチの道具(FR-301〜309)。並びがそのまま画面の左からの順になる。 */
const TOOLS = [
  {
    id: 'select',
    labelKey: 'toolbar.tool.select',
    tooltipKey: 'toolbar.tool.selectTooltip',
    Icon: CursorIcon,
  },
  {
    id: 'point',
    labelKey: 'toolbar.tool.point',
    tooltipKey: 'toolbar.tool.pointTooltip',
    Icon: PlotPointIcon,
  },
  {
    id: 'line',
    labelKey: 'toolbar.tool.line',
    tooltipKey: 'toolbar.tool.lineTooltip',
    Icon: LineToolIcon,
  },
  {
    id: 'arc',
    labelKey: 'toolbar.tool.arc',
    tooltipKey: 'toolbar.tool.arcTooltip',
    Icon: ArcToolIcon,
  },
  {
    id: 'pointArray',
    labelKey: 'toolbar.tool.pointArray',
    tooltipKey: 'toolbar.tool.pointArrayTooltip',
    Icon: PointArrayToolIcon,
  },
  {
    id: 'face',
    labelKey: 'toolbar.tool.face',
    tooltipKey: 'toolbar.tool.faceTooltip',
    Icon: FaceToolIcon,
  },
] as const satisfies readonly (ButtonEntry & { readonly id: SketchToolId })[];

/**
 * P4 で足した図形の道具(FR-314〜318、FR-326)。「スケッチ」区画の中の畳んだ一覧
 * 「作図」に入れる(§0.a-0.14)。基本の 6 道具を平置きのまま保ちつつ、1440 画素で
 * 1 段に収めるため(実測は報告に記す)。図柄は作らず名前だけの一覧にしてある
 * (`PlaneMenu` と同じ作り)。区画そのものの再編と図柄はタスク32 が行う。
 */
const SHAPE_TOOLS = [
  { id: 'circle', labelKey: 'toolbar.tool.circle', tooltipKey: 'toolbar.tool.circleTooltip' },
  {
    id: 'twoPointArc',
    labelKey: 'toolbar.tool.twoPointArc',
    tooltipKey: 'toolbar.tool.twoPointArcTooltip',
  },
  {
    id: 'rectangle',
    labelKey: 'toolbar.tool.rectangle',
    tooltipKey: 'toolbar.tool.rectangleTooltip',
  },
  { id: 'polygon', labelKey: 'toolbar.tool.polygon', tooltipKey: 'toolbar.tool.polygonTooltip' },
  { id: 'slot', labelKey: 'toolbar.tool.slot', tooltipKey: 'toolbar.tool.slotTooltip' },
  { id: 'ellipse', labelKey: 'toolbar.tool.ellipse', tooltipKey: 'toolbar.tool.ellipseTooltip' },
  { id: 'spline', labelKey: 'toolbar.tool.spline', tooltipKey: 'toolbar.tool.splineTooltip' },
] as const satisfies readonly {
  readonly id: ShapeToolId;
  readonly labelKey: MessageKey;
  readonly tooltipKey: MessageKey;
}[];

/**
 * ソリッドの道具(FR-401〜404)。左の3つは面を選んでから数値を聞き、
 * 右の3つは立体を2つ選んで押すだけで決まる(§0.a-0.6)。
 */
const SOLID_ACTIONS = [
  {
    id: 'extrude',
    labelKey: 'toolbar.solid.extrude',
    tooltipKey: 'toolbar.solid.extrudeTooltip',
    Icon: ExtrudeIcon,
  },
  {
    id: 'revolve',
    labelKey: 'toolbar.solid.revolve',
    tooltipKey: 'toolbar.solid.revolveTooltip',
    Icon: RevolveIcon,
  },
  {
    id: 'sew',
    labelKey: 'toolbar.solid.sew',
    tooltipKey: 'toolbar.solid.sewTooltip',
    Icon: SewIcon,
  },
  {
    id: 'union',
    labelKey: 'toolbar.solid.union',
    tooltipKey: 'toolbar.solid.unionTooltip',
    Icon: UnionIcon,
  },
  {
    id: 'subtract',
    labelKey: 'toolbar.solid.subtract',
    tooltipKey: 'toolbar.solid.subtractTooltip',
    Icon: SubtractIcon,
  },
  {
    id: 'intersect',
    labelKey: 'toolbar.solid.intersect',
    tooltipKey: 'toolbar.solid.intersectTooltip',
    Icon: IntersectIcon,
  },
  /**
   * ばね(FR-414)。対象を消費しない「作る」フィーチャーで加工ではない(§0.a-0.36)ため、
   * 加工6種とは別に「ソリッド」区画の7個目として置く(§0.34)。数値を聞くので、他の
   * 押し出し・回転・縫合と同じく openSolidInput 経由でその場入力を開く(runSolidAction)。
   */
  {
    id: 'spring',
    labelKey: 'toolbar.solid.spring',
    tooltipKey: 'toolbar.solid.springTooltip',
    Icon: SpringIcon,
  },
] as const satisfies readonly (ButtonEntry & { readonly id: SolidActionId })[];

/** 加工の道具 6 つ(§2.11 の「加工」区画)。「ソリッド」の右へ置く(§0.a-0.25 ③)。 */
const MACHINING_ACTIONS = [
  {
    id: 'hole',
    labelKey: 'toolbar.machining.hole',
    tooltipKey: 'toolbar.machining.holeTooltip',
    Icon: HoleIcon,
  },
  {
    id: 'threadHole',
    labelKey: 'toolbar.machining.threadHole',
    tooltipKey: 'toolbar.machining.threadHoleTooltip',
    Icon: ThreadHoleIcon,
  },
  {
    id: 'fillet',
    labelKey: 'toolbar.machining.fillet',
    tooltipKey: 'toolbar.machining.filletTooltip',
    Icon: FilletIcon,
  },
  {
    id: 'chamfer',
    labelKey: 'toolbar.machining.chamfer',
    tooltipKey: 'toolbar.machining.chamferTooltip',
    Icon: ChamferIcon,
  },
  {
    id: 'linearPattern',
    labelKey: 'toolbar.machining.linearPattern',
    tooltipKey: 'toolbar.machining.linearPatternTooltip',
    Icon: LinearPatternIcon,
  },
  {
    id: 'circularPattern',
    labelKey: 'toolbar.machining.circularPattern',
    tooltipKey: 'toolbar.machining.circularPatternTooltip',
    Icon: CircularPatternIcon,
  },
] as const satisfies readonly (ButtonEntry & { readonly id: MachiningToolId })[];

/** 作図面(要件§4.3、§0.a-0.3)。既定は XY。 */
const PLANES = [
  { id: 'xy', labelKey: 'toolbar.plane.xy', tooltipKey: 'toolbar.plane.xyTooltip' },
  { id: 'xz', labelKey: 'toolbar.plane.xz', tooltipKey: 'toolbar.plane.xzTooltip' },
  { id: 'yz', labelKey: 'toolbar.plane.yz', tooltipKey: 'toolbar.plane.yzTooltip' },
] as const satisfies readonly {
  readonly id: WorkPlaneId;
  readonly labelKey: MessageKey;
  readonly tooltipKey: MessageKey;
}[];

/**
 * 作業平面の作り方(FR-328、タスク13)。作図面の畳んだ一覧の中に「作業平面を作る…」として
 * 並べる。新しいトリガーを増やさないのは、ツールバーを 1440 画素で 1 段に保つため
 * (§0.a-0.14、§0.34)。区画そのものの再編と図柄はタスク32 が行う。
 */
const PLANE_TOOLS = [
  {
    id: 'referencePlaneThreePoints',
    labelKey: 'toolbar.reference.planeThreePoints',
    tooltipKey: 'toolbar.reference.planeThreePointsTooltip',
  },
  {
    id: 'referencePlaneOffset',
    labelKey: 'toolbar.reference.planeOffset',
    tooltipKey: 'toolbar.reference.planeOffsetTooltip',
  },
  {
    id: 'referencePlaneTilted',
    labelKey: 'toolbar.reference.planeTilted',
    tooltipKey: 'toolbar.reference.planeTiltedTooltip',
  },
  {
    id: 'referencePlaneThroughPoint',
    labelKey: 'toolbar.reference.planeThroughPoint',
    tooltipKey: 'toolbar.reference.planeThroughPointTooltip',
  },
] as const satisfies readonly {
  readonly id: ReferenceToolId;
  readonly labelKey: MessageKey;
  readonly tooltipKey: MessageKey;
}[];

/** 基準軸・基準点・座標系(FR-329、タスク13)。同じ畳んだ一覧の下の段に並べる。 */
const REFERENCE_TOOLS = [
  {
    id: 'referenceAxis',
    labelKey: 'toolbar.reference.axis',
    tooltipKey: 'toolbar.reference.axisTooltip',
  },
  {
    id: 'referencePoint',
    labelKey: 'toolbar.reference.point',
    tooltipKey: 'toolbar.reference.pointTooltip',
  },
  {
    id: 'referenceCoordinateSystem',
    labelKey: 'toolbar.reference.coordinateSystem',
    tooltipKey: 'toolbar.reference.coordinateSystemTooltip',
  },
] as const satisfies readonly {
  readonly id: ReferenceToolId;
  readonly labelKey: MessageKey;
  readonly tooltipKey: MessageKey;
}[];

/**
 * 吸着の種別(FR-107、§0.a-0.10)。P2 では 1 つのボタンと畳んだ一覧へまとめ、
 * ツールバーを 1440 画素で 1 段に保つ(§0.a-0.15)。畳んでいる間も
 * 「いくつ効いているか」をボタンの上に出し、名前はツールチップで読める。
 */
const SNAP_KINDS_UI = [
  {
    kind: 'endpoint',
    labelKey: 'toolbar.snap.endpoint',
    tooltipKey: 'toolbar.snap.endpointTooltip',
    Icon: SnapEndpointIcon,
  },
  {
    kind: 'intersection',
    labelKey: 'toolbar.snap.intersection',
    tooltipKey: 'toolbar.snap.intersectionTooltip',
    Icon: SnapIntersectionIcon,
  },
  {
    kind: 'midpoint',
    labelKey: 'toolbar.snap.midpoint',
    tooltipKey: 'toolbar.snap.midpointTooltip',
    Icon: SnapMidpointIcon,
  },
  {
    kind: 'center',
    labelKey: 'toolbar.snap.center',
    tooltipKey: 'toolbar.snap.centerTooltip',
    Icon: SnapCenterIcon,
  },
  {
    kind: 'grid',
    labelKey: 'toolbar.snap.grid',
    tooltipKey: 'toolbar.snap.gridTooltip',
    Icon: SnapGridIcon,
  },
] as const satisfies readonly (ButtonEntry & { readonly kind: SnapKind })[];

/**
 * 道具を選んだ直後に開く入力の段階(§2.9「出るきっかけ①ツールを選ぶ→すぐ出る」)。
 * 選択と面は数値ではなくクリックで進めるので開かない。
 */
const INITIAL_STEPS = {
  select: null,
  point: 'point',
  line: 'lineStart',
  arc: 'arcCenter',
  pointArray: 'pointArrayBase',
  face: null,
} as const satisfies Record<SketchToolId, NumericInputStep | null>;

/** ビューポートの大きさがまだ分からないときに使う基準位置(画素)。 */
const FALLBACK_ANCHOR_PIXELS = 160;

/** 名前と理由をつなぐ区切り。文字そのものは言葉に依らないのでここに置く。 */
const LABEL_SEPARATOR = ': ';
/** 畳んだ一覧の名前をつなぐ区切り。 */
const NAME_SEPARATOR = ' / ';

/**
 * ポップアップを出す基準の画面座標(§2.9「表示位置」)。
 *
 * 道具を選んだ直後はまだどこもクリックしていないので、ビューポートのほぼ中央を基準にする。
 * 大きさは `AppShell` が実寸を入れたストアから読む(DOM を直接探しに行かない、
 * rules/04-設計の規律.md)。はみ出しの折り返しはポップアップ側(`clampAnchor`)が行う。
 */
function viewportCenterAnchor(): readonly [number, number] {
  const [width, height] = useAppStore.getState().viewportSize;
  if (width <= 0 || height <= 0) {
    return [FALLBACK_ANCHOR_PIXELS, FALLBACK_ANCHOR_PIXELS];
  }
  return [Math.round(width / 2), Math.round(height / 2)];
}

/**
 * ソリッドのその場入力を出す場所。
 *
 * 立体の道具は「先に面を選んでから押す」ので、最後にビューポートで選んだところの
 * すぐそばへ出すと、何に対する入力なのかが目で追える(NFR-UX-1、NFR-UX-2)。
 * ツリーから選んだときなど、ビューポートを押していなければ中央へ出す。
 */
function solidAnchor(): readonly [number, number] {
  return useAppStore.getState().pickAnchor ?? viewportCenterAnchor();
}

/**
 * 道具のボタンを押したときの処理。
 *
 * 同じ道具をもう一度押したら解除して選択へ戻す(取りかけの操作を残さない、NFR-UX-3)。
 * 数値で位置を決める道具は、選んだ時点で入力欄を開く(NFR-UX-1)。
 */
function activateTool(id: SketchToolId, pressed: boolean): void {
  const store = useAppStore.getState();
  const next: SketchToolId = pressed && id !== 'select' ? 'select' : id;
  // 道具を変えると入力中のポップアップは閉じるので、開き直すのはこの後。
  store.setActiveTool(next);
  const step = INITIAL_STEPS[next];
  if (step !== null) {
    store.openNumericInput(createNumericInput(next, step), viewportCenterAnchor());
    return;
  }
  // 選択と面はクリックとキーで進める道具。押した直後の焦点はボタンに残るので、
  // ビューポートへ戻してもらう。そうしないと面を選んだ直後の Enter が効かない(NFR-UX-4)。
  store.requestViewportFocus();
}

/**
 * P4 の新しい図形(FR-314〜318、FR-326)の道具を選ぶ(タスク12)。
 *
 * 最初に開く段は `SHAPE_TOOL_STEPS`(numericInput.ts)が正本で、ここへ表を作り直さない。
 * 同じ道具をもう一度押したら選択へ戻すのは `activateTool` と同じ約束にする。
 */
function activateShapeTool(id: ShapeToolId, pressed: boolean): void {
  const store = useAppStore.getState();
  if (pressed) {
    store.setActiveTool('select');
    store.requestViewportFocus();
    return;
  }
  store.setActiveTool(id);
  store.openNumericInput(createNumericInput(id, SHAPE_TOOL_STEPS[id]), viewportCenterAnchor());
}

/**
 * 基準ジオメトリ(FR-328、FR-329)の道具を選ぶ(タスク13)。
 *
 * 最初に開く段は `REFERENCE_TOOL_STEPS`(numericInput.ts)が正本。軸の選択肢に並べる
 * 基準軸の一覧は、開くときの文書から引いて渡す(段をまたいで持ち越されるので 1 度でよい)。
 * 同じ道具をもう一度押したら選択へ戻すのは `activateTool` と同じ約束にする。
 */
function activateReferenceTool(id: ReferenceToolId, pressed: boolean): void {
  const store = useAppStore.getState();
  if (pressed) {
    store.setActiveTool('select');
    store.requestViewportFocus();
    return;
  }
  store.setActiveTool(id);
  store.openNumericInput(
    createNumericInput(id, REFERENCE_TOOL_STEPS[id], undefined, {
      referenceAxes: referenceAxisOptionsOf(store.document),
    }),
    viewportCenterAnchor(),
  );
}

/**
 * 押し出し・回転・縫合(FR-401〜403)。道具を選び、その場で数値を聞く(NFR-UX-2)。
 * 回転は線分が選ばれていれば「選んだ線分」も軸の候補に加える(§0.a-0.9)。
 */
function openSolidInput(tool: SolidToolId): void {
  const store = useAppStore.getState();
  store.setActiveTool(tool);
  const axisLine = tool === 'revolve' ? selectedLineRef(store.document, store.selection) : undefined;
  store.openNumericInput(
    createNumericInput(
      tool,
      SOLID_TOOL_STEPS[tool],
      undefined,
      axisLine === undefined ? {} : { axisLine },
    ),
    solidAnchor(),
  );
}

/**
 * 和・差・積(FR-404)。数値を聞かないので、押した瞬間に作って選択へ戻す(§0.a-0.6)。
 * 作った立体をそのまま選んでおくと、続けてもう 1 つ組み合わせられる(NFR-UX-1)。
 */
function commitBooleanAction(operation: BooleanOperation): void {
  const store = useAppStore.getState();
  const outcome = commitBooleanFromSelection(store.document, store.selection, operation);
  if (!outcome.ok) {
    store.setSolidError(outcome.reasonKey);
    return;
  }
  store.applyDocument(outcome.document);
  store.setSelection([outcome.featureId]);
  store.setActiveTool('select');
}

/** ソリッドのボタンを押したときの処理。前の3つは入力を開き、後の3つはその場で作る。 */
function runSolidAction(id: SolidActionId): void {
  if (id === 'union' || id === 'subtract' || id === 'intersect') {
    commitBooleanAction(id);
    return;
  }
  openSolidInput(id);
}

/** 押せないときのツールチップ。「名前: 理由」で、なぜ押せないのかを読めるようにする。 */
function unavailableTooltip(labelKey: MessageKey, reasonKey: MessageKey | null): string {
  return reasonKey === null ? t(labelKey) : `${t(labelKey)}${LABEL_SEPARATOR}${t(reasonKey)}`;
}

interface SnapKindsMenuProps {
  readonly snapEnabled: boolean;
  readonly snapKinds: readonly SnapKind[];
}

/**
 * 吸着の種別の畳んだ一覧(§0.a-0.15)。
 *
 * モーダルにしないので、開いている間も背後の視点操作と作図はそのまま効く。
 * 開いているかどうかは見た目だけの一時状態なので、ここでだけ持つ
 * (rules/04-設計の規律.md「useState は表示専用の一時状態だけ」)。
 * 吸着の入り切りと種別そのものはストアが正本。
 */
function SnapKindsMenu({ snapEnabled, snapKinds }: SnapKindsMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    // 外を押したら閉じる。モーダルの覆いを作らないので、押した先の操作はそのまま通る。
    const onPointerDown = (event: PointerEvent): void => {
      const container = containerRef.current;
      if (container !== null && event.target instanceof Node && !container.contains(event.target)) {
        setOpen(false);
      }
    };
    globalThis.addEventListener('pointerdown', onPointerDown);
    return () => {
      globalThis.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const activeNames = SNAP_KINDS_UI.filter((entry) => snapKinds.includes(entry.kind)).map((entry) =>
    t(entry.labelKey),
  );
  // 畳んでいても何が効いているかを読めるようにし、続けて開き方を伝える(NFR-UX-7)。
  const summary = `${t('toolbar.snap.kindsLabel')}${LABEL_SEPARATOR}${
    activeNames.length === 0 ? t('toolbar.snap.kindsNone') : activeNames.join(NAME_SEPARATOR)
  }\n${t('toolbar.snap.kindsHint')}`;

  return (
    <div
      className="pcad-menu"
      ref={containerRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="pcad-button pcad-menu__trigger"
        title={summary}
        aria-label={t('toolbar.snap.kindsLabel')}
        aria-haspopup="true"
        aria-expanded={open}
        aria-disabled={!snapEnabled}
        onClick={() => {
          // 吸着が切のときは種別を選ぶ意味がないので開かない(NFR-UX-5)。
          if (snapEnabled) {
            setOpen(!open);
          }
        }}
      >
        <span className="pcad-menu__count">
          {`${String(activeNames.length)}/${String(SNAP_KINDS_UI.length)}`}
        </span>
        <ChevronRightIcon className="pcad-menu__chevron" />
      </button>
      {open ? (
        <div className="pcad-menu__panel" role="group" aria-label={t('toolbar.snap.kindsLabel')}>
          {SNAP_KINDS_UI.map((entry) => (
            <button
              key={entry.kind}
              type="button"
              className="pcad-button pcad-menu__item"
              title={t(entry.tooltipKey)}
              aria-pressed={snapKinds.includes(entry.kind)}
              onClick={() => {
                useAppStore.getState().toggleSnapKind(entry.kind);
              }}
            >
              <entry.Icon />
              {t(entry.labelKey)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface PlaneMenuProps {
  readonly workPlaneId: WorkPlaneId;
  /** いま選ばれている道具。基準ジオメトリの道具なら一覧の中で押されて見える。 */
  readonly activeTool: NumericInputToolId;
  /** 文書にある任意の作業平面(FR-328)。基準の 3 面の下に名前で並べる。 */
  readonly customPlanes: readonly WorkPlaneEntry[];
}

/**
 * 作図面(XY / XZ / YZ)の畳んだ一覧(§0.a-0.25 ②、§0.34)。
 *
 * ①(無効なモードタブを隠す)と「加工」区画・ばねを足しただけでは、1440 画素へ
 * 必要な幅が実測 1437.3px となり(2026-09-04 実測)、余裕が 3px 弱しか無い
 * (書体やスクロールバーの差で環境によっては 1440px を超えかねない)。そこで
 * `SnapKindsMenu` と同じ畳んだ一覧の作りで 3 つを 1 つのトリガー+一覧へまとめ、
 * 安全な余白を作る(§0.34「②を行ってよい」)。トリガーには**いまの作図面の名前を
 * 札に出す**(畳んでも状態が分かる、§0.34)。モーダルにしない(NFR-UX-2)ので、
 * 開いている間も背後の操作はそのまま効く。
 */
function PlaneMenu({ workPlaneId, activeTool, customPlanes }: PlaneMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      const container = containerRef.current;
      if (container !== null && event.target instanceof Node && !container.contains(event.target)) {
        setOpen(false);
      }
    };
    globalThis.addEventListener('pointerdown', onPointerDown);
    return () => {
      globalThis.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const base = PLANES.find((plane) => plane.id === workPlaneId);
  const custom = customPlanes.find((plane) => plane.id === workPlaneId);
  // トリガーの札は、基準の 3 面なら「XY」、任意の作業平面なら付いている名前を出す。
  const currentLabel = base === undefined ? (custom?.name ?? t(PLANES[0].labelKey)) : t(base.labelKey);
  const currentTooltip = base === undefined ? t('toolbar.plane.tooltip') : t(base.tooltipKey);

  return (
    <div
      className="pcad-menu"
      ref={containerRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="pcad-button pcad-menu__trigger"
        title={currentTooltip}
        aria-label={`${t('toolbar.plane.groupLabel')}${LABEL_SEPARATOR}${currentLabel}`}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span className="pcad-menu__count">{currentLabel}</span>
        <ChevronRightIcon className="pcad-menu__chevron" />
      </button>
      {open ? (
        <div className="pcad-menu__panel" role="group" aria-label={t('toolbar.plane.groupLabel')}>
          {PLANES.map((plane) => (
            <button
              key={plane.id}
              type="button"
              className="pcad-button pcad-menu__item"
              title={t(plane.tooltipKey)}
              aria-pressed={workPlaneId === plane.id}
              onClick={() => {
                useAppStore.getState().setWorkPlane(plane.id);
                setOpen(false);
              }}
            >
              {t(plane.labelKey)}
            </button>
          ))}
          {/* 文書にある任意の作業平面(FR-328)。作った順に名前で並べる。 */}
          {customPlanes.map((plane) => (
            <button
              key={plane.id}
              type="button"
              className="pcad-button pcad-menu__item"
              title={t('toolbar.plane.tooltip')}
              aria-pressed={workPlaneId === plane.id}
              onClick={() => {
                useAppStore.getState().setWorkPlane(plane.id);
                setOpen(false);
              }}
            >
              {plane.name}
            </button>
          ))}
          {/* 作業平面の作り方 4 通り(FR-328)と、基準軸・基準点・座標系(FR-329)。 */}
          <span className="pcad-menu__section">{t('toolbar.plane.createPlane')}</span>
          {PLANE_TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className="pcad-button pcad-menu__item"
              title={t(tool.tooltipKey)}
              aria-pressed={activeTool === tool.id}
              onClick={() => {
                activateReferenceTool(tool.id, activeTool === tool.id);
                setOpen(false);
              }}
            >
              {t(tool.labelKey)}
            </button>
          ))}
          <span className="pcad-menu__section">{t('toolbar.reference.groupLabel')}</span>
          {REFERENCE_TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className="pcad-button pcad-menu__item"
              title={t(tool.tooltipKey)}
              aria-pressed={activeTool === tool.id}
              onClick={() => {
                activateReferenceTool(tool.id, activeTool === tool.id);
                setOpen(false);
              }}
            >
              {t(tool.labelKey)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface ShapeMenuProps {
  readonly activeTool: NumericInputToolId;
}

/**
 * 新しい図形の畳んだ一覧「作図」(FR-314〜318、FR-326、§0.a-0.14、タスク12)。
 *
 * `PlaneMenu` と同じ作り(非モーダル、外を押すと閉じる、トリガーに今の状態を出す)。
 * いま選ばれているのが作図の道具なら、その名前をトリガーに出して畳んでも分かるようにする。
 */
function ShapeMenu({ activeTool }: ShapeMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      const container = containerRef.current;
      if (container !== null && event.target instanceof Node && !container.contains(event.target)) {
        setOpen(false);
      }
    };
    globalThis.addEventListener('pointerdown', onPointerDown);
    return () => {
      globalThis.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const current = SHAPE_TOOLS.find((tool) => tool.id === activeTool) ?? null;
  const groupLabel = t('toolbar.shape.groupLabel');

  return (
    <div
      className="pcad-menu"
      ref={containerRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="pcad-button pcad-menu__trigger"
        title={t('toolbar.shape.tooltip')}
        aria-label={
          current === null
            ? groupLabel
            : `${groupLabel}${LABEL_SEPARATOR}${t(current.labelKey)}`
        }
        aria-haspopup="true"
        aria-expanded={open}
        aria-pressed={current !== null}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span className="pcad-menu__count">
          {current === null ? groupLabel : t(current.labelKey)}
        </span>
        <ChevronRightIcon className="pcad-menu__chevron" />
      </button>
      {open ? (
        <div className="pcad-menu__panel" role="group" aria-label={groupLabel}>
          {SHAPE_TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className="pcad-button pcad-menu__item"
              title={t(tool.tooltipKey)}
              aria-pressed={activeTool === tool.id}
              onClick={() => {
                activateShapeTool(tool.id, activeTool === tool.id);
                setOpen(false);
              }}
            >
              {t(tool.labelKey)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * `state.bodies`(model の `SolidBody`)に面・辺・頂点の一覧を(あれば)添えた形。
 *
 * その一覧が `SolidBody` へ届くのはタスク17(model の橋渡しの拡張)の後で、このタスクの
 * 着手時点ではまだ届いていない。`viewport/buildSolidGeometry.ts` の `SolidBodyWithSubShapes`
 * と同じ考え方(そちらは描画専用で `viewport/**` の担当外なので import せず、ここでは
 * 加工の押せる条件の判定に要る形だけを組み立てる。3 つとも省略可なので、`SolidBody` の値を
 * そのまま渡せる)。タスク17 が欄を必須で足したら、この型と変換関数は不要になり、
 * `state.bodies` をそのまま渡せる。
 */
export type SolidBodyWithSubShapes = SolidBody & {
  readonly faces?: readonly SolidFaceEntry[];
  readonly edges?: readonly SolidEdgeEntry[];
  readonly vertices?: readonly SolidVertexEntry[];
};

/**
 * ボディ一覧を `solidToolReadiness` / `commitSolidInput`(タスク25b の4引数目、`bodies`)が
 * 要る `SubShapeBody[]` へ詰め替える。面・辺・頂点の一覧がまだ届いていないボディは空の一覧
 * として扱う(その結果、加工のボタンは「対象が選ばれていません」の理由で押せないまま出る。
 * タスク17 の後に自動で解消する)。
 *
 * `AppShell.tsx` の `onSolidCommit` も同じ詰め替えを要るので、ここで輸出して使い回す
 * (`solidCommands.ts` 自身が「同じ判断を2か所に書かない」を掲げているのに合わせる)。
 */
export function subShapeBodiesOf(
  bodies: readonly SolidBodyWithSubShapes[],
): readonly SubShapeBody[] {
  return bodies.map((body) => ({
    featureId: body.featureId,
    mesh: { edgePositions: body.mesh.edgePositions },
    faces: body.faces ?? [],
    edges: body.edges ?? [],
    vertices: body.vertices ?? [],
  }));
}

interface MachiningGroupProps {
  readonly document: PartDocument;
  readonly bodies: readonly SubShapeBody[];
  readonly selection: readonly string[];
}

/**
 * 加工の区画(§2.11、FR-405〜408、FR-411、FR-412)。「ソリッド」の右へ置く(§0.a-0.25 ③)。
 * 図柄だけのボタンで、押せる条件と理由は `solidToolReadiness`(solidCommands.ts、
 * タスク25b)で決める。加工6種の判定そのものは `machiningToolReadiness`
 * (machiningCommands.ts、タスク25)にあるが、`solidToolReadiness` がすでにそこへ
 * 委譲しているので、ここで2重に呼ばない(同じ判断を2か所に書かない)。数値を聞くのは
 * 押し出し・回転・縫合と同じ道具の形なので、ボタンを押したときの処理も `openSolidInput`
 * をそのまま使う(`MachiningToolId` は `SolidToolId` の部分集合)。押せない道具を押したときに
 * 帯へも理由を出す作りは `SolidGroup` と揃える(§0.a-0.6、NFR-UX-5)。
 */
function MachiningGroup({ document, bodies, selection }: MachiningGroupProps): React.JSX.Element {
  return (
    <div className="pcad-toolbar__group" role="group" aria-label={t('toolbar.machining.title')}>
      <span className="pcad-toolbar__group-label" title={t('toolbar.machining.tooltip')}>
        {t('toolbar.machining.title')}
      </span>
      <div className="pcad-segmented">
        {MACHINING_ACTIONS.map((action) => {
          const readiness = solidToolReadiness(document, selection, action.id, bodies);
          return (
            <button
              key={action.id}
              type="button"
              className="pcad-button pcad-button--icon"
              title={
                readiness.ready
                  ? t(action.tooltipKey)
                  : unavailableTooltip(action.labelKey, readiness.reasonKey)
              }
              aria-label={t(action.labelKey)}
              aria-disabled={!readiness.ready}
              onClick={() => {
                if (readiness.ready) {
                  openSolidInput(action.id);
                  return;
                }
                /*
                  条件が揃っていなくても、押した時点で選ぶものを道具が要る種類へ切り替える
                  (§0.a-0.6、タスク30 不具合(b))。これで「穴を押す → 面を選ぶ → 点を Shift で
                  足す → 穴を押す」の流れが成立する(その場入力は開かない。setActiveTool の
                  絞り込みでポップアップは自然に閉じたままになる)。
                */
                useAppStore.getState().setActiveTool(action.id);
                // 押せない道具を押しても、ツールチップだけでなく帯にも理由を出す
                // (§0.a-0.6、NFR-UX-5。SolidGroup と同じ作り)。
                useAppStore.getState().setSolidError(readiness.reasonKey);
              }}
            >
              <action.Icon />
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface SolidGroupProps {
  readonly document: PartDocument;
  readonly bodies: readonly SubShapeBody[];
  readonly selection: readonly string[];
}

/**
 * ソリッドの区画(FR-401〜404、FR-414)。7 つとも図柄だけのボタンで、名前は読み上げ名と
 * ツールチップが担う(FR-904、NFR-UX-7)。いま押せないものは aria-disabled にし、
 * ツールチップで「名前: 理由」を読めるようにする。押しても立体は作らないが、
 * 押した瞬間にステータスバーへも同じ理由を出す(§0.a-0.6、NFR-UX-5)。7 個目のばねは
 * 対象を消費しない「作る」フィーチャーで加工ではないが(§0.a-0.36)、この区画へ足す
 * (§0.34)。
 */
function SolidGroup({ document, bodies, selection }: SolidGroupProps): React.JSX.Element {
  return (
    <div className="pcad-toolbar__group" role="group" aria-label={t('toolbar.solid.title')}>
      <span className="pcad-toolbar__group-label" title={t('toolbar.solid.tooltip')}>
        {t('toolbar.solid.title')}
      </span>
      <div className="pcad-segmented">
        {SOLID_ACTIONS.map((action) => {
          const readiness = solidToolReadiness(document, selection, action.id, bodies);
          return (
            <button
              key={action.id}
              type="button"
              className="pcad-button pcad-button--icon"
              title={
                readiness.ready
                  ? t(action.tooltipKey)
                  : unavailableTooltip(action.labelKey, readiness.reasonKey)
              }
              aria-label={t(action.labelKey)}
              aria-disabled={!readiness.ready}
              onClick={() => {
                if (readiness.ready) {
                  runSolidAction(action.id);
                  return;
                }
                /*
                  押し出し・回転・縫合・ばね(その場入力を開く4つ)は、条件が揃っていなくても
                  押した時点で選ぶものを道具の種類へ切り替える(§0.a-0.6、タスク30 不具合(b))。
                  和・差・積は数値を聞かず選ぶものも常に立体のままなので対象外(runSolidAction の
                  分岐と同じ切り分け)。
                */
                if (action.id !== 'union' && action.id !== 'subtract' && action.id !== 'intersect') {
                  useAppStore.getState().setActiveTool(action.id);
                }
                // 押せない道具を押しても、ツールチップだけでなく帯にも理由を出す
                // (§0.a-0.6、NFR-UX-5。2026-09-03 19:35 の統括の決定)。
                useAppStore.getState().setSolidError(readiness.reasonKey);
              }}
            >
              <action.Icon />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 画面上端のツールバー(要件§7.1)。
 *
 * 左から「製品名 → ファイル → 元に戻す・やり直す → モードのタブ → スケッチ → ソリッド →
 * 加工 → 作図面」、右へ「投影 / 表示 / 補助 / 吸着 / 視点」の機能グループを並べる
 * (§0.a-0.25 ③「加工」をソリッドの右へ)。
 * 機能グループは区画名を頭に置き、いま選ばれているものをアクセント色の面で示す(NFR-UX-7)。
 * 状態の正本は Zustand ストア1本(rules/04-設計の規律.md)。
 *
 * 横幅の方針: 1440 画素の窓で 1 段に収まることを条件にする(§0.a-0.15)。
 * 図柄で分かるものは図柄だけのボタン(`pcad-button--icon`)にして詰め、
 * 文字を添えたい道具(スケッチ・続けてかく)には `pcad-button--collapsible` を付けて、
 * 窓が 1600 画素より狭いときだけ文字を畳む(appShell.css)。図柄だけになるボタンには
 * 必ず読み上げ名(aria-label)と、名前で始まるツールチップを付ける(FR-904、NFR-UX-7)。
 */
export function Toolbar(): React.JSX.Element {
  const projection = useAppStore((state) => state.projection);
  const displayStyle = useAppStore((state) => state.displayStyle);
  const showGrid = useAppStore((state) => state.showGrid);
  const activeTool = useAppStore((state) => state.activeTool);
  const workPlaneId = useAppStore((state) => state.workPlaneId);
  const snapEnabled = useAppStore((state) => state.snapEnabled);
  const snapKinds = useAppStore((state) => state.snapKinds);
  const chaining = useAppStore((state) => state.chaining);
  const partDocument = useAppStore((state) => state.document);
  // 文書にある任意の作業平面(FR-328、タスク13)。作図面の一覧に名前で並べる。
  const customPlanes = workPlaneEntries(partDocument);
  const bodies = useAppStore((state) => state.bodies);
  // ソリッド・加工の押せる条件の判定(solidToolReadiness)が要る形へ詰め替える
  // (タスク17 の後は state.bodies をそのまま渡せるようになる、subShapeBodiesOf の注釈)。
  const subShapeBodies = subShapeBodiesOf(bodies);
  const selection = useAppStore((state) => state.selection);
  const canUndo = useAppStore((state) => state.canUndo);
  const canRedo = useAppStore((state) => state.canRedo);

  return (
    <header className="pcad-toolbar">
      <div className="pcad-toolbar__brand">
        <CubeIcon size={18} className="pcad-toolbar__mark" />
        <span className="pcad-toolbar__wordmark">{t('app.title')}</span>
      </div>

      {/*
        ファイルと履歴。どちらも世の中の道具と同じ図柄なので区画名を置かず、
        製品名のとなりに 5 つ並べる(§0.a-0.15)。
      */}
      <div className="pcad-toolbar__actions">
        <div className="pcad-segmented" role="group" aria-label={t('toolbar.file.title')}>
          {FILE_ACTIONS.map((action) => (
            <button
              key={action.id}
              type="button"
              className="pcad-button pcad-button--icon"
              title={fileTooltip(action.id, action.tooltipKey)}
              aria-label={t(action.labelKey)}
              onClick={(event) => {
                runFileAction(action.id, event.shiftKey);
              }}
            >
              <action.Icon />
            </button>
          ))}
        </div>
        <div className="pcad-segmented" role="group" aria-label={t('toolbar.history.groupLabel')}>
          <button
            type="button"
            className="pcad-button pcad-button--icon"
            title={
              canUndo ? t('toolbar.history.undoTooltip') : t('toolbar.history.undoUnavailable')
            }
            aria-label={t('toolbar.history.undo')}
            aria-disabled={!canUndo}
            onClick={() => {
              if (canUndo) {
                useAppStore.getState().undo();
              }
            }}
          >
            <UndoIcon />
          </button>
          <button
            type="button"
            className="pcad-button pcad-button--icon"
            title={
              canRedo ? t('toolbar.history.redoTooltip') : t('toolbar.history.redoUnavailable')
            }
            aria-label={t('toolbar.history.redo')}
            aria-disabled={!canRedo}
            onClick={() => {
              if (canRedo) {
                useAppStore.getState().redo();
              }
            }}
          >
            <RedoIcon />
          </button>
        </div>
      </div>

      {/*
        モードのタブ。今はモデリングだけが使える。「アセンブリ」「図面」は、それを実装する
        P7 / P8 まで出さない(畳んで薄く見せるのではなく、丸ごと隠す。§0.a-0.25 ①、
        §0.34 の幅の圧縮)。実装したらここへ戻す。
      */}
      <nav className="pcad-toolbar__modes" aria-label={t('toolbar.mode.groupLabel')}>
        <button type="button" className="pcad-tab" aria-pressed={true}>
          {t('toolbar.mode.modeling')}
        </button>
      </nav>

      <div
        className="pcad-toolbar__group"
        role="group"
        aria-label={t('toolbar.sketch.groupLabel')}
      >
        <span className="pcad-toolbar__group-label" title={t('toolbar.sketch.tooltip')}>
          {t('toolbar.sketch.groupLabel')}
        </span>
        <div className="pcad-segmented">
          {TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className="pcad-button pcad-button--collapsible"
              title={t(tool.tooltipKey)}
              aria-label={t(tool.labelKey)}
              aria-pressed={activeTool === tool.id}
              onClick={() => {
                activateTool(tool.id, activeTool === tool.id);
              }}
            >
              <tool.Icon />
              <span className="pcad-button__label">{t(tool.labelKey)}</span>
            </button>
          ))}
        </div>
        {/* 新しい図形は畳んだ一覧へ入れて、基本の 6 道具の平置きを崩さない(§0.a-0.14)。 */}
        <ShapeMenu activeTool={activeTool} />
      </div>

      <SolidGroup document={partDocument} bodies={subShapeBodies} selection={selection} />
      <MachiningGroup document={partDocument} bodies={subShapeBodies} selection={selection} />

      <div className="pcad-toolbar__group" role="group" aria-label={t('toolbar.plane.groupLabel')}>
        <span className="pcad-toolbar__group-label" title={t('toolbar.plane.tooltip')}>
          {t('toolbar.plane.groupLabel')}
        </span>
        <div className="pcad-segmented">
          <PlaneMenu
            workPlaneId={workPlaneId}
            activeTool={activeTool}
            customPlanes={customPlanes}
          />
          {/*
            いま見ている向きに最も近い作図面へ移る(§0.a-0.3)。視点の正本はビューポートの
            中にあるので、ここでは要求を数えるだけにしてビューポートに応えてもらう。
          */}
          <button
            type="button"
            className="pcad-button pcad-button--icon"
            title={t('toolbar.plane.matchViewTooltip')}
            aria-label={t('toolbar.plane.matchView')}
            onClick={() => {
              useAppStore.getState().requestMatchWorkPlaneToView();
            }}
          >
            <MatchViewIcon />
          </button>
        </div>
      </div>

      <span className="pcad-toolbar__spacer" />

      <div
        className="pcad-toolbar__group"
        role="group"
        aria-label={t('toolbar.projection.groupLabel')}
      >
        <span className="pcad-toolbar__group-label" title={t('toolbar.projection.tooltip')}>
          {t('toolbar.projection.groupLabel')}
        </span>
        {/*
          奥へ集まる線と平行なままの線という、見え方そのものを写した図柄なので
          文字を添えずに並べる。名前は読み上げ名とツールチップが持つ。
        */}
        <div className="pcad-segmented">
          <button
            type="button"
            className="pcad-button pcad-button--icon"
            title={t('toolbar.projection.perspectiveTooltip')}
            aria-label={t('toolbar.projection.perspective')}
            aria-pressed={projection === 'perspective'}
            onClick={() => {
              useAppStore.getState().setProjection('perspective');
            }}
          >
            <PerspectiveIcon />
          </button>
          <button
            type="button"
            className="pcad-button pcad-button--icon"
            title={t('toolbar.projection.orthographicTooltip')}
            aria-label={t('toolbar.projection.orthographic')}
            aria-pressed={projection === 'orthographic'}
            onClick={() => {
              useAppStore.getState().setProjection('orthographic');
            }}
          >
            <OrthographicIcon />
          </button>
        </div>
      </div>

      <div
        className="pcad-toolbar__group"
        role="group"
        aria-label={t('toolbar.displayStyle.groupLabel')}
      >
        <span className="pcad-toolbar__group-label" title={t('toolbar.displayStyle.tooltip')}>
          {t('toolbar.displayStyle.groupLabel')}
        </span>
        {/*
          3 つの図柄がそのまま見え方(塗りだけ / 塗りと稜線 / 線だけ)を写しているので、
          文字を添えずに図柄だけで並べる。名前は読み上げ名とツールチップが持つ。
        */}
        <div className="pcad-segmented">
          <button
            type="button"
            className="pcad-button pcad-button--icon"
            title={t('toolbar.displayStyle.shaded')}
            aria-label={t('toolbar.displayStyle.shaded')}
            aria-pressed={displayStyle === 'shaded'}
            onClick={() => {
              useAppStore.getState().setDisplayStyle('shaded');
            }}
          >
            <ShadedIcon />
          </button>
          <button
            type="button"
            className="pcad-button pcad-button--icon"
            title={t('toolbar.displayStyle.shadedWithEdges')}
            aria-label={t('toolbar.displayStyle.shadedWithEdges')}
            aria-pressed={displayStyle === 'shadedWithEdges'}
            onClick={() => {
              useAppStore.getState().setDisplayStyle('shadedWithEdges');
            }}
          >
            <ShadedWithEdgesIcon />
          </button>
          <button
            type="button"
            className="pcad-button pcad-button--icon"
            title={t('toolbar.displayStyle.wireframe')}
            aria-label={t('toolbar.displayStyle.wireframe')}
            aria-pressed={displayStyle === 'wireframe'}
            onClick={() => {
              useAppStore.getState().setDisplayStyle('wireframe');
            }}
          >
            <WireframeIcon />
          </button>
        </div>
      </div>

      <div className="pcad-toolbar__group" role="group" aria-label={t('toolbar.support.groupLabel')}>
        <span className="pcad-toolbar__group-label" title={t('toolbar.support.tooltip')}>
          {t('toolbar.support.groupLabel')}
        </span>
        <div className="pcad-segmented">
          {/* 方眼の図柄そのままなので文字は添えない。「続けてかく」は狭い窓でだけ畳む。 */}
          <button
            type="button"
            className="pcad-button pcad-button--icon"
            title={t('toolbar.grid.tooltip')}
            aria-label={t('toolbar.grid.label')}
            aria-pressed={showGrid}
            onClick={() => {
              useAppStore.getState().setShowGrid(!showGrid);
            }}
          >
            <GridIcon />
          </button>
          <button
            type="button"
            className="pcad-button pcad-button--collapsible"
            title={t('toolbar.chain.tooltip')}
            aria-label={t('toolbar.chain.label')}
            aria-pressed={chaining}
            onClick={() => {
              useAppStore.getState().setChaining(!chaining);
            }}
          >
            <ChainIcon />
            <span className="pcad-button__label">{t('toolbar.chain.label')}</span>
          </button>
        </div>
      </div>

      <div className="pcad-toolbar__group" role="group" aria-label={t('toolbar.snap.groupLabel')}>
        <span className="pcad-toolbar__group-label" title={t('toolbar.snap.tooltip')}>
          {t('toolbar.snap.groupLabel')}
        </span>
        <div className="pcad-segmented">
          <button
            type="button"
            className="pcad-button pcad-button--icon"
            title={t('toolbar.snap.tooltip')}
            aria-label={t('toolbar.snap.label')}
            aria-pressed={snapEnabled}
            onClick={() => {
              useAppStore.getState().setSnapEnabled(!snapEnabled);
            }}
          >
            <SnapIcon />
          </button>
          <SnapKindsMenu snapEnabled={snapEnabled} snapKinds={snapKinds} />
        </div>
      </div>

      <div className="pcad-toolbar__group" role="group" aria-label={t('toolbar.view.groupLabel')}>
        <span className="pcad-toolbar__group-label" title={t('toolbar.view.tooltip')}>
          {t('toolbar.view.groupLabel')}
        </span>
        <div className="pcad-segmented">
          <button
            type="button"
            className="pcad-button pcad-button--action pcad-button--icon"
            title={t('toolbar.home.tooltip')}
            aria-label={t('toolbar.home.label')}
            onClick={() => {
              useAppStore.getState().requestHomeView();
            }}
          >
            <HomeIcon />
          </button>
        </div>
      </div>

      {/*
        表示設定(FR-908、FR-909)。歯車ひとつを視点区画の右へ置き、押すとその場に
        テーマの見本と拡大率が開く(固定の区画は増やさない、要件§7.1)。
        区画名を持たない図柄だけのボタンなので、名前は読み上げ名とツールチップが担う。
        溝(.pcad-segmented)で囲まないのは、1 つしか無いことと、1440 画素の窓で
        1 段を保つ幅の予算のため(囲むと 6 画素増える)。
      */}
      <SettingsPanel />
    </header>
  );
}
