import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CurveSpec, Vec3Tuple } from '../types.js';
import { createAllocations, type Allocations } from './allocations.js';
import { booleanOp } from './booleanOp.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makePlanarFace } from './makePlanarFace.js';
import { makeSheetMetalBase } from './makeSheetMetalBase.js';
import { makeSheetMetalLBend } from './makeSheetMetalBend.js';
import { makeSheetMetalBody } from './makeSheetMetalBody.js';
import { boundingBoxRange } from './placeBodies.js';
import { recognizeSheetMetal } from './recognizeSheetMetal.js';
import { crossVec, dotVec, lengthVec, subVec } from './sketchCorner.js';
import { collectSubShapes } from './subShapes.js';
import { tessellate } from './tessellate.js';
import { APPROXIMATION_TOLERANCE_MM, exceedsMagnitude, GEOMETRIC_CONFUSION_MM } from './tolerances.js';
import { makeCompound } from './transformShape.js';

const X: Vec3Tuple = [1, 0, 0], Y: Vec3Tuple = [0, 1, 0], Z: Vec3Tuple = [0, 0, 1];
const MINUS_Y: Vec3Tuple = [0, -1, 0], MINUS_Z: Vec3Tuple = [0, 0, -1];
const DIRECTION_TOLERANCE = 1e-12;
const dimensions = { thickness: 2, radius: 3, width: 20, firstLength: 50, secondLength: 30 };
type Solution = Extract<ReturnType<typeof recognizeSheetMetal>, { ok: true }>;
let oc: OpenCascadeInstance;
let owned: Allocations;
beforeAll(async () => { oc = await loadOcctForNode(); });
beforeEach(() => { owned = createAllocations(); });
afterEach(() => { owned.release(); });

