/**
 * テーパピンの簡略形状。小端の径 d から長さ ℓ でテーパ比 1/50(径が ℓ / 50 だけ太くなる)の円すい台を、原点から +Z に置く
 * (両端の丸み・面取りは入れない)。
 */
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';

import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from '../../../part/createPartDocument.js';
import type { PartDocument, PrimitiveFeature } from '../../../part/types.js';
import { origin, withName } from '../../standard/partPrimitives.js';

/** テーパ比(径の差 ÷ 長さ)。 */
const TAPER_RATIO = 1 / 50;

export function buildTaperPinPart(diameter: number, length: ExpressionValue, name: string): PartDocument | null {
  if (![diameter, length.value].every((value) => Number.isFinite(value) && value > 0)) return null;
  const empty = createEmptyPartDocument();
  const created = createPrimitiveFeature(empty, 'cone', origin(0, 0, 0));
  const cone: PrimitiveFeature = { ...created, shape: { kind: 'cone', bottomRadius: expressionValueFromNumber(diameter / 2),
    topRadius: expressionValueFromNumber((diameter + length.value * TAPER_RATIO) / 2), height: length } };
  return withName(appendSolid(empty, cone), name);
}

/** 形の台本どおりの体積(円すい台、mm³)。 */
export function taperPinVolume(diameter: number, length: number): number | null {
  if (![diameter, length].every((value) => Number.isFinite(value) && value > 0)) return null;
  const small = diameter / 2;
  const large = (diameter + length * TAPER_RATIO) / 2;
  return Math.PI * length / 3 * (small ** 2 + small * large + large ** 2);
}
