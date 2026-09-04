/**
 * 3D スケッチ(作図面に依らないスケッチ、FR-330)の操作の約束を決める純関数
 * (計画書 docs/plans/P4-スケッチ拡張.md タスク14、§0.a-0.4・§0.a-0.5、§2.4)。
 *
 * 対応要件: FR-330(3D スケッチ)、FR-106(頂点のクリック選択)、NFR-UX-1・UX-5・UX-7。
 *
 * DOM にもストアにも three.js にも触れない。ここが決めるのは次の 4 つだけで、
 * 画面側(`attachSketchInteraction.ts` / `Toolbar.tsx` / `NumericInputPopover.tsx`)は
 * この判断を読むだけにする(同じ判断を 2 か所に書かない)。
 *
 *   1. どの道具が 3D スケッチで使えるか(使えないものの断りの文)
 *   2. どの道具で立体の頂点を直に押して点にできるか
 *   3. 座標の指定方法から極座標を隠すこと(§0.a-0.5)
 *   4. 頂点でも既にある点でもない場所を押したとき、点をどの面へ置くか
 */

import {
  FREE_WORK_PLANE_ID,
  isFreeWorkPlaneId,
  lengthVec3,
  normalizeVec3,
  planeAxesFor,
  scaleVec3,
  WORK_PLANES,
  type Vec3,
  type WorkPlane,
  type WorkPlaneId,
} from '@pointercad/model';

import { t } from '../i18n/t.js';
import { COORDINATE_MODES, type CoordinateMode, type NumericInputToolId } from './numericInput.js';

/**
 * 作図面が無いと形そのものが決まらない道具(§2.4)。
 *
 * model の `resolveSketch` が 3D スケッチで断るフィーチャー(点列・矩形・正多角形・長穴・
 * 楕円)と、作図面の中の 2 次元の幾何で中心を求める道具(円・2 点+半径の円弧)を並べる。
 * **使える側の一覧ではなく使えない側の一覧**にしてあるのは、立体の道具や基準ジオメトリの
 * 道具のように作図面に依らない道具を、足すたびにここへ書き足さずに済ませるため。
 */
const PLANE_BOUND_TOOLS: Readonly<Partial<Record<NumericInputToolId, true>>> = {
  pointArray: true,
  circle: true,
  twoPointArc: true,
  rectangle: true,
  polygon: true,
  slot: true,
  ellipse: true,
  // オフセット(FR-321、タスク21)。側(外/内・左/右)の判定に作図面の法線を使うため、
  // 3D スケッチ(作図面なし)では使えない。
  offset: true,
  // 複製系(FR-324、タスク24)のうち、作図面の向きが要るもの。
  // ミラーは「作図面の軸で折り返す」「線を含み作図面に垂直な平面で折り返す」のどちらも
  // 作図面を使い、直線配列の向きは作図面の第1軸から測る角度、円形配列の回す軸は作図面の
  // 法線なので、いずれも 3D スケッチでは決まらない(model の `copyMath.ts` も同じ理由で断る)。
  // **複写(平行移動)だけは 3D スケッチでも使える**ので入れない(ΔZ の欄が増える)。
  mirror: true,
  linearArray: true,
  circularArray: true,
  // 投影・交差(FR-325、タスク27)。投影先の面・切り口の面が作図面そのものなので、
  // 作図面が無い 3D スケッチでは行き先が決まらない(model の `resolveSketch` も同じ理由で
  // 「作図面がありません」と断る)。
  projectedCurve: true,
  planeSection: true,
};

/**
 * 3D スケッチで立体の頂点を直に押して点にできる道具(FR-330、タスク14・36)。
 *
 * 3D スケッチで作れる 5 種(点・線分・円弧・スプライン・面)のうち、位置を 1 点ずつ
 * 押して決める 4 つに加え、3 点の円弧(タスク36、2026-09-04 追加要件)。面は既にある要素を
 * 選んで囲む道具なので、頂点そのものは押さない。
 */
const VERTEX_PICKING_TOOLS: Readonly<Partial<Record<NumericInputToolId, true>>> = {
  point: true,
  line: true,
  arc: true,
  spline: true,
  threePointArc: true,
};

/**
 * その作図面でその道具を使えないときの断り(NFR-UX-5)。使えるなら null。
 * 3D スケッチ以外では常に null(作図面があればどの道具も使える)。
 */
export function freeSketchToolRejection(
  planeId: WorkPlaneId,
  tool: NumericInputToolId,
): string | null {
  if (!isFreeWorkPlaneId(planeId)) {
    return null;
  }
  return PLANE_BOUND_TOOLS[tool] === true ? t('freeSketch.error.needsWorkPlane') : null;
}

/** 3D スケッチで、押した場所の立体の頂点を点にできる道具か(FR-330)。 */
export function picksSolidVertices(planeId: WorkPlaneId, tool: NumericInputToolId): boolean {
  return isFreeWorkPlaneId(planeId) && VERTEX_PICKING_TOOLS[tool] === true;
}

/**
 * その作図面で選べる座標の指定方法(§0.a-0.5)。
 *
 * 極座標の角度と仰角は「作図面の第1軸から測った角度」なので、作図面が無い 3D スケッチでは
 * 基準そのものが無い。隠して絶対と相対の 2 つだけにする(NFR-UX-5「無効な指定を出さない」)。
 */
export function coordinateModesFor(planeId: WorkPlaneId): readonly CoordinateMode[] {
  if (!isFreeWorkPlaneId(planeId)) {
    return COORDINATE_MODES;
  }
  return COORDINATE_MODES.filter((mode) => mode !== 'polar');
}

/**
 * 3D スケッチで、立体の頂点でも既にある点でもない場所を押したときに点を置く面
 * (計画書タスク14 の「画面クリックの方式」)。
 *
 * **直前に置いた点を通り、画面に正対する(視線に垂直な)面**とする。まだ 1 点も置いて
 * いなければ原点を通る面になる。
 *
 * 統括の既定案「XY 平面(z=0)への投影」から変えた理由は 2 つ。①水平に近い視点では
 * XY 平面と視線がほぼ平行になり、押しても点が決まらない(交点が求まらない、わずかな
 * 手ぶれで数 m 先へ飛ぶ)。視線に垂直な面なら、どの視点からでも押した場所がそのまま
 * 点になる。②立体の頂点(たとえば高さ 10mm の角)を押した続きで空いた場所を押したとき、
 * z=0 へ落ちると高さが勝手に変わる。同じ面の上に留まるほうが「見えているところに置いた」
 * に一致する(NFR-UX-1、NFR-UX-2)。
 *
 * 面の id は `FREE_WORK_PLANE_ID`。保存される作図面ではなく、押した場所を世界座標へ
 * 直したり 3D スケッチの円弧の向きを決めたりするための一時的な面であることを、
 * id で見分けられるようにしている。
 */
export function freeClickPlane(base: Vec3, viewDirection: Vec3): WorkPlane {
  if (lengthVec3(viewDirection) <= 0) {
    // 視線が求まらないときは床と同じ向きの面へ落とす(原点だけ base へ寄せる)。
    return { ...WORK_PLANES.xy, id: FREE_WORK_PLANE_ID, origin: base };
  }
  // 法線はカメラを向く向き(視線の逆)。第1軸・第2軸の決め方は model の規約に任せる。
  const normal = scaleVec3(normalizeVec3(viewDirection), -1);
  const { axisU, axisV } = planeAxesFor(normal);
  return { id: FREE_WORK_PLANE_ID, origin: base, axisU, axisV, normal };
}
