/** Real OCCT acceptance of the test-only EX-18 oracle, including shapes that must not compare equal. */
import { stdout } from 'node:process';
import { beforeAll, describe, expect, it } from 'vitest';

import { createAllocations, type Allocations } from '../../../kernel/src/occt/allocations.js';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { placeShape } from '../../../kernel/src/occt/placeBodies.js';
import { measureVolume } from '../../../kernel/src/occt/solidMesh.js';
import { faceAt } from '../../../kernel/src/occt/subShapes.js';
import { EX18_ORACLE_EXPECTATIONS } from './ex18RouteFixtures.js';
import { compareEx18Shape, measureEx18Shape, type Ex18ShapeExpectation, type Ex18ShapeMeasurement } from './ex18ShapeOracle.js';

type Occt = Awaited<ReturnType<typeof loadOcctForNode>>;
type Shape = Parameters<typeof measureVolume>[1];
type Point = readonly [number, number, number];
let oc: Occt;

function record(label: string, result: object): void {
  stdout.write(`EX18 ${label}: ${JSON.stringify(result)}\n`);
}

beforeAll(async () => {
  const started = performance.now();
  oc = await loadOcctForNode();
  record('OCCT initialization', { durationMs: performance.now() - started });
}, 180_000);

function box(owner: Allocations, origin: Point, dimensions: Point): Shape {
  const point = owner.keep(new oc.gp_Pnt_3(...origin));
  const maker = owner.keep(new oc.BRepPrimAPI_MakeBox_3(point, ...dimensions));
  return owner.keep(maker.Shape());
}

function cylinder(owner: Allocations, origin: Point, radius: number, height: number): Shape {
  const point = owner.keep(new oc.gp_Pnt_3(...origin)), up = owner.keep(new oc.gp_Dir_4(0, 0, 1));
  const axes = owner.keep(new oc.gp_Ax2_3(point, up));
  const maker = owner.keep(new oc.BRepPrimAPI_MakeCylinder_3(axes, radius, height));
  return owner.keep(maker.Shape());
}

function boolean(owner: Allocations, kind: 'cut' | 'fuse', left: Shape, right: Shape): Shape {
  // Non-destructive mode preserves the operands for the borrowing regression below.
  const maker = owner.keep(kind === 'cut' ? new oc.BRepAlgoAPI_Cut_1() : new oc.BRepAlgoAPI_Fuse_1());
  const argumentsList = owner.keep(new oc.TopTools_ListOfShape_1()), tools = owner.keep(new oc.TopTools_ListOfShape_1());
  argumentsList.Append_1(left); tools.Append_1(right);
  maker.SetArguments(argumentsList); maker.SetTools(tools); maker.SetNonDestructive(true);
  maker.Build(owner.keep(new oc.Message_ProgressRange_1()));
  expect(maker.IsDone()).toBe(true);
  // Deliberately do not unify same-domain faces: the split-wall controls depend on the real topology.
  return owner.keep(maker.Shape());
}

function plate(owner: Allocations, radius = 3): Shape {
  return boolean(owner, 'cut', box(owner, [0, 0, 0], [40, 30, 10]), cylinder(owner, [10, 15, -1], radius, 12));
}

function flange(owner: Allocations): Shape {
  const exterior = boolean(owner, 'fuse', cylinder(owner, [0, 0, 0], 15, 5), cylinder(owner, [0, 0, 5], 10, 20));
  return boolean(owner, 'cut', exterior, cylinder(owner, [0, 0, -1], 3, 27));
}

function skewPrism(owner: Allocations): Shape {
  const polygon = owner.keep(new oc.BRepBuilderAPI_MakePolygon_1());
  const vertices: readonly Point[] = [[0, 0, 0], [20, 0, 0], [20, 10, 0], [0, 10, 0]];
  for (const vertex of vertices) polygon.Add_1(owner.keep(new oc.gp_Pnt_3(...vertex)));
  polygon.Close();
  const wire = owner.keep(polygon.Wire()), faceMaker = owner.keep(new oc.BRepBuilderAPI_MakeFace_15(wire, true));
  expect(faceMaker.IsDone()).toBe(true);
  const face = owner.keep(faceMaker.Face()), vector = owner.keep(new oc.gp_Vec_4(5, 0, 10));
  const prism = owner.keep(new oc.BRepPrimAPI_MakePrism_1(face, vector, true, true));
  return owner.keep(prism.Shape());
}

