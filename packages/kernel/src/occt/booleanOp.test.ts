import { stdout } from 'node:process';
import { nextUpper } from './analysisSurfaceCertificate.js';
import * as volumeModule from './volumeProperties.js';
import type {
  BRepAlgoAPI_BooleanOperation,
  OpenCascadeInstance,
  TopoDS_Shape,
} from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { BooleanOperation, BooleanStepSpec, BoxParameters, Vec3Tuple } from '../types.js';
import type { OcctDeletable } from './allocations.js';
import * as allocationModule from './allocations.js';
import {
  booleanOp,
  NOTHING_INSIDE_MESSAGE,
  NOTHING_OUTSIDE_MESSAGE,
  NOTHING_REMOVED_MESSAGE,
  type BooleanOptions,
} from './booleanOp.js';
import { writeBrepBytes } from './brepBytes.js';
import { R22_NEAR_CONTACT, R22_THIN_SOLIDS } from './geometryAcceptanceFixtures.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import { makePrimitive } from './makePrimitive.js';
import { makeExtrudeSolid } from './makeSolidSweep.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import { countSolidShapes } from './solidTopology.js';
import { distanceBetween } from './measureShape.js';

// Independent whole-parameter oracle for this 30-degree, a=4, b=2 fixture.
// Intervals enclose knot insertion itself: no unbounded native conversion error.
type EllipseInterval = readonly [number, number];
type EllipsePoint = readonly [EllipseInterval, EllipseInterval, EllipseInterval];
interface EllipseSpan { readonly poles: readonly EllipsePoint[]; readonly width: EllipseInterval }
const ELLIPSE_BOUNDARY_MM = 5e-10;
const ei = (x: number): EllipseInterval => {
  if (!Number.isFinite(x)) throw new Error('ellipse certificate: nonfinite');
  return [x, x];
};
const ea = (a: EllipseInterval, b: EllipseInterval): EllipseInterval => [-nextUpper(-(a[0] + b[0])), nextUpper(a[1] + b[1])];
const en = (a: EllipseInterval): EllipseInterval => [-a[1], -a[0]];
const es = (a: EllipseInterval, b: EllipseInterval): EllipseInterval => ea(a, en(b));
const em = (a: EllipseInterval, b: EllipseInterval): EllipseInterval => {
  const q = [a[0] * b[0], a[0] * b[1], a[1] * b[0], a[1] * b[1]];
  return [-nextUpper(-Math.min(...q)), nextUpper(Math.max(...q))];
};
const ed = (a: EllipseInterval, b: EllipseInterval): EllipseInterval => {
  if (!(b[0] > 0)) throw new Error('ellipse certificate: denominator');
  return em(a, [-nextUpper(-1 / b[1]), nextUpper(1 / b[0])]);
};
const eabs = (a: EllipseInterval): number => Math.max(Math.abs(a[0]), Math.abs(a[1]));
const ep = (a: EllipsePoint, b: EllipsePoint, f: (x: EllipseInterval, y: EllipseInterval) => EllipseInterval): EllipsePoint =>
  [f(a[0], b[0]), f(a[1], b[1]), f(a[2], b[2])];
const escale = (a: EllipsePoint, f: EllipseInterval): EllipsePoint => [em(a[0], f), em(a[1], f), em(a[2], f)];
const chooseEllipse = (n: number, k: number): number => {
  let value = 1;
  for (let i = 1; i <= k; i++) value = value * (n - i + 1) / i;
  return Math.round(value); // n <= 16: exact integer result, far below 2^53.
};
function ellipseProduct(a: readonly EllipseInterval[], b: readonly EllipseInterval[]): EllipseInterval[] {
  const p = a.length - 1, q = b.length - 1;
  return Array.from({ length: p + q + 1 }, (_, k) => {
    let sum = ei(0);
    for (let i = Math.max(0, k - q); i <= Math.min(p, k); i++) {
      const weight = ed(ei(chooseEllipse(p, i) * chooseEllipse(q, k - i)), ei(chooseEllipse(p + q, k)));
      sum = ea(sum, em(weight, em(a[i], b[k - i])));
    }
    return sum;
  });
}
function splitEllipse(poles: readonly EllipsePoint[]): readonly [EllipsePoint[], EllipsePoint[]] {
  let row = [...poles];
  const left = [row[0]], right = [row[row.length - 1]];
  while (row.length > 1) {
    row = row.slice(1).map((p, i) => escale(ep(row[i], p, ea), ei(0.5)));
    left.push(row[0]); right.unshift(row[row.length - 1]);
  }
  return [left, right];
}
// A clamped closed spline need not use the same native speed at its two ends.
// The oriented polar phase has d|theta|/dt = |u*v' - v*u'|/(u*u + v*v) > 0.
// Its tangent is therefore representation independent, with physical units mm/radian.
function ellipsePhaseTangent(p: EllipsePoint, d: EllipsePoint): { direction: 1 | -1; tangent: EllipsePoint } {
  const radiusSquared = ea(em(p[0], p[0]), em(p[1], p[1]));
  const cross = es(em(p[0], d[1]), em(p[1], d[0]));
  const direction = cross[0] > 0 ? 1 : cross[1] < 0 ? -1 : 0;
  if (!(radiusSquared[0] > 0) || direction === 0) throw new Error('ellipse certificate: nonregular closure phase');
  return { direction, tangent: escale(d, ed(radiusSquared, direction === 1 ? cross : en(cross))) };
}

