import type { Point2, RenderPath } from '@pointercad/drawing';
import type { CadSolidOutcome } from '@pointercad/fem';
import type { Vec3 } from '@pointercad/model/vec3';
import { describe, expect, it } from 'vitest';
import { solidReportField, type SolidReportField } from './solidReportField.js';

/**
 * The stress figure of the solid report, seen from the viewport's home view: the eye is toward (+1, -1, +1), so the
 * front (-Y), top (+Z) and right (+X) faces are visible and the back, bottom and left faces are not. A corner
 * tetrahedron [o, o+x, o+y, o+z] has its boundary triangles in the order of solidFieldView.ts: 4k bottom (-Z),
 * 4k+1 front (-Y), 4k+2 left (-X) and 4k+3 the sloping face (+X+Y+Z); from the home view only 4k+1 and 4k+3 are visible.
 */
type SolidResult = Extract<CadSolidOutcome, { kind: 'result' }>;
interface Element { readonly nodes: readonly [number, number, number, number]; readonly stressMPa: number }
interface Tet { readonly origin: Vec3; readonly sideMm: number; readonly stressMPa: number }

const FIGURE_BOX = [13, -7, 178, 42] as const;
const BAND_FILLS = ['#445ad3', '#6357c9', '#7954bf', '#8a51b4', '#9a4da7',
  '#a7499a', '#b4458a', '#bf4179', '#c93c63', '#d33744'];

/** A static result on the given nodes and tetrahedra (shared nodes make shared faces interior). */
function meshOutcome(nodes: readonly Vec3[], elements: readonly Element[]): SolidResult {
  const input: SolidResult['prepared']['input'] = {
    schema: 'pointercad-solid-tet4/1', source: { documentId: 'solid', revision: 1, meshKey: 'mesh' }, units: 'N-mm-MPa',
    numericBudgetBytes: 1, nodes, elements: elements.map(element => ({ nodes: element.nodes, materialId: 'material' })),
    materials: [{ id: 'material', youngMPa: 200, poisson: 0.3 }], constraints: [], nodalLoads: [], surfaceLoads: [],
  };
  return {
    kind: 'result', prepared: { input, loadedAreaMm2: 0, totalForceN: [0, 0, 0] },
    result: {
      kind: 'oofem-linear-solid-tet4', source: input.source, inputSha256: 'fixture',
      method: 'oofem-ltrspace-isole-native-ldlt/1', units: 'N-mm-MPa', structuralCertification: false,
      displacementMm: nodes.map((_, index) => [0, 0, index % 4 === 1 ? 50 : 0]),
      reactionN: nodes.map(() => [0, 0, 0]), elements: elements.map(({ stressMPa }) => ({
        strain: [0, 0, 0, 0, 0, 0], stressMPa: [stressMPa, 0, 0, 0, 0, 0],
      })),
      strainEnergyNmm: 0, maximumRelativeEquilibriumResidual: 0, reservedNumericBytes: 0,
      nativeElementForcesN: elements.map(() => []), minimumScaledPivot: 1,
    },
    mesh: {
      kind: 'netgen-tetra-mesh', input: { schema: 'pointercad-convex-plc/1', units: 'mm',
        source: { documentId: 'solid', revision: 1, featureId: 'tet', bodyKey: 'body' },
        coordinates: [], triangles: [], tags: [], tagCount: 0 },
      inputSha256: 'fixture', coordinates: [], tetrahedra: [], boundaryTriangles: [], boundaryTags: [],
      volumeMm3: 0, minTetVolumeMm3: 0,
    },
  };
}

/** Separate corner tetrahedra [o, o+x, o+y, o+z]. */
function outcome(tets: readonly Tet[]): SolidResult {
  const nodes = tets.flatMap(({ origin: [x, y, z], sideMm }): Vec3[] =>
    [[x, y, z], [x + sideMm, y, z], [x, y + sideMm, z], [x, y, z + sideMm]]);
  return meshOutcome(nodes, tets.map(({ stressMPa }, index) => {
    const first = index * 4;
    return { nodes: [first, first + 1, first + 2, first + 3], stressMPa };
  }));
}

function reportFor(result: SolidResult): SolidReportField {
  const field = solidReportField(result);
  if (field === null) throw new Error('Expected a report figure for this tetrahedral result');
  return field;
}

function fieldPaths(paths: readonly RenderPath[]): RenderPath[] {
  return paths.filter(path => path.layerId === 'field');
}

