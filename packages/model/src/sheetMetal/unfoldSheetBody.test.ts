import { exactExpressionValueFromNumber as n } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { curveSamplePoints } from '../sketch/curvePlaneSamples.js';
import type { ResolvedCurve } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { resolveRectangularFlange, type ResolvedSheetBody } from './resolveSheetGeometry.js';
import { rigidSheetCurve } from './rigidCurve.js';
import { unfoldSheetBody, type SheetFlatGeometry } from './unfoldSheetBody.js';
import { closedSheetLoop } from './testing/closedSheetLoop.js';

function fixture(angle = 90) {
  const points: readonly Vec3[] = [[0, 0, 0], [20, 0, 0], [20, 50, 0], [0, 50, 0]];
  const outer: ResolvedCurve[] = points.map((from, i) => ({ kind: 'segment', featureId: `side${i}`, from, to: points[(i + 1) % 4] }));
  const hole: ResolvedCurve = { kind: 'arc', featureId: 'hole', center: [10, 25, 0], normal: [0, 0, 1], xAxis: [1, 0, 0], radius: 2, startAngle: 0, endAngle: Math.PI * 2 };
  const source: ResolvedSheetBody = { rootFeatureId: 'base', rule: { thickness: n(2), innerRadius: n(3), kFactor: n(0.4) }, bends: [],
    panels: [{ id: 'base-panel', normal: [0, 0, 1], outer, holes: [[hole]] }] };
  const result = resolveRectangularFlange({ kind: 'sheetFlange', id: 'flange', name: 'U曲げ', suppressed: false, targetFeatureId: 'base',
    edges: [0, 2].map((i) => ({ panelId: 'base-panel', boundaryId: JSON.stringify(['sheet-edge', `side${i}`, 0]) })),
    length: n(30), angle: n(angle), startOffset: n(0), endOffset: n(0), lengthBasis: 'tangent', profile: null,
    rule: { innerRadius: null, kFactor: null } }, source, 'source');
  if (!result.ok) throw new Error(result.message);
  return result.value.body;
}
function bounds(flat: SheetFlatGeometry) {
  const points = flat.panels.flatMap((panel) => panel.outer.flatMap(curveSamplePoints));
  return [0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis])) - Math.min(...points.map((point) => point[axis])));
}

