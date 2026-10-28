import { beforeAll, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { expectWithinBudget } from '@pointercad/test-utils';
import type { CurveSpec, PrimitiveShapeSpec, Vec3Tuple } from '../types.js';
import { readBrepBytes, writeBrepBytes } from './brepBytes.js';
import { createAllocations } from './allocations.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makePrimitive } from './makePrimitive.js';
import { makeSheetMetalBase } from './makeSheetMetalBase.js';
import { makeThreadCut, makeThreadHole } from './makeThread.js';
import { measureMassProperties } from './measureShape.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import { collectSubShapes } from './subShapes.js';
import { tessellate } from './tessellate.js';
import { transformShape } from './transformShape.js';

let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await loadOcctForNode(); });

it.each(['sphere', 'cylinder'] as const)('%sの体積・重心・慣性を500ms以内で測る', (kind) => {
  const shape = kind === 'sphere' ? { kind, radius: 10 } : { kind, radius: 10, height: 20 };
  const handle = makePrimitive(oc, { kind: 'primitive', origin: [0, 0, 0], axis: [0, 0, 1], shape, originQuery: null, targetKey: null });
  try {
    const start = performance.now();
    const measured = measureMassProperties(oc, handle.shape);
    const elapsed = performance.now() - start;
    const volume = kind === 'sphere' ? 4000 * Math.PI / 3 : 2000 * Math.PI;
    expect(measured.volume).toBeCloseTo(volume, 6);
    expect(measured.centreOfMass[2]).toBeCloseTo(kind === 'sphere' ? 0 : 10, 8);
    const moments = [...measured.principalMoments].sort((a, b) => a - b);
    const expected = kind === 'sphere' ? [40 * volume, 40 * volume, 40 * volume] : [50 * volume, 700 / 12 * volume, 700 / 12 * volume];
    for (const [i, value] of expected.entries()) expect(moments[i] / value).toBeCloseTo(1, 6);
    console.log(`[実測] ${kind}の体積・重心・慣性: ${elapsed.toFixed(2)}ms / 上限500ms`);
    expectWithinBudget(elapsed, 500, `${kind}の質量特性`);
  } finally { handle.delete(); }
});

it('実らせんの体積・慣性を500ms以内で測り、測定前のB-repを変えない', () => {
  const handle = makeThreadCut(oc, [20, 15, 10], [0, 0, -1], { majorDiameter: 6, pitch: 1, length: 2 }, 6 - 1.0825317547305482);
  try {
    const before = writeBrepBytes(oc, handle.shape);
    const start = performance.now();
    const volume = measureVolume(oc, handle.shape);
    const measured = measureMassProperties(oc, handle.shape);
    const elapsed = performance.now() - start;
    expect(volume).toBeGreaterThan(0);
    expect(measured.volume).toBeCloseTo(volume, 9);
    expect(measured.principalMoments.every((moment) => Number.isFinite(moment) && moment > 0)).toBe(true);
    expect(writeBrepBytes(oc, handle.shape)).toEqual(before);
    console.log(`[実測] 実らせんの体積・慣性: ${elapsed.toFixed(2)}ms / 上限500ms`);
    expectWithinBudget(elapsed, 500, '実らせんの質量特性');
  } finally { handle.delete(); }
});

const rotate = (point: Vec3Tuple, axis: number): Vec3Tuple => axis === 0 ? point : axis === 1 ? [point[0], point[2], -point[1]] : [point[2], point[1], -point[0]];
const offset: Vec3Tuple = [31, -29, 43];
const moved = (point: Vec3Tuple, axis: number): Vec3Tuple => {
  const value = rotate(point, axis);
  return [value[0] + offset[0], value[1] + offset[1], value[2] + offset[2]];
};