function withShape(build: (owner: Allocations) => Shape, check: (shape: Shape, owner: Allocations) => void): void {
  const owner = createAllocations();
  try { check(build(owner), owner); } finally { owner.release(); }
}

function expectShape(label: string, measured: Ex18ShapeMeasurement, expected: Ex18ShapeExpectation): void {
  const comparison = compareEx18Shape(measured, expected);
  record(label, { ...comparison, volume: measured.volume, bounds: measured.bounds,
    validity: measured.validity, holes: measured.holes, limitations: measured.limitations });
  expect.soft(measured.validity.valid).toBe(true);
  expect.soft(measured.validity.solidCount).toBe(1);
  expect.soft(measured.validity.closed).toBe(true);
  expect.soft(measured.volumeMethod).toBe('occt-gprop');
  expect.soft(comparison.volumeRelativeError).toBeLessThanOrEqual(1e-9);
  expect.soft(measured.boundsMethod).toBe('analytic-brep');
  expect.soft(comparison.boundsMaximumErrorMm).toBeLessThanOrEqual(1e-6);
  expect.soft(measured.holesComplete).toBe(true);
  expect.soft(measured.throughHoleCount).toBe(expected.holes.length);
  expect.soft(comparison.holeAxisMaximumErrorMm).toBeLessThanOrEqual(1e-6);
  expect.soft(comparison.holeRadiusMaximumErrorMm).toBeLessThanOrEqual(1e-6);
  expect.soft(comparison.holeDirectionMaximumError).toBeLessThanOrEqual(1e-6);
  expect.soft(comparison.failures).toEqual([]);
  expect.soft(comparison.matches).toBe(true);
}

