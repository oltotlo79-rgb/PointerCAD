/** OCCTの標本をdoubleのまま受け取る。描画用Float32への変換は呼出側が行う。 */
import type { OpenCascadeInstance, TopoDS_Edge } from 'opencascade.js/dist/opencascade.full.js';
import { DEFAULT_ANGULAR_DEFLECTION, DEFAULT_LINEAR_DEFLECTION, type TessellationOptions } from '../types.js';
import { createAllocations } from './allocations.js';

export function curveSampleCoordinates(oc: OpenCascadeInstance, edge: TopoDS_Edge, options: TessellationOptions = {}, limit?: number): Float64Array {
  const linear = options.linearDeflection ?? DEFAULT_LINEAR_DEFLECTION, angular = options.angularDeflection ?? DEFAULT_ANGULAR_DEFLECTION;
  if (!Number.isFinite(linear) || linear <= 0 || !Number.isFinite(angular) || angular <= 0) throw new Error('曲線の分割精度には正の有限値を指定してください。');
  const allocations = createAllocations(), { keep, release } = allocations;
  try {
    const adaptor = keep(new oc.BRepAdaptor_Curve_2(edge));
    const discretizer = keep(new oc.GCPnts_TangentialDeflection_2(adaptor, angular, linear, 2, 1e-9, 1e-7));
    const count = Number(discretizer.NbPoints());
    if (!Number.isSafeInteger(count) || count < 0 || (limit !== undefined && count > limit)) throw new Error('指定精度の曲線点数が上限を超えました。曲線を分けて書き出してください。');
    const values = new Float64Array(count * 3);
    for (let index = 1; index <= count; index++) {
      const point = discretizer.Value(index);
      try { values.set([point.X(), point.Y(), point.Z()], (index - 1) * 3); }
      finally { point.delete(); }
    }
    return values;
  } finally { release(); }
}
