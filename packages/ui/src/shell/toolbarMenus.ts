/**
 * ツールバーの畳んだ一覧(「作図」「編集」「拘束」「作る」「合わせる」「加工」「投影」
 * 「見た目」)の中身と、その決まりごとの純関数
 * (計画書 docs/plans/P4-スケッチ拡張.md タスク32、§0.a-0.14。
 *  ソリッド側の組み替えは docs/plans/P5-高度なソリッド・外観と測定.md タスク51、§0.a-0.51。
 *  FR-904、NFR-UX-7)。
 *
 * 画面(`Toolbar.tsx`)から表と判断を分けてあるのは 2 つの理由による。
 * ①**項目の追加を 1 行で済ませる**ため。トリム・延長・フィレット・面取り・ミラー・複写・
 *   配列複写(タスク22〜24)は、この下の `EDIT_MENU_ITEMS` へ 1 行足すだけで一覧・図柄・
 *   ツールチップ・キーボード操作・幅の見積もりのすべてに反映される。
 * ②DOM を持たない判断(トリガーに出す図柄、最後に使った道具の記憶、↑↓ の行き先、
 *   区画の幅の見積もり)を単体で検査できるようにするため(`toolbarMenus.test.ts`)。
 *
 * ここは React にも DOM にも触れない。図柄は `icons.tsx` の関数への参照を持つだけで、
 * この場では呼ばない(JSX を書かないので拡張子は .ts のまま)。
 */

import type { BooleanOperation, SketchConstraintKind } from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';
import type {
  AppearanceToolId,
  EditMenuToolId,
  MeasureToolId,
  ShapeToolId,
  SolidToolId,
} from '../sketch/numericInput.js';
import type { ProjectionMode } from '../store/useAppStore.js';

import {
  AngleConstraintIcon,
  AppearanceIcon,
  BoxIcon,
  ChamferIcon,
  CircleToolIcon,
  CircularArrayToolIcon,
  CircularPatternIcon,
  CoincidentConstraintIcon,
  ConcentricConstraintIcon,
  ConeIcon,
  CopyToolIcon,
  CutIcon,
  CylinderIcon,
  DiameterConstraintIcon,
  DistanceConstraintIcon,
  DraftIcon,
  EllipseToolIcon,
  EmbossIcon,
  EqualConstraintIcon,
  ExtendToolIcon,
  ExtrudeIcon,
  FilletIcon,
  FixConstraintIcon,
  HoleIcon,
  HorizontalConstraintIcon,
  IntersectIcon,
  LinearArrayToolIcon,
  LinearPatternIcon,
  LoftIcon,
  MeasureIcon,
  MirrorSolidIcon,
  MirrorToolIcon,
  OffsetToolIcon,
  OrthographicIcon,
  ParallelConstraintIcon,
  PerpendicularConstraintIcon,
  PerspectiveIcon,
  PointPatternIcon,
  PolygonToolIcon,
  ProjectToolIcon,
  RadiusConstraintIcon,
  RectangleToolIcon,
  RevolveIcon,
  RibIcon,
  RuledIcon,
  SaveAsIcon,
  ScaleIcon,
  SectionToolIcon,
  SewIcon,
  ShellIcon,
  SketchChamferToolIcon,
  SketchFilletToolIcon,
  SlotToolIcon,
  SphereGridPointIcon,
  SphereIcon,
  SplineToolIcon,
  SpringIcon,
  SubtractIcon,
  SurfaceIcon,
  SweepIcon,
  SymmetricConstraintIcon,
  TangentConstraintIcon,
  ThreadHoleIcon,
  ThreadShaftIcon,
  ThreePointArcToolIcon,
  TorusIcon,
  TransformIcon,
  TrimToolIcon,
  TwoPointArcToolIcon,
  UnionIcon,
  VerticalConstraintIcon,
  type IconComponent,
} from './icons.js';

/**
 * 畳んだ一覧の 1 項目。項目は必ず**図柄と名前の両方**を持つ(名前だけの一覧は、
 * 開いたときに何の形なのかが読み取りにくかった。t12・t21 の申し送り)。
 */
export interface ToolMenuItem<Id extends string> {
  readonly id: Id;
  readonly labelKey: MessageKey;
  readonly tooltipKey: MessageKey;
  readonly Icon: IconComponent;
}