function lengthEqual(delta: number): boolean {
  return Number.isFinite(delta) && !exceedsMagnitude(delta, GEOMETRIC_CONFUSION_MM);
}
function directionEqual(delta: number): boolean {
  return Number.isFinite(delta) && !exceedsMagnitude(delta, DIRECTION_TOLERANCE);
}
function mm(actual: number, expected: number): void {
  expect(lengthEqual(actual - expected), `expected ${expected} mm, received ${actual} mm`).toBe(true);
}
function point(actual: Vec3Tuple, expected: Vec3Tuple): void { mm(lengthVec(subVec(actual, expected)), 0); }
function direction(actual: Vec3Tuple, expected: Vec3Tuple): void {
  expect(directionEqual(lengthVec(subVec(actual, expected))), `expected ${expected.join(', ')}, received ${actual.join(', ')}`).toBe(true);
}
function faces(shape: TopoDS_Shape) {
  return collectSubShapes(oc, shape, tessellate(oc, shape).faceRanges, extractEdges(oc, shape).edgeRanges).faces;
}
function reference(shape: TopoDS_Shape, normal: Vec3Tuple, through: Vec3Tuple): number {
  const matches = faces(shape).filter(face => face.surfaceKind === 'plane' && face.axis
    && directionEqual(lengthVec(subVec(face.axis, normal))) && lengthEqual(dotVec(subVec(face.centroid, through), normal)));
  expect(matches.map(face => face.index), 'oriented reference plane').toHaveLength(1);
  return matches[0].index;
}
function recognize(shape: TopoDS_Shape, normal: Vec3Tuple = MINUS_Z, through: Vec3Tuple = [0, 0, 0]) {
  return recognizeSheetMetal(oc, shape, reference(shape, normal, through));
}
function solution(result: ReturnType<typeof recognizeSheetMetal>): Solution {
  if (!result.ok) throw new Error(`Expected a sheet, received ${result.reason}`);
  mm(result.thickness, 2);
  return result;
}
function lShape(angle = 90): TopoDS_Shape { return owned.keep(makeSheetMetalLBend(oc, { ...dimensions, angle })).shape; }
function polygon(points: Vec3Tuple[]): CurveSpec[] {
  return points.map((from, i) => ({ kind: 'segment', from, to: points[(i + 1) % points.length] }));
}
function prism(outer: CurveSpec[], holes: CurveSpec[][] = []): TopoDS_Shape {
  const face = owned.keep(makePlanarFace(oc, outer, {}, undefined, undefined, holes));
  const vector = owned.keep(new oc.gp_Vec_4(20, 0, 0));
  const maker = owned.keep(new oc.BRepPrimAPI_MakePrism_1(face.face, vector, false, true));
  expect(maker.IsDone()).toBe(true);
  return owned.keep(maker.Shape());
}
// yz section viewed along +x. Angles are measured from +y toward +z.
function line(y1: number, z1: number, y2: number, z2: number): CurveSpec {
  return { kind: 'segment', from: [0, y1, z1], to: [0, y2, z2] };
}
function arc(y: number, z: number, radius: number, start: number, end: number): CurveSpec {
  return { kind: 'arc', center: [0, y, z], normal: X, xAxis: Y, radius,
    startAngle: start * Math.PI / 180, endAngle: end * Math.PI / 180 };
}
function modifiedL(kind: 'taper' | 'round' | 'eccentric', offset = 0): TopoDS_Shape {
  const back = kind === 'round' ? [line(offset, 2, -49, 2), arc(-49, 1, 1, 90, 180), line(-50, 1, -50, 0)]
    : [line(offset, 2, -50, kind === 'taper' ? 1 : 2), line(-50, kind === 'taper' ? 1 : 2, -50, 0)];
  return prism([line(-50, 0, 0, 0), arc(0, 5, 5, -90, 0), line(5, 5, 5, 35),
    line(5, 35, 3 + offset, 35), line(3 + offset, 35, 3 + offset, 5), arc(offset, 5, 3, 0, -90), ...back]);
}
function twoBends(): TopoDS_Shape {
  const panel = (points: Vec3Tuple[], normal: Vec3Tuple) => ({ outer: polygon(points), holes: [], thickness: 2, reversed: false, normal });
  return owned.keep(makeSheetMetalBody(oc, {
    panels: [
      panel([[0, -50, 0], [20, -50, 0], [20, 0, 0], [0, 0, 0]], Z),
      panel([[0, 5, 5], [20, 5, 5], [20, 5, 35], [0, 5, 35]], MINUS_Y),
      panel([[0, 8, 38], [20, 8, 38], [20, 33, 38], [0, 33, 38]], Z),
    ],
    bends: [
      { kind: 'rectangle', thickness: 2, radius: 3, width: 20, angle: 90, frame: { origin: [0, 0, 0], xAxis: X, yAxis: Y, normal: Z } },
      { kind: 'rectangle', thickness: 2, radius: 3, width: 20, angle: -90, frame: { origin: [0, 5, 35], xAxis: X, yAxis: Z, normal: MINUS_Y } },
    ],
  })).shape;
}
function box(low: Vec3Tuple, high: Vec3Tuple): TopoDS_Shape {
  const a = owned.keep(new oc.gp_Pnt_3(...low)), b = owned.keep(new oc.gp_Pnt_3(...high));
  return owned.keep(owned.keep(new oc.BRepPrimAPI_MakeBox_4(a, b)).Shape());
}
function bore(z: number): TopoDS_Shape {
  const origin = owned.keep(new oc.gp_Pnt_3(10, -25, z)), axis = owned.keep(new oc.gp_Dir_4(...Z));
  const axes = owned.keep(new oc.gp_Ax2_3(origin, axis));
  return owned.keep(owned.keep(new oc.BRepPrimAPI_MakeCylinder_3(axes, 3, 5)).Shape());
}
function cut(tool: TopoDS_Shape): TopoDS_Shape {
  return owned.keep(booleanOp(oc, 'subtract', lShape(), tool)).shape;
}
function expectEnvelope(shape: TopoDS_Shape): void {
  const bounds = owned.keep(new oc.Bnd_Box_1());
  oc.BRepBndLib.AddOptimal(shape, bounds, false, false);
  bounds.SetGap(0);
  const range = boundingBoxRange(bounds);
  point(range.min, [0, -50, 0]);
  point(range.max, [20, 5, 35]);
}
function checkBends(sheet: Solution, angles: number[], axis: Vec3Tuple = X): void {
  expect(sheet.panels).toHaveLength(angles.length + 1);
  expect(sheet.bends).toHaveLength(angles.length);
  sheet.bends.forEach((bend, i) => {
    const radians = (bend.angleDegrees - angles[i]) * Math.PI / 180;
    expect(directionEqual(radians), `bend ${i} angle ${bend.angleDegrees}`).toBe(true);
    mm(bend.radius, 3);
    mm(bend.width, 20);
    direction(bend.axis, axis);
    expect(bend.fromFaceIndex).toBe(sheet.panels[i].faceIndex);
    expect(bend.toFaceIndex).toBe(sheet.panels[i + 1].faceIndex);
    expect(bend.innerFaceIndex).not.toBe(bend.outerFaceIndex);
    for (const tangent of [bend.fromTangent, bend.toTangent]) {
      const delta = subVec(tangent.to, tangent.from);
      mm(lengthVec(delta), 20);
      mm(dotVec(delta, axis), 20);
    }
  });
}
function checkCircle(panel: Solution['panels'][number], center: Vec3Tuple): void {
  expect(panel.holes).toHaveLength(1);
  const arcs = panel.holes[0].map(item => item.curve);
  let sweep = 0;
  for (const curve of arcs) {
    if (curve.kind !== 'arc') throw new Error('Expected a circular hole');
    mm(curve.radius * 2, 6);
    point(curve.center, center);
    sweep += (curve.endAngle - curve.startAngle) * dotVec(curve.normal, panel.inward);
  }
  expect(directionEqual(sweep + 2 * Math.PI), 'clockwise hole about inward').toBe(true);
}
function checkRectangle(panel: Solution['panels'][number], side: number): void {
  expect(panel.outer).toHaveLength(4);
  const edges = panel.outer.map(item => {
    if (item.curve.kind !== 'segment') throw new Error('Expected a straight panel boundary');
    return item.curve;
  });
  const lengths = edges.map((edge, i) => {
    point(edge.to, edges[(i + 1) % edges.length].from);
    return lengthVec(subVec(edge.to, edge.from));
  }).sort((a, b) => a - b);
  lengths.forEach((length, i) => mm(length, i < 2 ? 20 : side));
  const origin = edges[0].from;
  const twiceArea = edges.reduce((area, edge) =>
    area + dotVec(crossVec(subVec(edge.from, origin), subVec(edge.to, origin)), panel.inward), 0);
  mm(twiceArea / (2 * side), 20);
}

