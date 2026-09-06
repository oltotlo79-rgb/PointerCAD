/**
 * スケッチの畳んだ一覧(「作図」「編集」「拘束」)の中身(FR-313〜318、FR-326)。
 *
 * 分け方の決定は P6 タスク52(一覧ごとに 1 ファイル)。
 */

import type { SketchConstraintKind } from '@pointercad/model';
import type { EditMenuToolId, ShapeToolId } from '../../sketch/numericInput.js';
import {
  AngleConstraintIcon,
  CircleToolIcon,
  CircularArrayToolIcon,
  CoincidentConstraintIcon,
  ConcentricConstraintIcon,
  CopyToolIcon,
  DiameterConstraintIcon,
  DistanceConstraintIcon,
  EllipseToolIcon,
  EqualConstraintIcon,
  ExtendToolIcon,
  FixConstraintIcon,
  HorizontalConstraintIcon,
  LinearArrayToolIcon,
  MirrorToolIcon,
  OffsetToolIcon,
  ParallelConstraintIcon,
  PerpendicularConstraintIcon,
  PolygonToolIcon,
  ProjectToolIcon,
  RadiusConstraintIcon,
  RectangleToolIcon,
  SectionToolIcon,
  SketchChamferToolIcon,
  SketchFilletToolIcon,
  SlotToolIcon,
  SplineToolIcon,
  SymmetricConstraintIcon,
  TangentConstraintIcon,
  ThreePointArcToolIcon,
  TrimToolIcon,
  TwoPointArcToolIcon,
  VerticalConstraintIcon,
} from '../icons.js';
import type { ToolMenuItem } from './menuItem.js';

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