it.each([0, 1, 2])('周期スプラインの押し出しを向き%s・平行移動後にも独立積分値で測る', (axis) => {
  const points: readonly Vec3Tuple[] = [[5, 5, 0], [15, 5, 0], [15, 15, 0], [5, 15, 0]];
  const spline: CurveSpec = { kind: 'spline', mode: 'control', closed: true, points: points.map((point) => moved(point, axis)) };
  const handle = makeSheetMetalBase(oc, { outer: [spline], holes: [], thickness: 2, reversed: false });
  try {
    const before = writeBrepBytes(oc, handle.shape);
    const measured = measureMassProperties(oc, handle.shape);
    expect(measured.volume).toBeCloseTo(1220 / 9, 7);
    for (const [i, value] of moved([10, 10, 1], axis).entries()) expect(measured.centreOfMass[i]).toBeCloseTo(value, 7);
    expect(measureVolume(oc, handle.shape)).toBeCloseTo(1220 / 9, 7);
    expect(writeBrepBytes(oc, handle.shape)).toEqual(before);
  } finally { handle.delete(); }
});

it('円穴と周期スプライン穴が同じ面にあっても、それぞれの独立面積から体積が決まる', () => {
  const points: readonly Vec3Tuple[] = [[0, 0, 0], [50, 0, 0], [50, 30, 0], [0, 30, 0]];
  const outer: readonly CurveSpec[] = points.map((from, i) => ({ kind: 'segment', from, to: points[(i + 1) % points.length] }));
  const spline: CurveSpec = { kind: 'spline', mode: 'control', closed: true, points: [[5, 5, 0], [15, 5, 0], [15, 15, 0], [5, 15, 0]] };
  const circle: CurveSpec = { kind: 'arc', center: [35, 15, 0], normal: [0, 0, 1], xAxis: [1, 0, 0], radius: 3, startAngle: 0, endAngle: 2 * Math.PI };
  const handle = makeSheetMetalBase(oc, { outer, holes: [[spline], [circle]], thickness: 2, reversed: false });
  try {
    const before = writeBrepBytes(oc, handle.shape);
    const expected = 3000 - 1220 / 9 - 18 * Math.PI;
    expect(measureVolume(oc, handle.shape)).toBeCloseTo(expected, 7);
    expect(measureMassProperties(oc, handle.shape).volume).toBeCloseTo(expected, 7);
    expect(writeBrepBytes(oc, handle.shape)).toEqual(before);
  } finally { handle.delete(); }
});

/** Disk moments of sqrt(R²-y²), independent of both the B-rep and Simpson quadrature. */
function radialBlindRemoval(radius: number, drillRadius: number, depth: number): number {
  const q = (drillRadius / radius) ** 2;
  let coefficient = 1, moment = 1, sum = 1;
  for (let n = 1; n < 32; n++) {
    coefficient *= (1.5 - n) / n * -q;
    moment *= (2 * n - 1) / (2 * (n + 1));
    sum += coefficient * moment;
  }
  // Integral cos²(t) sin^(2n)(t) = π C(2n,n) / (2·4^n·(n+1)).
  return Math.PI * drillRadius ** 2 * (radius * sum - (radius - depth));
}

