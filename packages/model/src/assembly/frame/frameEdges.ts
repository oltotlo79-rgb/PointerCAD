/**
 * フレームの一括配置(J-01 包み 4): 置いた部品のまっすぐな辺(選んだ時の部品の指紋)を、世界の座標の線にする。
 * 指紋は部品の座標で、直線の辺は 中点・向き・長さ を持つ。始点 = 中点 − 長さ/2 × 向き、終点 = 中点 + 長さ/2 × 向き を、
 * 部品の配置で世界へ写す。直線でない辺(円・楕円・その他)と、向き・長さを持たない辺は線にしない(null)。
 */
import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import { addVec3, lengthVec3, scaleVec3, subVec3 } from '../../sketch/vec3.js';
import { applyPlacementToPoint, type RigidPlacement } from '../placementMath.js';
import type { FrameLine } from './frameMembers.js';

/** 直線の辺の指紋と部品の配置から、世界の座標の線(始点 → 終点の向きは指紋の向き)。直線でなければ null。 */
export function frameLineFromEdge(ref: SubShapeRef, placement: RigidPlacement): FrameLine | null {
  const print = ref.fingerprint;
  if (print.kind !== 'edge' || print.curveKind !== 'line' || print.axis === null || !(print.length > 0)) return null;
  const axisLength = lengthVec3(print.axis);
  if (!(axisLength > 0)) return null;
  const half = scaleVec3(print.axis, print.length / 2 / axisLength);
  return { start: applyPlacementToPoint(placement, subVec3(print.position, half)),
    end: applyPlacementToPoint(placement, addVec3(print.position, half)) };
}