function pathPoints(path: RenderPath): Point2[] {
  return path.subpaths.flatMap(subpath => subpath.commands.flatMap(command =>
    command.kind === 'M' || command.kind === 'L' ? [command.to] : []));
}

/**
 * Two flat tetrahedra on both sides of one shared triangle (its face is interior): the side toward `toward` carries 10 MPa,
 * the opposite side 0 MPa. The triangle is ordered so that both tetrahedra have a positive volume in the supplied order,
 * and every outward normal is 0.1 or more away from edge-on for the home view.
 */
function bipyramid(triangle: readonly [Vec3, Vec3, Vec3], apex: Vec3, toward: Vec3): { nodes: Vec3[]; elements: Element[] } {
  const near: Vec3 = [apex[0] + toward[0], apex[1] + toward[1], apex[2] + toward[2]];
  const far: Vec3 = [apex[0] - toward[0], apex[1] - toward[1], apex[2] - toward[2]];
  return { nodes: [...triangle, near, far], elements: [{ nodes: [0, 1, 2, 3], stressMPa: 10 }, { nodes: [0, 2, 1, 4], stressMPa: 0 }] };
}

describe('solid report field', () => {
  it('counts the boundary, culls faces turned from the eye and drops only visible faces below 0.005 mm² on paper', () => {
    // Fit (171 mm wide, 42 mm high box after the band): scale 42 / 3.68403 = 11.4005 mm per mm. Both visible faces of a
    // corner tet project to s² / (2√3) times the squared scale: 0.00454 mm² for s = 0.011 and 0.00540 mm² for s = 0.012.
    const field = reportFor(outcome([
      { origin: [0, 0, 0], sideMm: 1, stressMPa: 0 },
      { origin: [2, 2, 2], sideMm: 0.011, stressMPa: 5 },
      { origin: [4, 4, 4], sideMm: 0.012, stressMPa: 10 },
    ]));
    const { paths, drawn, dropped } = field.draw(...FIGURE_BOX);
    expect(field.triangles).toBe(12);
    expect([drawn, dropped]).toEqual([4, 2]);
    expect(drawn + dropped + 6).toBe(field.triangles); // Bottom and left faces of each tet face away from the eye.
    expect(field.legend).toEqual({ minimum: 0, maximum: 10, constant: false });
    expect(fieldPaths(paths).map(path => [path.ownerId, path.fill, path.stroke])).toEqual([
      ['tri-3', BAND_FILLS[0], null], ['tri-1', BAND_FILLS[0], null], ['tri-11', BAND_FILLS[9], null], ['tri-9', BAND_FILLS[9], null],
    ]);
  });

  it('shows the top, front and right sides of the home view and never the bottom, back or left sides', () => {
    // Each bipyramid has 10 MPa on the visible side and 0 MPa on the hidden side; a figure seen from below, or the mirror
    // image of the view from (+1, +1, +1), would draw some of the 0 MPa faces.
    const parts = [
      bipyramid([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [0.3, 0.3, 0], [0, 0, 0.1]),
      bipyramid([[3, 0, 0], [3, 1, 0], [3, 0, 1]], [3, 0.3, 0.3], [0.1, 0, 0]),
      bipyramid([[6, 0, 0], [7, 0, 0], [6, 0, 1]], [6.3, 0, 0.3], [0, -0.1, 0]),
    ];
    const nodes = parts.flatMap(part => part.nodes);
    const shifted = (element: Element, offset: number): Element => {
      const [a, b, c, d] = element.nodes;
      return { ...element, nodes: [a + offset, b + offset, c + offset, d + offset] };
    };
    const elements = parts.flatMap((part, index) => part.elements.map(element => shifted(element, index * 5)));
    const field = reportFor(meshOutcome(nodes, elements));
    const { paths, drawn, dropped } = field.draw(...FIGURE_BOX);
    expect(field.triangles).toBe(18);
    expect([drawn, dropped]).toEqual([9, 0]);
    expect(new Set(fieldPaths(paths).map(path => path.fill))).toEqual(new Set([BAND_FILLS[9]]));
  });

  it('keeps the home view on paper the right way round: +Y goes up and right, +X down and right, +Z straight up', () => {
    const field = reportFor(outcome([{ origin: [0, 0, 0], sideMm: 1, stressMPa: 1 }]));
    const sloping = fieldPaths(field.draw(...FIGURE_BOX).paths).find(path => path.ownerId === 'tri-3');
    // The sloping face is (o+x, o+y, o+z) in that order.
    const [onX, onY, onZ] = sloping === undefined ? [] : pathPoints(sloping);
    expect(onY[0]).toBeCloseTo(onX[0], 9);
    expect(onY[1]).toBeGreaterThan(onX[1]);
    expect(onZ[0]).toBeLessThan(onX[0]);
    expect(onZ[1]).toBeGreaterThan(onY[1]);
  });

  it('draws from far to near by centroid depth and breaks equal depths by triangle index', () => {
    // Depth toward the eye ∝ x − y + z. The last tet lies on the second one (its own nodes, the same coordinates), so their
    // faces have exactly the same depths and the lower triangle index goes first.
    const field = reportFor(outcome([
      { origin: [4, 4, 4], sideMm: 1, stressMPa: 1 },
      { origin: [0, 0, 0], sideMm: 1, stressMPa: 2 },
      { origin: [-4, -4, -4], sideMm: 1, stressMPa: 3 },
      { origin: [0, 0, 0], sideMm: 1, stressMPa: 4 },
    ]));
    const { paths } = field.draw(...FIGURE_BOX);
    expect(fieldPaths(paths).map(path => [path.ownerId, path.fill])).toEqual([
      ['tri-11', BAND_FILLS[6]], ['tri-9', BAND_FILLS[6]], ['tri-7', BAND_FILLS[3]], ['tri-15', BAND_FILLS[9]],
      ['tri-5', BAND_FILLS[3]], ['tri-13', BAND_FILLS[9]], ['tri-3', BAND_FILLS[0]], ['tri-1', BAND_FILLS[0]],
    ]);
  });

  it('uses all ten colour steps in low-to-high order and the sixth step for a constant field', () => {
    const field = reportFor(outcome([{ origin: [0, 0, 0], sideMm: 1, stressMPa: 4 }]));
    const { paths } = field.draw(...FIGURE_BOX);
    const bands = paths.filter(path => path.layerId === 'legend' && path.fill !== null);
    expect(bands.map(path => path.fill)).toEqual(BAND_FILLS);
    expect(bands.map(path => pathPoints(path)[0][1])).toEqual(
      BAND_FILLS.map((_, index) => FIGURE_BOX[1] + FIGURE_BOX[3] * (index / BAND_FILLS.length)));
    expect(paths.find(path => path.ownerId === 'band-frame')?.stroke?.widthMm).toBeGreaterThan(0);
    expect(field.legend).toEqual({ minimum: 4, maximum: 4, constant: true });
    expect(fieldPaths(paths).map(path => path.fill)).toEqual([BAND_FILLS[5], BAND_FILLS[5]]);
  });

  it('keeps all coordinates finite and in the figure with a gap before the band, using the undeformed mesh', () => {
    const result = outcome([{ origin: [0, 0, 0], sideMm: 1, stressMPa: 4 }]);
    const field = reportFor(result);
    const narrowBox = [13, -7, 25, 42] as const;
    const [left, bottom, width, height] = narrowBox;
    const draw = field.draw(...narrowBox);
    const bandLeft = Math.min(...draw.paths.filter(path => path.layerId === 'legend').flatMap(pathPoints).map(point => point[0]));
    for (const path of draw.paths) {
      for (const [x, y] of pathPoints(path)) {
        expect([x, y].every(Number.isFinite)).toBe(true);
        expect(x).toBeGreaterThanOrEqual(left);
        expect(x).toBeLessThanOrEqual(left + width);
        expect(y).toBeGreaterThanOrEqual(bottom);
        expect(y).toBeLessThanOrEqual(bottom + height);
        if (path.layerId === 'field') expect(x).toBeLessThan(bandLeft);
      }
    }
    expect(field.draw(...narrowBox)).toEqual(draw);
    expect(reportFor(result).draw(...narrowBox)).toEqual(draw);
    const atRest = reportFor({ ...result, result: { ...result.result,
      displacementMm: result.result.displacementMm.map(() => [0, 0, 0]) } });
    expect(atRest.draw(...narrowBox)).toEqual(draw);
  });

  it('returns null when the result cannot build a field mesh', () => {
    const result = outcome([{ origin: [0, 0, 0], sideMm: 1, stressMPa: 4 }]);
    expect(solidReportField({ ...result, result: { ...result.result, displacementMm: [] } })).toBeNull();
  });
});
