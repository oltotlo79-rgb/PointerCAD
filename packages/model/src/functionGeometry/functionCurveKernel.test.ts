import { beforeAll, describe, expect, it } from 'vitest';
import {
  createFunctionMathSource,
  createMathBackend,
  type MathExecutionBackend,
} from '@pointercad/expression/math/worker';


import { makeFunctionCurve, createAllocations, isValidShape, type Vec3Tuple, type FunctionClipBox } from '@pointercad/kernel';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { FunctionPlotBounds } from './functionPlotBounds.js';
import { sampleExplicitFunctionCurve, type ExplicitFunctionCurveFormula } from './sampleExplicitFunctionCurve.js';
import type { ResolvedFunctionRanges } from './resolveFunctionRanges.js';

let backend: MathExecutionBackend, oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { backend = createMathBackend(); oc = await loadOcctForNode(); }, 180_000);
function math(source: string, independent: 'X' | 'Y' | 'Z' | 'T' = 'X') {
  return createFunctionMathSource(source, 'text', 'radian', { axes: independent === 'T' ? [] : [independent],
    parameters: independent === 'T' ? ['T'] : [], coefficients: [] }, backend);
}
const box: FunctionClipBox = { minimum: [-2, -0.5, -1], maximum: [2, 2, 1] };
function ranges(bounds = box): ResolvedFunctionRanges {
  const checked = FunctionPlotBounds.read({ X: { min: bounds.minimum[0], max: bounds.maximum[0] },
    Y: { min: bounds.minimum[1], max: bounds.maximum[1] }, Z: { min: bounds.minimum[2], max: bounds.maximum[2] } });
  if (!checked.ok) throw new Error(JSON.stringify(checked));
  return { bounds: checked.bounds, tolerance: 0.001, parameters: [], fixedCoordinate: null };
}
function samples(shape: Parameters<typeof isValidShape>[1]): readonly (readonly Vec3Tuple[])[] {
  const { keep, release } = createAllocations();
  try {
    const map = keep(new oc.TopTools_IndexedMapOfShape_1()); oc.TopExp.MapShapes_2(shape, map, true, true);
    const result: Vec3Tuple[][] = [];
    for (let index = 1; index <= map.Size(); index++) {
      const element = keep(map.FindKey(index));
      if (element.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_EDGE) continue;
      const adaptor = keep(new oc.BRepAdaptor_Curve_2(keep(oc.TopoDS.Edge_1(element))));
      const points: Vec3Tuple[] = [];
      for (let n = 0; n <= 128; n++) {
        const point = keep(adaptor.Value(adaptor.FirstParameter() + (adaptor.LastParameter() - adaptor.FirstParameter()) * n / 128));
        points.push([point.X(), point.Y(), point.Z()]);
      }
      result.push(points);
    }
    return result;
  } finally { release(); }
}
function create(formula: ExplicitFunctionCurveFormula, resolved = ranges()) {
  const sample = sampleExplicitFunctionCurve(formula, resolved, { backend, coefficients: [], shouldStop: () => undefined,
    identity: { documentId: 'curve-kernel', documentVersion: 1, editorId: 'function', inputRevision: 1 } });
  if (sample.status !== 'ready') throw new Error(JSON.stringify(sample));
  const bounds = resolved.bounds.toJSON();
  return makeFunctionCurve(oc, { components: sample.components.map(component => component.map(point => point.point)),
    bounds: { minimum: [bounds.X.min, bounds.Y.min, bounds.Z.min], maximum: [bounds.X.max, bounds.Y.max, bounds.Z.max] } });
}