/**
 * 「ファイル」の畳んだ一覧に並ぶ操作の id(P6 §0.57、タスク31)。
 *
 * **配線先のある操作だけを並べる。** 一覧に出ている行を押したら必ず正しいことが起きる、
 * という約束をこの型で守る(`Toolbar.tsx` の `runFileMenuAction` はこの型を網羅する
 * `switch` なので、**配線を書かずに id を足すと型検査が落ちる**)。
 *
 * §0.57 は最終的に 7 項目(書き出す・読み込む・ひな形から新規・ひな形として保存・
 * 別名保存・印刷・最近使ったファイル)と決めているが、P6 タスク31 の時点で配線先が
 * あるのは**別名保存だけ**なので、まずそれだけを載せる。残りは中身を作るタスクが
 * この型と下の表へ 1 行ずつ足す(溝の幅は 1 画素も増えない。`segmentedWidthPixels`)。
 *
 * - 書き出す・読み込む … タスク32(`file/exchangeFile.ts` とパネル)
 * - ひな形から新規・ひな形として保存・印刷・最近使ったファイル … タスク33
 *   (ひな形は `file/templateFile.ts`、最近使ったファイルは端末の覚え書き、
 *    印刷は `file/printView.ts` の `printViewport` に渡す
 *    `capture: () => string | null` = **ビューポートの 1 コマを白い下地で PNG にする口**が
 *    まだ無い。いまストアにある `captureThumbnail` は 256 画素の正方形で下地も画面と同じ
 *    暗い色なので、紙に出すと FR-908「印刷の見た目はテーマの影響を受けない」に反する。
 *    `viewport/createViewportScene.ts` へ `capturePrintFrame()` を足す必要がある)
 */
export type FileMenuActionId = 'saveAs';

/**
 * 「ファイル」の畳んだ一覧(FR-812、P6 §0.57、タスク31)。
 *
 * 新規・開く・保存の 3 つは**図柄のまま残す**(最もよく使うので 1 クリックで届かせる、
 * §0.57)。その右に畳んだボタンを 1 つだけ足し、たまにしか使わないファイル操作を
 * すべてこの中へ入れる。区画は増やさない(要件§7.1、rules/04)。
 *
 * 別名保存は P2 から「保存ボタンを Shift を押しながら押す」か Ctrl+Shift+S でできたが、
 * **押し方を知らないと辿り着けなかった**(FR-812 は入口を求めている)。ここへ 1 行置くと、
 * 画面を見るだけで見つかる(NFR-UX-7)。Shift 押しと Ctrl+Shift+S はそのまま残す。
 */
export const FILE_MENU_ITEMS: readonly ToolMenuItem<FileMenuActionId>[] = [
  {
    id: 'saveAs',
    labelKey: 'toolbar.file.saveAs',
    tooltipKey: 'toolbar.file.saveAsMenuTooltip',
    Icon: SaveAsIcon,
  },
];

/**
 * 「作図」の一覧(FR-313〜318、FR-326)。よく使う基本の 6 道具(選択・点・線分・円弧・
 * 点列・面)は平置きのままにして、ここには「たまに使うが数は多い」形を入れる
 * (利用者の決定 2026-09-04「図柄付きの畳んだボタンで 1 段に戻す」)。
 * 並びがそのまま一覧の上からの順になる。
 */
export const SHAPE_MENU_ITEMS: readonly ToolMenuItem<ShapeToolId>[] = [
  {
    id: 'circle',
    labelKey: 'toolbar.tool.circle',
    tooltipKey: 'toolbar.tool.circleTooltip',
    Icon: CircleToolIcon,
  },
  {
    id: 'twoPointArc',
    labelKey: 'toolbar.tool.twoPointArc',
    tooltipKey: 'toolbar.tool.twoPointArcTooltip',
    Icon: TwoPointArcToolIcon,
  },
  {
    id: 'threePointArc',
    labelKey: 'toolbar.tool.threePointArc',
    tooltipKey: 'toolbar.tool.threePointArcTooltip',
    Icon: ThreePointArcToolIcon,
  },
  {
    id: 'rectangle',
    labelKey: 'toolbar.tool.rectangle',
    tooltipKey: 'toolbar.tool.rectangleTooltip',
    Icon: RectangleToolIcon,
  },
  {
    id: 'polygon',
    labelKey: 'toolbar.tool.polygon',
    tooltipKey: 'toolbar.tool.polygonTooltip',
    Icon: PolygonToolIcon,
  },
  {
    id: 'slot',
    labelKey: 'toolbar.tool.slot',
    tooltipKey: 'toolbar.tool.slotTooltip',
    Icon: SlotToolIcon,
  },
  {
    id: 'ellipse',
    labelKey: 'toolbar.tool.ellipse',
    tooltipKey: 'toolbar.tool.ellipseTooltip',
    Icon: EllipseToolIcon,
  },
  {
    id: 'spline',
    labelKey: 'toolbar.tool.spline',
    tooltipKey: 'toolbar.tool.splineTooltip',
    Icon: SplineToolIcon,
  },
];

