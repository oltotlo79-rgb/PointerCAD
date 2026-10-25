import { exactExpressionValueFromNumber as n } from '@pointercad/expression';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildBooleanShape } from '../../../kernel/src/occt/buildBooleanShape.js';
import { makeSheetMetalBendBand } from '../../../kernel/src/occt/makeSheetMetalBend.js';
import type { SheetMetalBodyInput } from '../../../kernel/src/occt/makeSheetMetalBody.js';
import { makeSheetMetalCurvedPanel } from '../../../kernel/src/occt/makeSheetMetalCurvedPanel.js';
import { countSheetMetalSolids } from '../../../kernel/src/occt/sheetMetalJoin.js';

import { createAllocations } from '../../../kernel/src/occt/allocations.js';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { makeSheetMetalBase } from '../../../kernel/src/occt/makeSheetMetalBase.js';
import { makeSheetMetalBody } from '../../../kernel/src/occt/makeSheetMetalBody.js';
import { isValidShape, measureVolume } from '../../../kernel/src/occt/solidMesh.js';
import type { ResolvedCurve, ResolvedSegment } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { addVec3, distanceVec3, dotVec3, scaleVec3, subVec3 } from '../sketch/vec3.js';
import { connectLineBendRegions } from './connectLineBendRegions.js';
import { sheetLineBendPlan } from './lineBendPlan.js';
import type { ResolvedSheetBody } from './resolveSheetGeometry.js';

import type { SheetPanelGeometry, SheetTangentFrame } from './panelGeometry.js';
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

function expectNoMaterialOverlap(plan: SheetMetalBodyInput): void {
  const owned = createAllocations();
  try {
    const parts = plan.panels.map((panel) => owned.keep(makeSheetMetalBase(oc, panel)));
    for (const band of plan.bends) parts.push(owned.keep(band.kind === 'rectangle'
      ? makeSheetMetalBendBand(oc, band) : makeSheetMetalCurvedPanel(oc, band)));
    let overlapCount = 0;
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
      const pair = createAllocations();
      try {
        const range = pair.keep(new oc.Message_ProgressRange_1());
        const common = buildBooleanShape(oc, 'intersect', parts[i].shape, [parts[j].shape], range, pair);
        overlapCount += countSheetMetalSolids(oc, common);
      } finally { pair.release(); }
    }
    expect(overlapCount, '材料部材の共通ソリッド数').toBe(0);
  } finally { owned.release(); }
}

function nativeVertices(shape: Parameters<typeof countSheetMetalSolids>[1]): readonly Vec3[] {
  const owned = createAllocations(), vertices: Vec3[] = [];
  try {
    const map = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, map, true, true);
    for (let index = 1; index <= map.Size(); index++) {
      const subShape = owned.keep(map.FindKey(index));
      if (subShape.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_VERTEX) continue;
      const vertex = owned.keep(oc.TopoDS.Vertex_1(subShape)), point = owned.keep(oc.BRep_Tool.Pnt(vertex));
      vertices.push([point.X(), point.Y(), point.Z()]);
    }
    return vertices;
  } finally { owned.release(); }
}

function expectNativeTangencies(shape: Parameters<typeof countSheetMetalSolids>[1], frame: SheetTangentFrame,
  angle: number, side: 'left' | 'right', kFactor: number): void {
  const vertices = nativeVertices(shape);
  const theta = Math.abs(angle) * Math.PI / 180, sign = Math.sign(angle), direction = side === 'right' ? 1 : -1;
  const allowance = theta * (3 + kFactor * 2), startY = 15 - direction * allowance / 2;
  const radius = angle > 0 ? 3 + 2 : 3;
  const endY = startY + direction * radius * Math.sin(theta), endZ = sign * radius * (1 - Math.cos(theta));
  // 入力座標と円の式だけから、接線の内外各端点をdoubleで求める。
  for (const x of [0, 40]) for (const offset of [0, 2]) {
    const points: readonly Vec3[] = [[x, startY, offset],
      [x, endY - direction * sign * Math.sin(theta) * offset, endZ + Math.cos(theta) * offset]];
    for (const local of points) {
      const coordinate = (axis: number) => frame.origin[axis] + frame.xAxis[axis] * local[0]
        + frame.yAxis[axis] * local[1] + frame.normal[axis] * local[2];
      const expected: Vec3 = [coordinate(0), coordinate(1), coordinate(2)];
      expect(Math.min(...vertices.map((vertex) => distanceVec3(expected, vertex))), '独立接線点とnative頂点の距離mm')
        .toBeLessThanOrEqual(1e-6);
    }
  }
}

