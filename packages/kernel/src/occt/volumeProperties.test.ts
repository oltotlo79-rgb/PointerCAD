import { beforeAll, expect, it } from 'vitest';
import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { expectWithinBudget } from '@pointercad/test-utils';
import type { CurveSpec, Vec3Tuple } from '../types.js';
import { writeBrepBytes } from './brepBytes.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makePrimitive } from './makePrimitive.js';
import { makeSheetMetalBase } from './makeSheetMetalBase.js';
import { makeThreadCut } from './makeThread.js';
import { measureMassProperties } from './measureShape.js';
import { measureVolume } from './solidMesh.js';

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