describe('EX-18 independent B-rep shape oracle', () => {
  it('A: measures the perforated plate against 12000 - 90*pi and the independent envelope/hole', () => {
    withShape(owner => plate(owner), shape => expectShape('A', measureEx18Shape(oc, shape), EX18_ORACLE_EXPECTATIONS.A));
  });

  it('B: measures the flanged cylinder against 2900*pi, including circular extrema absent from vertices', () => {
    withShape(flange, shape => {
      const result = measureEx18Shape(oc, shape);
      expectShape('B', result, EX18_ORACLE_EXPECTATIONS.B);
      expect(result.meshApproximation).toBeNull();
    });
  });

  it('C: measures the skew prism against 2000, its eight-vertex envelope and zero holes', () => {
    withShape(skewPrism, shape => expectShape('C', measureEx18Shape(oc, shape), EX18_ORACLE_EXPECTATIONS.C));
  });

  it('rejects the same volume with a different envelope and no hole', () => {
    withShape(owner => box(owner, [0, 0, 0], [40 - 0.3 * Math.PI, 30, 10]), shape => {
      const result = measureEx18Shape(oc, shape), comparison = compareEx18Shape(result, EX18_ORACLE_EXPECTATIONS.A);
      expect(comparison.volumeRelativeError).toBeLessThanOrEqual(1e-9);
      expect(comparison.boundsMaximumErrorMm).toBeGreaterThan(0.9);
      expect(result.throughHoleCount).toBe(0);
      expect(comparison.failures).toContain('bounds');
      expect(comparison.failures).toContain('hole-count');
      expect(comparison.matches).toBe(false);
      record('same-volume control', comparison);
    });
  });

  it('rejects the same envelope with a radius-2 hole', () => {
    withShape(owner => plate(owner, 2), shape => {
      const result = measureEx18Shape(oc, shape), comparison = compareEx18Shape(result, EX18_ORACLE_EXPECTATIONS.A);
      expect(result.validity.valid).toBe(true);
      expect(comparison.boundsMaximumErrorMm).toBeLessThanOrEqual(1e-6);
      expect(result.throughHoleCount).toBe(1);
      expect(comparison.holeRadiusMaximumErrorMm).toBeCloseTo(1, 12);
      expect(comparison.failures).toContain('hole-radius');
      expect(comparison.matches).toBe(false);
      record('different-hole control', comparison);
    });
  });

  it('counts two axially connected cylindrical wall faces as one passage', () => {
    withShape(owner => {
      const bottom = boolean(owner, 'cut', box(owner, [0, 0, 0], [40, 30, 5]), cylinder(owner, [10, 15, -1], 3, 7));
      const top = boolean(owner, 'cut', box(owner, [0, 0, 5], [40, 30, 5]), cylinder(owner, [10, 15, 4], 3, 7));
      return boolean(owner, 'fuse', bottom, top);
    }, shape => {
      const result = measureEx18Shape(oc, shape);
      expectShape('axially split wall', result, EX18_ORACLE_EXPECTATIONS.A);
      expect(result.holes[0]?.wallFaceIndices).toHaveLength(2);
    });
  });

  it('rejects an open five-face shell even when GProp returns a nonzero apparent volume', () => {
    withShape(owner => {
      const original = box(owner, [0, 0, 0], [40, 30, 10]);
      const copier = owner.keep(new oc.BRepBuilderAPI_Copy_2(original, true, false)), copy = owner.keep(copier.Shape());
      const sewing = owner.keep(new oc.BRepBuilderAPI_Sewing(1e-7, true, true, true, false));
      for (let index = 0; index < 5; index++) {
        const face = faceAt(oc, copy, index);
        if (face === null) throw new Error('Missing box face in open-shell fixture');
        sewing.Add(owner.keep(face));
      }
      sewing.Perform(owner.keep(new oc.Message_ProgressRange_1()));
      return owner.keep(sewing.SewedShape());
    }, shape => {
      const result = measureEx18Shape(oc, shape);
      expect(result.validity.solidCount).toBe(0);
      expect(result.validity.closed).toBe(false);
      expect(result.validity.valid).toBe(false);
      expect(result.holesComplete).toBe(false);
      expect(result.volume).toBeGreaterThan(0);
      expect(compareEx18Shape(result, EX18_ORACLE_EXPECTATIONS.A).failures).toContain('validity');
      record('open-shell control', result);
    });
  });

  it('counts two semicylindrical wall faces as one passage', () => {
    withShape(owner => {
      const left = boolean(owner, 'cut', box(owner, [0, 0, 0], [40, 15, 10]), cylinder(owner, [10, 15, -1], 3, 12));
      const right = boolean(owner, 'cut', box(owner, [0, 15, 0], [40, 15, 10]), cylinder(owner, [10, 15, -1], 3, 12));
      return boolean(owner, 'fuse', left, right);
    }, shape => {
      const result = measureEx18Shape(oc, shape);
      expectShape('semicylindrical split wall', result, EX18_ORACLE_EXPECTATIONS.A);
      expect(result.holes[0]?.wallFaceIndices).toHaveLength(2);
    });
  });

  it('does not count a blind cylindrical bore whose lower circular end is capped', () => {
    withShape(owner => boolean(owner, 'cut', box(owner, [0, 0, 0], [40, 30, 10]), cylinder(owner, [10, 15, 2], 3, 9)), shape => {
      const result = measureEx18Shape(oc, shape);
      expect(result.validity.valid).toBe(true);
      expect(result.holesComplete).toBe(true);
      expect(result.throughHoleCount).toBe(0);
      expect(compareEx18Shape(result, EX18_ORACLE_EXPECTATIONS.A).failures).toContain('hole-count');
    });
  });

  it('keeps disconnected coaxial equal-radius blind bores separate', () => {
    withShape(owner => {
      const lower = boolean(owner, 'cut', box(owner, [0, 0, 0], [40, 30, 10]), cylinder(owner, [10, 15, -1], 3, 5));
      return boolean(owner, 'cut', lower, cylinder(owner, [10, 15, 6], 3, 5));
    }, shape => {
      const result = measureEx18Shape(oc, shape);
      expect(result.validity.valid).toBe(true);
      expect(result.holesComplete).toBe(true);
      expect(result.throughHoleCount).toBe(0);
    });
  });

  it('measures a placed hole axis independently of its Z direction', () => {
    withShape(owner => owner.keep(placeShape(oc, plate(owner), { position: [7, 11, 13], rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] })).shape, shape => {
      expectShape('rotated plate', measureEx18Shape(oc, shape), {
        volume: 12000 - 90 * Math.PI, low: [7, 1, 13], high: [47, 11, 43],
        holes: [{ axisOrigin: [17, 0, 28], direction: [0, 1, 0], radius: 3 }],
      });
    });
  });

  it('does not mutate or consume a borrowed shape, which remains usable by the next operation', () => {
    withShape(owner => plate(owner), (shape, owner) => {
      const before = measureEx18Shape(oc, shape), again = measureEx18Shape(oc, shape);
      expect(again).toEqual(before);
      const cut = boolean(owner, 'cut', shape, cylinder(owner, [30, 15, -1], 2, 12));
      expectShape('borrowed shape follow-up', measureEx18Shape(oc, cut), {
        volume: 12000 - 130 * Math.PI, low: [0, 0, 0], high: [40, 30, 10], holes: [
          { axisOrigin: [10, 15, 0], direction: [0, 0, 1], radius: 3 },
          { axisOrigin: [30, 15, 0], direction: [0, 0, 1], radius: 2 },
        ],
      });
      expect(measureEx18Shape(oc, shape)).toEqual(before);
    });
  });

  it('rejects a shifted hole despite identical volume, envelope, hole count and radius', () => {
    withShape(owner => boolean(owner, 'cut', box(owner, [0, 0, 0], [40, 30, 10]), cylinder(owner, [12, 15, -1], 3, 12)), shape => {
      const comparison = compareEx18Shape(measureEx18Shape(oc, shape), EX18_ORACLE_EXPECTATIONS.A);
      expect(comparison.volumeRelativeError).toBeLessThanOrEqual(1e-9);
      expect(comparison.boundsMaximumErrorMm).toBeLessThanOrEqual(1e-6);
      expect(comparison.holeRadiusMaximumErrorMm).toBeLessThanOrEqual(1e-6);
      expect(comparison.holeAxisMaximumErrorMm).toBeCloseTo(2, 12);
      expect(comparison.failures).toEqual(['hole-axis']);
    });
  });

  it('rejects two closed solids as a single-solid result', () => {
    withShape(owner => {
      const compound = owner.keep(new oc.TopoDS_Compound()), builder = owner.keep(new oc.BRep_Builder());
      builder.MakeCompound(compound);
      builder.Add(compound, box(owner, [0, 0, 0], [10, 10, 10]));
      builder.Add(compound, box(owner, [20, 0, 0], [10, 10, 10]));
      return compound;
    }, shape => {
      const result = measureEx18Shape(oc, shape);
      expect(result.validity.brepValid).toBe(true);
      expect(result.validity.closed).toBe(true);
      expect(result.validity.solidCount).toBe(2);
      expect(result.validity.valid).toBe(false);
    });
  });

  it('does not certify two open sections of a stepped bore as two independent through holes', () => {
    withShape(owner => {
      const drilled = plate(owner);
      return boolean(owner, 'cut', drilled, cylinder(owner, [10, 15, 3], 4, 4));
    }, shape => {
      const result = measureEx18Shape(oc, shape);
      expect(result.validity.valid).toBe(true);
      expect(result.boundsMethod).toBe('analytic-brep');
      expect(result.holesComplete).toBe(false);
      expect(result.limitations).toContain('open cylindrical passage does not span the body: stepped/partial-span bore unsupported');
      expect(compareEx18Shape(result, EX18_ORACLE_EXPECTATIONS.A).matches).toBe(false);
    });
  });
});

