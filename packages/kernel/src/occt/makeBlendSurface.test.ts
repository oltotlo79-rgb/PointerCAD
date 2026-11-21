import type { BRepAdaptor_Surface, OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Vec3Tuple } from '../types.js';
import { createAllocations } from './allocations.js';
import type { BlendSurfaceInput } from './blendControlRows.js';
import { borrowHandle } from './borrowHandle.js';
import { MAX_FUNCTION_SURFACE_SPLINE_POLES } from './functionSurfaceSpline.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBlendSurface } from './makeBlendSurface.js';
import { isValidShape } from './solidMesh.js';
import { APPROXIMATION_TOLERANCE_MM } from './tolerances.js';

let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);

const tolerance = { distanceMm: APPROXIMATION_TOLERANCE_MM, angleDeg: 0.01 };
const corner: BlendSurfaceInput = {
  uKnots: [-2, -1, 3, 6], weightA: 3, weightB: 6, flipB: false,
  edgeA: u => ({ point: [u, 0, 0], tangent: [0, 1, 0] }),
  edgeB: u => ({ point: [u, 3, 3], tangent: [0, 0, 1] }),
};

function checkFace(input: BlendSurfaceInput, inspect: (adaptor: BRepAdaptor_Surface) => void): void {
  const result = makeBlendSurface(oc, input, tolerance);
  if (result.status !== 'shape') throw new Error(JSON.stringify(result.measurement));
  const owned = createAllocations();
  owned.keep(result);
  try {
    expect(result.shape.ShapeType()).toBe(oc.TopAbs_ShapeEnum.TopAbs_FACE);
    expect(isValidShape(oc, result.shape)).toBe(true);
    expect(result.measurement.maxAngleDeg).toBeLessThan(0.01);
    expect(result.measurement.maxDistanceMm).toBeLessThan(tolerance.distanceMm);
    inspect(owned.keep(new oc.BRepAdaptor_Surface_2(result.shape, true)));
  } finally { owned.release(); }
  expect(() => result.delete()).not.toThrow();
}

function checkVector(actual: Vec3Tuple, expected: Vec3Tuple): void {
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 10));
}

function evaluate(adaptor: BRepAdaptor_Surface, u: number, v: number) {
  const owned = createAllocations();
  try {
    const point = owned.keep(new oc.gp_Pnt_1());
    const du = owned.keep(new oc.gp_Vec_1()), dv = owned.keep(new oc.gp_Vec_1());
    adaptor.D1(u, v, point, du, dv);
    return { point: [point.X(), point.Y(), point.Z()] as const, dv: [dv.X(), dv.Y(), dv.Z()] as const };
  } finally { owned.release(); }
}