it.each([false, true])('円筒側面のM6下穴を独立積分で測りB-repを保持する（剛体移動=%s）', (rigid) => {
  const { keep, release } = createAllocations();
  try {
    const cylinder = keep(makePrimitive(oc, { kind: 'primitive', origin: [0, 0, 0], axis: [0, 0, 1],
      shape: { kind: 'cylinder', radius: 10, height: 40 }, originQuery: null, targetKey: null }));
    const turned = keep(transformShape(oc, cylinder.shape, { translation: [0, 0, 0], rotationOrigin: [0, 0, 0],
      rotationAxis: [0, 1, 0], rotationAngle: rigid ? Math.PI / 6 : 0 }));
    const target = keep(transformShape(oc, turned.shape, { translation: rigid ? [40, -25, 15] : [0, 0, 0],
      rotationOrigin: [0, 0, 0], rotationAxis: [0, 0, 1], rotationAngle: rigid ? 50 * Math.PI / 180 : 0 }));
    const mesh = tessellate(oc, target.shape), lines = extractEdges(oc, target.shape);
    const faces = collectSubShapes(oc, target.shape, mesh.faceRanges, lines.edgeRanges).faces;
    const side = faces.find((face) => face.surfaceKind === 'cylinder');
    if (side === undefined) throw new Error('Missing cylinder side');
    const drilled = makeThreadHole(oc, { kind: 'thread', targetKey: 'target',
      face: { kind: 'face', index: side.index, surfaceKind: side.surfaceKind, area: side.area,
        position: side.centroid, axis: side.axis, radius: side.radius },
      centers: [], drillDiameter: 4.917, depth: 8, tiltAngle: 0, tiltAzimuth: 0, transforms: [],
      thread: null, mark: { majorDiameter: 6, length: 6 }, cylindrical: { kind: 'cylinder-face',
        locations: [{ height: 13, angle: 37 * Math.PI / 180 }, { height: 27, angle: -53 * Math.PI / 180 }] },
    }, target.shape, faces);
    const output = keep(drilled.handle);
    expect(isValidShape(oc, output.shape)).toBe(true);
    expect(hasSolid(oc, output.shape)).toBe(true);
    const before = writeBrepBytes(oc, output.shape);
    const expected = 4000 * Math.PI - 2 * radialBlindRemoval(10, 4.917 / 2, 8);
    const adaptive = [1e-7, 1e-9, 1e-11].map((eps) => {
      const properties = keep(new oc.GProp_GProps_1());
      const error = oc.BRepGProp.VolumeProperties_2(output.shape, properties, eps, false, false);
      return { eps, error, volume: properties.Mass() };
    });
    for (const row of adaptive) {
      expect(Number.isFinite(row.error) && row.error >= 0 && row.error <= row.eps).toBe(true);
      expect(Math.abs(row.volume - expected) / expected).toBeLessThan(1e-6);
    }
    const volume = measureVolume(oc, output.shape);
    const measured = measureMassProperties(oc, output.shape);
    expect(writeBrepBytes(oc, output.shape)).toEqual(before);
    console.log('[EX05 volume]', JSON.stringify({ rigid, expected, volume, adaptive,
      brepSha256: createHash('sha256').update(before).digest('hex') }));
    expect(measured.volume).toBe(volume);
    expect(Math.abs(volume - expected) / expected).toBeLessThan(1e-5);
  } finally { release(); }
});

/** Exact C1 piecewise quadratic in a cubic representation, independent of the expression sampler. */
function exactVolumeProfile(constant: number, hinge: boolean): readonly CurveSpec[] {
  const knots = [0, 2, 3, 7, 10];
  const y = (x: number) => constant + x * x / 10 + (hinge ? Math.max(0, x - 3) ** 2 / 5 : 0);
  const derivative = (x: number) => x / 5 + (hinge ? 2 * Math.max(0, x - 3) / 5 : 0);
  const points: Vec3Tuple[] = [[0, constant, 0]];
  for (let index = 0; index < knots.length - 1; index++) {
    const a = knots[index], b = knots[index + 1], third = (b - a) / 3;
    points.push([a + third, y(a) + third * derivative(a), 0], [b - third, y(b) - third * derivative(b), 0]);
  }
  points.push([10, y(10), 0]);
  return [
    { kind: 'spline', mode: 'control', degree: 3, closed: false, knots, points },
    { kind: 'segment', from: [10, y(10), 0], to: [10, 0, 0] },
    { kind: 'segment', from: [10, 0, 0], to: [0, 0, 0] },
    { kind: 'segment', from: [0, 0, 0], to: [0, constant, 0] },
  ];
}

