/**
 * ソリッドの畳んだ一覧(「作る」「合わせる」「加工」)の中身(P5 タスク51、§0.a-0.51)。
 *
 * 分け方の決定は P6 タスク52(一覧ごとに 1 ファイル)。
 */

import type { BooleanOperation } from '@pointercad/model';
import type { SolidToolId } from '../../sketch/numericInput.js';
import {
  BoxIcon,
  ChamferIcon,
  CircularPatternIcon,
  ConeIcon,
  CutIcon,
  CylinderIcon,
  DraftIcon,
  EmbossIcon,
  ExtrudeIcon,
  FilletIcon,
  HoleIcon,
  IntersectIcon,
  LinearPatternIcon,
  LoftIcon,
  MirrorSolidIcon,
  PointPatternIcon,
  RevolveIcon,
  RibIcon,
  RuledIcon,
  ScaleIcon,
  SewIcon,
  ShellIcon,
  SphereGridPointIcon,
  SphereIcon,
  SpringIcon,
  SubtractIcon,
  SurfaceIcon,
  SweepIcon,
  ThreadHoleIcon,
  ThreadShaftIcon,
  TorusIcon,
  TransformIcon,
  UnionIcon,
} from '../icons.js';
import type { ToolMenuItem } from './menuItem.js';

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
