import { beforeAll, describe, expect, it } from 'vitest';
import { createAllocations } from '../../../kernel/src/occt/allocations.js';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { makeSheetMetalBase } from '../../../kernel/src/occt/makeSheetMetalBase.js';
import { makeSheetMetalBody } from '../../../kernel/src/occt/makeSheetMetalBody.js';
import { isValidShape, measureVolume } from '../../../kernel/src/occt/solidMesh.js';
import type { ResolvedCurve, ResolvedSegment } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import type { SheetPanelGeometry } from './panelGeometry.js';
import { partitionSheetLineBend } from './partitionLineBend.js';
import { rigidSheetCurve } from './rigidCurve.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);
function polygon(points: readonly Vec3[]): readonly ResolvedCurve[] {
  return points.map((from, i) => ({ kind: 'segment', featureId: `edge-${i}`, from, to: points[(i + 1) % points.length] }));
}
const flat = { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1] } as const;
const yz = { origin: [10, 20, 30], xAxis: [0, 1, 0], yAxis: [0, 0, 1], normal: [1, 0, 0] } as const;
const input = { thickness: 2, radius: 3, kFactor: 0.4, angle: 90 };
const circle: ResolvedCurve = { kind: 'arc', featureId: 'hole', center: [20, 15, 0], radius: 4,
  normal: [0, 0, 1], xAxis: [1, 0, 0], startAngle: 0, endAngle: 2 * Math.PI };
const rectangle = polygon([[0, 0, 0], [40, 0, 0], [40, 30, 0], [0, 30, 0]]);
const line: ResolvedSegment = { kind: 'segment', featureId: 'line', from: [0, 15, 0], to: [40, 15, 0] };

describe('指定線での曲げを実OCCTへつなぐ', () => {
  const cases = [90, -90].flatMap((angle) => [{ plane: 'XY', frame: flat }, { plane: 'YZ', frame: yz }]
    .flatMap(({ plane, frame }) => (['left', 'right'] as const).map((side) => ({ angle, plane, frame, side }))));
  it.each(cases)('角度$angle・$side固定・$plane平面で、穴を横断する曲げが閉じた1立体になる', ({ angle, frame, side }) => {
      const source: SheetPanelGeometry = { id: 'source', outer: rectangle.map((curve) => rigidSheetCurve(curve, flat, frame)),
        holes: [[rigidSheetCurve(circle, flat, frame)]], normal: frame.normal };
      const axis = rigidSheetCurve(line, flat, frame); if (axis.kind !== 'segment') throw new Error('直線が必要です');
      const result = partitionSheetLineBend(source, axis, side, { ...input, angle }, 'bend'); if (!result.ok) throw new Error(result.message);
      const value = result.value, { keep, release } = createAllocations();
      try {
        const plate = (panel: SheetPanelGeometry) => keep(makeSheetMetalBase(oc, { outer: panel.outer, holes: panel.holes,
          normal: panel.normal, thickness: 2, reversed: false }));
        const original = plate(source), before = measureVolume(oc, original.shape);
        const { shape } = keep(makeSheetMetalBody(oc, {
          panels: [...value.fixed, ...value.moving].map((panel) => ({ outer: panel.outer, holes: panel.holes, normal: panel.normal, thickness: 2, reversed: false })),
          bends: value.bands.map((band) => ({ kind: 'profile', frame: value.frame, ...input, angle,
            neutralRadius: value.metrics.neutralRadius, outer: band.outer, holes: band.holes })),
        }));
        // 中央帯に入る円の面積は2*(h*sqrt(r²-h²)+r²*asin(h/r))。
        const half = 1.9 * Math.PI / 2, holeBand = 2 * (half * Math.sqrt(16 - half * half) + 16 * Math.asin(half / 4));
        const bandArea = 40 * 1.9 * Math.PI - holeBand;
        expect(isValidShape(oc, shape)).toBe(true);
        expect(measureVolume(oc, shape)).toBeCloseTo(2 * (1200 - 16 * Math.PI + (4 / 3.8 - 1) * bandArea), 5);
        expect(measureVolume(oc, original.shape)).toBe(before);
      } finally { release(); }
  });
});
