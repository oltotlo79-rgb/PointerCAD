/** 固定OCCT bindingの列挙値と引数型のずれを、登録値の実体を検査して吸収する。 */
import type { GeomAbs_Shape, OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';

function isRegisteredC1(value: unknown, registry: unknown): value is GeomAbs_Shape {
  return typeof registry === 'function' && 'GeomAbs_C1' in registry && registry.GeomAbs_C1 === value
    && typeof value === 'object' && value !== null && value instanceof registry
    && 'value' in value && typeof value.value === 'number' && Number.isInteger(value.value);
}
/** 2026-09-11 PM判断: BuildCurves3dの精度指定に限って使用する。型抑止・無条件castをしない。 */
export function curveC1Continuity(oc: OpenCascadeInstance): GeomAbs_Shape {
  const registry: unknown = oc.GeomAbs_Shape, value: unknown = oc.GeomAbs_Shape.GeomAbs_C1;
  if (!isRegisteredC1(value, registry)) throw new Error('曲線精度を指定するOCCTの連続性を確認できませんでした。');
  return value;
}