describe('有限XYZの関数入力から実CADの曲線へ接続する（ADD-4）', () => {
  it.each([
    ['X^2', 2],
    ['tensorelement(tensorproduct([X,X^2],[1,2]),[2,1])', 1],
  ] as const)('%sの曲線自体をY境界で切り、全ての内点・端点が指定範囲と原関数の精度を満たす', (source, maximumY) => {
    const limits: FunctionClipBox = { ...box, maximum: [2, maximumY, 1] };
    const curve = create({ kind: 'coordinate-curve', independent: 'X', outputs: { Y: math(source), Z: math('0') } }, ranges(limits));
    if (curve.status !== 'shape') throw new Error('Expected CAD curve');
    try {
      expect(isValidShape(oc, curve.shape)).toBe(true);
      const components = samples(curve.shape); expect(components).toHaveLength(1);
      for (const [x, y, z] of components.flat()) {
        expect(x).toBeGreaterThanOrEqual(-2-1e-6); expect(x).toBeLessThanOrEqual(2+1e-6);
        expect(y).toBeGreaterThanOrEqual(-0.5-1e-6); expect(y).toBeLessThanOrEqual(maximumY+1e-6);
        expect(Math.abs(y-x*x)).toBeLessThanOrEqual(0.001); expect(z).toBeCloseTo(0, 10);
      }
      expect(components[0][0][1]).toBeCloseTo(maximumY, 8); expect(components[0].at(-1)?.[1]).toBeCloseTo(maximumY, 8);
      expect(Math.abs(components[0][0][0])).toBeCloseTo(Math.sqrt(maximumY), 3);
      expect(Math.abs(components[0].at(-1)?.[0] ?? NaN)).toBeCloseTo(Math.sqrt(maximumY), 3);
      for (const component of components) for (const point of component) {
        expect(point[2]).toBeGreaterThanOrEqual(-1); expect(point[2]).toBeLessThanOrEqual(1);
      }
    } finally { curve.delete(); }
  });

  it('無限に続く双曲線の2枝をCADの段階でも分け、端点だけを境界へクランプしない', () => {
    const limits: FunctionClipBox = { minimum: [-2, -3, -1], maximum: [2, 3, 1] };
    const curve = create({ kind: 'coordinate-curve', independent: 'X', outputs: { Y: math('1/X'), Z: math('0') } }, ranges(limits));
    if (curve.status !== 'shape') throw new Error('Expected hyperbola');
    try {
      const components = samples(curve.shape); expect(components).toHaveLength(2);
      for (const component of components) {
        expect(component.every(point => Math.sign(point[0]) === Math.sign(component[0][0]))).toBe(true);
        for (const [x, y] of component) { expect(Math.abs(y-1/x)).toBeLessThanOrEqual(0.001); expect(Math.abs(y)).toBeLessThanOrEqual(3+1e-6); }
      }
      expect(components.flat().some(point => Math.abs(Math.abs(point[1])-3) < 1e-6)).toBe(true);
    } finally { curve.delete(); }
  });

  it('媒介変数Tの広い範囲で作っても、らせんの実CAD辺はZ境界で切り取る', () => {
    const lower = 0, upper = 4*Math.PI;
    const base = ranges({ minimum: [-2, -2, 0.2], maximum: [2, 2, 0.8] });
    const curve = create({ kind: 'parametric-curve', outputs: { X: math('cos(T)', 'T'), Y: math('sin(T)', 'T'), Z: math('T/(2*pi)', 'T') },
      T: { min: { source: '0', value: lower, display: '0' }, max: { source: '4*pi', value: upper, display: String(upper) } } },
    { ...base, parameters: [{ parameter: 'T', range: { min: lower, max: upper } }] });
    if (curve.status !== 'shape') throw new Error('Expected clipped helix');
    try {
      const component = samples(curve.shape)[0];
      expect(component[0][2]).toBeCloseTo(0.2, 8); expect(component.at(-1)?.[2]).toBeCloseTo(0.8, 8);
      for (const [x, y, z] of component) {
        expect(z).toBeGreaterThanOrEqual(0.2-1e-6); expect(z).toBeLessThanOrEqual(0.8+1e-6);
        expect(Math.hypot(x-Math.cos(z*2*Math.PI), y-Math.sin(z*2*Math.PI))).toBeLessThanOrEqual(0.001);
      }
    } finally { curve.delete(); }
  });

  it('XYZの不正範囲を断った後も、取消後も、次の正しい生成が成立する', () => {
    const components: readonly (readonly Vec3Tuple[])[] = [[[0,0,0],[1,1,0]]];
    expect(() => makeFunctionCurve(oc, { components, bounds: { minimum: [NaN,0,0], maximum: [1,1,1] } })).toThrow();
    let checks = 0;
    expect(makeFunctionCurve(oc, { components, bounds: box }, () => ++checks >= 3)).toEqual({ status: 'cancelled' });
    const valid = makeFunctionCurve(oc, { components, bounds: box });
    if (valid.status !== 'shape') throw new Error('Expected retried line');
    try { expect(isValidShape(oc, valid.shape)).toBe(true); } finally { valid.delete(); }
  });
});