function expectConnectionPoints(body: ResolvedSheetBody): void {
  const pointDistance = (point: Vec3, curves: readonly ResolvedCurve[]): number => Math.min(...curves.flatMap((curve) => {
    if (curve.kind !== 'segment') return [];
    const vector = subVec3(curve.to, curve.from), lengthSquared = dotVec3(vector, vector);
    const ratio = Math.max(0, Math.min(1, dotVec3(subVec3(point, curve.from), vector) / lengthSquared));
    return [distanceVec3(point, addVec3(curve.from, scaleVec3(vector, ratio)))];
  }));
  for (const bend of body.bends) {
    const parent = body.panels.find((panel) => panel.id === bend.parentPanelId);
    const child = body.panels.find((panel) => panel.id === bend.childPanelId);
    if (parent === undefined || child === undefined) throw new Error('接続先が必要です');
    for (const [panel, contacts] of [[parent, bend.parentContacts ?? [bend.parentEdge]],
      [child, bend.childContacts ?? [bend.childEdge]]] as const) {
      expect(contacts.length).toBeGreaterThan(0);
      for (const contact of contacts) for (const point of [contact.from, contact.to])
        expect(pointDistance(point, panel.outer), '接続点から実パネル境界までの距離mm').toBeLessThanOrEqual(1e-6);
    }
  }
}

describe('指定線での曲げを実OCCTへつなぐ', () => {
  const cases = [90, -90].flatMap((angle) => [{ plane: 'XY', frame: flat }, { plane: 'YZ', frame: yz }]
    .flatMap(({ plane, frame }) => (['left', 'right'] as const).map((side) => ({ angle, plane, frame, side }))));
  it.each(cases)('角度$angle・$side固定・$plane平面で、穴を横断する曲げが閉じた1立体になる', ({ angle, frame, side }) => {
      const source: SheetPanelGeometry = { id: 'source', outer: rectangle.map((curve) => rigidSheetCurve(curve, flat, frame)),
        holes: [[rigidSheetCurve(circle, flat, frame)]], normal: frame.normal };
      const sourceBefore = JSON.stringify(source);
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
        const allowance = Math.abs(angle) * Math.PI / 180 * (3 + 0.4 * 2);
        const originalArea = 40 * 30 - Math.PI * 4 ** 2;
        const expectedVolume = 2 * (originalArea - bandArea) + 2 * bandArea * (3 + 2 / 2) / (3 + 0.4 * 2);
        expect(expectedVolume).toBeGreaterThan(0);
        expect(Math.abs(measureVolume(oc, shape) - expectedVolume) / expectedVolume).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(value.metrics.bendAllowance - allowance)).toBeLessThanOrEqual(1e-9);
        const connected = connectLineBendRegions(value, 'bend'); if (!connected.ok) throw new Error(connected.message);
        expectConnectionPoints({ rootFeatureId: 'source', rule: { thickness: n(2), innerRadius: n(3), kFactor: n(0.4) },
          panels: [...value.fixed, ...value.moving], bends: connected.value });
        expectNoMaterialOverlap(sheetLineBendPlan(value));
        expectNativeTangencies(shape, frame, angle, side, 0.4);
        expect(Math.abs(before - 2 * originalArea) / (2 * originalArea)).toBeLessThanOrEqual(1e-9);
        expect(JSON.stringify(source)).toBe(sourceBefore);

        expect(isValidShape(oc, shape)).toBe(true);
        expect(measureVolume(oc, shape)).toBeCloseTo(2 * (1200 - 16 * Math.PI + (4 / 3.8 - 1) * bandArea), 5);
        expect(measureVolume(oc, original.shape)).toBe(before);
      } finally { release(); }
  });

  it.each([0, 0.4, 0.5].flatMap((kFactor) => [-90, 90].map((angle) => ({ kFactor, angle }))))(
    'K=$kFactor・$angle度の帯を独立円環体積で照合し、K=0.5だけ元板体積を保つ', ({ kFactor, angle }) => {
      const source: SheetPanelGeometry = { id: 'k-source', normal: flat.normal, outer: rectangle, holes: [] };
      const rule = { ...input, kFactor, angle }, before = JSON.stringify({ source, rule, line });
      const result = partitionSheetLineBend(source, line, angle < 0 ? 'left' : 'right', rule, 'k-bend');
      if (!result.ok) throw new Error(result.message);
      const plan = sheetLineBendPlan(result.value), owned = createAllocations();
      try {
        const body = owned.keep(makeSheetMetalBody(oc, plan));
        const theta = Math.abs(angle) * Math.PI / 180, allowance = theta * (3 + 2 * kFactor);
        const originalArea = 40 * 30, bandArea = 40 * allowance;
        const bandVolume = 40 * 2 * theta * (3 + 2 / 2);
        const expected = 2 * (originalArea - bandArea) + bandVolume;
        expect(expected).toBeGreaterThan(0);
        expect(Math.abs(body.volume - expected) / expected).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(result.value.metrics.bendAllowance - allowance)).toBeLessThanOrEqual(1e-9);
        if (kFactor === 0.5) expect(Math.abs(body.volume - 2400) / 2400).toBeLessThanOrEqual(1e-9);
        else {
          expect(body.volume).toBeGreaterThan(2400);
          expect(Math.abs(body.volume - 2400 - 2 * bandArea * ((3 + 1) / (3 + 2 * kFactor) - 1)))
            .toBeLessThanOrEqual(expected * 1e-9);
        }
        expect(isValidShape(oc, body.shape)).toBe(true);
        expect(countSheetMetalSolids(oc, body.shape)).toBe(1);
        expectNoMaterialOverlap(plan);
        expectNativeTangencies(body.shape, flat, angle, angle < 0 ? 'left' : 'right', kFactor);
        expect(JSON.stringify({ source, rule, line })).toBe(before);
      } finally { owned.release(); }
  });
});
