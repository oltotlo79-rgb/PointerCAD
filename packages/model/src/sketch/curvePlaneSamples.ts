import { arcPointAt, ellipsePointAt } from './intersectionMath.js';
import type { ResolvedCurve } from './types.js';
import type { Vec3 } from './vec3.js';

const ARC_PLANE_SAMPLES = 5;

/**
 * 平面の当てはめに使う標本点。円弧は中心と弧の上の数点まで見る。
 * 端点だけを見ると、端点だけが一致する別々の平面の円弧を同じ平面と誤判定する
 * (部品と板金の解決が同じ標本を使うため、partへの逆依存を持たない場所へ分離)。
 */
export function curveSamplePoints(curve: ResolvedCurve): readonly Vec3[] {
  switch (curve.kind) {
    case 'segment':
      return [curve.from, curve.to];
    case 'arc': {
      const span = curve.endAngle - curve.startAngle;
      const samples: Vec3[] = [curve.center];
      for (let index = 0; index < ARC_PLANE_SAMPLES; index += 1) {
        samples.push(
          arcPointAt(curve, curve.startAngle + (span * index) / (ARC_PLANE_SAMPLES - 1)),
        );
      }
      return samples;
    }
    case 'ellipse': {
      const span = curve.endAngle - curve.startAngle;
      const samples: Vec3[] = [curve.center];
      for (let index = 0; index < ARC_PLANE_SAMPLES; index += 1) {
        samples.push(
          ellipsePointAt(curve, curve.startAngle + (span * index) / (ARC_PLANE_SAMPLES - 1)),
        );
      }
      return samples;
    }
    case 'spline':
      // 極は点のアフィン結合なので、点が乗る平面に曲線も必ず乗る(resolveSketch と同じ理由)。
      return curve.points;
  }
}