/** Native surface inventory is diagnostic evidence, not a product routing helper. */
function volumeFaceKinds(shape: TopoDS_Shape) {
  const owned = createAllocations();
  try {
    const map = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, map, true, true);
    const result: { extrusion: boolean; spline: boolean; periodic: boolean }[] = [];
    for (let index = 1; index <= map.Size(); index++) {
      const local = createAllocations();
      try {
        const item = local.keep(map.FindKey(index));
        if (item.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_FACE) continue;
        const face = local.keep(oc.TopoDS.Face_1(item));
        const surface = local.keep(new oc.BRepAdaptor_Surface_2(face, false));
        const extrusion = surface.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_SurfaceOfExtrusion;
        const basis = extrusion ? local.keep(surface.BasisCurve()) : null;
        result.push({ extrusion, spline: basis?.get().GetType() === oc.GeomAbs_CurveType.GeomAbs_BSplineCurve,
          periodic: basis?.get().IsPeriodic() ?? false });
      } finally { local.release(); }
    }
    return result;
  } finally { owned.release(); }
}

function independentGkVolume(shape: TopoDS_Shape) {
  const properties = new oc.GProp_GProps_1();
  try {
    const error = oc.BRepGProp.VolumePropertiesGK_1(shape, properties, 1e-12, false, true, true, true, false);
    expect(Number.isFinite(error) && error >= 0 && error <= 1e-12).toBe(true);
    return properties.Mass();
  } finally { properties.delete(); }
}

it.each([
  { constant: 1, hinge: false, rigid: false },
  { constant: 2, hinge: false, rigid: true },
  { constant: 1, hinge: true, rigid: false },
  { constant: 1, hinge: true, rigid: true },
])('非周期スプライン押出を独立解析積分で照合する %j', ({ constant, hinge, rigid }) => {
  const owned = createAllocations();
  try {
    const original = owned.keep(makeSheetMetalBase(oc, { outer: exactVolumeProfile(constant, hinge), holes: [],
      thickness: 10, reversed: false, normal: [0, 0, 1] }));
    const placed = owned.keep(transformShape(oc, original.shape, { translation: rigid ? [31, -29, 43] : [0, 0, 0],
      rotationOrigin: [0, 0, 0], rotationAxis: [1, 2, 3], rotationAngle: rigid ? 0.7 : 0 }));
    const shape = placed.shape, before = writeBrepBytes(oc, shape), kinds = volumeFaceKinds(shape);
    expect(kinds.some(face => face.extrusion && face.spline && !face.periodic)).toBe(true);
    expect(isValidShape(oc, shape)).toBe(true); expect(hasSolid(oc, shape)).toBe(true);
    // H * [integral x²/10 + c + (x-3)_+²/5, x=0..10]. Hinge case is 662, not 1300/3.
    const expected = 10 * (100 / 3 + 10 * constant + (hinge ? 343 / 15 : 0));
    const fixedProps = owned.keep(new oc.GProp_GProps_1());
    oc.BRepGProp.VolumeProperties_1(shape, fixedProps, false, false, false);
    const fixed = fixedProps.Mass(), gk = independentGkVolume(shape);
    const start = performance.now(), volume = measureVolume(oc, shape), elapsed = performance.now() - start;
    const properties = measureMassProperties(oc, shape);
    const reopened = owned.keep(readBrepBytes(oc, before)), restored = independentGkVolume(reopened);
    for (const actual of [volume, properties.volume, gk, restored]) {
      expect(actual).toBeGreaterThan(0);
      expect(Math.abs(actual - expected) / expected).toBeLessThanOrEqual(1e-9);
    }
    expect(Math.abs(volume - gk) / gk).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(restored - gk) / gk).toBeLessThanOrEqual(1e-9);
    expect(properties.principalMoments.every(value => Number.isFinite(value) && value > 0)).toBe(true);
    expect(writeBrepBytes(oc, shape)).toEqual(before);
    console.log('[volume precision]', JSON.stringify({ constant, hinge, rigid, expected, fixed, gk, volume, restored, elapsed, kinds,
      brepSha256: createHash('sha256').update(before).digest('hex') }));
  } finally { owned.release(); }
});

