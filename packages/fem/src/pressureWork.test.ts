import { describe, expect, it } from 'vitest';
import { prepareCadSolidAnalysis } from './cadSolidAnalysis.js';
import { add, buildPressureCase, cross, cylinderPressureGeometry, dot, fieldAt, IDENTITY, independentResultants, matVec,
  nodalResultants, norm, placeIntegrals, planarPressureGeometry, pressureSettings, relativeError, rotationAbout, scale,
  skew, sphereCapPressureGeometry, sub, ZERO_MAT, type LinearField, type Placement, type PressureGeometry,
  type Vec } from './pressureWork.testSupport.js';

// W13: dead signed pressure (positive pushes into the material) -> public tet4 nodal loads, compared with exact surface
// integrals that never read the product conversion. The triangulated face is the oracle at 1e-6; the smooth CAD surface
// it approximates is kept as a separate row. For the half cylinder the faceted resultant is exactly -2 R L p y-hat for
// ANY partition (sum of chords = end - start), so a factor such as sin(pi/N)/(pi/N) does not describe the resultant.
const PRESSURE_MPA = 2.5, LIMIT = 1e-6;
const UNPLACED: Placement = { name: 'unplaced', rotation: IDENTITY, translation: [0, 0, 0] };
const TURNED: Placement = { name: 'axis (1,2,3) 37 deg', rotation: rotationAbout([1, 2, 3], 37), translation: [12.5, -7.25, 3.125] };
const OMEGA: Vec = [0.2, -0.5, 0.35], PIVOT: Vec = [1, 2, -1];
const FIELDS: readonly LinearField[] = [
  { name: 'rigid translation', gradient: ZERO_MAT, offset: [0.3, -0.7, 1.1] },
  { name: 'rigid rotation', gradient: skew(OMEGA), offset: scale(-1, cross(OMEGA, PIVOT)) },
  { name: 'first-order stretch', gradient: [[1.2, 0.3, -0.4], [0.1, -0.6, 0.25], [0.5, -0.2, 0.9]], offset: [0.05, 0, -0.1] },
];
const geometries = (): PressureGeometry[] => [planarPressureGeometry(), cylinderPressureGeometry(true),
  cylinderPressureGeometry(false), sphereCapPressureGeometry()];
/** Representative force |p| x area; the sphere cap uses its smooth area (an upper bound of the faceted one). */
const representativeForce = (geometry: PressureGeometry): number =>
  Math.abs(PRESSURE_MPA) * (geometry.triangulated.area ?? geometry.smooth.area ?? Number.NaN);