function certifyEllipseSpans(spans: readonly EllipseSpan[], cap: 0 | 10): void {
  if (spans.length === 0 || spans.length > 512) throw new Error('ellipse certificate: span budget');
  let winding = 0, orientation = 0, visits = 0;
  const difference = (a: EllipsePoint, b: EllipsePoint): number => {
    const d = ep(a, b, es);
    return Math.max(nextUpper(4 * eabs(d[0])), nextUpper(4 * eabs(d[1])), eabs(d[2]));
  };
  const tangent = (s: EllipseSpan, end: boolean): EllipsePoint => {
    const p = s.poles, n = p.length - 1;
    return escale(ep(end ? p[n] : p[1], end ? p[n - 1] : p[0], es), ed(ei(n), s.width));
  };
  for (let index = 0; index < spans.length; index++) {
    const span = spans[index], next = spans[(index + 1) % spans.length];
    if (!(span.width[0] > 0) || span.poles.length < 3 || span.poles.length > 9) throw new Error('ellipse certificate: degree/domain');
    const positionGap = difference(span.poles.at(-1)!, next.poles[0]);
    const endTangent = tangent(span, true), startTangent = tangent(next, false);
    let derivativeGap = difference(endTangent, startTangent);
    if (index + 1 === spans.length) {
      // Internal knots keep the original native-parameter C1 check. Only the identified
      // closing endpoints use their common positive phase coordinate; no seam is skipped.
      const endPhase = ellipsePhaseTangent(span.poles.at(-1)!, endTangent);
      const startPhase = ellipsePhaseTangent(next.poles[0], startTangent);
      if (endPhase.direction !== startPhase.direction) throw new Error('ellipse certificate: reversed closure phase');
      derivativeGap = difference(endPhase.tangent, startPhase.tangent);
    }
    if (positionGap > ELLIPSE_BOUNDARY_MM || derivativeGap > ELLIPSE_BOUNDARY_MM) {
      throw new Error(`ellipse certificate: C1 seam ${index} position=${positionGap} derivative=${derivativeGap}`);
    }
  }
  const visit = (p: readonly EllipsePoint[], depth: number): void => {
    if (++visits > 16384 || depth > 16) throw new Error('ellipse certificate: finite subdivision budget');
    const u = p.map(v => v[0]), v = p.map(v => v[1]), n = p.length - 1;
    const uu = ellipseProduct(u, u), vv = ellipseProduct(v, v);
    const residual = Math.max(...uu.map((x, i) => eabs(es(ea(x, vv[i]), ei(1)))));
    const zError = Math.max(...p.map(x => eabs(es(x[2], ei(cap)))));
    // Distance to radial projection on the ellipse <= a*|u²+v²-1| (denominator >= 1).
    const spatialBound = nextUpper(nextUpper(4 * residual) + zError);
    const du = u.slice(1).map((x, i) => em(ei(n), es(x, u[i])));
    const dv = v.slice(1).map((x, i) => em(ei(n), es(x, v[i])));
    const udv = ellipseProduct(u, dv), vdu = ellipseProduct(v, du);
    const cross = udv.map((x, i) => es(x, vdu[i]));
    const sign = cross.every(x => x[0] > 0) ? 1 : cross.every(x => x[1] < 0) ? -1 : 0;
    // Count crossings of a fixed non-axis ray, avoiding transcendental angle sums.
    const rayX = p.map(x => ea(x[0], em(ei(3), x[1])));
    const rayY = p.map(x => es(em(ei(3), x[1]), x[0]));
    const xp = rayX.every(x => x[0] > 0), xn = rayX.every(x => x[1] < 0);
    const yp = rayY.every(x => x[0] > 0), yn = rayY.every(x => x[1] < 0);
    const first = rayY[0], last = rayY.at(-1)!;
    const firstSign = first[0] > 0 ? 1 : first[1] < 0 ? -1 : 0;
    const lastSign = last[0] > 0 ? 1 : last[1] < 0 ? -1 : 0;
    if (!(spatialBound <= ELLIPSE_BOUNDARY_MM) || sign === 0 || !(xp || xn || yp || yn)
      || (xp && (firstSign === 0 || lastSign === 0))) {
      const halves = splitEllipse(p); visit(halves[0], depth + 1); visit(halves[1], depth + 1); return;
    }
    if (orientation !== 0 && orientation !== sign) throw new Error('ellipse certificate: reversed/nonregular traversal');
    orientation = sign;
    if (xp && firstSign !== lastSign) winding += sign;
  };
  for (const span of spans) visit(span.poles, 0);
  if (Math.abs(winding) !== 1 || winding !== orientation) throw new Error('ellipse certificate: not one full winding');
}
function ellipseBezierIntervals(degree: number, rawPoles: readonly (readonly [number, number, number])[],
  uniqueKnots: readonly number[], multiplicities: readonly number[]): EllipseSpan[] {
  if (degree < 2 || degree > 8 || rawPoles.length > 4096 || uniqueKnots.length < 2 || uniqueKnots.length > 513
    || uniqueKnots.length !== multiplicities.length) throw new Error('ellipse certificate: native data budget');
  if (multiplicities[0] !== degree + 1 || multiplicities.at(-1) !== degree + 1
    || multiplicities.slice(1, -1).some(m => !Number.isInteger(m) || m < 1 || m > degree - 1)) throw new Error('ellipse certificate: not clamped C1');
  if (uniqueKnots.some((k, i) => !Number.isFinite(k) || (i > 0 && !(k > uniqueKnots[i - 1])))) throw new Error('ellipse certificate: knot order');
  let knots = uniqueKnots.flatMap((k, i) => Array<number>(multiplicities[i]).fill(k));
  let poles: EllipsePoint[] = rawPoles.map(p => [ei(p[0]), ei(p[1]), ei(p[2])]);
  if (knots.length !== poles.length + degree + 1) throw new Error('ellipse certificate: knot/pole relation');
  for (const knot of uniqueKnots.slice(1, -1)) {
    let multiplicity = knots.filter(k => k === knot).length;
    while (multiplicity < degree) {
      const k = knots.lastIndexOf(knot), count = poles.length - 1;
      const next: EllipsePoint[] = Array<EllipsePoint>(poles.length + 1);
      for (let i = 0; i <= k - degree; i++) next[i] = poles[i]!;
      for (let i = k - multiplicity; i <= count; i++) next[i + 1] = poles[i]!;
      for (let i = k - degree + 1; i <= k - multiplicity; i++) {
        const alpha = ed(es(ei(knot), ei(knots[i])), es(ei(knots[i + degree]), ei(knots[i])));
        next[i] = ep(escale(poles[i], alpha), escale(poles[i - 1], es(ei(1), alpha)), ea);
      }
      knots = [...knots.slice(0, k + 1), knot, ...knots.slice(k + 1)]; poles = next; multiplicity++;
    }
  }
  const cosine = ellipseCosineInterval();
  poles = poles.map(p => {
    const x = es(p[0], ei(5)), y = es(p[1], ei(5));
    return [ed(ea(em(cosine, x), em(ei(0.5), y)), ei(4)),
      ed(es(em(cosine, y), em(ei(0.5), x)), ei(2)), p[2]];
  });
  if (poles.length !== (uniqueKnots.length - 1) * degree + 1) throw new Error('ellipse certificate: conversion coverage');
  return uniqueKnots.slice(1).map((k, i) => ({ poles: poles.slice(i * degree, i * degree + degree + 1), width: es(ei(k), ei(uniqueKnots[i])) }));
}

function ellipseCosineInterval(): EllipseInterval {
  // Bracket sqrt(3) by verified squared endpoints, rather than assume libm error.
  let lo = Math.sqrt(3), hi = lo;
  for (let step = 0; step < 8 && !(em(ei(lo), ei(lo))[1] < 3 && em(ei(hi), ei(hi))[0] > 3); step++) {
    lo = -nextUpper(-lo); hi = nextUpper(hi);
  }
  if (!(em(ei(lo), ei(lo))[1] < 3 && em(ei(hi), ei(hi))[0] > 3)) throw new Error('ellipse certificate: sqrt bracket');
  return ed([lo, hi], ei(2));
}

/** 大きい方の箱。原点を角とする 20 × 20 × 20 で、体積は 20·20·20 = 8000 mm³。 */
const BIG_BOX: BoxParameters = { dx: 20, dy: 20, dz: 20 };
const BIG_VOLUME = 8000;

/** 小さい方の箱。原点を角とする 10 × 10 × 10 で、体積は 10·10·10 = 1000 mm³。 */
const SMALL_BOX: BoxParameters = { dx: 10, dy: 10, dz: 10 };
const SMALL_VOLUME = 1000;

/**
 * どちらも原点を角とするので、小さい箱 (0,0,0)-(10,10,10) は
 * 大きい箱 (0,0,0)-(20,20,20) に完全に含まれる。したがって
 *   和 = 8000            (小さい箱は大きい箱の中にあるので大きい箱のまま)
 *   差 = 8000 − 1000 = 7000
 *   積 = 1000            (共通部分は小さい箱そのもの)
 * いずれも手計算した値で、実測に合わせて動かさない。
 */
const UNION_CONTAINED = BIG_VOLUME;
const SUBTRACT_CONTAINED = BIG_VOLUME - SMALL_VOLUME;
const INTERSECT_CONTAINED = SMALL_VOLUME;

/** 交わらない位置へ小さい箱を置くときのずらし量(mm)。100 > 20 なので確実に離れる。 */
const FAR_OFFSET: Vec3Tuple = [100, 0, 0];

/** 離れた 2 体の和は単純な足し算になる。8000 + 1000 = 9000。 */
const UNION_DISJOINT = BIG_VOLUME + SMALL_VOLUME;

/**
 * 半分だけ重なる配置の独立検算に使うずらし量(mm)。
 * 20 × 20 × 20 の箱を (10,10,10) ずらすと、重なりは各軸 10 mm ぶんになる。
 *   積 = 10·10·10 = 1000
 *   和 = 8000 + 8000 − 1000 = 15000  (包除原理 |A∪B| = |A| + |B| − |A∩B|)
 *   差 = 8000 − 1000 = 7000          (A から重なりを取り除いた残り)
 */
const HALF_OFFSET: Vec3Tuple = [10, 10, 10];
const HALF_INTERSECT = 10 * 10 * 10;
const HALF_UNION = BIG_VOLUME + BIG_VOLUME - HALF_INTERSECT;
const HALF_SUBTRACT = BIG_VOLUME - HALF_INTERSECT;

interface TestShapeHandle {
  readonly shape: TopoDS_Shape;
  delete(): void;
}

/** 同じ入力を貸し続けた場合と、新しい入力の結果を体積・位相で比較する。 */
function shapeMetrics(oc: OpenCascadeInstance, shape: TopoDS_Shape) {
  const { keep, release } = allocationModule.createAllocations();
  try {
    const map = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, map, true, true);
    let faces = 0;
    let edges = 0;
    for (let index = 1; index <= map.Size(); index += 1) {
      const subShape = keep(map.FindKey(index));
      if (subShape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_FACE) faces += 1;
      if (subShape.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_EDGE) edges += 1;
    }
    return { volume: measureVolume(oc, shape), faces, edges };
  } finally {
    release();
  }
}

function expectSameMetrics(
  actual: ReturnType<typeof shapeMetrics>,
  expected: ReturnType<typeof shapeMetrics>,
): void {
  expect(Math.abs(actual.volume - expected.volume) / Math.abs(expected.volume)).toBeLessThan(1e-6);
  expect(actual.faces).toBe(expected.faces);
  expect(actual.edges).toBe(expected.edges);
}

/** 控えの実物を使い、確保した各オブジェクトへの delete を個別に数える。 */
function observeAllocations(oc: OpenCascadeInstance) {
  const entries: { item: OcctDeletable; deleted: number }[] = [];
  const buildModes: boolean[] = [];
  function track<T extends OcctDeletable>(item: T): T {
    const entry = { item, deleted: 0 };
    const originalDelete = item.delete.bind(item);
    item.delete = (): void => {
      entry.deleted += 1;
      originalDelete();
    };
    entries.push(entry);
    if (item instanceof oc.BRepAlgoAPI_BooleanOperation) {
      const maker: BRepAlgoAPI_BooleanOperation = item;
      const build = maker.Build.bind(maker);
      // prototype の例外注入モックを二重に spyOn せず、実体の呼び出しだけを観測する。
      maker.Build = (range): void => {
        buildModes.push(maker.NonDestructive());
        build(range);
      };
    }
    return item;
  }

  const createAllocations = allocationModule.createAllocations;
  vi.spyOn(allocationModule, 'createAllocations').mockImplementation(() => {
    const allocations = createAllocations();
    return {
      keep<T extends OcctDeletable>(item: T): T {
        return allocations.keep(track(item));
      },
      release: allocations.release,
    };
  });
  // solidMesh の2関数は自分の finally で解放するため、その一時物も別に数える。
  const Properties = oc.GProp_GProps_1;
  vi.spyOn(oc, 'GProp_GProps_1').mockImplementation(function () {
    return track(new Properties());
  });
  const Analyzer = oc.BRepCheck_Analyzer;
  vi.spyOn(oc, 'BRepCheck_Analyzer').mockImplementation(function (
    ...args: ConstructorParameters<typeof Analyzer>
  ) {
    return track(new Analyzer(...args));
  });

  return { entries, buildModes };
}