/**
 * 「編集」の一覧(FR-321〜324)。オフセット・トリム・延長。
 *
 * **タスク23・24 への申し送り**: スケッチのフィレット・スケッチの面取り・ミラー・複写・
 * 配列複写は、この表へ `{ id, labelKey, tooltipKey, Icon }` の 1 行を足すだけで一覧に並ぶ。
 * 押せる条件は `editCommands.ts` の `editToolReadiness` が道具 id で振り分けているので、
 * 「選んでから操作」でない道具を足すときはそちらへ 1 行足す(タスク22 でトリム・延長の
 * ぶんを足した)。一覧の項目が増えてもツールバーの幅は変わらない
 * (`segmentedWidthPixels` の注釈)。
 */
export const EDIT_MENU_ITEMS: readonly ToolMenuItem<EditMenuToolId>[] = [
  {
    id: 'offset',
    labelKey: 'toolbar.tool.offset',
    tooltipKey: 'toolbar.tool.offsetTooltip',
    Icon: OffsetToolIcon,
  },
  {
    id: 'trim',
    labelKey: 'toolbar.tool.trim',
    tooltipKey: 'toolbar.tool.trimTooltip',
    Icon: TrimToolIcon,
  },
  {
    id: 'extend',
    labelKey: 'toolbar.tool.extend',
    tooltipKey: 'toolbar.tool.extendTooltip',
    Icon: ExtendToolIcon,
  },
  // 角を指して使う 2 つ(タスク23)。整形系なので複製系より前へ置く。
  {
    id: 'sketchFillet',
    labelKey: 'toolbar.tool.sketchFillet',
    tooltipKey: 'toolbar.tool.sketchFilletTooltip',
    Icon: SketchFilletToolIcon,
  },
  {
    id: 'sketchChamfer',
    labelKey: 'toolbar.tool.sketchChamfer',
    tooltipKey: 'toolbar.tool.sketchChamferTooltip',
    Icon: SketchChamferToolIcon,
  },
  {
    id: 'mirror',
    labelKey: 'toolbar.tool.mirror',
    tooltipKey: 'toolbar.tool.mirrorTooltip',
    Icon: MirrorToolIcon,
  },
  {
    id: 'copy',
    labelKey: 'toolbar.tool.copyMove',
    tooltipKey: 'toolbar.tool.copyMoveTooltip',
    Icon: CopyToolIcon,
  },
  {
    id: 'linearArray',
    labelKey: 'toolbar.tool.linearArray',
    tooltipKey: 'toolbar.tool.linearArrayTooltip',
    Icon: LinearArrayToolIcon,
  },
  {
    id: 'circularArray',
    labelKey: 'toolbar.tool.circularArray',
    tooltipKey: 'toolbar.tool.circularArrayTooltip',
    Icon: CircularArrayToolIcon,
  },
  /*
    投影・断面(FR-325、タスク27)。かいた線をいじる道具ではなく「立体からかたちを
    取り込む」道具なので、一覧の最後にまとめて並べる。押す相手がスケッチではなく立体
    なので、押せる条件(`editToolReadiness`)は常に押せる側へ振り分けてある。
  */
  {
    id: 'projectedCurve',
    labelKey: 'toolbar.tool.projectedCurve',
    tooltipKey: 'toolbar.tool.projectedCurveTooltip',
    Icon: ProjectToolIcon,
  },
  {
    id: 'planeSection',
    labelKey: 'toolbar.tool.planeSection',
    tooltipKey: 'toolbar.tool.planeSectionTooltip',
    Icon: SectionToolIcon,
  },
];