describe('制御点から作るつなぎ面', () => {
  it('極数の上限と近すぎる節を、元の辺を評価する前に断る', () => {
    let visits = 0;
    const edgeA = (u: number) => { visits++; return corner.edgeA(u); };
    // 2*n poles along U, times four along V. One extra knot exceeds the shared ceiling.
    const count = Math.floor(MAX_FUNCTION_SURFACE_SPLINE_POLES / 8) + 1;
    for (const uKnots of [[1, 1 + Number.EPSILON], Array.from({ length: count }, (_, i) => i)]) {
      expect(() => makeBlendSurface(oc, { ...corner, edgeA, uKnots }, tolerance)).toThrow(RangeError);
    }
    expect(visits).toBe(0);
  });

  it('直交する平面の間で、共通の U 節・V の 4 極・両側の位置と微分を実面から読む', () => {
    checkFace(corner, adaptor => {
      expect(adaptor.GetType()).toBe(oc.GeomAbs_SurfaceType.GeomAbs_BSplineSurface);
      const handle = adaptor.BSpline();
      try {
        const surface = borrowHandle(handle);
        expect([Number(surface.UDegree()), Number(surface.VDegree())]).toEqual([3, 3]);
        expect([Number(surface.NbUPoles()), Number(surface.NbVPoles())]).toEqual([8, 4]);
        expect([surface.IsURational(), surface.IsVRational(), surface.IsCNu(1)]).toEqual([false, false, true]);
        expect(corner.uKnots.map((_, i) => surface.UKnot(i + 1))).toEqual(corner.uKnots);
        expect(corner.uKnots.map((_, i) => Number(surface.UMultiplicity(i + 1)))).toEqual([4, 2, 2, 4]);
        expect([surface.VKnot(1), surface.VKnot(2)]).toEqual([0, 1]);
        expect([Number(surface.VMultiplicity(1)), Number(surface.VMultiplicity(2))]).toEqual([4, 4]);
      } finally { handle.delete(); }
      for (const u of [-2, -1.5, -1, 1.25, 3, 6]) {
        const a = evaluate(adaptor, u, 0), b = evaluate(adaptor, u, 1);
        checkVector(a.point, [u, 0, 0]); checkVector(a.dv, [0, 3, 0]);
        checkVector(b.point, [u, 3, 3]); checkVector(b.dv, [0, 0, 6]);
        // YZ controls (0,0),(1,0),(3,1),(3,3) have Bernstein weights (1,3,3,1)/8 at v=1/2.
        checkVector(evaluate(adaptor, u, 0.5).point, [u, 15 / 8, 6 / 8]);
      }
    });
  });

  it('平行で高さのずれた 2 平面の間を S 字で結ぶ', () => {
    const input: BlendSurfaceInput = { ...corner, weightA: 6,
      edgeB: u => ({ point: [u, 6, 4], tangent: [0, 1, 0] }) };
    checkFace(input, adaptor => {
      // Y controls [0,2,4,6] give 6v. Z controls [0,0,4,4] give 4(3v²-2v³),
      // with opposite curvature on either side of v=1/2 and horizontal end tangents.
      for (const v of [0, 0.25, 0.5, 0.75, 1]) {
        const { point, dv } = evaluate(adaptor, 1.75, v);
        checkVector(point, [1.75, 6 * v, 4 * v * v * (3 - 2 * v)]);
        checkVector(dv, [0, 6, 24 * v * (1 - v)]);
      }
    });
  });

  it('flipB は非等間隔の U を反転し、B の位置と接線を同じ元の位置から取る', () => {
    const input: BlendSurfaceInput = { ...corner, flipB: true,
      edgeB: t => ({ point: [4 - t, 3, 3], tangent: [0, 0, 1 + (4 - t) / 8] }) };
    checkFace(input, adaptor => {
      // The reflected parameter is (-2+6)-u. Thus x=u and dV.z=6(1+u/8), with positive sign.
      for (const u of [-2, -1, 1.75, 3, 5.5, 6]) {
        const b = evaluate(adaptor, u, 1);
        checkVector(b.point, [u, 3, 3]); checkVector(b.dv, [0, 0, 6 * (1 + u / 8)]);
      }
    });
  });

  it('両端の節では一致しても、節間に残る元の辺の膨らみと接線のずれを測って面を断る', () => {
    const bump = (u: number) => 4 * u * (1 - u);
    const input: BlendSurfaceInput = { ...corner, uKnots: [0, 1],
      edgeA: u => ({ point: [u, 0, bump(u)], tangent: [0, 1, 0] }),
      edgeB: u => ({ point: [u, 3, 3], tangent: [0, bump(u), 1] }) };
    // At u=1/2 the A fit misses z=1 by 1 mm; at B, +Z and (0,1,1) form 45°.
    const result = makeBlendSurface(oc, input, tolerance);
    try {
      expect(result.status).toBe('outside-tolerance');
      expect(result.measurement.maxDistanceMm).toBeCloseTo(1, 12);
      expect(result.measurement.maxAngleDeg).toBeCloseTo(45, 10);
    } finally { if (result.status === 'shape') result.delete(); }
  });
});