const OPERATIONS: readonly BooleanOperation[] = ['union', 'subtract', 'intersect'];
const EXCEPTION_POINTS = [
  'Append_1',
  'SetArguments',
  'SetTools',
  'SetNonDestructive',
  'Build',
  'HasErrors',
  'IsDone',
  'Shape',
  'MapShapes_2',
  'FindKey',
  'ShapeType',
  'computeVolumeProperties',
  'Mass',
  'IsValid_2',
] as const;

function injectException(
  oc: OpenCascadeInstance,
  point: (typeof EXCEPTION_POINTS)[number],
  failure: Error,
): void {
  const fail = (): never => {
    throw failure;
  };
  switch (point) {
    case 'Append_1':
      vi.spyOn(oc.TopTools_ListOfShape.prototype, point).mockImplementation(fail);
      return;
    case 'SetArguments':
    case 'SetNonDestructive':
      vi.spyOn(oc.BRepAlgoAPI_BuilderAlgo.prototype, point).mockImplementation(fail);
      return;
    case 'SetTools':
    case 'Build':
      vi.spyOn(oc.BRepAlgoAPI_BooleanOperation.prototype, point).mockImplementation(fail);
      return;
    case 'HasErrors':
      vi.spyOn(oc.BRepAlgoAPI_Algo.prototype, point).mockImplementation(fail);
      return;
    case 'IsDone':
      vi.spyOn(oc.BRepBuilderAPI_Command.prototype, point).mockImplementation(fail);
      return;
    case 'Shape':
      vi.spyOn(oc.BRepAlgoAPI_Algo.prototype, point).mockImplementation(fail);
      return;
    case 'MapShapes_2':
      vi.spyOn(oc.TopExp, point).mockImplementation(fail);
      return;
    case 'FindKey':
      vi.spyOn(oc.TopTools_IndexedMapOfShape.prototype, point).mockImplementation(fail);
      return;
    case 'ShapeType':
      vi.spyOn(oc.TopoDS_Shape.prototype, point).mockImplementation(fail);
      return;
    case 'computeVolumeProperties':
      vi.spyOn(volumeModule, point).mockImplementation(fail);
      return;
    case 'Mass':
      vi.spyOn(oc.GProp_GProps.prototype, point).mockImplementation(fail);
      return;
    case 'IsValid_2':
      vi.spyOn(oc.BRepCheck_Analyzer.prototype, point).mockImplementation(fail);
      return;
  }
}

/**
 * 箱を平行移動して置く。
 * makeBox は原点を角とする箱しか作れないので、離れた位置や半分だけ重なる位置の箱は
 * ここで gp_Trsf の平行移動 + BRepBuilderAPI_Transform_2 で作る。
 */
function makeTranslatedBox(
  oc: OpenCascadeInstance,
  parameters: BoxParameters,
  offset: Vec3Tuple,
): TestShapeHandle {
  const box = makeBox(oc, parameters);
  const translation = new oc.gp_Trsf_1();
  const vector = new oc.gp_Vec_4(offset[0], offset[1], offset[2]);
  translation.SetTranslation_1(vector);
  // 第 3 引数 Copy = true は、元の形を書き換えずに写しを作る指定。
  const transform = new oc.BRepBuilderAPI_Transform_2(box.shape, translation, true);
  const deleteParts = (): void => {
    transform.delete();
    vector.delete();
    translation.delete();
    box.delete();
  };

  if (!transform.IsDone()) {
    deleteParts();
    throw new Error('テスト用の箱を平行移動できませんでした。');
  }
  const shape = transform.Shape();

  return {
    shape,
    delete(): void {
      shape.delete();
      deleteParts();
    },
  };
}