/**
 * 「拘束」の一覧(FR-313、P4b タスク13)。幾何拘束 10 種 → 寸法拘束 4 種の 14 種を並べる。
 *
 * **区画は増やさず、畳んだ一覧を 1 つ足すだけ**にする(統括の決定 2026-09-05)。
 * 溝の幅は畳んだボタン 1 つぶん(31 画素)しか増えず、一覧の中に 14 種を入れても
 * ツールバーの高さは 1 段(68.5 画素)のまま(`segmentedWidthPixels` の注釈)。
 *
 * 並びは `constraintCommands.ts` の `CONSTRAINT_KIND_ORDER` と同じにする。あちらが画面の
 * 並びの正本で、ここは図柄と説明を足した表。`SketchConstraintKind` を網羅する形にして
 * あるので、model 側で種類が増えたらこの表が型検査で落ちる。
 */
export const CONSTRAINT_MENU_ITEMS: readonly ToolMenuItem<SketchConstraintKind>[] = [
  {
    id: 'coincident',
    labelKey: 'constraint.kind.coincident',
    tooltipKey: 'toolbar.constraint.coincidentTooltip',
    Icon: CoincidentConstraintIcon,
  },
  {
    id: 'horizontal',
    labelKey: 'constraint.kind.horizontal',
    tooltipKey: 'toolbar.constraint.horizontalTooltip',
    Icon: HorizontalConstraintIcon,
  },
  {
    id: 'vertical',
    labelKey: 'constraint.kind.vertical',
    tooltipKey: 'toolbar.constraint.verticalTooltip',
    Icon: VerticalConstraintIcon,
  },
  {
    id: 'parallel',
    labelKey: 'constraint.kind.parallel',
    tooltipKey: 'toolbar.constraint.parallelTooltip',
    Icon: ParallelConstraintIcon,
  },
  {
    id: 'perpendicular',
    labelKey: 'constraint.kind.perpendicular',
    tooltipKey: 'toolbar.constraint.perpendicularTooltip',
    Icon: PerpendicularConstraintIcon,
  },
  {
    id: 'tangent',
    labelKey: 'constraint.kind.tangent',
    tooltipKey: 'toolbar.constraint.tangentTooltip',
    Icon: TangentConstraintIcon,
  },
  {
    id: 'concentric',
    labelKey: 'constraint.kind.concentric',
    tooltipKey: 'toolbar.constraint.concentricTooltip',
    Icon: ConcentricConstraintIcon,
  },
  {
    id: 'equal',
    labelKey: 'constraint.kind.equal',
    tooltipKey: 'toolbar.constraint.equalTooltip',
    Icon: EqualConstraintIcon,
  },
  {
    id: 'symmetric',
    labelKey: 'constraint.kind.symmetric',
    tooltipKey: 'toolbar.constraint.symmetricTooltip',
    Icon: SymmetricConstraintIcon,
  },
  {
    id: 'fix',
    labelKey: 'constraint.kind.fix',
    tooltipKey: 'toolbar.constraint.fixTooltip',
    Icon: FixConstraintIcon,
  },
  {
    id: 'distance',
    labelKey: 'constraint.kind.distance',
    tooltipKey: 'toolbar.constraint.distanceTooltip',
    Icon: DistanceConstraintIcon,
  },
  {
    id: 'angle',
    labelKey: 'constraint.kind.angle',
    tooltipKey: 'toolbar.constraint.angleTooltip',
    Icon: AngleConstraintIcon,
  },
  {
    id: 'radius',
    labelKey: 'constraint.kind.radius',
    tooltipKey: 'toolbar.constraint.radiusTooltip',
    Icon: RadiusConstraintIcon,
  },
  {
    id: 'diameter',
    labelKey: 'constraint.kind.diameter',
    tooltipKey: 'toolbar.constraint.diameterTooltip',
    Icon: DiameterConstraintIcon,
  },
];

/**
 * 「作る」の一覧(FR-401〜403、FR-414。P5 タスク51、§0.a-0.51)。
 *
 * 押し出し・回転・縫合・ばねは、どれも「面や点を選んでから数値を聞き、立体を新しく作る」
 * 道具なので 1 つの一覧にまとめる。**タスク18(基本形状 5 種)とタスク49(罫線・スイープ・
 * ロフト・ミラー)は、この表へ 1 行足すだけで一覧に並ぶ**(ツールバーの幅は 1 画素も
 * 増えない。`segmentedWidthPixels` の注釈)。
 */