describe('W13 surface pressure to nodal loads against independent integrals', () => {
  it('matches independent resultant, moment and work integrals on planar, polygonal-cylinder and triangulated sphere-cap pressure faces', async () => {
    for (const geometry of geometries()) {
      const { solid } = geometry, steps = solid.circumferentialSteps;
      if (steps.length > 0) {
        expect(steps.length).toBeGreaterThanOrEqual(24);
        expect(Math.max(...steps) / Math.min(...steps)).toBeGreaterThan(1.5);
      }
      const forceScale = representativeForce(geometry);
      expect(Number.isFinite(forceScale) && forceScale > 0).toBe(true);
      for (const placement of [UNPLACED, TURNED]) {
        const value = await buildPressureCase(solid, placement);
        const prepared = prepareCadSolidAnalysis(value.context, value.mesh, value.regions, value.labelFaces,
          pressureSettings(value, solid, PRESSURE_MPA));
        const actual = nodalResultants(prepared.input, FIELDS);
        const expected = independentResultants(placeIntegrals(geometry.triangulated, placement), PRESSURE_MPA, FIELDS);
        const reach = Math.max(...value.points.map(norm));
        const checks: [string, ReturnType<typeof relativeError>][] = [
          ['nodal force', relativeError(actual.force, expected.force, forceScale)],
          ['totalForceN', relativeError(prepared.totalForceN, expected.force, forceScale)],
          ['moment about origin', relativeError(actual.moment, expected.moment, forceScale * reach)],
          ...FIELDS.map((field, index): [string, ReturnType<typeof relativeError>] => [`work ${field.name}`,
            relativeError(actual.work[index], expected.work[index],
              forceScale * Math.max(...value.points.map(x => norm(fieldAt(field, x)))))]),
        ];
        if (geometry.triangulated.area !== null)
          checks.push(['loaded area', relativeError(prepared.loadedAreaMm2, geometry.triangulated.area, geometry.triangulated.area)]);
        for (const [name, row] of checks)
          expect(row.error, `${solid.name} / ${placement.name} / ${name} (${row.denominator})`).toBeLessThanOrEqual(LIMIT);
        if (solid.name === 'cylinder-full') {
          // Closed-loop zero expectations are divided by the representative force / moment / work, never by ~0.
          expect(checks.slice(0, 5).map(([, row]) => row.denominator))
            .toEqual(['representative', 'representative', 'representative', 'representative', 'representative']);
          expect(checks[5][1].denominator).toBe('expected');
        }
        if (solid.name.startsWith('cylinder')) {
          const axis = matVec(placement.rotation, [0, 0, 1]);
          expect(Math.abs(dot(actual.force, axis)) / forceScale, `${solid.name} axial force / |p|A`).toBeLessThanOrEqual(LIMIT);
        }
      }
    }
    // Smooth originals stay distinct from the faceted oracle.
    const [, full, half, cap] = geometries();
    expect(relativeError(half.triangulated.vectorArea, half.smooth.vectorArea, 1).error).toBeLessThanOrEqual(LIMIT);
    expect(relativeError(scale(-PRESSURE_MPA, half.triangulated.vectorArea), [0, -2 * 3 * 6 * PRESSURE_MPA, 0], 1).error)
      .toBeLessThanOrEqual(LIMIT);
    for (const cylinder of [full, half]) {
      const [faceted, smooth] = [cylinder.triangulated.area ?? Number.NaN, cylinder.smooth.area ?? Number.NaN];
      expect((smooth - faceted) / smooth).toBeGreaterThan(1e-4);
    }
    expect((norm(cap.smooth.vectorArea) - norm(cap.triangulated.vectorArea)) / norm(cap.smooth.vectorArea)).toBeGreaterThan(1e-3);
  });

  it('keeps positive pressure inward and carries resultant and moment through a 37 degree rigid rotation about (1,2,3)', async () => {
    for (const geometry of geometries()) {
      const { solid } = geometry, forceScale = representativeForce(geometry);
      const base = await buildPressureCase(solid, UNPLACED), turned = await buildPressureCase(solid, TURNED);
      const reach = Math.max(...turned.points.map(norm));
      const loadedCount = solid.faceOfTriangle.filter(face => face === solid.loadedFace).length;
      const forces: Vec[] = [];
      for (const pressure of [PRESSURE_MPA, -PRESSURE_MPA]) {
        const pair = [base, turned].map(value => ({ value, prepared: prepareCadSolidAnalysis(value.context, value.mesh,
          value.regions, value.labelFaces, pressureSettings(value, solid, pressure)) }));
        for (const { value, prepared } of pair) {
          expect(prepared.input.surfaceLoads).toHaveLength(loadedCount);
          for (const load of prepared.input.surfaceLoads) {
            const [a, b, c] = load.nodes.map(node => prepared.input.nodes[node]);
            // Convex solid: the interior node sees every boundary face from inside, so this is an outward direction.
            const outward = sub(scale(1 / 3, add(add(a, b), c)), value.interior);
            expect(Math.sign(dot(load.tractionMPa, outward)), `${solid.name} inward sign`).toBe(-Math.sign(pressure));
            expect(Math.abs(norm(load.tractionMPa) - Math.abs(pressure)) / Math.abs(pressure)).toBeLessThanOrEqual(LIMIT);
          }
        }
        const [unplaced, placed] = pair.map(({ prepared }) => nodalResultants(prepared.input, []));
        const rotatedForce = matVec(TURNED.rotation, unplaced.force);
        const movedMoment = add(matVec(TURNED.rotation, unplaced.moment), cross(TURNED.translation, rotatedForce));
        expect(relativeError(placed.force, rotatedForce, forceScale).error, `${solid.name} rotated force`).toBeLessThanOrEqual(LIMIT);
        expect(relativeError(placed.moment, movedMoment, forceScale * reach).error, `${solid.name} rotated moment`)
          .toBeLessThanOrEqual(LIMIT);
        forces.push(placed.force);
      }
      expect(relativeError(forces[1], scale(-1, forces[0]), forceScale).error, `${solid.name} reversal`).toBeLessThanOrEqual(LIMIT);
    }
  });
});