describe('立体の和・差・積(ブーリアン)', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  it('target-only Cutは実対象originだけを継承し工具originを推測しない', () => {
    const owned = allocationModule.createAllocations();
    try {
      const target = owned.keep(makePrimitive(oc, { kind: 'primitive', origin: [10, 10, 10], axis: [0, 0, 1],
        shape: { kind: 'box', sizeX: 20, sizeY: 20, sizeZ: 20 }, originQuery: null, targetKey: null }, 'plate'));
      const tool = owned.keep(makePrimitive(oc, { kind: 'primitive', origin: [5, 5, -1], axis: [0, 0, 1],
        shape: { kind: 'cylinder', radius: 3, height: 22 }, originQuery: null, targetKey: null }, 'drill'));
      if (target.origins?.state !== 'tracked' || tool.origins?.state !== 'tracked') {
        throw new Error('実producer originがありません');
      }
      const before = [shapeMetrics(oc, target.shape), shapeMetrics(oc, tool.shape)];
      const result = booleanOp(oc, 'subtract', target.shape, tool.shape,
        { featureId: 'hole', target: target.origins });
      try {
        expect(result.volume).toBeCloseTo(8000 - Math.PI * 9 * 20, 6);
        expect(result.origins?.state).toBe('tracked');
        if (result.origins?.state !== 'tracked') throw new Error('対象継承がありません');
        expect(result.origins.bindings.map(binding => binding.origin))
          .toEqual(target.origins.bindings.map(binding => binding.origin));
        expect(result.origins.bindings.some(binding => binding.state === 'unique'
          && binding.origin.identity.kind === 'box-face' && binding.origin.identity.role === 'top')).toBe(true);
      } finally { result.delete(); }
      expect([shapeMetrics(oc, target.shape), shapeMetrics(oc, tool.shape)]).toEqual(before);
      const refused = owned.keep(booleanOp(oc, 'subtract', target.shape, tool.shape,
        { featureId: 'hole', target: target.origins,
          tool: { version: 1, state: 'untracked', reason: 'unsupported-operation' } }));
      expect(refused.origins).toEqual({ version: 1, state: 'untracked', reason: 'unsupported-operation' });
    } finally { owned.release(); }
  });

  it.each([
    { operation: 'union', volumeFactor: 590 },
    { operation: 'subtract', volumeFactor: 410 },
    { operation: 'intersect', volumeFactor: 90 },
  ] as const)('異径円筒$operationは実producer起点を通し解析体積と借用形状を保つ', ({ operation, volumeFactor }) => {
    const owned = allocationModule.createAllocations();
    try {
      const target = owned.keep(makePrimitive(oc, { kind: 'primitive', origin: [0, 0, 0], axis: [0, 0, 1],
        shape: { kind: 'cylinder', radius: 5, height: 20 }, originQuery: null, targetKey: null }, 'target-cylinder'));
      const tool = owned.keep(makePrimitive(oc, { kind: 'primitive', origin: [0, 0, 10], axis: [0, 0, 1],
        shape: { kind: 'cylinder', radius: 3, height: 20 }, originQuery: null, targetKey: null }, 'tool-cylinder'));
      if (target.origins?.state !== 'tracked' || tool.origins?.state !== 'tracked') {
        throw new Error('native cylinder producer origins required');
      }
      expect(target.origins.bindings).toHaveLength(8);
      expect(tool.origins.bindings).toHaveLength(8);
      const before = [shapeMetrics(oc, target.shape), shapeMetrics(oc, tool.shape)];
      const result = booleanOp(oc, operation, target.shape, tool.shape,
        { featureId: 'cylinder-boolean', target: target.origins, tool: tool.origins });
      try {
        expect(result.volume).toBeCloseTo(Math.PI * volumeFactor, 6);
        expect(measureVolume(oc, result.shape)).toBeCloseTo(Math.PI * volumeFactor, 6);
        expect(isValidShape(oc, result.shape)).toBe(true);
        expect(result.origins?.state).toBe('tracked');
        if (result.origins?.state !== 'tracked') throw new Error('native cylinder Boolean origins required');
        expect(result.origins.bindings).toHaveLength(16);
        expect(result.origins.bindings.every(binding => binding.origin.identity.featureId !== 'cylinder-boolean')).toBe(true);
        expect(result.origins.bindings.some(binding => binding.state === 'unique')).toBe(true);
        console.info('CYLINDER_PRODUCT_BOOLEAN', JSON.stringify({ operation, volume: result.volume,
          states: result.origins.bindings.map(binding => binding.state) }));
      } finally { result.delete(); }
      expect([shapeMetrics(oc, target.shape), shapeMetrics(oc, tool.shape)]).toEqual(before);
    } finally { owned.release(); }
  });

  it('A∪B のあと同じ A で A−C・A∩D を作っても、新しい A と体積・面数・辺数が一致する', () => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const a = keep(makeBox(oc, BIG_BOX));
      const b = keep(makeTranslatedBox(oc, BIG_BOX, HALF_OFFSET));
      const c = keep(makeTranslatedBox(oc, SMALL_BOX, [5, 5, 5]));
      const d = keep(makeTranslatedBox(oc, BIG_BOX, [-10, 0, 0]));
      const before = shapeMetrics(oc, a.shape);
      const cases: readonly { operation: BooleanOperation; tool: TestShapeHandle; volume: number }[] = [
        { operation: 'union', tool: b, volume: HALF_UNION },
        { operation: 'subtract', tool: c, volume: SUBTRACT_CONTAINED },
        { operation: 'intersect', tool: d, volume: BIG_VOLUME / 2 },
      ];
      for (const { operation, tool, volume } of cases) {
        const result = booleanOp(oc, operation, a.shape, tool.shape);
        try {
          const fresh = keep(makeBox(oc, BIG_BOX));
          const reference = keep(booleanOp(oc, operation, fresh.shape, tool.shape));
          expectSameMetrics(shapeMetrics(oc, result.shape), shapeMetrics(oc, reference.shape));
          expect(result.volume).toBeCloseTo(volume, 6);
        } finally {
          result.delete();
        }
        expectSameMetrics(shapeMetrics(oc, a.shape), before);
      }
    } finally {
      release();
    }
  });

  it.each(OPERATIONS)('%s: 空の工具で不成立になっても同じ入力を続く差に使える', (operation) => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const a = keep(makeBox(oc, BIG_BOX));
      const empty = keep(new oc.TopoDS_Shape());
      const tool = keep(makeBox(oc, SMALL_BOX));
      expect(() => booleanOp(oc, operation, a.shape, empty)).toThrow(
        '2 つの立体を組み合わせられませんでした。位置や形を見直してください。',
      );
      const result = keep(booleanOp(oc, 'subtract', a.shape, tool.shape));
      const fresh = keep(makeBox(oc, BIG_BOX));
      const reference = keep(booleanOp(oc, 'subtract', fresh.shape, tool.shape));
      expect(result.volume).toBeCloseTo(SUBTRACT_CONTAINED, 6);
      expectSameMetrics(shapeMetrics(oc, result.shape), shapeMetrics(oc, reference.shape));
      expectSameMetrics(shapeMetrics(oc, a.shape), shapeMetrics(oc, fresh.shape));
    } finally {
      release();
    }
  });

  it('何も残らず断った後にも同じ2形状の和を作れる', () => {
    const { keep, release } = allocationModule.createAllocations();
    try {
      const a = keep(makeBox(oc, BIG_BOX));
      const far = keep(makeTranslatedBox(oc, SMALL_BOX, FAR_OFFSET));
      expect(() => booleanOp(oc, 'intersect', a.shape, far.shape)).toThrow(
        '組み合わせた結果、立体が残りませんでした。',
      );
      const result = keep(booleanOp(oc, 'union', a.shape, far.shape));
      expect(result.volume).toBeCloseTo(UNION_DISJOINT, 6);
      expect(isValidShape(oc, result.shape)).toBe(true);
    } finally {
      release();
    }
  });

  it('releases the built Cut when its synchronous observer throws without deleting either borrowed input', () => {
    const big = makeBox(oc, BIG_BOX);
    const small = makeBox(oc, SMALL_BOX);
    try {
      const { entries, buildModes } = observeAllocations(oc);
      expect(() => booleanOp(oc, 'subtract', big.shape, small.shape, undefined, (maker, output) => {
        expect(maker.IsDone()).toBe(true);
        expect(output.IsNull()).toBe(false);
        throw new Error('hole observer failed');
      })).toThrow('hole observer failed');
      expect(buildModes).toEqual([true]);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((entry) => entry.deleted === 1)).toBe(true);
      expect(entries.some((entry) => entry.item === big.shape || entry.item === small.shape)).toBe(false);
      vi.restoreAllMocks();
      expect(measureVolume(oc, big.shape)).toBeCloseTo(BIG_VOLUME, 6);
      expect(measureVolume(oc, small.shape)).toBeCloseTo(SMALL_VOLUME, 6);
      const retry = booleanOp(oc, 'subtract', big.shape, small.shape);
      try { expect(retry.volume).toBeCloseTo(SUBTRACT_CONTAINED, 6); }
      finally { retry.delete(); }
    } finally {
      vi.restoreAllMocks(); small.delete(); big.delete();
    }
  });

  it.each(OPERATIONS)('%s: Build前に非破壊モードを立て、一時物と結果の所有を解放する', (operation) => {
    const big = makeBox(oc, BIG_BOX);
    const small = makeBox(oc, SMALL_BOX);
    try {
      const { entries, buildModes } = observeAllocations(oc);
      const result = booleanOp(oc, operation, big.shape, small.shape);
      try {
        expect(buildModes).toEqual([true]);
        // 入力リスト・Appendの戻り・走査・測定・検査の一時物は既に解放済み。
        const retained = entries.filter((entry) => entry.deleted === 0);
        expect(retained).toHaveLength(3);
        expect(retained.map((entry) => entry.item)).toEqual([
          expect.any(oc.Message_ProgressRange),
          expect.any(oc.BRepAlgoAPI_BooleanOperation),
          result.shape,
        ]);
      } finally {
        result.delete();
      }
      result.delete();
      expect(entries.length).toBeGreaterThan(7);
      for (const entry of entries) expect(entry.deleted).toBe(1);
    } finally {
      vi.restoreAllMocks();
      small.delete();
      big.delete();
    }
  });

  describe.each(OPERATIONS)('%s の例外時の解放', (operation) => {
    it.each(EXCEPTION_POINTS)('%s が投げても確保数と解放数が一致し、入力を再利用できる', (point) => {
      const big = makeBox(oc, BIG_BOX);
      const small = makeBox(oc, SMALL_BOX);
      try {
        const failure = new Error(`OCCT ${point} の例外`);
        injectException(oc, point, failure);
        const { entries } = observeAllocations(oc);
        expect(() => booleanOp(oc, operation, big.shape, small.shape).delete()).toThrow(failure);
        expect(entries.length).toBeGreaterThan(0);
        for (const entry of entries) expect(entry.deleted).toBe(1);
        const deleted = entries.reduce((sum, entry) => sum + entry.deleted, 0);
        console.log(`${operation}/${point}: 確保${entries.length}・解放${deleted}`);
        vi.restoreAllMocks();
        const next = booleanOp(oc, 'subtract', big.shape, small.shape);
        try {
          expect(next.volume).toBeCloseTo(SUBTRACT_CONTAINED, 6);
          expect(measureVolume(oc, big.shape)).toBeCloseTo(BIG_VOLUME, 6);
          expect(measureVolume(oc, small.shape)).toBeCloseTo(SMALL_VOLUME, 6);
        } finally {
          next.delete();
        }
      } finally {
        vi.restoreAllMocks();
        small.delete();
        big.delete();
      }
    });
  });

  it('小さい箱を完全に含む大きい箱との和は、大きい箱のままの 8000 mm³ になる', () => {
    const big = makeBox(oc, BIG_BOX);
    const small = makeBox(oc, SMALL_BOX);
    try {
      const result = booleanOp(oc, 'union', big.shape, small.shape);
      try {
        expect(measureVolume(oc, result.shape)).toBeCloseTo(UNION_CONTAINED, 6);
        expect(hasSolid(oc, result.shape)).toBe(true);
        expect(isValidShape(oc, result.shape)).toBe(true);
      } finally {
        result.delete();
      }
    } finally {
      small.delete();
      big.delete();
    }
  });

  it('大きい箱から中に含まれる小さい箱を引くと 7000 mm³ になる', () => {
    const big = makeBox(oc, BIG_BOX);
    const small = makeBox(oc, SMALL_BOX);
    try {
      const result = booleanOp(oc, 'subtract', big.shape, small.shape);
      try {
        expect(measureVolume(oc, result.shape)).toBeCloseTo(SUBTRACT_CONTAINED, 6);
        expect(hasSolid(oc, result.shape)).toBe(true);
        expect(isValidShape(oc, result.shape)).toBe(true);
      } finally {
        result.delete();
      }
    } finally {
      small.delete();
      big.delete();
    }
  });

  it('大きい箱と中に含まれる小さい箱の積は、小さい箱と同じ 1000 mm³ になる', () => {
    const big = makeBox(oc, BIG_BOX);
    const small = makeBox(oc, SMALL_BOX);
    try {
      const result = booleanOp(oc, 'intersect', big.shape, small.shape);
      try {
        expect(measureVolume(oc, result.shape)).toBeCloseTo(INTERSECT_CONTAINED, 6);
        expect(hasSolid(oc, result.shape)).toBe(true);
        expect(isValidShape(oc, result.shape)).toBe(true);
      } finally {
        result.delete();
      }
    } finally {
      small.delete();
      big.delete();
    }
  });

  it('半分だけ重なる 2 つの箱で、積が 1000・和が 15000・差が 7000 になる(包除原理の検算)', () => {
    const big = makeBox(oc, BIG_BOX);
    const shifted = makeTranslatedBox(oc, BIG_BOX, HALF_OFFSET);
    try {
      const intersection = booleanOp(oc, 'intersect', big.shape, shifted.shape);
      try {
        expect(measureVolume(oc, intersection.shape)).toBeCloseTo(HALF_INTERSECT, 6);
        expect(hasSolid(oc, intersection.shape)).toBe(true);
        expect(isValidShape(oc, intersection.shape)).toBe(true);
      } finally {
        intersection.delete();
      }

      const union = booleanOp(oc, 'union', big.shape, shifted.shape);
      try {
        expect(measureVolume(oc, union.shape)).toBeCloseTo(HALF_UNION, 6);
        expect(hasSolid(oc, union.shape)).toBe(true);
        expect(isValidShape(oc, union.shape)).toBe(true);
      } finally {
        union.delete();
      }

      const difference = booleanOp(oc, 'subtract', big.shape, shifted.shape);
      try {
        expect(measureVolume(oc, difference.shape)).toBeCloseTo(HALF_SUBTRACT, 6);
        expect(hasSolid(oc, difference.shape)).toBe(true);
        expect(isValidShape(oc, difference.shape)).toBe(true);
      } finally {
        difference.delete();
      }
    } finally {
      shifted.delete();
      big.delete();
    }
  });

  it('離れた 2 つの箱の和は、2 つの塊を含んだまま体積が 9000 mm³ になる', () => {
    const big = makeBox(oc, BIG_BOX);
    const far = makeTranslatedBox(oc, SMALL_BOX, FAR_OFFSET);
    try {
      const result = booleanOp(oc, 'union', big.shape, far.shape);
      try {
        expect(measureVolume(oc, result.shape)).toBeCloseTo(UNION_DISJOINT, 6);
        expect(hasSolid(oc, result.shape)).toBe(true);
        expect(isValidShape(oc, result.shape)).toBe(true);
        // The independent inputs are two disjoint boxes, not merely some positive-volume solid.
        expect(countSolidShapes(oc, result.shape)).toBe(2);
        const { keep, release } = allocationModule.createAllocations();
        try {
          const map = keep(new oc.TopTools_IndexedMapOfShape_1());
          oc.TopExp.MapShapes_2(result.shape, map, true, true);
          const components: TopoDS_Shape[] = [];
          for (let index = 1; index <= map.Size(); index += 1) {
            const member = keep(map.FindKey(index));
            if (member.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SOLID) components.push(member);
          }
          expect(components).toHaveLength(2);
          const [first, second] = components;
          if (first === undefined || second === undefined) throw new Error('Expected two native solid components');
          const volumes = components.map(component => measureVolume(oc, component)).sort((a, b) => a - b);
          expect(volumes[0]).toBeCloseTo(1000, 6);
          expect(volumes[1]).toBeCloseTo(8000, 6);
          // Original big box ends at x=20; the translated small box starts at x=100.
          const separation = distanceBetween(oc, first, second);
          expect(separation.distance).toBeCloseTo(80, 6);
          expect(separation.inner).toBe(false);
        } finally { release(); }
      } finally {
        result.delete();
      }
    } finally {
      far.delete();
      big.delete();
    }
  });

  it('組み合わせた結果をそのまま次の演算の入力にできる(和のあとに差を取る)', () => {
    const big = makeBox(oc, BIG_BOX);
    const far = makeTranslatedBox(oc, SMALL_BOX, FAR_OFFSET);
    try {
      // (大きい箱 ∪ 離れた小さい箱) − 大きい箱 = 離れた小さい箱。9000 − 8000 = 1000。
      const combined = booleanOp(oc, 'union', big.shape, far.shape);
      try {
        const remainder = booleanOp(oc, 'subtract', combined.shape, big.shape);
        try {
          expect(measureVolume(oc, remainder.shape)).toBeCloseTo(SMALL_VOLUME, 6);
          expect(hasSolid(oc, remainder.shape)).toBe(true);
          expect(isValidShape(oc, remainder.shape)).toBe(true);
        } finally {
          remainder.delete();
        }
      } finally {
        combined.delete();
      }
    } finally {
      far.delete();
      big.delete();
    }
  });

  it('含まれている側から含んでいる側を引くと、何も残らないので理由をつけて断る', () => {
    const big = makeBox(oc, BIG_BOX);
    const small = makeBox(oc, SMALL_BOX);
    try {
      expect(() => booleanOp(oc, 'subtract', small.shape, big.shape)).toThrow(
        '組み合わせた結果、立体が残りませんでした。',
      );
    } finally {
      small.delete();
      big.delete();
    }
  });

  it('離れた 2 つの箱の積は交わりが無いので理由をつけて断る', () => {
    const big = makeBox(oc, BIG_BOX);
    const far = makeTranslatedBox(oc, SMALL_BOX, FAR_OFFSET);
    try {
      expect(() => booleanOp(oc, 'intersect', big.shape, far.shape)).toThrow(
        '組み合わせた結果、立体が残りませんでした。',
      );
    } finally {
      far.delete();
      big.delete();
    }
  });

  it('結果を解放しても、渡した 2 つの立体はそのまま使える(引数を解放しない約束)', () => {
    const big = makeBox(oc, BIG_BOX);
    const small = makeBox(oc, SMALL_BOX);
    try {
      const result = booleanOp(oc, 'union', big.shape, small.shape);
      result.delete();
      expect(measureVolume(oc, big.shape)).toBeCloseTo(BIG_VOLUME, 6);
      expect(measureVolume(oc, small.shape)).toBeCloseTo(SMALL_VOLUME, 6);
    } finally {
      small.delete();
      big.delete();
    }
  });

  it('断ったあとでも、渡した 2 つの立体はそのまま使える', () => {
    const big = makeBox(oc, BIG_BOX);
    const far = makeTranslatedBox(oc, SMALL_BOX, FAR_OFFSET);
    try {
      expect(() => booleanOp(oc, 'intersect', big.shape, far.shape)).toThrow(Error);
      expect(measureVolume(oc, big.shape)).toBeCloseTo(BIG_VOLUME, 6);
      expect(measureVolume(oc, far.shape)).toBeCloseTo(SMALL_VOLUME, 6);
    } finally {
      far.delete();
      big.delete();
    }
  });
});