function shapeEdges(owner: Allocations, shape: Shape): ReturnType<Occt['TopoDS']['Edge_1']>[] {
  const map = owner.keep(new oc.TopTools_IndexedMapOfShape_1());
  oc.TopExp.MapShapes_2(shape, map, true, true);
  const edges: ReturnType<Occt['TopoDS']['Edge_1']>[] = [];
  for (let index = 1; index <= map.Size(); index++) {
    const member = owner.keep(map.FindKey(index));
    if (member.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_EDGE) edges.push(owner.keep(oc.TopoDS.Edge_1(member)));
  }
  return edges;
}

function controlPoints(owner: Allocations, coordinates: readonly Point[]): InstanceType<Occt['TColgp_Array1OfPnt_2']> {
  const poles = owner.keep(new oc.TColgp_Array1OfPnt_2(1, coordinates.length));
  coordinates.forEach((point, index) => poles.SetValue(index + 1, owner.keep(new oc.gp_Pnt_3(...point))));
  return poles;
}

function splineCurve(owner: Allocations, coordinates: readonly Point[], degree: number,
  knotValues: readonly number[], multiplicities: readonly number[], periodic = false, weights?: readonly number[],
): InstanceType<Occt['Handle_Geom_Curve_2']> {
  const poles = controlPoints(owner, coordinates);
  const knots = owner.keep(new oc.TColStd_Array1OfReal_2(1, knotValues.length));
  const mults = owner.keep(new oc.TColStd_Array1OfInteger_2(1, multiplicities.length));
  knotValues.forEach((value, index) => knots.SetValue(index + 1, value));
  multiplicities.forEach((value, index) => mults.SetValue(index + 1, value));
  if (weights === undefined) {
    // The handle takes ownership of the curve; do not also register the raw curve.
    return owner.keep(new oc.Handle_Geom_Curve_2(new oc.Geom_BSplineCurve_1(poles, knots, mults, degree, periodic)));
  }
  const poleWeights = owner.keep(new oc.TColStd_Array1OfReal_2(1, weights.length));
  weights.forEach((value, index) => poleWeights.SetValue(index + 1, value));
  return owner.keep(new oc.Handle_Geom_Curve_2(new oc.Geom_BSplineCurve_2(poles, poleWeights, knots, mults, degree, periodic, true)));
}