export const CREATE_MENU_ITEMS: readonly ToolMenuItem<SolidToolId>[] = [
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
  /*
    ばね(FR-414)。対象を消費しない「作る」フィーチャーで加工ではない(§0.a-0.36)ので、
    加工の一覧ではなくこちらへ入れる(P4 までツールバーで「ソリッド」区画の 7 個目に
    置いていたのと同じ切り分け)。
  */
  {
    id: 'spring',
    labelKey: 'toolbar.solid.spring',
    tooltipKey: 'toolbar.solid.springTooltip',
    Icon: SpringIcon,
  },
  /*
    基本形状5種(FR-429、タスク18)。対象を消費しない「作る」フィーチャー(§0.a-0.19)なので
    ばねと同じくこの一覧に入る。**この 5 行を足してもツールバーの幅は 1 画素も増えない**
    (`segmentedWidthPixels` は溝に並ぶボタンの個数しか見ない。§0.a-0.80)。
    並びは §2.15 の段の表と同じ「球・箱・円柱・円錐・トーラス」。
  */
  {
    id: 'sphere',
    labelKey: 'toolbar.solid.sphere',
    tooltipKey: 'toolbar.solid.sphereTooltip',
    Icon: SphereIcon,
  },
  {
    id: 'box',
    labelKey: 'toolbar.solid.box',
    tooltipKey: 'toolbar.solid.boxTooltip',
    Icon: BoxIcon,
  },
  {
    id: 'cylinder',
    labelKey: 'toolbar.solid.cylinder',
    tooltipKey: 'toolbar.solid.cylinderTooltip',
    Icon: CylinderIcon,
  },
  {
    id: 'cone',
    labelKey: 'toolbar.solid.cone',
    tooltipKey: 'toolbar.solid.coneTooltip',
    Icon: ConeIcon,
  },
  {
    id: 'torus',
    labelKey: 'toolbar.solid.torus',
    tooltipKey: 'toolbar.solid.torusTooltip',
    Icon: TorusIcon,
  },
  /*
    球面上の点(FR-431、タスク22)。作るのは立体ではなく 3D スケッチの点だが、
    **球を選んでから押す**という使い方が基本形状と地続きなので、球のすぐ後ろへ置く
    (利用者は「球まわりの道具」を 1 か所で探せる)。**この 1 行を足してもツールバーの幅は
    1 画素も増えない**(`segmentedWidthPixels` は溝に並ぶボタンの個数しか見ない。§0.a-0.80)。
  */
  {
    id: 'sphereGridPoint',
    labelKey: 'toolbar.solid.sphereGridPoint',
    tooltipKey: 'toolbar.solid.sphereGridPointTooltip',
    Icon: SphereGridPointIcon,
  },
  /*
    面をつなぐ(罫線面、FR-430)とロフト(FR-410。タスク27)。どちらも対象を消費しない
    「作る」フィーチャー(§0.a-0.27)なのでこの一覧に入る。**この 2 行を足しても
    ツールバーの幅は 1 画素も増えない**(`segmentedWidthPixels` は溝に並ぶボタンの個数しか
    見ない。§0.a-0.80)。並びは基本形状の後ろで、直線で結ぶ「面をつなぐ」→ なめらかに
    結ぶ「ロフト」の順(利用者から見て素直な方を先に置く)。
  */
  {
    id: 'ruled',
    labelKey: 'toolbar.solid.ruled',
    tooltipKey: 'toolbar.solid.ruledTooltip',
    Icon: RuledIcon,
  },
  {
    id: 'loft',
    labelKey: 'toolbar.solid.loft',
    tooltipKey: 'toolbar.solid.loftTooltip',
    Icon: LoftIcon,
  },
  /*
    P5 の Should 群のうち「作る」フィーチャー 3 つ(タスク50、§2.15)。
    スイープ(FR-409)は対象を取らず、ミラー(FR-419)と曲面(FR-428)は**対象を消費しない**
    (§0.a-0.36、§0.a-0.45)ので、加工ではなくこの一覧に入る。**この 3 行を足しても
    ツールバーの幅は 1 画素も増えない**(`segmentedWidthPixels` は溝に並ぶボタンの個数しか
    見ない。§0.a-0.80)。
  */
  {
    id: 'sweep',
    labelKey: 'toolbar.solid.sweep',
    tooltipKey: 'toolbar.solid.sweepTooltip',
    Icon: SweepIcon,
  },
  {
    id: 'mirrorSolid',
    labelKey: 'toolbar.solid.mirror',
    tooltipKey: 'toolbar.solid.mirrorTooltip',
    Icon: MirrorSolidIcon,
  },
  {
    id: 'surface',
    labelKey: 'toolbar.solid.surface',
    tooltipKey: 'toolbar.solid.surfaceTooltip',
    Icon: SurfaceIcon,
  },
];