describe('R22: 近接Booleanと薄板・短辺の解析体積', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
  beforeAll(async () => { oc = await loadOcctForNode(); });

  it.each([
    ['subtract', 7999.967, R22_NEAR_CONTACT.subtractVolumeMm3],
    ['union', 15999.975, R22_NEAR_CONTACT.unionVolumeMm3],
  ] as const)('%s の薄い重なり誤差を全体積比だけでは見逃す', (_operation, distorted, expected) => {
    const absoluteError = Math.abs(distorted - expected);
    expect(absoluteError / expected).toBeLessThan(1e-6);
    expect(absoluteError / R22_NEAR_CONTACT.intersectionVolumeMm3).toBeGreaterThanOrEqual(0.01);
  });

  it.each([
    ['intersect', R22_NEAR_CONTACT.intersectionVolumeMm3],
    ['subtract', R22_NEAR_CONTACT.subtractVolumeMm3],
    ['union', R22_NEAR_CONTACT.unionVolumeMm3],
  ] as const)('%s: 0.0001mm重なる20mm箱の解析体積と入力不変', (operation, expectedVolume) => {
    const a = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
    try {
      const b = makeTranslatedBox(oc, { dx: 20, dy: 20, dz: 20 }, [20 - R22_NEAR_CONTACT.overlapMm, 0, 0]);
      try {
        const result = booleanOp(oc, operation, a.shape, b.shape);
        try {
          expect(hasSolid(oc, result.shape)).toBe(true);
          expect(isValidShape(oc, result.shape)).toBe(true);
          const actualVolume = measureVolume(oc, result.shape);
          const absoluteError = Math.abs(actualVolume - expectedVolume);
          expect(absoluteError / expectedVolume).toBeLessThan(1e-6);
          expect(absoluteError).toBeLessThan(R22_NEAR_CONTACT.intersectionVolumeMm3 * 0.01);
          expect(measureVolume(oc, a.shape)).toBeCloseTo(8000, 9);
          expect(measureVolume(oc, b.shape)).toBeCloseTo(8000, 9);
        } finally {
          result.delete();
        }
      } finally {
        b.delete();
      }
    } finally {
      a.delete();
    }
  });

  it.each(R22_THIN_SOLIDS)('$name remains a valid six-face solid with exact bounds', ({ size, volumeMm3 }) => {
    const handle = makeBox(oc, { dx: size[0], dy: size[1], dz: size[2] });
    try {
      expect(hasSolid(oc, handle.shape)).toBe(true);
      expect(isValidShape(oc, handle.shape)).toBe(true);
      expect(Math.abs(measureVolume(oc, handle.shape) - volumeMm3) / volumeMm3).toBeLessThan(1e-6);
      const metrics = shapeMetrics(oc, handle.shape);
      expect(metrics.faces).toBe(6);
      expect(metrics.edges).toBe(12);
      const bounds = new oc.Bnd_Box_1();
      try {
        oc.BRepBndLib.Add(handle.shape, bounds, false);
        bounds.SetGap(0);
        const low = bounds.CornerMin();
        const high = bounds.CornerMax();
        try {
          for (const coordinate of [low.X(), low.Y(), low.Z()]) expect(Math.abs(coordinate)).toBeLessThanOrEqual(1e-7);
          for (const [actual, expected] of [[high.X(), size[0]], [high.Y(), size[1]], [high.Z(), size[2]]]) {
            expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-7);
          }
        } finally {
          high.delete();
          low.delete();
        }
      } finally {
        bounds.delete();
      }
    } finally {
      handle.delete();
    }
  });
});