describe('P10 平面パネルと円筒曲げの展開', () => {
  it('角筒の継ぎ目を接線で切り、固定面と継ぎ目を変えても4曲げ分の材料を残す', () => {
    const body = closedSheetLoop();
    expect(unfoldSheetBody(body, 'wall-0', []).ok).toBe(false);
    for (const fixed of body.panels) for (const seam of body.bends) {
      const result = unfoldSheetBody(body, fixed.id, [seam.id]); if (!result.ok) throw new Error(result.message);
      expect(result.value.panels).toHaveLength(4); expect(result.value.bends).toHaveLength(4); expect(result.value.joins).toHaveLength(3);
      const bands = result.value.bends.flatMap((bend) => bend.panel === null ? [] : [bend.panel]);
      const all = { ...result.value, panels: [...result.value.panels, ...bands] }, size = bounds(all);
      expect(size[0]).toBeCloseTo(20, 9); expect(size[1]).toBeCloseTo(80 + 7.6 * Math.PI, 9);
      expect(result.value.bends.find((bend) => bend.id === seam.id)?.seamPanelId).toBe(seam.childPanelId);
    }
  });
  it.each([90, -90])('%d°のU板を独立計算の展開長へ開き、固定面を変えても寸法と穴を保持する', (angle) => {
    const body = fixture(angle), before = JSON.stringify(body);
    for (const fixed of body.panels) {
      const result = unfoldSheetBody(body, fixed.id, []); if (!result.ok) throw new Error(result.message);
      expect(result.value.panels).toHaveLength(3); expect(result.value.bends).toHaveLength(2);
      const size = bounds(result.value);
      expect(size[0]).toBeCloseTo(20, 10); expect(size[1]).toBeCloseTo(121.9380520836412, 9); expect(size[2]).toBeCloseTo(0, 10);
      for (const bend of result.value.bends) {
        expect(bend.allowance).toBeCloseTo(5.969026041820607, 10);
        expect(bend.angle).toBe(angle); expect(bend.panel?.outer).toHaveLength(4);
        expect(Math.hypot(bend.to[0] - bend.from[0], bend.to[1] - bend.from[1])).toBeCloseTo(20, 10);
      }
      const hole = result.value.panels.find((panel) => panel.id === 'base-panel')?.holes[0][0];
      expect(hole?.kind).toBe('arc'); if (hole?.kind !== 'arc') throw new Error('円の穴が必要です');
      expect(hole.radius).toBe(2); expect(hole.endAngle).toBe(Math.PI * 2); expect(hole.center[2]).toBeCloseTo(0, 10);
    }
    expect(JSON.stringify(body)).toBe(before);
  });
  it('0°は中立長ゼロで帯を生成せず、平板全長110を保つ', () => {
    const result = unfoldSheetBody(fixture(0), 'base-panel', []); if (!result.ok) throw new Error(result.message);
    expect(bounds(result.value)).toEqual([20, 110, 0]);
    expect(result.value.bends.every((bend) => bend.panel === null && bend.allowance === 0)).toBe(true);
  });
  it('単一の斜め平板で円・楕円・スプラインの穴の方式と座標を維持する', () => {
    const source = fixture().panels[0];
    const curve: ResolvedCurve = { kind: 'spline', featureId: 's', mode: 'interpolate', closed: true,
      points: [[4, 10, 0], [8, 10, 0], [8, 14, 0], [4, 14, 0]] };
    const ellipse: ResolvedCurve = { kind: 'ellipse', featureId: 'e', center: [10, 35, 0], normal: [0, 0, 1], majorAxis: [1, 0, 0], majorRadius: 3, minorRadius: 2, startAngle: 0, endAngle: Math.PI * 2 };
    const from = { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1] } as const;
    const to = { origin: [10, 20, 30], xAxis: [0, 1, 0], yAxis: [0, 0, 1], normal: [1, 0, 0] } as const;
    const map = (item: ResolvedCurve) => rigidSheetCurve(item, from, to);
    const body = { ...fixture(), bends: [], panels: [{ ...source, normal: to.normal, outer: source.outer.map(map), holes: [...source.holes, [curve], [ellipse]].map((loop) => loop.map(map)) }] };
    const result = unfoldSheetBody(body, source.id, []); if (!result.ok) throw new Error(result.message);
    expect(bounds(result.value)).toEqual([20, 50, 0]);
    expect(result.value.panels[0].holes[1][0]).toEqual(curve);
    expect(result.value.panels[0].holes[2][0]).toEqual(ellipse);
  });
  it('固定面の消失、未知の継ぎ目、分離、周回、平面外の穴を明示して断る', () => {
    const body = fixture();
    expect(unfoldSheetBody(body, 'missing', []).ok).toBe(false);
    expect(unfoldSheetBody(body, 'base-panel', ['missing']).ok).toBe(false);
    const detached = unfoldSheetBody(body, 'base-panel', [body.bends[0].id]);
    if (detached.ok) throw new Error('分離を断る必要があります'); expect(detached.message).toContain('複数');
    const cycle = unfoldSheetBody({ ...body, bends: [...body.bends, { ...body.bends[0], id: 'cycle' }] }, 'base-panel', []);
    if (cycle.ok) throw new Error('周回を断る必要があります'); expect(cycle.message).toContain('周回');
    const panel = body.panels[0], hole = panel.holes[0][0]; if (hole.kind !== 'arc') throw new Error('円が必要です');
    expect(unfoldSheetBody({ ...body, panels: [{ ...panel, holes: [[{ ...hole, center: [10, 25, 1] }]] }, ...body.panels.slice(1)] }, 'base-panel', []).ok).toBe(false);
  });
});