/**
 * 「合わせる」の一覧(FR-404。P5 タスク51、§0.a-0.51)。
 *
 * 和・差・積は「立体を 2 つ選んで押すだけで決まる」点が「作る」の 4 つと違う(数値を
 * 聞かない、§0.a-0.6)ので、同じ「ソリッド」区画の中でも別の一覧に分ける。
 * 並びは `BooleanOperation` の意味の順(足す → 引く → 重なりだけ残す)。
 */
export const COMBINE_MENU_ITEMS: readonly ToolMenuItem<BooleanOperation>[] = [
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
];

/**
 * 「加工」の一覧(FR-405〜408、FR-411、FR-412。P5 タスク51、§0.a-0.51)。
 *
 * できあがった立体へ手を入れる道具。**タスク27f(切断)とタスク49(抜き勾配・シェル・
 * リブ・エンボス・外ねじ・移動/回転・拡大縮小・点パターン)は、この表へ 1 行足すだけ**で
 * 一覧に並び、ツールバーの幅は変わらない。
 */
export const MACHINING_MENU_ITEMS: readonly ToolMenuItem<SolidToolId>[] = [
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
  /*
    P5 の Should 群のうち「できあがった立体へ手を入れる」9 つ(タスク50・27e、§2.15)。
    抜き勾配(FR-417)・くり抜き(FR-418)・リブ(FR-420)・エンボス(FR-421)・
    外ねじ(FR-423)・移動/回転(FR-424)・拡大縮小(FR-424)・点パターン(FR-425)・
    切断(FR-432)。**この 9 行を足してもツールバーの幅は 1 画素も増えない**(§0.a-0.64)。
    並びは「形を変える → 位置と大きさを変える → 並べる → 切る」の順。
  */
  {
    id: 'draft',
    labelKey: 'toolbar.machining.draft',
    tooltipKey: 'toolbar.machining.draftTooltip',
    Icon: DraftIcon,
  },
  {
    id: 'shell',
    labelKey: 'toolbar.machining.shell',
    tooltipKey: 'toolbar.machining.shellTooltip',
    Icon: ShellIcon,
  },
  {
    id: 'rib',
    labelKey: 'toolbar.machining.rib',
    tooltipKey: 'toolbar.machining.ribTooltip',
    Icon: RibIcon,
  },
  {
    id: 'emboss',
    labelKey: 'toolbar.machining.emboss',
    tooltipKey: 'toolbar.machining.embossTooltip',
    Icon: EmbossIcon,
  },
  {
    id: 'threadShaft',
    labelKey: 'toolbar.machining.threadShaft',
    tooltipKey: 'toolbar.machining.threadShaftTooltip',
    Icon: ThreadShaftIcon,
  },
  {
    id: 'transform',
    labelKey: 'toolbar.machining.transform',
    tooltipKey: 'toolbar.machining.transformTooltip',
    Icon: TransformIcon,
  },
  {
    id: 'scale',
    labelKey: 'toolbar.machining.scale',
    tooltipKey: 'toolbar.machining.scaleTooltip',
    Icon: ScaleIcon,
  },
  {
    id: 'pointPattern',
    labelKey: 'toolbar.machining.pointPattern',
    tooltipKey: 'toolbar.machining.pointPatternTooltip',
    Icon: PointPatternIcon,
  },
  {
    id: 'cut',
    labelKey: 'toolbar.machining.cut',
    tooltipKey: 'toolbar.machining.cutTooltip',
    Icon: CutIcon,
  },
];

