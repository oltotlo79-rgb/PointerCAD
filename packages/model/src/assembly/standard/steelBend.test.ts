import { stdout } from 'node:process';

import { createKernelApi } from '@pointercad/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../../../../kernel/src/occt/loadOcct.node.js';
import type { SolidEdgeInfo, Vec3Tuple } from '../../../../kernel/src/types.js';
import type { SolidBody } from '../../kernelBridge/solidContracts.js';
import { createDirectKernelBridge } from '../../kernelBridge.js';
import { recomputePart } from '../../part/recomputePart.js';
import { resolvePart } from '../../part/resolvePart.js';
import type { StandardPartSource } from '../resolveAssembly.js';
import { buildStandardPartFromSource, createStandardPartSource } from './buildStandardPart.js';
import { createSteelBend, steelBendInputState } from './steelBend.js';
import { planSteelBend, steelBendSection, type SteelBendDimensions } from './steelBendGeometry.js';
import { STEEL_PRODUCTS, steelProductOptions, type SteelProduct } from './steelCatalog.js';

const dimensions: SteelBendDimensions = { radius: 30, radiusConvention: 'inside', angleDegrees: 90,
  firstLeg: 100, secondLeg: 200, legDimension: 'tangent' };
function product(key: string): SteelProduct {
  const row = STEEL_PRODUCTS.find((candidate) => candidate.key === key);
  if (row === undefined) throw new Error('Missing sourced fixture');
  return row;
}
function source(row: SteelProduct, length: number): StandardPartSource {
  return createStandardPartSource(row.catalog, row.size, { ...steelProductOptions(row), length: String(length) });
}
const flatLength = 300 + 55 * Math.PI / 2;

describe('W05 model creation refuses invalid geometry without rewriting stock or inputs', () => {
  it.each([
    { name: 'nonfinite', change: { radius: Infinity }, reason: 'invalidRadius' },
    { name: 'Ri zero', change: { radius: 0 }, reason: 'invalidRadius' },
    { name: 'zero leg', change: { secondLeg: 0 }, reason: 'invalidLength' },
    { name: '180 degrees', change: { angleDegrees: 180 }, reason: 'invalidAngle' },
    { name: 'tight R', change: { radius: Math.hypot(50, 6) / 2 - 25 }, reason: 'radiusTooTight' },
    { name: 'no tangent leg', change: { legDimension: 'outside', firstLeg: 80 }, reason: 'insufficientLegLength' },
  ] satisfies readonly { name: string; change: Partial<SteelBendDimensions>; reason: string }[])('$name has a reason and leaves the straight stock regenerable', ({ change, reason }) => {
    const stock = source(product('SS400:flatBar:FB 50×6'), flatLength), input = { ...dimensions, ...change };
    const straight = buildStandardPartFromSource(stock), before = structuredClone({ stock, input, straight });
    expect(createSteelBend(stock, input)).toEqual({ ok: false, reason });
    expect({ stock, input, straight }).toEqual(before);
    expect(buildStandardPartFromSource(stock)).toEqual(straight);
    const recovery = createSteelBend(stock, dimensions);
    if (!recovery.ok) throw new Error(recovery.reason);
    expect(recovery.geometry.centrelineLengthMm).toBeCloseTo(300 + 55 * Math.PI / 2, 12);
    expect(steelBendInputState(recovery.document).status).toBe('original');
  });

  it.each(['unknown bend generator', 'missing catalog row', 'duplicate stable ID', 'missing recipe', 'old stock generator'] as const)('%s remains unsupported/modified/missing rather than silently rebuilding', (kind) => {
    const created = createSteelBend(source(product('SS400:flatBar:FB 50×6'), flatLength), dimensions);
    if (!created.ok) throw new Error(created.reason);
    const document = created.document, owner = document.solids[0];
    if (owner.kind !== 'sweep' || owner.steelBend === undefined) throw new Error('Missing authored sweep');
    const input = owner.steelBend;
    const replacement = kind === 'unknown bend generator' ? { ...owner, steelBend: { ...input, generatorRevision: 'steel-bend-future' } }
      : kind === 'missing catalog row' ? { ...owner, steelBend: { ...input,
        stockSource: { ...input.stockSource, options: { ...input.stockSource.options, steelProduct: 'unknown-product' } } } }
      : kind === 'old stock generator' ? { ...owner, steelBend: { ...input,
        stockSource: { ...input.stockSource, generatorRevision: '2-steel-1' } } }
      : { ...owner };
    if (kind === 'missing recipe') delete replacement.steelBend;
    const candidate = { ...document, solids: kind === 'duplicate stable ID' ? [...document.solids, { ...owner }]
      : [replacement, ...document.solids.slice(1)] };
    const before = structuredClone(candidate), result = steelBendInputState(candidate);
    expect(result.status).toBe(kind === 'missing recipe' ? 'missing' : kind === 'duplicate stable ID' ? 'modified' : 'unsupported');
    if (result.status !== 'missing') expect(result.input).toBe(replacement.steelBend);
    expect(candidate).toEqual(before);
    expect(steelBendInputState(document)).toEqual({ status: 'original', input });
    expect(created.geometry.centrelineLengthMm).toBeCloseTo(flatLength, 12);
    const path = document.sketches.find((sketch) => sketch.id === 'steel-bend-path');
    expect(path?.features).toMatchObject([{ kind: 'line', to: { z: { value: 100 } } },
      { kind: 'arc', radius: { value: 55 } }, { kind: 'line' }]);
  });
});