/**
 * EX04 閉じた輪郭による貫通切断の幾何(UNEXECUTED until Root runs it)。
 *
 * UI の切断(`cutCommands.ts` の `commitProfileCut`)は新しい分割を持たず、既存の押し出しと差を積む。
 * ここではその 2 つの実関数(`makeExtrudeSolid` → `booleanOp`)を、文書が組み立てるのと同じ形
 * (作図面 z = 0 の円を両側へ押し出した柱)で直接たどり、解析値と比べる。
 *
 * 期待値は形からだけ決める: 10³ の箱から中心 (5, 5)・半径 r の円柱を z 方向に貫いて引くと
 * 残りは 1000 − π r² · 10、抜けた芯は π r² · 10、和は 1000。許容差は既存の円柱の差の検査
 * (同じ describe の上の `8000 − π·9·20`)と同じ `toBeCloseTo(…, 6)` で、出力を見て緩めない。
 * 両側押し出しの長さ 69 は、10³ の箱と z = 0 の半径 3 以下の円から `commitProfileCut` が決める
 * ceil(4H)(H = √297)と同じ数で、片側 34.5 は箱の厚み 10 を十分に越える。
 */
describe('EX04 閉じた輪郭で貫いて切る: 既存の押し出し + 差', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
  const THROUGH = 69;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  /** 作図面 z = 0 の円を両側へ押し出した柱(model の両側押し出しと同じく、断面を −d/2 ずらして d 押す)。 */
  function circlePrism(radius: number) {
    return makeExtrudeSolid(oc, {
      kind: 'extrude',
      profile: [{ kind: 'arc', center: [5, 5, -THROUGH / 2], normal: [0, 0, 1], xAxis: [1, 0, 0], radius,
        startAngle: 0, endAngle: 2 * Math.PI }],
      direction: [0, 0, 1],
      distance: THROUGH,
    });
  }

  it.each([[3], [2]])('半径 %d: 残り 1000 − 10πr²、芯 10πr²、和 1000', (radius) => {
    const owned = allocationModule.createAllocations();
    try {
      const box = owned.keep(makeBox(oc, { dx: 10, dy: 10, dz: 10 }));
      const tool = owned.keep(circlePrism(radius));
      const cut = owned.keep(booleanOp(oc, 'subtract', box.shape, tool.shape));
      const core = owned.keep(booleanOp(oc, 'intersect', box.shape, tool.shape));
      const removed = Math.PI * radius * radius * 10;
      expect(cut.volume).toBeCloseTo(1000 - removed, 6);
      expect(core.volume).toBeCloseTo(removed, 6);
      expect(cut.volume + core.volume).toBeCloseTo(1000, 6);
      expect(isValidShape(oc, cut.shape)).toBe(true);
      // 入力の形は変わらない(箱は次の再計算でも同じ鍵の材料)。
      expect(measureVolume(oc, box.shape)).toBeCloseTo(1000, 9);
    } finally {
      owned.release();
    }
  });

  it('回した楕円の貫通切削は独立な面積πab×厚さと一致し、楕円の境界と1個の妥当な立体を保つ', () => {
    const owned = allocationModule.createAllocations();
    try {
      const box = owned.keep(makeBox(oc, { dx: 10, dy: 10, dz: 10 }));
      const angle = Math.PI / 6;
      const tool = owned.keep(makeExtrudeSolid(oc, {
        kind: 'extrude',
        profile: [{ kind: 'ellipse', center: [5, 5, -THROUGH / 2], normal: [0, 0, 1],
          majorAxis: [Math.cos(angle), Math.sin(angle), 0], majorRadius: 4, minorRadius: 2 }],
        direction: [0, 0, 1], distance: THROUGH,
      }));
      const cut = owned.keep(booleanOp(oc, 'subtract', box.shape, tool.shape, undefined, undefined, { requireRemoval: true }));
      const core = owned.keep(booleanOp(oc, 'intersect', box.shape, tool.shape));
      // Rotation preserves the full ellipse area πab. Both radii fit strictly inside the 10×10 plate.
      const removed = Math.PI * 4 * 2 * 10;
      expect(cut.volume).toBeCloseTo(1000 - removed, 6);
      expect(core.volume).toBeCloseTo(removed, 6);
      expect(cut.volume + core.volume).toBeCloseTo(1000, 6);
      for (const result of [cut, core]) {
        expect(isValidShape(oc, result.shape)).toBe(true);
        expect(hasSolid(oc, result.shape)).toBe(true);
        const topology = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
        oc.TopExp.MapShapes_2(result.shape, topology, true, true);
        let solids = 0;
        for (let index = 1; index <= topology.Size(); index += 1) {
          if (owned.keep(topology.FindKey(index)).ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SOLID) solids += 1;
        }
        expect(solids).toBe(1);
      }
      // NFR-RE-3 and EX-04 constrain geometry, not OCCT's internal curve enum.
      // Certify every parameter of both openings at the old nine-decimal radius precision.
      for (const result of [cut, core]) {
        const topology = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
        oc.TopExp.MapShapes_2(result.shape, topology, true, true);
        const caps: number[] = [];
        let analyticSides = 0;
        for (let index = 1; index <= topology.Size(); index += 1) {
          const member = owned.keep(topology.FindKey(index));
          if (member.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_FACE) {
            const surface = owned.keep(new oc.BRepAdaptor_Surface_2(owned.keep(oc.TopoDS.Face_1(member)), false));
            if (surface.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_SurfaceOfExtrusion) continue;
            const basis = owned.keep(surface.BasisCurve());
            expect(basis.get().GetType()).toBe(oc.GeomAbs_CurveType.GeomAbs_Ellipse);
            const ellipse = owned.keep(basis.get().Ellipse());
            expect(ellipse.MajorRadius()).toBeCloseTo(4, 9);
            expect(ellipse.MinorRadius()).toBeCloseTo(2, 9);
            const centre = owned.keep(ellipse.Location());
            expect(centre.X()).toBeCloseTo(5, 9); expect(centre.Y()).toBeCloseTo(5, 9);
            const major = owned.keep(owned.keep(ellipse.XAxis()).Direction());
            const alignment = major.X() * Math.cos(angle) + major.Y() * Math.sin(angle);
            expect(Math.abs(alignment)).toBeCloseTo(1, 12);
            analyticSides++;
            continue;
          }
          if (member.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_EDGE) continue;
          const edge = owned.keep(oc.TopoDS.Edge_1(member));
          const curve = owned.keep(new oc.BRepAdaptor_Curve_2(edge));
          if (curve.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line) continue;
          const start = owned.keep(curve.Value(curve.FirstParameter()));
          const cap: 0 | 10 = Math.abs(start.Z()) < Math.abs(start.Z() - 10) ? 0 : 10;
          if (curve.GetType() === oc.GeomAbs_CurveType.GeomAbs_Ellipse) {
            const ellipse = owned.keep(curve.Ellipse()), centre = owned.keep(ellipse.Location());
            const axis = owned.keep(ellipse.Axis()), direction = owned.keep(axis.Direction());
            expect(ellipse.MajorRadius()).toBeCloseTo(4, 9); expect(ellipse.MinorRadius()).toBeCloseTo(2, 9);
            expect(centre.X()).toBeCloseTo(5, 9); expect(centre.Y()).toBeCloseTo(5, 9); expect(centre.Z()).toBeCloseTo(cap, 9);
            expect(Math.abs(direction.Z())).toBeCloseTo(1, 12);
            const major = owned.keep(owned.keep(ellipse.XAxis()).Direction());
            const alignment = major.X() * Math.cos(angle) + major.Y() * Math.sin(angle);
            expect(Math.abs(alignment)).toBeCloseTo(1, 12);
            expect(curve.LastParameter() - curve.FirstParameter()).toBeCloseTo(2 * Math.PI, 12);
            const minor = owned.keep(owned.keep(ellipse.YAxis()).Direction());
            const cosine = ellipseCosineInterval();
            const majorSign = alignment >= 0 ? 1 : -1;
            const minorSign = -minor.X() * Math.sin(angle) + minor.Y() * Math.cos(angle) >= 0 ? 1 : -1;
            const actualMajor = [major.X(), major.Y(), major.Z()].map(x => em(ei(x), ei(majorSign * ellipse.MajorRadius())));
            const actualMinor = [minor.X(), minor.Y(), minor.Z()].map(x => em(ei(x), ei(minorSign * ellipse.MinorRadius())));
            const expectedMajor = [em(ei(4), cosine), ei(2), ei(0)];
            const expectedMinor = [ei(-1), em(ei(2), cosine), ei(0)];
            let error = ei(0);
            for (let axisIndex = 0; axisIndex < 3; axisIndex++) {
              error = ea(error, ei(eabs(es(actualMajor[axisIndex], expectedMajor[axisIndex]))));
              error = ea(error, ei(eabs(es(actualMinor[axisIndex], expectedMinor[axisIndex]))));
            }
            for (const [actual, expected] of [[centre.X(), 5], [centre.Y(), 5], [centre.Z(), cap]] as const) {
              error = ea(error, ei(eabs(es(ei(actual), ei(expected)))));
            }
            const fullTurn = em(ei(2), [-nextUpper(-Math.PI), nextUpper(Math.PI)]);
            error = ea(error, em(ei(4), ei(eabs(es(es(ei(curve.LastParameter()), ei(curve.FirstParameter())), fullTurn)))));
            expect(error[1]).toBeLessThanOrEqual(ELLIPSE_BOUNDARY_MM);
          } else {
            expect(curve.GetType()).toBe(oc.GeomAbs_CurveType.GeomAbs_BSplineCurve);
            // BRepAdaptor.BSpline would transform poles for a nonidentity placement.
            // Refuse that extra rounding path; the captured original poles are the certificate input.
            expect(owned.keep(curve.Trsf()).Form()).toBe(oc.gp_TrsfForm.gp_Identity);
            const handle = owned.keep(curve.BSpline()), spline = handle.get();
            expect(spline.IsRational()).toBe(false); expect(spline.IsPeriodic()).toBe(false); expect(spline.IsCN(1)).toBe(true);
            expect(spline.FirstParameter()).toBe(curve.FirstParameter()); expect(spline.LastParameter()).toBe(curve.LastParameter());
            const poles = Array.from({ length: spline.NbPoles() }, (_, i) => {
              const p = owned.keep(spline.Pole(i + 1)); return [p.X(), p.Y(), p.Z()] as const;
            });
            const knots = Array.from({ length: spline.NbKnots() }, (_, i) => spline.Knot(i + 1));
            const mults = knots.map((_, i) => spline.Multiplicity(i + 1));
            const spans = ellipseBezierIntervals(spline.Degree(), poles, knots, mults);
            certifyEllipseSpans(spans, cap);
            // Physical negative controls reuse original native coefficients, never a fabricated PASS curve.
            const changed = (f: (p: EllipsePoint, i: number, j: number) => EllipsePoint): EllipseSpan[] =>
              spans.map((s, i) => ({ ...s, poles: s.poles.map((p, j) => f(p, i, j)) }));
            expect(() => certifyEllipseSpans(changed(p => [ea(p[0], ei(0.001)), p[1], p[2]]), cap)).toThrow();
            expect(() => certifyEllipseSpans(changed(p => [em(p[0], ei(1.001)), em(p[1], ei(1.001)), p[2]]), cap)).toThrow();
            expect(() => certifyEllipseSpans(spans.map(s => ({ ...s, poles: [s.poles[0], s.poles.at(-1)!] })), cap)).toThrow();
            const firstSpan = spans[0];
            expect(() => certifyEllipseSpans([{ poles: splitEllipse(firstSpan.poles)[0], width: em(firstSpan.width, ei(0.5)) }], cap)).toThrow();
            expect(() => certifyEllipseSpans([...spans, ...spans], cap)).toThrow();
            expect(() => certifyEllipseSpans(spans.map((s, i) => i === 0 ? { ...s, poles: [...s.poles].reverse() } : s), cap)).toThrow();
            expect(() => certifyEllipseSpans(changed((p, i, j) => i === 0 && j === 2 ? [ea(p[0], ei(0.01)), p[1], p[2]] : p), cap)).toThrow();
            // Same native geometry under a positive global parameter scale must remain admissible.
            expect(() => certifyEllipseSpans(spans.map(s => ({ ...s, width: em(s.width, ei(2)) })), cap)).not.toThrow();
            // A genuine closing corner must still fail specifically at the seam, not merely at a later distance check.
            const corner = changed((p, i, j) => i === spans.length - 1 && j === spans[i].poles.length - 2
              ? [ea(p[0], ei(0.0001)), p[1], p[2]] : p);
            expect(() => certifyEllipseSpans(corner, cap)).toThrow(/C1 seam /);
          }
          caps.push(cap);
        }
        expect(analyticSides).toBe(1);
        expect(caps.sort((a, b) => a - b)).toEqual([0, 10]);
      }
      expect(measureVolume(oc, box.shape)).toBeCloseTo(1000, 9);
    } finally { owned.release(); }
  });

  it('切り口は折れ線ではなく厳密な円柱面(半径 3)のまま残る', () => {
    const owned = allocationModule.createAllocations();
    try {
      const box = owned.keep(makeBox(oc, { dx: 10, dy: 10, dz: 10 }));
      const tool = owned.keep(circlePrism(3));
      const cut = owned.keep(booleanOp(oc, 'subtract', box.shape, tool.shape));
      const faces = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
      oc.TopExp.MapShapes_2(cut.shape, faces, true, true);
      const radii: number[] = [];
      let planar = 0;
      for (let index = 1; index <= faces.Size(); index += 1) {
        const member = owned.keep(faces.FindKey(index));
        if (member.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_FACE) continue;
        const adaptor = owned.keep(new oc.BRepAdaptor_Surface_2(owned.keep(oc.TopoDS.Face_1(member)), true));
        if (adaptor.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
          radii.push(owned.keep(adaptor.Cylinder()).Radius());
        } else if (adaptor.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Plane) {
          planar += 1;
        }
      }
      // 箱の 6 面(上下は穴あき)+ 円柱の内壁。内壁が 1 枚以上あり、どれも半径 3。
      expect(planar).toBe(6);
      expect(radii.length).toBeGreaterThanOrEqual(1);
      for (const radius of radii) expect(radius).toBeCloseTo(3, 9);
    } finally {
      owned.release();
    }
  });

  it('requireRemoval を立てた差: 削れる輪郭は従来と同じ体積、届かない輪郭は理由つきで断る', () => {
    const owned = allocationModule.createAllocations();
    try {
      const box = owned.keep(makeBox(oc, { dx: 10, dy: 10, dz: 10 }));
      const hit = owned.keep(circlePrism(3));
      const cut = owned.keep(booleanOp(oc, 'subtract', box.shape, hit.shape, undefined, undefined, { requireRemoval: true }));
      expect(cut.volume).toBeCloseTo(1000 - 90 * Math.PI, 6);
      const far = owned.keep(makeExtrudeSolid(oc, {
        kind: 'extrude',
        profile: [{ kind: 'arc', center: [50, 50, -THROUGH / 2], normal: [0, 0, 1], xAxis: [1, 0, 0], radius: 3,
          startAngle: 0, endAngle: 2 * Math.PI }],
        direction: [0, 0, 1],
        distance: THROUGH,
      }));
      expect(() => booleanOp(oc, 'subtract', box.shape, far.shape, undefined, undefined, { requireRemoval: true }))
        .toThrow('何も削れませんでした');
      // 断っても入力の形は変わらない(再計算は直前の正しい形を残せる)。
      expect(measureVolume(oc, box.shape)).toBeCloseTo(1000, 9);
      // 和・積や、欄を立てない差は従来どおり(既定を変えない)。
      const plain = owned.keep(booleanOp(oc, 'subtract', box.shape, far.shape));
      expect(plain.volume).toBeCloseTo(1000, 6);
    } finally {
      owned.release();
    }
  });

  it('requireRemoval の型は段・引数とも true だけ(保存が断る false を型でも渡せない)', () => {
    // 型の検査で確かめる対照。欄が boolean のままなら、この 2 行が型の誤りになる。
    expectTypeOf<BooleanStepSpec['requireRemoval']>().toEqualTypeOf<true | undefined>();
    expectTypeOf<BooleanOptions['requireRemoval']>().toEqualTypeOf<true | undefined>();
  });

  it('箱に届かない輪郭の差は何も削らない(UI が押す前に `profileMissesTarget` で断る理由)', () => {
    const owned = allocationModule.createAllocations();
    try {
      const box = owned.keep(makeBox(oc, { dx: 10, dy: 10, dz: 10 }));
      const far = owned.keep(makeExtrudeSolid(oc, {
        kind: 'extrude',
        profile: [{ kind: 'arc', center: [50, 50, -THROUGH / 2], normal: [0, 0, 1], xAxis: [1, 0, 0], radius: 3,
          startAngle: 0, endAngle: 2 * Math.PI }],
        direction: [0, 0, 1],
        distance: THROUGH,
      }));
      const cut = owned.keep(booleanOp(oc, 'subtract', box.shape, far.shape));
      expect(cut.volume).toBeCloseTo(1000, 6);
    } finally {
      owned.release();
    }
  });
});

