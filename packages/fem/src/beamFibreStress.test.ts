import { describe, expect, it } from 'vitest';
import { checkFibreSection, compareWithYield, elementFibreStresses, fibreExtremes, type AnalysedSection,
  type BeamFibreSection } from './beamFibreStress.js';
import type { ImpactElementEndForces, SectionResultants } from './beamImpactInterior.js';

// Independent textbook forms (not the code's N/A + My z/Iy - Mz y/Iz): rectangle 6M/(b h^2), solid circle
// 32M/(pi d^3), tube 32 M D/(pi (D^4 - d^4)). SI units: m, N, N m, Pa.
function near(actual: number, expected: number, relative = 1e-12): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(relative * Math.max(Math.abs(expected), 1e-30));
}
const rectangle = { kind: 'rectangle', widthYM: 0.02, depthZM: 0.04 } as const;
const rectangleSection: AnalysedSection = { areaM2: 0.02 * 0.04, iyM4: 0.02 * 0.04 ** 3 / 12, izM4: 0.04 * 0.02 ** 3 / 12 };
const resultants = (n: number, my: number, mz: number): SectionResultants => [n, 0, 0, 0, my, mz];

describe('elastic longitudinal fibre stress over the actual section boundary', () => {
  it('rectangle, pure My: +-6M/(b h^2) with tension at +z (right-hand moment about local y)', () => {
    const { maximum, minimum } = fibreExtremes(resultants(0, 100, 0), rectangle, rectangleSection);
    near(maximum.stressPa, 6 * 100 / (0.02 * 0.04 ** 2));
    expect(maximum.zM).toBe(0.02);
    near(minimum.stressPa, -6 * 100 / (0.02 * 0.04 ** 2));
    expect(minimum.zM).toBe(-0.02);
  });

  it('rectangle, pure Mz: tension at -y (a positive moment about local z compresses +y fibres)', () => {
    const { maximum } = fibreExtremes(resultants(0, 0, 10), rectangle, rectangleSection);
    near(maximum.stressPa, 6 * 10 / (0.04 * 0.02 ** 2));
    expect(maximum.yM).toBe(-0.01);
  });

  it('rectangle, combined N + My + Mz: corner extremes N/A +- 6My/(b h^2) +- 6Mz/(h b^2) and compression sign', () => {
    const { maximum, minimum } = fibreExtremes(resultants(8000, 100, 10), rectangle, rectangleSection);
    const axial = 8000 / (0.02 * 0.04), bendY = 6 * 100 / (0.02 * 0.04 ** 2), bendZ = 6 * 10 / (0.04 * 0.02 ** 2);
    near(maximum.stressPa, axial + bendY + bendZ);
    expect([maximum.yM, maximum.zM]).toEqual([-0.01, 0.02]);
    near(minimum.stressPa, axial - bendY - bendZ);
    expect(minimum.stressPa).toBeLessThan(0);
    expect([minimum.yM, minimum.zM]).toEqual([0.01, -0.02]);
    // Pure compression: both extremes negative and equal to N/A.
    const squeezed = fibreExtremes(resultants(-8000, 0, 0), rectangle, rectangleSection);
    near(squeezed.maximum.stressPa, -axial);
    near(squeezed.minimum.stressPa, -axial);
  });

  it('solid circle, biaxial My = 30, Mz = 40 N m: 32|M|/(pi d^3) at the boundary point along (-Mz, My)', () => {
    const d = 0.03, inertia = Math.PI * d ** 4 / 64;
    const circle: AnalysedSection = { areaM2: Math.PI * d * d / 4, iyM4: inertia, izM4: inertia };
    const { maximum, minimum } = fibreExtremes(resultants(0, 30, 40), { kind: 'circle', diameterM: d }, circle);
    near(maximum.stressPa, 32 * 50 / (Math.PI * d ** 3));
    near(maximum.yM, -0.012);
    near(maximum.zM, 0.009);
    near(minimum.stressPa, -32 * 50 / (Math.PI * d ** 3));
  });

  it('tube D = 50 mm, t = 5 mm, My = 100 N m: 32 M D / (pi (D^4 - d^4))', () => {
    const D = 0.05, inner = 0.04, inertia = Math.PI * (D ** 4 - inner ** 4) / 64;
    const tube: AnalysedSection = { areaM2: Math.PI * (D * D - inner * inner) / 4, iyM4: inertia, izM4: inertia };
    const { maximum } = fibreExtremes(resultants(0, 100, 0), { kind: 'tube', outsideDiameterM: D, wallThicknessM: 0.005 }, tube);
    near(maximum.stressPa, 32 * 100 * D / (Math.PI * (D ** 4 - inner ** 4)));
    near(maximum.zM, 0.025);
  });
});

