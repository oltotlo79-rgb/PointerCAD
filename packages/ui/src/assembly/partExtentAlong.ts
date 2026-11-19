/**
 * 寸法で動かす(配置の補助 P-A)の測り方: 部品の範囲を、向き d に沿って測る(向きとの内積の [最小, 最大])。
 * - 外接箱を向きへ写すと、丸い物・回した部品で大きく出るので使わない(統括の決定 2026-11-19: 案 B。世界の軸の向きも同じ測り方)。
 *   アルミフレーム・鋼材・機械要素・部品のファイルとも同じ。
 * - 式で測れる形は式の値(統括の決定 2026-11-19: 寸法で 0.2 mm のずれは受け入れない。rules/04 の数値の精度)。
 *   - 表示の網の頂点(形の上の点。平面と直線でできた所の極みは頂点そのもの)。
 *   - 円の辺(円柱・円錐・角の丸み・穴の境): 辺の持つ中心・X 軸・Y 軸・角の範囲から、向きに沿った極みを式で求める
 *     (円柱・円錐は直線で張った面なので、面の中の極みは境の辺の上にある)。
 *   - 全体の球・全体の円環(面積が全体の面積と合う時だけ): 中心から式で求める。
 * - 式で測れない形(楕円・自由な曲線の辺、一部だけの球・円環、自由な曲面)は網の点で測り、その形が網の弦のずれ
 *   (DISPLAY_MESH_DEVIATION_MM)だけ外へ出ている事があり得る分を、範囲の誤差(lowErrorMm・highErrorMm)に載せる
 *   (黙って近似を正確な値のように見せない。窓の予告が印を出す)。
 * - 部品の座標の網の頂点・辺の線は、座標の枠の原点からの相対(frameJointCheckView.ts の外接箱と同じ読み方)。辺・面の解析の値は部品の座標。
 * - 読み込んだ三角形の形(bodyKind 'mesh')は、三角形そのものが形なので網の値が正確。形の情報(面の一覧)が無いボディは、全体を網の値とする。
 * - 形の無い部品・抑制した部品・表示に無い部品は入れない(呼ぶ側は範囲が無い理由として扱う)。
 */
import {
  applyPlacementToDirection, applyPlacementToPoint, DISPLAY_MESH_DEVIATION_MM, withinMagnitude, type AssemblyDocument,
  type DimensionMoveExtent, type RigidPlacement, type SolidBody, type SolidEdgeEntry, type SolidFaceEntry, type Vec3,
} from '@pointercad/model';

import type { AssemblyView } from '../store/assemblySlice.js';

/** 測るのに使う表示の欄(部品の形の鍵と配置、形ごとのボディ)。 */
type ExtentView = Pick<AssemblyView, 'bodies'> & { readonly resolved: Pick<AssemblyView['resolved'], 'partKeys' | 'placements'> };

/** 全体の球・円環とみなす、面積の相対の合い方(これより欠けた面は一部だけの面として網で測る)。 */
const FULL_SURFACE_AREA_TOLERANCE = 1e-6;
/** 円の辺の極みの角が、角の範囲の中かを見る余裕(ラジアン)。 */
const ANGLE_TOLERANCE = 1e-12;

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** 1 つのボディを測る途中の値: 形の上の点の最小・最大(low・high)と、形が届き得る最小・最大(lowLimit・highLimit)。 */
interface Reach {
  low: number;
  high: number;
  lowLimit: number;
  highLimit: number;
}

/** 部品の座標の点(網の配列の i 番目。座標の枠の原点を足す)の、世界での向きに沿った値。 */
function meshValue(positions: ArrayLike<number>, index: number, origin: Vec3, placement: RigidPlacement, direction: Vec3): number {
  return dot(applyPlacementToPoint(placement,
    [(positions[index] ?? 0) + origin[0], (positions[index + 1] ?? 0) + origin[1], (positions[index + 2] ?? 0) + origin[2]]), direction);
}

