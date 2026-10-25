/**
 * 規格部品を穴の軸の上へ置く配置(EX-06)。
 *
 * 既存の台本(`buildStandardPart.ts`)の部品の座標に合わせる:
 * - 六角ボルト: 首下の座面が z=0、軸は +Z(頭は −Z 側)。
 * - 六角ナット・平座金・ばね座金: 下の面が z=0、厚さは +Z 側。
 * したがって部品の +Z を、ボルトは相手の板へ向かう向き、ナットと座金は板から離れる向きへ回す。
 */

import { expressionValueFromNumber } from '@pointercad/expression';

import { multiplyQuaternion, normalizeQuaternion, type Quaternion } from '../placementMath.js';
import type { Placement } from '../types.js';
import { addVec3, cleanZeroVec3, scaleVec3, type Vec3 } from '../../sketch/vec3.js';

/** X 軸まわりの 180°。+Z を −Z へ写す。 */
const HALF_TURN_X: Quaternion = [1, 0, 0, 0];

/**
 * 部品の +Z を `direction`(長さ 1)へ向ける回転。内積で +Z/−Z へ丸めず、半角の公式
 * `q = (ẑ×d, 1+ẑ·d)` を正規化する。−Z に近い側は −Z からの同じ公式に X 軸まわり 180° を
 * 合成し、`1+ẑ·d` の桁落ちを避ける(小さな傾きも真逆も失わない)。軸まわりのひねりは
 * 決めない値なので、同じ向きには常に同じ四元数を返す。
 */
export function rotationFromZ(direction: Vec3): Quaternion {
  const [x, y, z] = direction;
  if (z >= 0) return normalizeQuaternion([-y, x, 0, 1 + z]);
  // −Z から d への回転: (−ẑ×d, 1−ẑ·d) = (y, −x, 0, 1−z)。先に +Z を −Z へ回す。
  return multiplyQuaternion(normalizeQuaternion([y, -x, 0, 1 - z]), HALF_TURN_X);
}

/** `origin + direction·distance` に、+Z を `zDirection` へ向けて置く保存形の配置。 */
export function placementOnAxis(origin: Vec3, direction: Vec3, distance: number, zDirection: Vec3): Placement {
  const position = cleanZeroVec3(addVec3(origin, scaleVec3(direction, distance)));
  return {
    position: [
      expressionValueFromNumber(position[0]),
      expressionValueFromNumber(position[1]),
      expressionValueFromNumber(position[2]),
    ],
    rotation: normalizeQuaternion(rotationFromZ(zDirection)),
  };
}