// Expectations use catalog dimensions and rectangle/quarter-disc moments, never the bend planner.
const roundedCornerArea = 1 - Math.PI / 4;
const oracleAngleArea = 564 + roundedCornerArea * (6.5 ** 2 - 2 * 4.5 ** 2);
const oracleAngleCentroid = (8292 + roundedCornerArea * 6.5 ** 2 * 12.5 - 6.5 ** 3 / 6
  - roundedCornerArea * 4.5 ** 2 * 47 - 4.5 ** 3 / 3) / oracleAngleArea;
const oracleSections = [
  { key: 'SS400:flatBar:FB 50×6', area: 300, insideRadius: 30,
    directions: [0, 90], centroid: [25, 3], pipe: false },
  { key: 'SS400:equalAngle:L 50×50×6', area: oracleAngleArea, insideRadius: 100,
    directions: [0, 180], centroid: [oracleAngleCentroid, oracleAngleCentroid], pipe: false },
  { key: 'SGP:steelPipe:15A', area: Math.PI * (10.85 ** 2 - 8.05 ** 2), insideRadius: 30,
    directions: [45, 90], centroid: [0, 0], pipe: true },
];
const oracleCases = oracleSections.flatMap((section) => [60, 120].flatMap((angle, index) =>
  (['inside', 'outside'] as const).map((radiusConvention) => {
    const direction = section.directions[index];
    const dx = direction === 0 ? 1 : direction === 180 ? -1 : direction === 90 ? 0 : Math.SQRT1_2;
    const dy = direction === 90 ? 1 : direction === 45 ? Math.SQRT1_2 : 0;
    const width = section.pipe ? 21.7 : direction === 90 ? 6 : 50;
    const insideOffset = section.pipe ? 10.85 : direction === 180 ? section.centroid[0]
      : direction === 90 ? 3 : 50 - section.centroid[0];
    const centreRadius = section.insideRadius + insideOffset;
    const outsideRadius = section.insideRadius + width;
    // Both radius conventions describe the same shape. Exercise tangent/inside/outside leg inputs too.
    const legDimension = radiusConvention === 'inside' ? 'tangent' : angle === 60 ? 'inside' : 'outside';
    const setback = legDimension === 'tangent' ? 0
      : (legDimension === 'inside' ? section.insideRadius : outsideRadius)
        * (angle === 60 ? 1 / Math.sqrt(3) : Math.sqrt(3));
    return { ...section, angle, direction, dx, dy, width, centreRadius, outsideRadius,
      length: 300 + centreRadius * angle * Math.PI / 180,
      input: { directionDegrees: direction, radiusConvention, angleDegrees: angle, legDimension,
        radius: radiusConvention === 'inside' ? section.insideRadius : outsideRadius,
        firstLeg: 100 + setback, secondLeg: 200 + setback } satisfies SteelBendDimensions };
  })));
type OracleCase = typeof oracleCases[number];