/** 形の上の点(正確な値)を足す。 */
function addExact(reach: Reach, value: number): void {
  reach.low = Math.min(reach.low, value);
  reach.high = Math.max(reach.high, value);
}

/** 式で測れない形の網の点の範囲 [min, max] から、形が届き得る範囲(網の弦のずれだけ外)を足す。 */
function addUncertain(reach: Reach, min: number, max: number): void {
  if (min > max) return;
  reach.lowLimit = Math.min(reach.lowLimit, min - DISPLAY_MESH_DEVIATION_MM);
  reach.highLimit = Math.max(reach.highLimit, max + DISPLAY_MESH_DEVIATION_MM);
}

/** 円の辺の、向きに沿った極み(角の範囲の中の極みの角と、両端)を式で足す。 */
function addCircleArc(reach: Reach, basis: NonNullable<SolidEdgeEntry['circleBasis']>, radius: number, placement: RigidPlacement,
  direction: Vec3): void {
  const center = dot(applyPlacementToPoint(placement, basis.origin), direction);
  const a = radius * dot(applyPlacementToDirection(placement, basis.xAxis), direction);
  const b = radius * dot(applyPlacementToDirection(placement, basis.yAxis), direction);
  const [start, end] = basis.parameterRange;
  const at = (angle: number): number => center + a * Math.cos(angle) + b * Math.sin(angle);
  addExact(reach, at(start));
  addExact(reach, at(end));
  const peak = Math.atan2(b, a);
  for (const angle of [peak, peak + Math.PI]) {
    // 範囲の始めの角以上で一番小さい、同じ向きの角(2π の倍を足す)。
    const turned = angle + 2 * Math.PI * Math.ceil((start - angle) / (2 * Math.PI) - ANGLE_TOLERANCE);
    if (turned <= end + ANGLE_TOLERANCE) addExact(reach, at(turned));
  }
}