/**
 * 「投影」の一覧(FR-102。P5 タスク51、§0.a-0.51)。
 *
 * 2 つしかないが、畳んだボタンには**いま効いているほうの図柄が出る**(`triggerItemOf` が
 * `activeTool` = いまの投影と一致する項目を返す)ので、畳んでも今の見え方は読み取れる
 * (`PlaneMenu` のトリガーに作図面の名前を出すのと同じ考え方)。
 */
export const PROJECTION_MENU_ITEMS: readonly ToolMenuItem<ProjectionMode>[] = [
  {
    id: 'perspective',
    labelKey: 'toolbar.projection.perspective',
    tooltipKey: 'toolbar.projection.perspectiveTooltip',
    Icon: PerspectiveIcon,
  },
  {
    id: 'orthographic',
    labelKey: 'toolbar.projection.orthographic',
    tooltipKey: 'toolbar.projection.orthographicTooltip',
    Icon: OrthographicIcon,
  },
];

/**
 * 「見た目」の一覧に並ぶ道具の id(P5 タスク51・32)。
 *
 * 外観(FR-1106〜1110)と測る(FR-1101、FR-1102)は、どちらも**立体を作らず**
 * 「選んでいるものについて何かをする」道具なので、同じ一覧に入る。
 */
export type LookToolId = AppearanceToolId | MeasureToolId;

/**
 * 「見た目」の一覧(FR-1106〜1110、FR-1101、FR-1102。P5 タスク51、タスク32)。
 *
 * **「測る」は 2 行目**(§0.a-0.29 が「測る」をボタン 1 つと決めているので、区画を増やさずに
 * この一覧へ足せる。要件§7.1 の「固定の区画は増やさない」)。この 1 行を足しても
 * ツールバーの幅は 1 画素も増えない(`segmentedWidthPixels` は溝に並ぶボタンの個数しか
 * 見ない。§0.a-0.80)。
 */
export const LOOK_MENU_ITEMS: readonly ToolMenuItem<LookToolId>[] = [
  {
    id: 'appearance',
    labelKey: 'toolbar.appearance.assign',
    tooltipKey: 'toolbar.appearance.assignTooltip',
    Icon: AppearanceIcon,
  },
  {
    id: 'measure',
    labelKey: 'toolbar.measure.title',
    tooltipKey: 'toolbar.measure.tooltip',
    Icon: MeasureIcon,
  },
];

/**
 * 畳んだボタンに出す図柄のもとになる項目。
 *
 * ①いまその一覧の道具を使っているならその道具、②使っていなければ**最後にこの一覧から
 * 選んだ道具**、③一度も使っていなければ `null`(区画そのものの図柄を出す)。
 * ②は「よく使う道具は 1 クリック、それ以外は 2 クリック」にするための工夫で、
 * 世の中の道具箱つきボタン(Photoshop 等)と同じ振る舞い。
 */
export function triggerItemOf<Id extends string>(
  items: readonly ToolMenuItem<Id>[],
  activeToolId: string,
  recentId: Id | null,
): ToolMenuItem<Id> | null {
  const active = items.find((item) => item.id === activeToolId);
  if (active !== undefined) {
    return active;
  }
  return items.find((item) => item.id === recentId) ?? null;
}

/**
 * 「最後に使った道具」の記憶を更新する。一覧に無い id(別の区画の道具へ移ったときなど)では
 * 前の記憶をそのまま残す。道具の正本はストアで、これは畳んだボタンの見た目だけの記憶。
 */
export function rememberRecentTool<Id extends string>(
  items: readonly ToolMenuItem<Id>[],
  recentId: Id | null,
  chosenId: string,
): Id | null {
  const chosen = items.find((item) => item.id === chosenId);
  return chosen === undefined ? recentId : chosen.id;
}

/**
 * 開いている一覧の中で ↑↓ Home End を押したときの行き先(0 起点)。
 * 端では反対の端へ回り込む。一覧を動かさないキーは `null` を返し、押したキーは
 * ブラウザ既定(頁の縦送り)へそのまま渡す。決めるのは Enter / Space で、
 * これは焦点のあるボタンの既定の動きがそのまま使えるのでここでは扱わない。
 */