describe('W05 accepted sides also produce one native solid with independent area times length', () => {
  const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
  beforeAll(async () => { await loadOcctForNode(); }, 180_000);
  afterAll(() => { bridge.dispose(); });
  it.each([
    { name: 'finite after nonfinite', key: 'SS400:flatBar:FB 50×6', input: dimensions, offset: 25, width: 50, area: 300 },
    { name: 'positive inside radius', key: 'SGP:steelPipe:15A', input: { ...dimensions, radius: 1 }, offset: 10.85, width: 21.7,
      area: Math.PI * (10.85 ** 2 - 8.05 ** 2) },
    { name: 'positive tangent leg', key: 'SS400:flatBar:FB 50×6', input: { ...dimensions, firstLeg: 1 }, offset: 25, width: 50, area: 300 },
    { name: '179.999 degrees', key: 'SS400:flatBar:FB 50×6', input: { ...dimensions, angleDegrees: 179.999 }, offset: 25, width: 50, area: 300 },
    { name: 'immediately above conservative radius', key: 'SS400:flatBar:FB 50×6',
      input: { ...dimensions, radius: Math.hypot(50, 6) / 2 - 25 + 1e-8 }, offset: 25, width: 50, area: 300 },
  ])('$name has native radius bounds, positive signed volume and no input mutation', async (test) => {
    const rc = test.input.radius + test.offset;
    const length = test.input.firstLeg + test.input.secondLeg + rc * test.input.angleDegrees * Math.PI / 180;
    const stock = source(product(test.key), length), before = structuredClone({ stock, input: test.input });
    const accepted = createSteelBend(stock, test.input);
    if (!accepted.ok) throw new Error(accepted.reason);
    try {
      const result = await recomputePart(accepted.document, bridge, { partId: accepted.document.id });
      expect(result.errors).toEqual([]);
      expect(result.bodies).toHaveLength(1);
      const body = result.bodies[0], expectedVolume = test.area * length;
      expect(body.isValid).toBe(true);
      expect(body.bodyKind).toBe('solid');
      expect(body.volume).toBeGreaterThan(0);
      expect(Math.abs(body.volume - expectedVolume) / expectedVolume).toBeLessThanOrEqual(1e-9);
      if (test.key === 'SGP:steelPipe:15A') {
        const tori = body.faces.flatMap((face) => face.analyticSurface?.kind === 'torus' ? [face.analyticSurface] : []);
        expect(tori.length).toBeGreaterThanOrEqual(2);
        expect(tori.every((torus) => Math.abs(torus.majorRadius - rc) <= 1e-6)).toBe(true);
        expect(tori.some((torus) => Math.abs(torus.minorRadius - 10.85) <= 1e-6)).toBe(true);
        expect(tori.some((torus) => Math.abs(torus.minorRadius - 8.05) <= 1e-6)).toBe(true);
      } else {
        const radii = body.faces.flatMap((face) => face.surfaceKind === 'cylinder' && face.radius !== null ? [face.radius] : []);
        expect(radii.some((radius) => Math.abs(radius - test.input.radius) <= 1e-6)).toBe(true);
        expect(radii.some((radius) => Math.abs(radius - test.input.radius - test.width) <= 1e-6)).toBe(true);
      }
      expect({ stock, input: test.input }).toEqual(before);
    } finally { await bridge.releasePart(accepted.document.id); }
  });
});
function difference(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function offset(a: Vec3Tuple, b: Vec3Tuple, scale: number): Vec3Tuple {
  return [a[0] + scale * b[0], a[1] + scale * b[1], a[2] + scale * b[2]];
}
function dot(a: Vec3Tuple, b: Vec3Tuple): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function unit(a: Vec3Tuple): Vec3Tuple { return offset([0, 0, 0], a, 1 / Math.hypot(...a)); }
function distance(a: Vec3Tuple, b: Vec3Tuple): number { return Math.hypot(...difference(a, b)); }
function angleBetween(a: Vec3Tuple, b: Vec3Tuple): number {
  return Math.atan2(Math.hypot(...cross(a, b)), dot(a, b));
}
function forward(axis: Vec3Tuple, direction: Vec3Tuple): Vec3Tuple {
  return dot(axis, direction) < 0 ? offset([0, 0, 0], axis, -1) : axis;
}
function nearestEdge(edges: readonly SolidEdgeInfo[], score: (edge: SolidEdgeInfo) => number): SolidEdgeInfo {
  const sorted = [...edges].sort((a, b) => score(a) - score(b));
  if (sorted[0] === undefined) throw new Error('No native edge for independent bend measurement');
  return sorted[0];
}
function oracleFrame(test: OracleCase) {
  const direction: Vec3Tuple = [test.dx, test.dy, 0];
  const normal: Vec3Tuple = [test.dy, -test.dx, 0];
  const cosine = test.angle === 60 ? 0.5 : -0.5;
  const sine = Math.sqrt(3) / 2;
  const centre: Vec3Tuple = [test.centreRadius * test.dx, test.centreRadius * test.dy, 100];
  const endTangent: Vec3Tuple = [test.dx * sine, test.dy * sine, cosine];
  const joins: readonly Vec3Tuple[] = [[0, 0, 100],
    [test.centreRadius * test.dx * (1 - cosine), test.centreRadius * test.dy * (1 - cosine),
      100 + test.centreRadius * sine]];
  return { direction, normal, cosine, sine, centre, endTangent, joins };
}
interface OracleMeasurements {
  readonly inside: number;
  readonly outside: number;
  readonly points: readonly number[];
  readonly tangents: readonly number[];
  readonly angles: readonly number[];
}
function measurePolygonBend(body: SolidBody, test: OracleCase): OracleMeasurements {
  const frame = oracleFrame(test);
  const cylinders = body.faces.filter((face) => face.surfaceKind === 'cylinder' && face.axis !== null
    && Math.abs(dot(face.axis, frame.normal)) > 0.99);
  const radii = cylinders.map((face) => {
    if (face.radius === null || face.axisOrigin == null) throw new Error('Missing analytic cylinder');
    // The centre of each cylindrical patch can slide along its axis, but not off the bend axis.
    expect(Math.hypot(...cross(difference(face.axisOrigin, frame.centre), frame.normal))).toBeLessThanOrEqual(1e-6);
    return face.radius;
  });
  expect(radii.length).toBeGreaterThanOrEqual(2);
  const inside = Math.min(...radii);
  const outside = Math.max(...radii);
  const points: number[] = [];
  const tangents: number[] = [];
  const angles: number[] = [];
  const cx = test.centroid[0];
  const cy = test.centroid[1];
  const firstCorners: readonly Vec3Tuple[] = test.direction === 90 ? [[-cx, 3, 100], [-cx, -3, 100]]
    : test.direction === 180 ? [[-cx, -cy, 100], [50 - cx, -cy, 100]]
      : [[50 - cx, -cy, 100], [-cx, -cy, 100]];
  for (const [side, first] of firstCorners.entries()) {
    const expectedRadius = side === 0 ? test.insideRadius : test.outsideRadius;
    const radialOffset = dot(first, frame.direction);
    const transverse = difference([first[0], first[1], 0], offset([0, 0, 0], frame.direction, radialOffset));
    const centre = offset(frame.centre, transverse, 1);
    const second = offset(offset(centre, frame.direction, -expectedRadius * frame.cosine), [0, 0, 1], expectedRadius * frame.sine);
    const arc = nearestEdge(body.edges.filter((edge) => edge.curveKind === 'circle' && edge.axis !== null
      && Math.abs(dot(edge.axis, frame.normal)) > 0.99),
    (edge) => Math.min(distance(edge.start, first), distance(edge.end, first)));
    if (arc.axisOrigin == null || arc.radius === null || arc.axis === null) throw new Error('Missing analytic bend arc');
    expect(Math.abs(arc.radius - (side === 0 ? inside : outside))).toBeLessThanOrEqual(1e-9);
    points.push(distance(arc.axisOrigin, centre));
    const ends = distance(arc.start, first) < distance(arc.end, first) ? [arc.start, arc.end] : [arc.end, arc.start];
    angles.push(Math.abs(arc.length / arc.radius - test.angle * Math.PI / 180));
    for (const [index, expected] of [first, second].entries()) {
      const point = ends[index];
      const expectedTangent: Vec3Tuple = index === 0 ? [0, 0, 1] : frame.endTangent;
      const line = nearestEdge(body.edges.filter((edge) => edge.curveKind === 'line'
        && edge.axis !== null && Math.abs(dot(edge.axis, expectedTangent)) > 0.99),
      (edge) => Math.min(distance(edge.start, point), distance(edge.end, point)));
      const incoming = index === 0;
      const lineJoin = distance(line.start, point) < distance(line.end, point) ? line.start : line.end;
      const farEnd = lineJoin === line.start ? line.end : line.start;
      const lineTangent = unit(incoming ? difference(lineJoin, farEnd) : difference(farEnd, lineJoin));
      const arcTangent = forward(unit(cross(arc.axis, difference(point, arc.axisOrigin))), expectedTangent);
      points.push(distance(point, expected), distance(lineJoin, point),
        distance(farEnd, offset(expected, expectedTangent, incoming ? -100 : 200)));
      tangents.push(angleBetween(lineTangent, expectedTangent), angleBetween(arcTangent, expectedTangent),
        angleBetween(lineTangent, arcTangent));
    }
  }
  return { inside, outside, points, tangents, angles };
}

function measurePipeBend(body: SolidBody, test: OracleCase): OracleMeasurements {
  const frame = oracleFrame(test);
  // A pipe bend is toroidal, not cylindrical. Read the exact native torus instead of fitting a mesh.
  const toroidalFaces = body.faces.filter((face) => face.analyticSurface?.kind === 'torus');
  expect(toroidalFaces).toHaveLength(2);
  const outer = toroidalFaces.find((face) => face.analyticSurface?.kind === 'torus'
    && Math.abs(face.analyticSurface.minorRadius - 10.85) <= 1e-6);
  const torus = outer?.analyticSurface;
  if (torus?.kind !== 'torus' || outer === undefined) throw new Error('Missing outer native torus');
  const inner = toroidalFaces.find((face) => face !== outer)?.analyticSurface;
  if (inner?.kind !== 'torus') throw new Error('Missing bore native torus');
  expect(Math.abs(inner.minorRadius - 8.05)).toBeLessThanOrEqual(1e-6);
  expect(Math.abs(inner.majorRadius - torus.majorRadius)).toBeLessThanOrEqual(1e-9);
  const points = [distance(torus.origin, frame.centre), distance(inner.origin, frame.centre)];
  const tangents: number[] = [];
  const measuredDirections: Vec3Tuple[] = [];
  const measuredRadials: Vec3Tuple[] = [];
  for (const [index, expected] of frame.joins.entries()) {
    const circle = nearestEdge(body.edges.filter((edge) => edge.curveKind === 'circle' && edge.axisOrigin != null
      && edge.radius !== null && Math.abs(edge.radius - 10.85) <= 1e-6),
    (edge) => edge.axisOrigin == null ? Infinity : distance(edge.axisOrigin, expected));
    if (circle.axisOrigin == null || circle.radius === null || circle.axis === null) throw new Error('Missing native join circle');
    const circleCentre = circle.axisOrigin;
    const circleRadius = circle.radius;
    expect(Math.abs(circle.length - 2 * Math.PI * circle.radius)).toBeLessThanOrEqual(1e-6);
    const radial = unit(difference(circle.axisOrigin, torus.origin));
    const expectedTangent: Vec3Tuple = index === 0 ? [0, 0, 1] : frame.endTangent;
    const tangent = forward(circle.axis, expectedTangent);
    const torusTangent = forward(unit(cross(torus.axis, radial)), expectedTangent);
    measuredDirections.push(tangent);
    measuredRadials.push(radial);
    points.push(distance(circle.axisOrigin, expected));
    // Native topology must connect this torus to a straight cylindrical wall on the same axis.
    const wall = body.faces.find((face) => face.surfaceKind === 'cylinder' && face.axis !== null
      && face.axisOrigin != null && face.radius !== null && Math.abs(face.radius - circleRadius) <= 1e-6
      && Math.abs(dot(face.axis, tangent)) > 0.99 && outer.adjacentFaces?.includes(face.index));
    if (wall?.axis == null || wall.axisOrigin == null || wall.cylinderSpan == null) throw new Error('Missing adjacent straight pipe wall');
    const wallCentre = wall.axisOrigin;
    const wallAxis = wall.axis;
    points.push(Math.hypot(...cross(difference(circle.axisOrigin, wall.axisOrigin), wall.axis)),
      Math.min(...wall.cylinderSpan.map((extent) => distance(offset(wallCentre, wallAxis, extent), circleCentre))));
    for (const side of [-1, 1]) {
      const actual = offset(circle.axisOrigin, radial, side * circle.radius);
      const expectedRadial: Vec3Tuple = index === 0 ? [-test.dx, -test.dy, 0]
        : [-test.dx * frame.cosine, -test.dy * frame.cosine, frame.sine];
      points.push(distance(actual, offset(expected, expectedRadial, side * 10.85)));
    }
    tangents.push(angleBetween(tangent, expectedTangent), angleBetween(torusTangent, tangent),
      angleBetween(forward(wall.axis, expectedTangent), torusTangent));
  }
  return { inside: torus.majorRadius - torus.minorRadius, outside: torus.majorRadius + torus.minorRadius,
    points, tangents, angles: [Math.abs(angleBetween(measuredDirections[0], measuredDirections[1]) - test.angle * Math.PI / 180),
      Math.abs(angleBetween(measuredRadials[0], measuredRadials[1]) - test.angle * Math.PI / 180)] };
}

describe('steel bend independent native radius, joins, tangency and signed volume oracle', () => {
  const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
  beforeAll(async () => { await loadOcctForNode(); }, 180_000);
  afterAll(() => { bridge.dispose(); });
  it.each(oracleCases)('$key / $input.radiusConvention R / $angle degrees / direction $direction', async (test) => {
    const inputSource = source(product(test.key), test.length);
    const before = JSON.stringify({ input: test.input, source: inputSource });
    const result = createSteelBend(inputSource, test.input);
    if (!result.ok) throw new Error(result.reason);
    try {
      const computed = await recomputePart(result.document, bridge);
      expect(computed.errors).toEqual([]);
      expect(computed.bodies).toHaveLength(1);
      const body = computed.bodies[0];
      expect(body.isValid).toBe(true);
      expect(body.bodyKind).toBe('solid');
      const measured = test.pipe ? measurePipeBend(body, test) : measurePolygonBend(body, test);
      const expectedVolume = test.area * test.length;
      const metrics = { key: test.key, basis: test.input.radiusConvention, angle: test.angle, direction: test.direction,
        inside: measured.inside, outside: measured.outside,
        radiusError: Math.max(Math.abs(measured.inside - test.insideRadius), Math.abs(measured.outside - test.outsideRadius)),
        widthError: Math.abs(measured.outside - measured.inside - test.width),
        joinError: Math.max(...measured.points), tangentError: Math.max(...measured.tangents),
        angleError: Math.max(...measured.angles), expectedVolume, volume: body.volume,
        relativeVolumeError: Math.abs(body.volume - expectedVolume) / expectedVolume };
      stdout.write(`steel-bend-oracle ${JSON.stringify(metrics)}${String.fromCharCode(10)}`);
      expect(metrics.radiusError).toBeLessThanOrEqual(1e-6);
      expect(metrics.widthError).toBeLessThanOrEqual(1e-9);
      expect(metrics.joinError).toBeLessThanOrEqual(1e-6);
      expect(metrics.tangentError).toBeLessThanOrEqual(1e-6);
      expect(metrics.angleError).toBeLessThanOrEqual(1e-6);
      expect(expectedVolume).toBeGreaterThan(0);
      expect(body.volume).toBeGreaterThan(0);
      expect(metrics.relativeVolumeError).toBeLessThanOrEqual(1e-9);
      expect(JSON.stringify({ input: test.input, source: inputSource })).toBe(before);
    } finally { await bridge.releasePart(result.document.id); }
  });
});

describe('steel bend real editable PartDocument operation', () => {
  it.each([90, 180, 270, 45])('saves the %s degree bend plane without rotating or replacing the section', (directionDegrees) => {
    const row = product('SS400:flatBar:FB 50×6');
    const width = directionDegrees === 90 || directionDegrees === 270 ? 6
      : directionDegrees === 45 ? 56 / Math.sqrt(2) : 50;
    const expectedLength = 300 + (30 + width / 2) * Math.PI / 2;
    const result = createSteelBend(source(row, expectedLength), { ...dimensions, directionDegrees });
    const original = createSteelBend(source(row, flatLength), dimensions);
    if (!result.ok || !original.ok) throw new Error('Fixture construction failed');
    expect(result.document.sketches[0].features).toEqual(original.document.sketches[0].features);
    expect(result.document.references).toHaveLength(1);
    const reference = result.document.references[0];
    if (reference?.kind !== 'referencePlane' || reference.plane.kind !== 'tilted') {
      throw new Error('Missing saved tilted reference plane');
    }
    const { angle, ...plane } = reference.plane;
    expect([{ ...reference, plane }]).toEqual([{ id: 'steel-bend-plane', name: 'Steel bend direction',
      kind: 'referencePlane', visible: false, plane: { kind: 'tilted', base: 'xz',
        axis: { kind: 'world', axis: 'z' } } }]);
    expect(angle.value).toBe(directionDegrees);
    const path = result.document.sketches.find((sketch) => sketch.id === 'steel-bend-path');
    expect(path?.features.map((feature) => feature.planeId))
      .toEqual(['steel-bend-plane', 'steel-bend-plane', 'steel-bend-plane']);
    const arc = path?.features.find((feature) => feature.kind === 'arc');
    if (arc?.kind !== 'arc') throw new Error('Missing saved arc');
    expect(result.geometry.centrelineRadiusMm).toBeCloseTo(30 + width / 2, 11);
    // Editable numeric expressions persist 12 significant digits, independently of the analytic plan.
    const savedRadius = directionDegrees === 45
      ? { source: '49.7989898732', value: 49.7989898732, display: '49.7989898732' }
      : directionDegrees === 180
        ? { source: '55', value: 55, display: '55' }
        : { source: '33', value: 33, display: '33' };
    expect(arc.radius).toEqual(savedRadius);
    expect(arc).toMatchObject({ startAngle: { value: 180 }, endAngle: { value: 90 } });
    expect(resolvePart(result.document).errors).toEqual([]);
    expect(Number(result.document.steelStockSource?.options.length)).toBeCloseTo(expectedLength, 11);
    expect(createSteelBend(source(row, 1000), { ...dimensions, directionDegrees }))
      .toEqual({ ok: false, reason: 'stockLengthMismatch' });
  });

  it('creates the line/arc/line sweep, resolves it and retains source exactly without mutating the straight document', () => {
    const input = source(product('SS400:flatBar:FB 50×6'), flatLength);
    const previousSource = { ...input, options: { ...input.options } };
    const straight = buildStandardPartFromSource(input);
    const result = createSteelBend(input, dimensions);
    if (!result.ok) throw new Error(result.reason);
    expect(result.document.steelStockSource).toEqual(previousSource);
    expect(result.document.steelStockSource).not.toBe(input);
    expect(input).toEqual(previousSource);
    expect(buildStandardPartFromSource(input)).toEqual(straight);
    expect(straight?.solids[0].kind).toBe('extrude');
    expect(result.document.solids).toHaveLength(1);
    expect(result.document.solids[0]).toMatchObject({ kind: 'sweep', frenet: true,
      path: { sketchId: 'steel-bend-path', curveIds: ['first-leg', 'bend-arc', 'second-leg'] } });
    const path = result.document.sketches.find((sketch) => sketch.id === 'steel-bend-path');
    expect(path?.features.map((feature) => feature.kind)).toEqual(['line', 'arc', 'line']);
    const arc = path?.features.find((feature) => feature.kind === 'arc');
    expect(arc).toMatchObject({ planeId: 'xz', radius: { value: 55 },
      startAngle: { value: 180 }, endAngle: { value: 90 } });
    expect(resolvePart(result.document).errors).toEqual([]);
  });

  it.each(STEEL_PRODUCTS)('$key keeps its sourced section, grade and provenance in an ordinary resolvable part', (row) => {
    const section = steelBendSection(row);
    if (section === null) throw new Error('Missing sourced section');
    const input = { ...dimensions, radius: 1000 };
    const plan = planSteelBend(section, input);
    if (!plan.ok) throw new Error(plan.reason);
    const original = source(row, plan.geometry.centrelineLengthMm);
    const result = createSteelBend(original, input);
    if (!result.ok) throw new Error(result.reason);
    expect(result.document.steelStockSource).toEqual(original);
    expect(resolvePart(result.document).errors).toEqual([]);
    expect(result.document.solids.filter((feature) => feature.kind === 'sweep'))
      .toHaveLength(row.catalog === 'steelPipe' ? 2 : 1);
    if (row.catalog === 'steelPipe') {
      expect(result.document.solids[2]).toMatchObject({ kind: 'boolean', operation: 'subtract',
        targetFeatureId: 'steel-bend-sweep-0', toolFeatureId: 'steel-bend-sweep-1' });
    }
  });

  it('retains each source-backed L root/tip arc rather than substituting the simplified polygon', () => {
    const row = product('SS400:equalAngle:L 50×50×6');
    const section = steelBendSection(row);
    if (section === null) throw new Error('Missing L section');
    const input = { ...dimensions, radius: 100 };
    const plan = planSteelBend(section, input);
    if (!plan.ok) throw new Error(plan.reason);
    const result = createSteelBend(source(row, plan.geometry.centrelineLengthMm), input);
    if (!result.ok) throw new Error(result.reason);
    const arcs = result.document.sketches[0].features.filter((feature) => feature.kind === 'arc');
    expect(arcs.map((arc) => arc.radius.value)).toEqual([4.5, 6.5, 4.5]);
    expect(arcs.some((arc) => arc.endAngle.value < arc.startAngle.value)).toBe(true);
  });

  it('refuses forged, unknown and older bend sources without changing their existing straight regeneration', () => {
    const current = source(product('SS400:flatBar:FB 50×6'), flatLength);
    expect(createSteelBend({ ...current, options: { ...current.options, materialGrade: 'S45C' } }, dimensions))
      .toEqual({ ok: false, reason: 'unsupportedSource' });
    expect(createSteelBend({ ...current, generatorRevision: 'unknown' }, dimensions))
      .toEqual({ ok: false, reason: 'unsupportedSource' });
    const legacy = { ...current, generatorRevision: '2-steel-1' };
    expect(createSteelBend(legacy, dimensions)).toEqual({ ok: false, reason: 'unsupportedSource' });
    expect(buildStandardPartFromSource(legacy)).not.toBeNull();
    const unassigned = createStandardPartSource('equalAngle', 'L 50×50×6', { length: '100' });
    expect(createSteelBend(unassigned, dimensions)).toEqual({ ok: false, reason: 'unsupportedSource' });
    expect(buildStandardPartFromSource(unassigned)).not.toBeNull();
  });

  it('refuses inconsistent/invalid stock lengths instead of silently changing the purchased source', () => {
    const row = product('SS400:flatBar:FB 50×6');
    expect(createSteelBend(source(row, 1000), dimensions)).toEqual({ ok: false, reason: 'stockLengthMismatch' });
    for (const length of ['0', '12001', '1/', '1e999']) {
      const invalid = { ...source(row, flatLength), options: { ...steelProductOptions(row), length } };
      expect(createSteelBend(invalid, dimensions)).toEqual({ ok: false, reason: 'invalidStockLength' });
    }
    const valid = source(row, flatLength);
    expect(createSteelBend(valid, { ...dimensions, firstLeg: 0 })).toEqual({ ok: false, reason: 'invalidLength' });
  });
});

describe('steel bend through the existing native sweep and boolean path', () => {
  const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
  beforeAll(async () => { await loadOcctForNode(); }, 180_000);
  afterAll(() => { bridge.dispose(); });
  // Independent rectangle and square-minus-quarter-disc decomposition for the rounded L.
  const k = 1 - Math.PI / 4;
  const angleArea = 564 + k * (6.5 ** 2 - 2 * 4.5 ** 2);
  const angleCentroid = (8292 + k * 6.5 ** 2 * 12.5 - 6.5 ** 3 / 6
    - k * 4.5 ** 2 * 47 - 4.5 ** 3 / 3) / angleArea;
  const cases = [
    { key: 'SS400:flatBar:FB 50×6', centreRadius: 55, area: 300, radius: 30, angle: 90 },
    { key: 'SS400:flatBar:FB 50×6', centreRadius: 55, area: 300, radius: 30, angle: 60 },
    { key: 'SGP:steelPipe:15A', centreRadius: 40.85, area: Math.PI * (10.85 ** 2 - 8.05 ** 2), radius: 30, angle: 90 },
    { key: 'SS400:equalAngle:L 50×50×6', centreRadius: 150 - angleCentroid, area: angleArea, radius: 100, angle: 90 },
  ];
  const directedCases = [
    { key: 'SS400:flatBar:FB 50×6', direction: 90, centreRadius: 33, area: 300, radius: 30 },
    { key: 'SS400:flatBar:FB 50×6', direction: 45, centreRadius: 30 + 28 / Math.sqrt(2), area: 300, radius: 30 },
    { key: 'SS400:equalAngle:L 50×50×6', direction: 180, centreRadius: 100 + angleCentroid, area: angleArea, radius: 100 },
    { key: 'SGP:steelPipe:15A', direction: 270, centreRadius: 40.85,
      area: Math.PI * (10.85 ** 2 - 8.05 ** 2), radius: 30 },
  ];
  for (const input of directedCases) it(`${input.key} towards ${input.direction} degrees keeps the independent full swept volume`, async () => {
    const length = 300 + input.centreRadius * Math.PI / 2;
    const result = createSteelBend(source(product(input.key), length),
      { ...dimensions, radius: input.radius, directionDegrees: input.direction });
    if (!result.ok) throw new Error(result.reason);
    try {
      const computed = await recomputePart(result.document, bridge);
      expect(computed.errors).toEqual([]);
      expect(computed.bodies).toHaveLength(1);
      expect(computed.bodies[0].isValid).toBe(true);
      expect(computed.bodies[0].mesh.triangleCount).toBeGreaterThan(0);
      const expected = input.area * length;
      expect(Math.abs(computed.bodies[0].volume - expected) / expected).toBeLessThan(1e-8);
      if (input.key === 'SS400:flatBar:FB 50×6') {
        const body = computed.bodies[0];
        const frame = body.coordinateFrame?.origin ?? [0, 0, 0];
        // Actual starting cap remains the same XY rectangle, not a rotated profile.
        // Float32 display coordinates are only used to identify its four exact CAD corners.
        for (const [x, y] of [[-25, -3], [25, -3], [25, 3], [-25, 3]]) {
          let closest = Infinity;
          for (let i = 0; i < body.mesh.positions.length; i += 3) {
            closest = Math.min(closest, Math.hypot(body.mesh.positions[i] + frame[0] - x,
              body.mesh.positions[i + 1] + frame[1] - y, body.mesh.positions[i + 2] + frame[2]));
          }
          expect(closest).toBeLessThan(1e-4);
        }
      }
    } finally { await bridge.releasePart(result.document.id); }
  });
  it.each(cases)('$key at $angle degrees has one valid bent solid and the independent full swept volume', async (input) => {
    const length = 300 + input.centreRadius * Math.PI * input.angle / 180;
    const result = createSteelBend(source(product(input.key), length),
      { ...dimensions, radius: input.radius, angleDegrees: input.angle });
    if (!result.ok) throw new Error(result.reason);
    try {
      const computed = await recomputePart(result.document, bridge);
      expect(computed.errors).toEqual([]);
      expect(computed.bodies).toHaveLength(1);
      expect(computed.bodies[0].isValid).toBe(true);
      expect(computed.bodies[0].mesh.triangleCount).toBeGreaterThan(0);
      const expected = input.area * length;
      expect(Math.abs(computed.bodies[0].volume - expected) / expected).toBeLessThan(1e-8);
    } finally { await bridge.releasePart(result.document.id); }
  });
});
