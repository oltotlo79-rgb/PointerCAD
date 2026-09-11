/** 独立した4平面と4四分円の角筒。外半径5、板厚2、直線部20、幅20。 */
import { exactExpressionValueFromNumber as n } from '@pointercad/expression';
import type { ResolvedCurve } from '../../sketch/types.js';
import { addVec3, scaleVec3, type Vec3 } from '../../sketch/vec3.js';
import type { SheetTangentFrame } from '../panelGeometry.js';
import type { ResolvedSheetBody } from '../resolveSheetGeometry.js';

export function closedSheetLoop(): ResolvedSheetBody {
  const frames: readonly SheetTangentFrame[] = [
    { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1] },
    { origin: [0, 25, 5], xAxis: [1, 0, 0], yAxis: [0, 0, 1], normal: [0, -1, 0] },
    { origin: [0, 20, 30], xAxis: [1, 0, 0], yAxis: [0, -1, 0], normal: [0, 0, -1] },
    { origin: [0, -5, 25], xAxis: [1, 0, 0], yAxis: [0, 0, -1], normal: [0, 1, 0] },
  ];
  const point = (frame: SheetTangentFrame, x: number, y: number): Vec3 => addVec3(frame.origin, addVec3(scaleVec3(frame.xAxis, x), scaleVec3(frame.yAxis, y)));
  return { rootFeatureId: 'tube', rule: { thickness: n(2), innerRadius: n(3), kFactor: n(0.4) },
    panels: frames.map((frame, panel) => {
      const points = [point(frame, 0, 0), point(frame, 20, 0), point(frame, 20, 20), point(frame, 0, 20)];
      const outer: ResolvedCurve[] = points.map((from, i) => ({ kind: 'segment', featureId: `wall-${panel}-edge-${i}`, from, to: points[(i + 1) % 4] }));
      return { id: `wall-${panel}`, normal: frame.normal, outer, holes: [] };
    }),
    bends: frames.map((frame, i) => ({ id: `corner-${i}`, parentPanelId: `wall-${i}`, childPanelId: `wall-${(i + 1) % 4}`,
      parentEdge: { from: point(frame, 20, 20), to: point(frame, 0, 20) },
      childEdge: { from: point(frames[(i + 1) % 4], 0, 0), to: point(frames[(i + 1) % 4], 20, 0) },
      frame: { ...frame, origin: point(frame, 0, 20) }, width: 20, angle: 90, radius: 3, kFactor: 0.4, allowance: 1.9 * Math.PI })),
  };
}