function ruledCylinder(owner: Allocations): Shape {
  const maker = owner.keep(new oc.BRepOffsetAPI_ThruSections(true, true, 1e-7));
  maker.SetSmoothing(false);
  for (const z of [0, 20]) {
    const axes = owner.keep(new oc.gp_Ax2_3(owner.keep(new oc.gp_Pnt_3(0, 0, z)), owner.keep(new oc.gp_Dir_4(0, 0, 1))));
    const circle = owner.keep(new oc.gp_Circ_2(axes, 10));
    const edge = owner.keep(owner.keep(new oc.BRepBuilderAPI_MakeEdge_8(circle)).Edge());
    const wire = owner.keep(owner.keep(new oc.BRepBuilderAPI_MakeWire_2(edge)).Wire());
    maker.AddWire(wire);
  }
  maker.Build(owner.keep(new oc.Message_ProgressRange_1()));
  expect(maker.IsDone()).toBe(true);
  return owner.keep(maker.Shape());
}

function bezierPrism(owner: Allocations, middleY: number): Shape {
  const poles = controlPoints(owner, [[0, 0, 0], [10, middleY, 0], [20, 0, 0]]);
  const curve = owner.keep(new oc.Handle_Geom_Curve_2(new oc.Geom_BezierCurve_1(poles)));
  const edge = owner.keep(owner.keep(new oc.BRepBuilderAPI_MakeEdge_24(curve)).Edge());
  const wireMaker = owner.keep(new oc.BRepBuilderAPI_MakeWire_2(edge));
  const corners: readonly Point[] = [[20, 0, 0], [20, 10, 0], [0, 10, 0], [0, 0, 0]];
  for (let index = 1; index < corners.length; index++) {
    const start = owner.keep(new oc.gp_Pnt_3(...corners[index - 1])), end = owner.keep(new oc.gp_Pnt_3(...corners[index]));
    wireMaker.Add_1(owner.keep(owner.keep(new oc.BRepBuilderAPI_MakeEdge_3(start, end)).Edge()));
  }
  const faceMaker = owner.keep(new oc.BRepBuilderAPI_MakeFace_15(owner.keep(wireMaker.Wire()), true));
  expect(faceMaker.IsDone()).toBe(true);
  const prism = owner.keep(new oc.BRepPrimAPI_MakePrism_1(owner.keep(faceMaker.Face()), owner.keep(new oc.gp_Vec_4(0, 0, 5)), true, true));
  return owner.keep(prism.Shape());
}