it('同じ押出面でも楕円と周期スプラインは既存の積分経路を保つ', () => {
  const owned = createAllocations();
  const gk = vi.spyOn(oc.BRepGProp, 'VolumePropertiesGK_1');
  try {
    const ellipse: CurveSpec = { kind: 'ellipse', center: [0, 0, 0], normal: [0, 0, 1], majorAxis: [1, 0, 0],
      majorRadius: 4, minorRadius: 2, startAngle: 0, endAngle: 2 * Math.PI };
    const elliptic = owned.keep(makeSheetMetalBase(oc, { outer: [ellipse], holes: [], thickness: 10, reversed: false }));
    const periodic: CurveSpec = { kind: 'spline', mode: 'control', closed: true,
      points: [[5, 5, 0], [15, 5, 0], [15, 15, 0], [5, 15, 0]] };
    const spline = owned.keep(makeSheetMetalBase(oc, { outer: [periodic], holes: [], thickness: 2, reversed: false }));
    for (const handle of [elliptic, spline]) expect(volumeFaceKinds(handle.shape).some(face => face.extrusion)).toBe(true);
    const ellipseBefore = writeBrepBytes(oc, elliptic.shape), splineBefore = writeBrepBytes(oc, spline.shape);
    gk.mockClear();
    expect(Math.abs(measureVolume(oc, elliptic.shape) - 80 * Math.PI) / (80 * Math.PI)).toBeLessThanOrEqual(1e-9);
    expect(gk).toHaveBeenCalledTimes(1);
    expect(gk.mock.calls[0]?.slice(2)).toEqual([1e-12, false, true, false, false, false]);
    // 体積の省計算が、別callerの重心/慣性を消していないことを同じ実楕円で確かめる。
    gk.mockClear();
    const full = measureMassProperties(oc, elliptic.shape);
    expect(Math.abs(full.volume - 80 * Math.PI) / (80 * Math.PI)).toBeLessThanOrEqual(1e-9);
    expect(Math.hypot(full.centreOfMass[0], full.centreOfMass[1], Math.abs(full.centreOfMass[2]) - 5)).toBeLessThanOrEqual(1e-9);
    expect(full.principalMoments.every(value => Number.isFinite(value) && value > 0)).toBe(true);
    expect(gk).toHaveBeenCalledTimes(1);
    expect(gk.mock.calls[0]?.slice(2)).toEqual([1e-12, false, true, true, true, false]);
    gk.mockClear();
    expect(measureVolume(oc, spline.shape)).toBeCloseTo(1220 / 9, 7);
    expect(gk).not.toHaveBeenCalled();
    expect(writeBrepBytes(oc, elliptic.shape)).toEqual(ellipseBefore);
    expect(writeBrepBytes(oc, spline.shape)).toEqual(splineBefore);
  } finally { gk.mockRestore(); owned.release(); }
});

it('箱・球・円筒と認証済み平面の高速経路をGKへ広げない', () => {
  const owned = createAllocations();
  const gk = vi.spyOn(oc.BRepGProp, 'VolumePropertiesGK_1');
  try {
    const specifications: readonly PrimitiveShapeSpec[] = [
      { kind: 'box', sizeX: 10, sizeY: 20, sizeZ: 30 }, { kind: 'sphere', radius: 10 },
      { kind: 'cylinder', radius: 10, height: 20 },
    ];
    for (const [index, shape] of specifications.entries()) {
      const handle = owned.keep(makePrimitive(oc, { kind: 'primitive', origin: [0, 0, 0], axis: [0, 0, 1],
        shape, originQuery: null, targetKey: null }));
      const before = writeBrepBytes(oc, handle.shape), expected = [6000, 4000 * Math.PI / 3, 2000 * Math.PI][index];
      gk.mockClear();
      const volume = measureVolume(oc, handle.shape);
      expect(Math.abs(volume - expected) / expected).toBeLessThanOrEqual(1e-9);
      if (shape.kind === 'box') expect(measureVolume(oc, handle.shape, true)).toBe(volume);
      expect(gk).not.toHaveBeenCalled();
      expect(writeBrepBytes(oc, handle.shape)).toEqual(before);
    }
  } finally { gk.mockRestore(); owned.release(); }
});