/*
 * EX-04 W3 閉じた輪郭の切断の残す側(UNEXECUTED until Root runs it)。
 * 内側を残す = requireRemoval を立てた積、外側を残す = 同じ印の差、両方 = 差と積の対
 * (model の `BooleanFeature.pairedWith`)。期待値は形だけから決める(実装の出力を写さない):
 * - 対象は 0〜10 の立方体(体積 1000)。輪郭は作図面 z = 0 の中心 (5, 5) の円 r = 2・3 と、長半径 4・
 *   短半径 2 を 30 度回した楕円。どれも立方体の中に収まり、上下へ貫く(長さ 69、片側 34.5 > 10)。
 * - 内側 = 断面積 × 厚さ 10(πr²·10、πab·10。回しても面積は πab)、外側 = 1000 − 内側、和 = 1000。
 * - 比較は相対誤差 ≤1e-9(上の describe の toBeCloseTo(…, 6) より厳しい。出力を見て緩めない)。
 */
describe('EX-04 W3 閉じた輪郭の切断の残す側(requireRemoval を立てた積と差)', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
  const THROUGH = 69;
  const BOX_VOLUME = 1000;
  const THICKNESS = 10;
  const RELATIVE = 1e-9;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  /** 作図面 z = 0 の円を、立方体を上下へ貫くように押し出した柱(model の両側押し出しと同じ置き方)。 */
  function circlePrism(radius: number, center: readonly [number, number] = [5, 5]) {
    return makeExtrudeSolid(oc, {
      kind: 'extrude',
      profile: [{ kind: 'arc', center: [center[0], center[1], -THROUGH / 2], normal: [0, 0, 1], xAxis: [1, 0, 0],
        radius, startAngle: 0, endAngle: 2 * Math.PI }],
      direction: [0, 0, 1],
      distance: THROUGH,
    });
  }

  /** 長半径 4・短半径 2 の楕円を 30 度回して押し出した柱。 */
  function rotatedEllipsePrism() {
    const angle = Math.PI / 6;
    return makeExtrudeSolid(oc, {
      kind: 'extrude',
      profile: [{ kind: 'ellipse', center: [5, 5, -THROUGH / 2], normal: [0, 0, 1],
        majorAxis: [Math.cos(angle), Math.sin(angle), 0], majorRadius: 4, minorRadius: 2 }],
      direction: [0, 0, 1],
      distance: THROUGH,
    });
  }

  const PROFILES = [
    { name: '円 r = 2', area: Math.PI * 2 * 2, prism: () => circlePrism(2) },
    { name: '円 r = 3', area: Math.PI * 3 * 3, prism: () => circlePrism(3) },
    { name: '30 度回した楕円 a = 4・b = 2', area: Math.PI * 4 * 2, prism: () => rotatedEllipsePrism() },
  ];

  function relativeError(actual: number, expected: number): number {
    return Math.abs(actual - expected) / Math.abs(expected);
  }

  it.each(PROFILES)('$name: 内側 = 断面積×10、外側 = 1000 − 内側、和 = 1000(相対 1e-9)、どちらも 1 個の妥当な立体',
    ({ area, prism }) => {
      const owned = allocationModule.createAllocations();
      try {
        const box = owned.keep(makeBox(oc, { dx: 10, dy: 10, dz: 10 }));
        const tool = owned.keep(prism());
        const boxBytes = writeBrepBytes(oc, box.shape);
        const toolBytes = writeBrepBytes(oc, tool.shape);
        const options: BooleanOptions = { requireRemoval: true };
        const inside = owned.keep(booleanOp(oc, 'intersect', box.shape, tool.shape, undefined, undefined, options));
        const outside = owned.keep(booleanOp(oc, 'subtract', box.shape, tool.shape, undefined, undefined, options));
        const expectedInside = area * THICKNESS;
        // 実測の記録(最終報告の幾何の表の原票)。
        stdout.write(`EX-04 W3 kernel 体積: ${JSON.stringify({
          inside: { volume: inside.volume, expected: expectedInside,
            relativeError: relativeError(inside.volume, expectedInside) },
          outside: { volume: outside.volume, expected: BOX_VOLUME - expectedInside,
            relativeError: relativeError(outside.volume, BOX_VOLUME - expectedInside) },
          sumRelativeError: relativeError(inside.volume + outside.volume, BOX_VOLUME),
        })}${String.fromCharCode(10)}`);
        expect(relativeError(inside.volume, expectedInside)).toBeLessThanOrEqual(RELATIVE);
        expect(relativeError(outside.volume, BOX_VOLUME - expectedInside)).toBeLessThanOrEqual(RELATIVE);
        expect(relativeError(inside.volume + outside.volume, BOX_VOLUME)).toBeLessThanOrEqual(RELATIVE);
        for (const result of [inside, outside]) {
          expect(result.volume).toBeGreaterThan(0);
          expect(isValidShape(oc, result.shape)).toBe(true);
          expect(countSolidShapes(oc, result.shape)).toBe(1);
        }
        // 入力の形はバイトまで変わらない(箱と押し出しは次の再計算でも同じ鍵の材料。対の 2 つが同じ入力を借りる。
        // rules/06 §10.16)。
        expect(writeBrepBytes(oc, box.shape)).toEqual(boxBytes);
        expect(writeBrepBytes(oc, tool.shape)).toEqual(toolBytes);
      } finally {
        owned.release();
      }
    });

  it('積: 輪郭が届かなければ「内側に何も残らない」、立体をまるごと囲めば「何も削れない」で断り、入力は変わらない', () => {
    const owned = allocationModule.createAllocations();
    try {
      const box = owned.keep(makeBox(oc, { dx: 10, dy: 10, dz: 10 }));
      // 中心 (50, 50) の円は立方体に届かない。半径 20 の円は立方体(対角の半分 √50 ≈ 7.07)をまるごと囲む。
      const far = owned.keep(circlePrism(3, [50, 50]));
      const enclosing = owned.keep(circlePrism(20));
      const options: BooleanOptions = { requireRemoval: true };
      expect(() => booleanOp(oc, 'intersect', box.shape, far.shape, undefined, undefined, options))
        .toThrow(NOTHING_INSIDE_MESSAGE);
      expect(() => booleanOp(oc, 'intersect', box.shape, enclosing.shape, undefined, undefined, options))
        .toThrow(NOTHING_OUTSIDE_MESSAGE);
      // 同じ配置の差は従来どおり(届かない = 何も削れない、囲む = 何も残らない)。両方を残す対はそろって断る。
      expect(() => booleanOp(oc, 'subtract', box.shape, far.shape, undefined, undefined, options))
        .toThrow(NOTHING_REMOVED_MESSAGE);
      expect(() => booleanOp(oc, 'subtract', box.shape, enclosing.shape, undefined, undefined, options))
        .toThrow('組み合わせた結果、立体が残りませんでした。');
      // 印の無い積は従来どおり(囲む輪郭は立方体のまま 1000、届かない輪郭は「何も残らない」)。
      const plain = owned.keep(booleanOp(oc, 'intersect', box.shape, enclosing.shape));
      expect(relativeError(plain.volume, BOX_VOLUME)).toBeLessThanOrEqual(RELATIVE);
      expect(() => booleanOp(oc, 'intersect', box.shape, far.shape)).toThrow('組み合わせた結果、立体が残りませんでした。');
      // 断っても入力の形は変わらない(再計算は直前の正しい形を残せる)。
      expect(relativeError(measureVolume(oc, box.shape), BOX_VOLUME)).toBeLessThanOrEqual(RELATIVE);
    } finally {
      owned.release();
    }
  });

  it.each([
    ['成立する積(半径 3)', 3, [5, 5], null],
    ['届かない積', 3, [50, 50], NOTHING_INSIDE_MESSAGE],
    ['囲む積', 20, [5, 5], NOTHING_OUTSIDE_MESSAGE],
  ] as const)('%s: 確保したものは全て 1 回ずつ解放し、借りた入力は解放しない', (_title, radius, center, message) => {
    const box = makeBox(oc, { dx: 10, dy: 10, dz: 10 });
    const tool = circlePrism(radius, center);
    try {
      const { entries } = observeAllocations(oc);
      if (message === null) {
        const result = booleanOp(oc, 'intersect', box.shape, tool.shape, undefined, undefined, { requireRemoval: true });
        result.delete();
      } else {
        expect(() => booleanOp(oc, 'intersect', box.shape, tool.shape, undefined, undefined, { requireRemoval: true })
          .delete()).toThrow(message);
      }
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) expect(entry.deleted).toBe(1);
      expect(entries.some((entry) => entry.item === box.shape || entry.item === tool.shape)).toBe(false);
      vi.restoreAllMocks();
      expect(relativeError(measureVolume(oc, box.shape), BOX_VOLUME)).toBeLessThanOrEqual(RELATIVE);
    } finally {
      vi.restoreAllMocks();
      tool.delete();
      box.delete();
    }
  });
});