export function nextHighlightIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) {
    return null;
  }
  switch (key) {
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 幅の見積もり(1440 画素の窓で 1 段に収めるための予算、§0.a-0.14・0.15)
// ---------------------------------------------------------------------------

/** 図柄だけのボタンの幅。`appShell.css` の `.pcad-button--icon` と同じ値。 */
export const ICON_BUTTON_WIDTH_PIXELS = 26;

/**
 * 畳んだ一覧のボタン(図柄+小さな ▾)の幅。`appShell.css` の
 * `.pcad-menu__trigger--icon` と同じ値。図柄 16 + 隙間 1 + ▾ 9 = 26 に、
 * 押せる面を図柄だけのボタンより少しだけ広げるぶんを足してある。
 */
export const MENU_TRIGGER_WIDTH_PIXELS = 31;

/** 溝(`.pcad-segmented`)の内側の隙間・内余白・枠線。`appShell.css` と同じ値。 */
const SEGMENTED_GAP_PIXELS = 2;
const SEGMENTED_PADDING_PIXELS = 2;
const SEGMENTED_BORDER_PIXELS = 1;

/**
 * 溝 1 つぶんの幅(画素)。ツールバーが 1440 画素の窓で 1 段に収まるかの予算を、
 * 実測の前に見積もるために使う(実測は撮影の手順で行い、報告に残す)。
 *
 * **引数が「個数」だけであること自体が要点**で、畳んだ一覧の中に項目をいくつ足しても
 * 溝の幅は変わらない。タスク22〜24 が「編集」へ 7 つの道具を足しても、ツールバーの幅は
 * 1 画素も増えない(検査 `toolbarMenus.test.ts` がこれを固定している)。
 */
export function segmentedWidthPixels(iconButtons: number, menuTriggers: number): number {
  const buttons = iconButtons + menuTriggers;
  if (buttons <= 0) {
    return 0;
  }
  return (
    iconButtons * ICON_BUTTON_WIDTH_PIXELS +
    menuTriggers * MENU_TRIGGER_WIDTH_PIXELS +
    (buttons - 1) * SEGMENTED_GAP_PIXELS +
    2 * SEGMENTED_PADDING_PIXELS +
    2 * SEGMENTED_BORDER_PIXELS
  );
}

/** 「スケッチ」区画に平置きする基本の道具の数(選択・点・線分・円弧・点列・面)。 */
export const BASIC_SKETCH_TOOL_COUNT = 6;

/**
 * 「スケッチ」区画に置く畳んだ一覧の数(「作図」「編集」「拘束」)。
 * P4b タスク13 で「拘束」を足して 2 → 3 になった。溝の幅は 31 画素だけ増える
 * (`segmentedWidthPixels`)ので、1440 画素の窓では 1 段(68.5 画素)のまま。
 */
export const SKETCH_MENU_COUNT = 3;

/**
 * 「ソリッド」区画に置く畳んだ一覧の数(「作る」「合わせる」「加工」、P5 タスク51)。
 *
 * P4b までは 図柄 7 個の「ソリッド」区画(実測 200 画素)と 図柄 6 個の「加工」区画
 * (同 172 画素)が別々に並んでいた。3 つの一覧へ畳んで 1 つの溝へまとめると
 * `segmentedWidthPixels(0, 3)` = 103 画素になり、区画のあいだの隙間(6 画素)も 1 つ減る。
 */
export const SOLID_MENU_COUNT = 3;

/** 「投影」「見た目」の区画に置く畳んだ一覧の数(どちらも 1 つ、P5 タスク51)。 */
export const SINGLE_MENU_COUNT = 1;

/**
 * 「ファイル」の溝に平置きする図柄のボタンの数(新規・開く・保存、§0.a-0.15、§0.57)。
 * **この 3 つは畳まない**(最もよく使うので 1 クリックで届かせる)。
 */
export const FILE_ACTION_ICON_COUNT = 3;

/**
 * 「ファイル」の溝に置く畳んだ一覧の数(P6 §0.57、タスク31)。
 *
 * 溝は `segmentedWidthPixels(3, 0)` = 88 画素から `segmentedWidthPixels(3, 1)` = 121 画素へ
 * 33 画素だけ広がる(畳んだボタン 31 + 隙間 2)。**一覧の中へ項目をいくつ足しても
 * ここから先は 1 画素も増えない**ので、§0.57 の残り 6 項目(タスク32・33)も幅に効かない。
 * 実測は 1440×900 で必要幅 1172.3 → 1205.3 画素、余裕 267.7 → 234.7 画素(報告に記載)。
 */
export const FILE_MENU_COUNT = 1;