/** 四つの三次Bezier弧をC1接続した閉じた非周期母線。制御点は入力定数。 */
function closedClampedProfile(axis: number): CurveSpec {
  const points: readonly Vec3Tuple[] = [
    [1, 0, 0], [1, 0.5, 0], [0.5, 1, 0], [-0.5, 1, 0], [-1, 0.5, 0],
    [-1, -0.5, 0], [-0.5, -1, 0], [0.5, -1, 0], [1, -0.5, 0], [1, 0, 0],
  ];
  return { kind: 'spline', mode: 'control', closed: false, degree: 3, knots: [0, 1, 2, 3, 4],
    points: points.map(point => axis === 0 ? point : moved(point, axis)) };
}

it.each([0, 2])('閉じた非周期母線の測定用コピーを分割して独立面積と照合する: 向き%s', (axis) => {
  const handle = makeSheetMetalBase(oc, { outer: [closedClampedProfile(axis)], holes: [], thickness: 3,
    reversed: false, normal: rotate([0, 0, 1], axis) });
  const before = writeBrepBytes(oc, handle.shape);
  const original = oc.BRepGProp.VolumePropertiesGK_1.bind(oc.BRepGProp);
  const sameInputs: boolean[] = [];
  const gk = vi.spyOn(oc.BRepGProp, 'VolumePropertiesGK_1').mockImplementation((...args) => {
    sameInputs.push(args[0].IsSame(handle.shape));
    return original(...args);
  });
  try {
    expect(isValidShape(oc, handle.shape)).toBe(true);
    expect(hasSolid(oc, handle.shape)).toBe(true);
    expect(volumeFaceKinds(handle.shape).some(face => face.extrusion && face.spline && !face.periodic)).toBe(true);
    // 第1象限はx=1-3t²/2+t³/2、y=3t/2-t³/2。
    // Greenの面積積分(1/2)∮(x dy-y dx)=4*61/80=61/20、体積は高さ3倍。
    const expected = 183 / 20;
    const volume = measureVolume(oc, handle.shape);
    const full = measureMassProperties(oc, handle.shape);
    for (const actual of [volume, full.volume]) {
      expect(actual).toBeGreaterThan(0);
      expect(Math.abs(actual - expected) / expected).toBeLessThanOrEqual(1e-9);
    }
    const centre: Vec3Tuple = axis === 0 ? [0, 0, 1.5] : moved([0, 0, 1.5], axis);
    for (const [index, value] of centre.entries()) expect(Math.abs(full.centreOfMass[index] - value)).toBeLessThanOrEqual(1e-9);
    expect(full.principalMoments.every(value => Number.isFinite(value) && value > 0)).toBe(true);
    expect(sameInputs).toEqual([false, false]);
    expect(gk.mock.calls.map(call => call.slice(2))).toEqual([
      [1e-12, false, true, false, false, false], [1e-12, false, true, true, true, false],
    ]);
    expect(writeBrepBytes(oc, handle.shape)).toEqual(before);
  } finally { gk.mockRestore(); handle.delete(); }
});

it('閉じた非周期母線を分割してもGK精度不足を拒否し借用形を変えない', () => {
  const handle = makeSheetMetalBase(oc, { outer: [closedClampedProfile(0)], holes: [], thickness: 3,
    reversed: false, normal: [0, 0, 1] });
  const before = writeBrepBytes(oc, handle.shape);
  const gk = vi.spyOn(oc.BRepGProp, 'VolumePropertiesGK_1').mockReturnValue(1.1e-12);
  try {
    expect(() => measureVolume(oc, handle.shape)).toThrow('立体の体積を必要な精度で計算できませんでした。');
    expect(gk).toHaveBeenCalledTimes(1);
    expect(writeBrepBytes(oc, handle.shape)).toEqual(before);
  } finally { gk.mockRestore(); handle.delete(); }
});