describe('実立体からの板金認識', () => {
  it('円穴付き平板の外周と内周を基準面から読む', () => {
    const outer = polygon([[0, 0, 0], [50, 0, 0], [50, 20, 0], [0, 20, 0]]);
    const hole: CurveSpec = { kind: 'arc', center: [25, 10, 0], normal: Z, xAxis: X, radius: 3, startAngle: 0, endAngle: 2 * Math.PI };
    const shape = owned.keep(makeSheetMetalBase(oc, { outer, holes: [[hole]], thickness: 2, reversed: false, normal: Z })).shape;
    const sheet = solution(recognize(shape));
    checkBends(sheet, []);
    direction(sheet.panels[0].inward, Z);
    checkRectangle(sheet.panels[0], 50);
    checkCircle(sheet.panels[0], [25, 10, 0]);
  });
  it.each([90, -90, 45, -135])('符号付き%d度の曲げを読む', angle => {
    const sheet = solution(recognize(lShape(angle)));
    checkBends(sheet, [angle]);
    direction(sheet.panels[0].inward, Z);
    const theta = angle * Math.PI / 180;
    direction(sheet.panels[1].inward, [0, -Math.sin(theta), Math.cos(theta)]);
    checkRectangle(sheet.panels[0], 50);
    checkRectangle(sheet.panels[1], 30);
    point(sheet.bends[0].fromTangent.from, [0, 0, 0]);
    expect(sheet.panels.every(panel => panel.holes.length === 0)).toBe(true);
  });
  it('基準面を表裏逆に選ぶと板厚方向と角度の符号が反転する', () => {
    const sheet = solution(recognize(lShape(), Z, [0, 0, 2]));
    checkBends(sheet, [-90], [-1, 0, 0]);
    direction(sheet.panels[0].inward, MINUS_Z);
    point(sheet.bends[0].fromTangent.from, [20, 0, 2]);
  });
  it('二つの曲げと三枚のパネルを基準面から順にたどる', () => {
    const sheet = solution(recognize(twoBends()));
    checkBends(sheet, [90, -90]);
    sheet.panels.forEach((panel, i) => checkRectangle(panel, [50, 30, 25][i]));
    direction(sheet.panels[1].inward, MINUS_Y);
    direction(sheet.panels[2].inward, Z);
    point(sheet.bends[0].toTangent.from, [0, 5, 5]);
    point(sheet.bends[1].fromTangent.from, [0, 5, 35]);
    point(sheet.bends[1].toTangent.from, [0, 8, 38]);
  });
  it('回転と平行移動後の座標で接線・軸・板厚方向を返す', () => {
    const transform = owned.keep(new oc.gp_Trsf_1());
    transform.SetValues(0, 0, 1, 7, 1, 0, 0, -11, 0, 1, 0, 13);
    const moved = owned.keep(lShape().Moved(owned.keep(new oc.TopLoc_Location_2(transform)), true));
    const sheet = solution(recognize(moved, [-1, 0, 0], [7, -11, 13]));
    checkBends(sheet, [90], Y);
    direction(sheet.panels[0].inward, X);
    point(sheet.bends[0].fromTangent.from, [7, -11, 13]);
    point(sheet.bends[0].toTangent.from, [12, -11, 18]);
  });
  it.each([['taper', 'variableThickness'], ['round', 'unsupportedBend']] as const)(
    '同じ外寸の %s を %s として断る', (kind, reason) => {
      const shape = modifiedL(kind);
      expectEnvelope(shape);
      expect(recognize(shape)).toEqual({ ok: false, reason });
    });
  it('幅の途中で接線を越える切り欠きを断る', () => {
    const shape = cut(box([-1, -1, -1], [4, 2, 6]));
    expectEnvelope(shape);
    expect(recognize(shape)).toEqual({ ok: false, reason: 'cutAcrossBend' });
  });
  it('平板に収まる貫通穴を残す', () => {
    const shape = cut(bore(-1));
    expectEnvelope(shape);
    const sheet = solution(recognize(shape));
    checkBends(sheet, [90]);
    checkCircle(sheet.panels[0], [10, -25, 0]);
    expect(sheet.panels[1].holes).toHaveLength(0);
  });
  it('底の残る穴を断る', () => {
    const shape = cut(bore(1));
    expect(recognize(shape)).toEqual({ ok: false, reason: 'variableThickness' });
  });
  it('半周を占める同軸円筒曲げを断る', () => {
    const shape = prism([line(-50, 0, 0, 0), arc(0, 5, 5, -90, 90), line(0, 10, -30, 10),
      line(-30, 10, -30, 8), line(-30, 8, 0, 8), arc(0, 5, 3, 90, -90),
      line(0, 2, -50, 2), line(-50, 2, -50, 0)]);
    expect(recognize(shape)).toEqual({ ok: false, reason: 'unsupportedBend' });
  });
  it('軸のずれが公差の半分なら曲げを認識する', () => {
    const sheet = solution(recognize(modifiedL('eccentric', APPROXIMATION_TOLERANCE_MM / 2)));
    checkBends(sheet, [90]);
    direction(sheet.panels[1].inward, MINUS_Y);
  });
  it.each([2 * APPROXIMATION_TOLERANCE_MM, 0.25])('平行でも軸線間距離 %d mm の円筒対を断る', offset => {
    expect(recognize(modifiedL('eccentric', offset))).toEqual({ ok: false, reason: 'unsupportedBend' });
  });
  it('離れた二立体を含む元を断る', () => {
    const source = owned.keep(makeCompound(oc, [lShape(), box([40, 0, 0], [45, 5, 5])]));
    expect(recognizeSheetMetal(oc, source.shape, 0)).toEqual({ ok: false, reason: 'invalidSource' });
  });
  it('基準面に円筒を選ぶと表裏を決められない', () => {
    const shape = lShape(), curved = faces(shape).find(face => face.surfaceKind === 'cylinder');
    if (!curved) throw new Error('Expected a cylindrical bend face');
    expect(recognizeSheetMetal(oc, shape, curved.index)).toEqual({ ok: false, reason: 'ambiguousPair' });
  });
  it('楕円の平板境界を断る', () => {
    const ellipse: CurveSpec = { kind: 'ellipse', center: [0, 0, 0], normal: Z, majorAxis: X, majorRadius: 10, minorRadius: 5 };
    const shape = owned.keep(makeSheetMetalBase(oc, { outer: [ellipse], holes: [], thickness: 2, reversed: false, normal: Z })).shape;
    expect(recognize(shape)).toEqual({ ok: false, reason: 'unsupportedBoundary' });
  });
  it('四つの曲げが閉路を作る角管を断る', () => {
    const loop = (r: number) => [line(0, -r, 20, -r), arc(20, 0, r, -90, 0),
      line(20 + r, 0, 20 + r, 15), arc(20, 15, r, 0, 90), line(20, 15 + r, 0, 15 + r),
      arc(0, 15, r, 90, 180), line(-r, 15, -r, 0), arc(0, 0, r, 180, 270)];
    const shape = prism(loop(5), [loop(3)]);
    expect(recognize(shape, MINUS_Z, [0, 0, -5])).toEqual({ ok: false, reason: 'unsupportedConnection' });
  });
});