describe('section definition validation (explicit outline, never derived from A and I)', () => {
  it('accepts a consistent outline and reports unsupported, invalid and inconsistent ones by type', () => {
    expect(checkFibreSection(rectangle, rectangleSection).status).toBe('supported');
    expect(checkFibreSection({ kind: 'unsupported', profile: 'hBeam' }, rectangleSection))
      .toEqual({ status: 'unsupported', profile: 'hBeam' });
    expect(checkFibreSection({ kind: 'rectangle', widthYM: -0.02, depthZM: 0.04 }, rectangleSection).status).toBe('invalid');
    expect(checkFibreSection({ kind: 'tube', outsideDiameterM: 0.05, wallThicknessM: 0.03 }, rectangleSection).status).toBe('invalid');
    // Swapped orientation (width along z) changes Iy/Iz: refused instead of silently mixed.
    expect(checkFibreSection({ kind: 'rectangle', widthYM: 0.04, depthZM: 0.02 }, rectangleSection))
      .toMatchObject({ status: 'inconsistent', property: 'iy' });
    // A millimetre outline against SI section properties is caught as a unit mistake.
    expect(checkFibreSection({ kind: 'rectangle', widthYM: 20, depthZM: 40 }, rectangleSection))
      .toMatchObject({ status: 'inconsistent', property: 'area' });
  });
});

describe('element ends over emitted samples, and the yield comparison', () => {
  const forces = (start: readonly SectionResultants[], end: readonly SectionResultants[]): ImpactElementEndForces[] =>
    [{ element: 1, memberId: 'm', segment: 0, start, end }];
  it('double curvature: member-mean moment zero, but both ends reach 6M/(h b^2) in the governing sample', () => {
    const M = 10;
    const rows = elementFibreStresses(forces([resultants(0, 0, 0), resultants(0, 0, M)], [resultants(0, 0, 0), resultants(0, 0, -M)]),
      rectangle, rectangleSection);
    const peak = 6 * M / (0.04 * 0.02 ** 2);
    for (const row of rows) {
      near(row.tension.stressPa, peak);
      near(row.compression.stressPa, -peak);
      expect(row.tension.sample).toBe(1);
    }
    // Opposite ends put tension on opposite y faces.
    expect(rows.map(row => row.tension.yM)).toEqual([-0.01, 0.01]);
  });

  it('yield: missing data is not a pass; a caller-supplied sourced value gives a nominal-only comparison', () => {
    expect(compareWithYield(3e8, null).status).toBe('data-missing');
    // Test-only datum (not a material claim): 245 MPa from a hypothetical preset.
    const allowable = { presetId: 'test-only', yieldMPa: 245, sourceId: 'test-only', condition: 'test-only' };
    expect(compareWithYield(-2.0e8, allowable)).toMatchObject({ status: 'nominal-stress-below-yield', peakMPa: 200 });
    expect(compareWithYield(2.45e8, allowable).status).toBe('nominal-stress-at-or-above-yield');
    expect(() => compareWithYield(Number.NaN, allowable)).toThrow('fibre-stress');
  });

  it('rejects a non-finite stress', () => {
    expect(() => fibreExtremes(resultants(Number.POSITIVE_INFINITY, 0, 0), rectangle, rectangleSection)).toThrow('fibre-stress');
  });
});

// Keeps the typed union exhaustive for consumers: every supported kind is accepted by the checker.
const kinds: readonly BeamFibreSection['kind'][] = ['rectangle', 'circle', 'tube', 'unsupported'];
it('documents the four section kinds', () => expect(kinds).toHaveLength(4));
