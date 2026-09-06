/**
 * スケッチの区画に並ぶ道具の表(平置きの 6 道具・作図面・作業平面・基準ジオメトリ・
 * 吸い付きの種類・数の欄の初期の段)と、その場で決まる小さな判断。
 *
 * 一覧ごとに 1 ファイルへ分けた(P6 タスク52)。
 */

import type { WorkPlaneId } from '@pointercad/model';
import type { MessageKey } from '../../i18n/t.js';
import { freeSketchToolRejection } from '../../sketch/freeSketch.js';
import type {
  NumericInputStep,
  NumericInputToolId,
  ReferenceToolId,
  SketchToolId,
} from '../../sketch/numericInput.js';
import type { SnapKind } from '../../sketch/snapMath.js';
import { useAppStore } from '../../store/useAppStore.js';
import {
  ArcToolIcon,
  CursorIcon,
  FaceToolIcon,
  LineToolIcon,
  PlotPointIcon,
  PointArrayToolIcon,
  SnapCenterIcon,
  SnapEndpointIcon,
  SnapExtensionIcon,
  SnapGridIcon,
  SnapIntersectionIcon,
  SnapMidpointIcon,
  SnapParallelIcon,
  SnapPerpendicularIcon,
  SnapPolarIcon,
} from '../icons.js';
import type { ButtonEntry } from './toolbarShared.js';

/** スケッチの道具(FR-301〜309)。並びがそのまま画面の左からの順になる。 */
export const TOOLS = [
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

/*
 * ソリッドと加工の道具の表は `toolbarMenus.ts` の `CREATE_MENU_ITEMS` /
 * `COMBINE_MENU_ITEMS` / `MACHINING_MENU_ITEMS` へ移した(P5 タスク51、§0.a-0.51)。
 * 図柄 13 個を平置きしていた 2 つの区画を「作る」「合わせる」「加工」の畳んだ一覧
 * 3 つへまとめたので、区画ごとの表もそちらへ寄せてある(同じ表を 2 か所に書かない)。
 */

/** 作図面(要件§4.3、§0.a-0.3)。既定は XY。 */
export const PLANES = [
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
export const PLANE_TOOLS = [
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
export const REFERENCE_TOOLS = [
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
export const SNAP_KINDS_UI = [
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
  /*
   * 向きの吸着(FR-110、P4b タスク16)。**同じ一覧に並べる**のは、利用者から見れば
   * 「どこに吸い付くか」の設定が 1 か所であるべきだから(§0.13 の決定、NFR-UX-1)。
   * 並びは `SNAP_PRIORITY` の末尾 4 つと同じ順にして、優先順位が見た目にも表れるようにする。
   */
  {
    kind: 'polar',
    labelKey: 'toolbar.snap.polar',
    tooltipKey: 'toolbar.snap.polarTooltip',
    Icon: SnapPolarIcon,
  },
  {
    kind: 'extension',
    labelKey: 'toolbar.snap.extension',
    tooltipKey: 'toolbar.snap.extensionTooltip',
    Icon: SnapExtensionIcon,
  },
  {
    kind: 'perpendicular',
    labelKey: 'toolbar.snap.perpendicular',
    tooltipKey: 'toolbar.snap.perpendicularTooltip',
    Icon: SnapPerpendicularIcon,
  },
  {
    kind: 'parallel',
    labelKey: 'toolbar.snap.parallel',
    tooltipKey: 'toolbar.snap.parallelTooltip',
    Icon: SnapParallelIcon,
  },
] as const satisfies readonly (ButtonEntry & { readonly kind: SnapKind })[];

/**
 * 道具を選んだ直後に開く入力の段階(§2.9「出るきっかけ①ツールを選ぶ→すぐ出る」)。
 * 選択と面は数値ではなくクリックで進めるので開かない。
 */
export const INITIAL_STEPS = {
  select: null,
  point: 'point',
  line: 'lineStart',
  arc: 'arcCenter',
  pointArray: 'pointArrayBase',
  face: null,
} as const satisfies Record<SketchToolId, NumericInputStep | null>;

/** 角度の札(「15°」)。言葉に依らない書き方なのでここで組み立てる(SettingsPanel と同じ流儀)。 */
const DEGREE_SIGN = '°';

export function angleStepLabel(step: number): string {
  return `${String(step)}${DEGREE_SIGN}`;
}

/** 角度の刻みを差し替える(テーマと拡大率はそのまま)。 */
export function selectTrackAngleStep(step: number): void {
  const store = useAppStore.getState();
  store.setDisplaySettings({ ...store.displaySettings, trackAngleStep: step });
}

/**
 * 3D スケッチ(FR-330)で使えない道具は選ばせず、理由を帯へ出す(NFR-UX-5、タスク14)。
 *
 * 使える・使えないの判断は `freeSketch.ts` の `freeSketchToolRejection` 1 か所に置いてある。
 * 押せなくするのではなく「押したら理由が出る」形にしてあるのは、押せない見た目だけだと
 * なぜ使えないのかが分からないため(P3 の加工6種と同じ扱い、`docs/報告記録.md`
 * 2026-09-04 10:50 の仕上げ (e)-(b))。
 */
export function blockedInFreeSketch(tool: NumericInputToolId): boolean {
  const store = useAppStore.getState();
  const rejection = freeSketchToolRejection(store.workPlaneId, tool);
  if (rejection === null) {
    return false;
  }
  store.setShapeError(rejection);
  return true;
}

/**
 * 作図面を選び直す(FR-328、FR-330)。3D スケッチへ切り替えたときに、作図面が要る道具を
 * 選んだままにしない(その道具のまま押すと理由も出せずに何も起きないため)。
 */
export function selectWorkPlane(planeId: WorkPlaneId): void {
  const store = useAppStore.getState();
  store.setWorkPlane(planeId);
  const rejection = freeSketchToolRejection(planeId, store.activeTool);
  if (rejection !== null) {
    store.setActiveTool('select');
    store.setShapeError(rejection);
  }
}