/** 辺の網の線(座標の枠の原点からの相対)の点の、向きに沿った [min, max]。 */
function edgeMeshRange(body: SolidBody, edge: SolidEdgeEntry, origin: Vec3, placement: RigidPlacement, direction: Vec3): [number, number] {
  let min = Number.POSITIVE_INFINITY, max = Number.NEGATIVE_INFINITY;
  const positions = body.mesh.edgePositions;
  for (let index = edge.segmentOffset * 6; index < (edge.segmentOffset + edge.segmentCount) * 6 && index + 2 < positions.length; index += 3) {
    const value = meshValue(positions, index, origin, placement, direction);
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return [min, max];
}

/** 面の三角形の頂点の、向きに沿った [min, max]。 */
function faceMeshRange(body: SolidBody, face: SolidFaceEntry, origin: Vec3, placement: RigidPlacement, direction: Vec3): [number, number] {
  let min = Number.POSITIVE_INFINITY, max = Number.NEGATIVE_INFINITY;
  const { indices, positions } = body.mesh;
  for (let corner = face.triangleOffset * 3; corner < (face.triangleOffset + face.triangleCount) * 3 && corner < indices.length; corner += 1) {
    const value = meshValue(positions, (indices[corner] ?? 0) * 3, origin, placement, direction);
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return [min, max];
}

/** 面積が全体の面積と合うか(全体の球・円環か)。 */
const wholeArea = (area: number, full: number): boolean => full > 0 && withinMagnitude(area - full, full * FULL_SURFACE_AREA_TOLERANCE);

/** 面の中に極みがあり得る面(球・円環・自由な曲面)を足す。全体の球・円環は式、ほかは網の点と弦のずれ。 */
function addCurvedFace(reach: Reach, body: SolidBody, face: SolidFaceEntry, origin: Vec3, placement: RigidPlacement, direction: Vec3): void {
  if (face.surfaceKind === 'plane' || face.surfaceKind === 'cylinder' || face.surfaceKind === 'cone') return;
  const torus = face.analyticSurface?.kind === 'torus' ? face.analyticSurface : null;
  if (face.surfaceKind === 'sphere' && face.radius !== null && face.axisOrigin !== undefined && face.axisOrigin !== null
    && wholeArea(face.area, 4 * Math.PI * face.radius ** 2)) {
    const center = dot(applyPlacementToPoint(placement, face.axisOrigin), direction);
    addExact(reach, center - face.radius);
    addExact(reach, center + face.radius);
    return;
  }
  if (face.surfaceKind === 'torus' && torus !== null && wholeArea(face.area, 4 * Math.PI ** 2 * torus.majorRadius * torus.minorRadius)) {
    const center = dot(applyPlacementToPoint(placement, torus.origin), direction);
    const along = dot(applyPlacementToDirection(placement, torus.axis), direction);
    const half = torus.majorRadius * Math.sqrt(Math.max(0, 1 - along * along)) + torus.minorRadius;
    addExact(reach, center - half);
    addExact(reach, center + half);
    return;
  }
  const [min, max] = faceMeshRange(body, face, origin, placement, direction);
  addUncertain(reach, min, max);
}

/** 1 つのボディを、網の頂点・円の辺の式・全体の球と円環の式で測り、式で測れない形の分を届き得る範囲に足す。 */
function reachOfBody(reach: Reach, body: SolidBody, placement: RigidPlacement, direction: Vec3): void {
  const origin = body.coordinateFrame?.origin ?? [0, 0, 0];
  const positions = body.mesh.positions;
  let min = Number.POSITIVE_INFINITY, max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index + 2 < positions.length; index += 3) {
    const value = meshValue(positions, index, origin, placement, direction);
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (min > max) return;
  addExact(reach, min);
  addExact(reach, max);
  if (body.bodyKind === 'mesh') return;
  if (body.faces.length === 0) {
    // 形の情報が無い(数え上げの上限を超えた形・古い形)。全体を網の値として扱う。
    addUncertain(reach, min, max);
    return;
  }
  for (const edge of body.edges) {
    if (edge.curveKind === 'line') continue;
    if (edge.curveKind === 'circle' && edge.circleBasis !== undefined && edge.radius !== null) {
      addCircleArc(reach, edge.circleBasis, edge.radius, placement, direction);
    } else {
      const [edgeMin, edgeMax] = edgeMeshRange(body, edge, origin, placement, direction);
      addUncertain(reach, edgeMin, edgeMax);
    }
  }
  for (const face of body.faces) addCurvedFace(reach, body, face, origin, placement, direction);
}

/** 部品の形の、向きに沿った範囲と誤差(式で測れない形が届き得る分)。点が無ければ null。 */
function extentOfBodies(bodies: readonly SolidBody[], placement: RigidPlacement, direction: Vec3): DimensionMoveExtent | null {
  const reach: Reach = { low: Number.POSITIVE_INFINITY, high: Number.NEGATIVE_INFINITY,
    lowLimit: Number.POSITIVE_INFINITY, highLimit: Number.NEGATIVE_INFINITY };
  for (const body of bodies) reachOfBody(reach, body, placement, direction);
  if (reach.low > reach.high) return null;
  return { low: reach.low, high: reach.high, lowErrorMm: Math.max(0, reach.low - reach.lowLimit),
    highErrorMm: Math.max(0, reach.highLimit - reach.high) };
}

/** 部品(ids。重なりは 1 回)の、長さ 1 の向き direction に沿った範囲。範囲が作れない部品は入れない。 */
export function partExtentsAlong(document: AssemblyDocument, view: ExtentView, direction: Vec3, ids: readonly string[]):
ReadonlyMap<string, DimensionMoveExtent> {
  const extents = new Map<string, DimensionMoveExtent>();
  for (const id of new Set(ids)) {
    const component = document.components.find((candidate) => candidate.id === id);
    const key = view.resolved.partKeys.get(id), placement = view.resolved.placements.get(id);
    if (component === undefined || component.suppressed || key === undefined || placement === undefined) continue;
    const extent = extentOfBodies(view.bodies.get(key) ?? [], placement, direction);
    if (extent !== null) extents.set(id, extent);
  }
  return extents;
}