describe('EX-18 certified linear Bezier and BSpline boundaries', () => {
  it('certifies a capped r10 ruled cylinder with a linear Bezier seam, including its drilled and placed forms', () => {
    withShape(ruledCylinder, (shape, owner) => {
      const seams = shapeEdges(owner, shape).map(edge => owner.keep(new oc.BRepAdaptor_Curve_2(edge)))
        .filter(curve => curve.GetType() === oc.GeomAbs_CurveType.GeomAbs_BezierCurve);
      expect(seams).toHaveLength(1);
      expect(seams[0].Degree()).toBe(1);
      expect(seams[0].NbPoles()).toBe(2);
      const before = measureEx18Shape(oc, shape);
      expectShape('linear Bezier ruled cylinder', before, { volume: 2000 * Math.PI, low: [-10, -10, 0], high: [10, 10, 20], holes: [] });
      const drilled = boolean(owner, 'cut', shape, cylinder(owner, [0, 0, -1], 3, 22));
      expectShape('linear Bezier ruled cylinder with bore', measureEx18Shape(oc, drilled), {
        volume: 1820 * Math.PI, low: [-10, -10, 0], high: [10, 10, 20],
        holes: [{ axisOrigin: [0, 0, 0], direction: [0, 0, 1], radius: 3 }],
      });
      const placed = owner.keep(placeShape(oc, drilled, { position: [7, 11, 13], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] })).shape;
      expectShape('placed linear Bezier cylinder', measureEx18Shape(oc, placed), {
        volume: 1820 * Math.PI, low: [-3, 1, 13], high: [17, 21, 33],
        holes: [{ axisOrigin: [7, 11, 0], direction: [0, 0, 1], radius: 3 }],
      });
      expect(measureEx18Shape(oc, shape)).toEqual(before);
      const line = owner.keep(new oc.Handle_Geom_Curve_2(new oc.Geom_BezierCurve_1(controlPoints(owner, [[0, 0, 0], [20, 0, 0]]))));
      for (const [first, last] of [[0.25, 1], [0, 0.75]]) {
        const trimmed = owner.keep(owner.keep(new oc.BRepBuilderAPI_MakeEdge_25(line, first, last)).Edge());
        expect(measureEx18Shape(oc, trimmed).limitations).toContain('non-linear/non-circular boundary');
      }
      // A short segment keeps these trim parameters above OCCT's parameter confusion.
      // This distinguishes the required 1e-9 mm pole check from the looser geometric tolerance.
      const shortLine = owner.keep(new oc.Handle_Geom_Curve_2(new oc.Geom_BezierCurve_1(controlPoints(owner, [[0, 0, 0], [0.001, 0, 0]]))));
      for (const offset of [0.5e-9, 2e-9]) {
        for (const [first, last] of [[offset / 0.001, 1], [0, 1 - offset / 0.001]]) {
          const trimmed = owner.keep(owner.keep(new oc.BRepBuilderAPI_MakeEdge_25(shortLine, first, last)).Edge());
          const actual = measureEx18Shape(oc, trimmed);
          expect(actual.boundsMethod).toBe(offset < 1e-9 ? 'analytic-brep' : 'unsupported');
          if (offset < 1e-9) {
            expect(actual.bounds?.low[0]).toBeCloseTo(first * 0.001, 18);
            expect(actual.bounds?.high[0]).toBeCloseTo(last * 0.001, 18);
          }
        }
      }
    });
  });

  it('keeps quadratic Bezier boundaries unsupported, including collinear poles', () => {
    for (const middleY of [-4, 0]) withShape(owner => bezierPrism(owner, middleY), (shape, owner) => {
      const curves = shapeEdges(owner, shape).map(edge => owner.keep(new oc.BRepAdaptor_Curve_2(edge)))
        .filter(curve => curve.GetType() === oc.GeomAbs_CurveType.GeomAbs_BezierCurve);
      expect(curves.length).toBeGreaterThan(0);
      expect(curves.every(curve => curve.Degree() === 2 && curve.NbPoles() === 3)).toBe(true);
      const measured = measureEx18Shape(oc, shape);
      expect(measured.validity.valid).toBe(true);
      expect(measured.bounds).toBeNull();
      expect(measured.boundsMethod).toBe('unsupported');
      expect(measured.holesComplete).toBe(false);
      expect(measured.limitations).toContain('non-linear/non-circular boundary');
      expect(compareEx18Shape(measured, { volume: 1000, low: [0, 0, 0], high: [20, 10, 5], holes: [] }).matches).toBe(false);
      record('quadratic Bezier rejection', { middleY, measured });
    });
  });

  it('certifies a nonperiodic nonrational degree-one two-pole BSpline and rejects unsupported spline representations', () => {
    withShape(owner => box(owner, [0, 0, 0], [20, 10, 5]), (shape, owner) => {
      const edge = shapeEdges(owner, shape)[0], original = owner.keep(new oc.BRepAdaptor_Curve_2(edge));
      const first = original.FirstParameter(), last = original.LastParameter();
      const start = owner.keep(original.Value(first)), end = owner.keep(original.Value(last));
      const poles: readonly Point[] = [[start.X(), start.Y(), start.Z()], [end.X(), end.Y(), end.Z()]];
      const spline = splineCurve(owner, poles, 1, [first, last], [2, 2]);
      // Only this newly owned fixture is changed; the same linear parameterization preserves its pcurves.
      owner.keep(new oc.BRep_Builder()).UpdateEdge_1(edge, spline, original.Tolerance());
      const curve = owner.keep(new oc.BRepAdaptor_Curve_2(edge));
      expect(curve.GetType()).toBe(oc.GeomAbs_CurveType.GeomAbs_BSplineCurve);
      expect([curve.Degree(), curve.NbPoles(), curve.NbKnots(), curve.IsPeriodic(), curve.IsRational()]).toEqual([1, 2, 2, false, false]);
      expectShape('linear BSpline box', measureEx18Shape(oc, shape), { volume: 1000, low: [0, 0, 0], high: [20, 10, 5], holes: [] });
      const placed = owner.keep(placeShape(oc, shape, { position: [7, 11, 13], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] })).shape;
      expectShape('placed linear BSpline box', measureEx18Shape(oc, placed), { volume: 1000, low: [-3, 11, 13], high: [7, 31, 18], holes: [] });
      for (const [trimFirst, trimLast] of [[first + (last - first) / 4, last], [first, last - (last - first) / 4]]) {
        const trimmed = owner.keep(owner.keep(new oc.BRepBuilderAPI_MakeEdge_25(spline, trimFirst, trimLast)).Edge());
        expect(measureEx18Shape(oc, trimmed).limitations).toContain('non-linear/non-circular boundary');
      }
      const shortSpline = splineCurve(owner, [[0, 0, 0], [0.001, 0, 0]], 1, [0, 1], [2, 2]);
      for (const offset of [0.5e-9, 2e-9]) {
        for (const [trimFirst, trimLast] of [[offset / 0.001, 1], [0, 1 - offset / 0.001]]) {
          const trimmed = owner.keep(owner.keep(new oc.BRepBuilderAPI_MakeEdge_25(shortSpline, trimFirst, trimLast)).Edge());
          const actual = measureEx18Shape(oc, trimmed);
          expect(actual.boundsMethod).toBe(offset < 1e-9 ? 'analytic-brep' : 'unsupported');
          if (offset < 1e-9) {
            expect(actual.bounds?.low[0]).toBeCloseTo(trimFirst * 0.001, 18);
            expect(actual.bounds?.high[0]).toBeCloseTo(trimLast * 0.001, 18);
          }
        }
      }
      const linePoles: readonly Point[] = [[0, 0, 0], [20, 0, 0]];
      const threePoles: readonly Point[] = [[0, 0, 0], [10, 0, 0], [20, 0, 0]];
      const rejected = [
        splineCurve(owner, linePoles, 1, [0, 1], [2, 2], false, [1, 2]),
        splineCurve(owner, linePoles, 1, [0, 0.5, 1], [1, 1, 1], true),
        splineCurve(owner, threePoles, 1, [0, 0.5, 1], [2, 1, 2]),
        splineCurve(owner, threePoles, 2, [0, 1], [3, 3]),
      ];
      for (const candidate of rejected) {
        const unsupported = owner.keep(owner.keep(new oc.BRepBuilderAPI_MakeEdge_24(candidate)).Edge());
        const measured = measureEx18Shape(oc, unsupported);
        expect(measured.bounds).toBeNull();
        expect(measured.limitations).toContain('non-linear/non-circular boundary');
      }
    });
  });
});
