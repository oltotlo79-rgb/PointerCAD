import { exactExpressionValueFromNumber as num } from '@pointercad/expression';

import { absoluteCoordinate } from '../createSketchDocument.js';
import type { SketchDocument, SketchFeature } from '../types.js';
import type { Vec3 } from '../vec3.js';
import type { ConstraintTarget, SketchConstraint } from './types.js';

/** Analytic fixtures only: no residual, Jacobian, rank or solver imports.
 * The separate Decimal calculation is retained with the W03 work report.
 */
export interface GeometryOracle {
  readonly name: string;
  readonly document: SketchDocument;
  readonly expected: ReadonlyMap<string, Vec3>;
  readonly radii: ReadonlyMap<string, number>;
  readonly variables: number;
  readonly rank: number;
  readonly equations: number;
  readonly anchor: string;
  readonly duplicateOf: string;
}

const point = (pointId: string): ConstraintTarget => ({ kind: 'point', pointId });
const vertex = (featureId: string, at: 'start' | 'end' | 'center'): ConstraintTarget =>
  ({ kind: 'vertex', featureId, vertex: at });
const curve = (featureId: string): ConstraintTarget => ({ kind: 'curve', element: { featureId } });
const base = (id: string) => ({ id, name: id });

function dimension(
  id: string, a: ConstraintTarget, b: ConstraintTarget, value: number,
  kind: 'distance' | 'horizontalDistance' | 'verticalDistance' = 'distance',
): SketchConstraint {
  return { ...base(id), kind, a, b, length: num(value) };
}

function documentOf(name: string, features: SketchFeature[], constraints: SketchConstraint[]): SketchDocument {
  return { id: name, name, features, constraints };
}

/** The spokes and consecutive rim edges form nondegenerate triangles.
 * 1997 lengths remove all shape changes except three planar rigid motions;
 * one vertical component removes rotation, leaving exactly two translations.
 */
export function triangleFanOracle(perturbed = true, oriented = true): GeometryOracle {
  const expected = new Map<string, Vec3>();
  expected.set('fan-0', [0, 0, 0]);
  for (let i = 1; i < 1000; i += 1) {
    expected.set(`fan-${i}`, i % 2 === 1 ? [6 + i / 512, 0, 0] : [0, 8 + i / 512, 0]);
  }
  const features: SketchFeature[] = [...expected].map(([id, xyz], i) => ({
    ...base(id), kind: 'point', planeId: 'xy',
    at: absoluteCoordinate(xyz[0] + (perturbed && i === 1 ? 0.125 : 0), xyz[1], 0),
  }));
  const constraints: SketchConstraint[] = [];
  const length = (a: number, b: number): void => {
    const p = requiredPoint(expected, `fan-${a}`), q = requiredPoint(expected, `fan-${b}`);
    constraints.push(dimension(`fan-length-${a}-${b}`, point(`fan-${a}`), point(`fan-${b}`),
      Math.hypot(p[0] - q[0], p[1] - q[1])));
  };
  for (let i = 1; i < 1000; i += 1) {
    length(0, i);
    if (i > 1) length(i - 1, i);
  }
  if (oriented) constraints.push(dimension('fan-orientation', point('fan-0'), point('fan-1'), 0, 'verticalDistance'));
  return {
    name: 'triangle fan', document: documentOf('fan-oracle', features, constraints), expected,
    radii: new Map(), variables: 2000, rank: oriented ? 1998 : 1997,
    equations: oriented ? 1998 : 1997, anchor: 'fan-0', duplicateOf: 'fan-length-0-1',
  };
}

/** 500 separate segments have 1000 free endpoints. Joining neighbours removes
 * 998 scalar freedoms. Each nonzero segment has one independent length and
 * one independent direction: 2000 - 998 - 500 - 500 = 2.
 */
export function coincidenceChainOracle(perturbed = true): GeometryOracle {
  const expected = new Map<string, Vec3>();
  const features: SketchFeature[] = [], constraints: SketchConstraint[] = [];
  for (let i = 0; i < 500; i += 1) {
    const id = `chain-${i}`, x = 2 * Math.ceil(i / 2), y = 2 * Math.floor(i / 2);
    const start: Vec3 = [x, y, 0], end: Vec3 = [x + (i % 2 === 0 ? 2 : 0), y + (i % 2 === 1 ? 2 : 0), 0];
    expected.set(`${id}:start`, start); expected.set(`${id}:end`, end);
    features.push({ ...base(id), kind: 'line', planeId: 'xy', construction: false,
      from: absoluteCoordinate(...start),
      to: absoluteCoordinate(end[0] + (perturbed && i === 0 ? 0.125 : 0), end[1], 0) });
    if (i > 0) constraints.push({ ...base(`chain-join-${i}`), kind: 'coincident',
      a: vertex(`chain-${i - 1}`, 'end'), b: vertex(id, 'start') });
    constraints.push(dimension(`chain-length-${i}`, vertex(id, 'start'), vertex(id, 'end'), 2));
    const orientation = base(`chain-direction-${i}`);
    switch (i % 4) {
      case 0: constraints.push({ ...orientation, kind: 'horizontal', target: curve(id) }); break;
      case 1: constraints.push({ ...orientation, kind: 'vertical', target: curve(id) }); break;
      case 2: constraints.push({ ...orientation, kind: 'parallel', a: curve(id), b: curve(`chain-${i - 2}`) }); break;
      case 3: constraints.push({ ...orientation, kind: 'perpendicular', a: curve(id), b: curve(`chain-${i - 1}`) }); break;
    }
  }
  return { name: 'coincidence chain', document: documentOf('chain-oracle', features, constraints),
    expected, radii: new Map(), variables: 2000, rank: 1998, equations: 1998,
    anchor: 'chain-0:start', duplicateOf: 'chain-length-0' };
}

/** Each cell has eight genuinely movable points, three movable radii and one
 * expression-valued minor radius: 19 variables. Seventeen independent scalar
 * equations leave just its two translations. The two additional tangencies
 * are redundant, since all centres and major radii already agree. Connecting
 * 25 centres removes 48 freedoms: 475 - (25*17+48) = 2.
 * The ellipse is tangent at its major-axis extremum; its minor radius is 3,
 * so this is an actual ellipse, not a circle standing in for one.
 */
export function mixedCurvesOracle(perturbed = true): GeometryOracle {
  const expected = new Map<string, Vec3>(), radii = new Map<string, number>();
  const features: SketchFeature[] = [], constraints: SketchConstraint[] = [];
  for (let i = 0; i < 25; i += 1) {
    const prefix = `mixed-${i}`, x = i * 20;
    const circleId = `${prefix}-circle`, arcId = `${prefix}-arc`, ellipseId = `${prefix}-ellipse`;
    const lineId = `${prefix}-line`, pointId = `${prefix}-point`;
    for (const id of [circleId, arcId, ellipseId]) {
      expected.set(`${id}:center`, [x, 0, 0]);
      constraints.push({ ...base(`${id}-radius`), kind: 'radius', target: curve(id), size: num(5) });
      if (id !== circleId) constraints.push({ ...base(`${id}-concentric`), kind: 'concentric', a: curve(circleId), b: curve(id) });
      constraints.push({ ...base(`${id}-tangent`), kind: 'tangent', line: curve(lineId), circle: curve(id) });
    }
    radii.set(`${circleId}.r`, 5); radii.set(`${arcId}.r`, 5);
    radii.set(`${ellipseId}.rmajor`, 5); radii.set(`${ellipseId}.rminor`, 3);
    const seedRadius = perturbed && i === 0 ? 5.125 : 5;
    features.push({ ...base(circleId), kind: 'arc', planeId: 'xy', construction: false,
      center: absoluteCoordinate(x, 0, 0), radius: num(seedRadius), startAngle: num(0), endAngle: num(360) });
    features.push({ ...base(arcId), kind: 'arc', planeId: 'xy', construction: false,
      center: absoluteCoordinate(x, 0, 0), radius: num(5), startAngle: num(0), endAngle: num(90) });
    features.push({ ...base(ellipseId), kind: 'ellipse', planeId: 'xy', construction: false,
      center: absoluteCoordinate(x, 0, 0), majorRadius: num(5),
      minorRadius: { source: '6 / 2', value: 3, display: '3' },
      rotation: num(0), startAngle: num(0), endAngle: num(360) });
    expected.set(`${arcId}:start`, [x + 5, 0, 0]); expected.set(`${arcId}:end`, [x, 5, 0]);
    constraints.push(dimension(`${arcId}-start-y`, vertex(arcId, 'center'), vertex(arcId, 'start'), 0, 'verticalDistance'));
    constraints.push(dimension(`${arcId}-end-x`, vertex(arcId, 'center'), vertex(arcId, 'end'), 0, 'horizontalDistance'));
    expected.set(`${lineId}:start`, [x + 5, 4, 0]); expected.set(`${lineId}:end`, [x + 5, -4, 0]);
    features.push({ ...base(lineId), kind: 'line', planeId: 'xy', construction: false,
      from: absoluteCoordinate(x + 5, 4, 0), to: absoluteCoordinate(x + 5, -4, 0) });
    constraints.push({ ...base(`${lineId}-vertical`), kind: 'vertical', target: curve(lineId) });
    constraints.push(dimension(`${lineId}-length`, vertex(lineId, 'start'), vertex(lineId, 'end'), 8));
    constraints.push(dimension(`${lineId}-height`, vertex(circleId, 'center'), vertex(lineId, 'start'), 4, 'verticalDistance'));
    expected.set(pointId, [x + 3, 4, 0]);
    features.push({ ...base(pointId), kind: 'point', planeId: 'xy', at: absoluteCoordinate(x + 3, 4, 0) });
    constraints.push(dimension(`${pointId}-radial`, vertex(circleId, 'center'), point(pointId), 5));
    constraints.push(dimension(`${pointId}-offset`, vertex(lineId, 'start'), point(pointId), 2));
    if (i > 0) {
      const previous = vertex(`mixed-${i - 1}-circle`, 'center'), current = vertex(circleId, 'center');
      constraints.push(dimension(`${prefix}-spacing`, previous, current, 20, 'horizontalDistance'));
      constraints.push(dimension(`${prefix}-alignment`, previous, current, 0, 'verticalDistance'));
    }
  }
  return { name: 'mixed curves', document: documentOf('mixed-oracle', features, constraints),
    expected, radii, variables: 475, rank: 473, equations: 523,
    anchor: 'mixed-0-circle:center', duplicateOf: 'mixed-0-circle-radius' };
}

export const geometryOracleFactories = [triangleFanOracle, coincidenceChainOracle, mixedCurvesOracle] as const;

export function requiredPoint(points: ReadonlyMap<string, Vec3>, id: string): Vec3 {
  const value = points.get(id);
  if (value === undefined || !value.every(Number.isFinite)) throw new Error(`Missing or nonfinite oracle point: ${id}`);
  return value;
}

function pointKey(target: ConstraintTarget): string {
  if (target.kind === 'point') return target.pointId;
  if (target.kind === 'vertex') return `${target.featureId}:${target.vertex}`;
  throw new Error('Expected point target');
}

function curveId(target: ConstraintTarget): string {
  if (target.kind !== 'curve') throw new Error('Expected curve target');
  return target.element.featureId;
}

/** Euclidean checks against analytic coordinates and lengths. Ellipse support
 * uses sqrt((a*nx)^2+(b*ny)^2), independently of the production circle formula.
 * Direction errors are dimensionless and reported separately from millimetres.
 */
export function geometryErrors(
  fixture: GeometryOracle, actual: ReadonlyMap<string, Vec3>, actualRadii: ReadonlyMap<string, number>,
): { coordinate: number; length: number; direction: number } {
  let coordinate = 0, length = 0, direction = 0;
  for (const [id, expected] of fixture.expected) {
    const value = requiredPoint(actual, id);
    coordinate = Math.max(coordinate, Math.hypot(...value.map((component, axis) => component - expected[axis])));
  }
  const radius = (id: string, suffix: string): number => {
    const value = actualRadii.get(id + suffix);
    if (value === undefined || !Number.isFinite(value)) throw new Error(`Missing oracle radius: ${id}${suffix}`);
    return value;
  };
  for (const [id, expected] of fixture.radii) {
    const value = actualRadii.get(id);
    if (value === undefined || !Number.isFinite(value)) throw new Error(`Missing oracle radius: ${id}`);
    length = Math.max(length, Math.abs(value - expected));
  }
  const at = (target: ConstraintTarget): Vec3 => requiredPoint(actual, pointKey(target));
  const segment = (target: ConstraintTarget): readonly [Vec3, Vec3] => {
    const id = curveId(target);
    return [requiredPoint(actual, `${id}:start`), requiredPoint(actual, `${id}:end`)];
  };
  for (const constraint of fixture.document.constraints ?? []) {
    switch (constraint.kind) {
      case 'distance': case 'horizontalDistance': case 'verticalDistance': case 'coincident': {
        const a = at(constraint.a), b = at(constraint.b);
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const measured = constraint.kind === 'horizontalDistance' ? dx
          : constraint.kind === 'verticalDistance' ? dy : Math.hypot(dx, dy);
        const expected = 'length' in constraint ? constraint.length.value : 0;
        length = Math.max(length, Math.abs(measured - expected));
        break;
      }
      case 'horizontal': case 'vertical': {
        const [a, b] = segment(constraint.target);
        length = Math.max(length, Math.abs(b[constraint.kind === 'horizontal' ? 1 : 0] - a[constraint.kind === 'horizontal' ? 1 : 0]));
        break;
      }
      case 'parallel': case 'perpendicular': {
        const [a, b] = segment(constraint.a), [c, d] = segment(constraint.b);
        const u = [b[0] - a[0], b[1] - a[1]], v = [d[0] - c[0], d[1] - c[1]];
        const product = constraint.kind === 'parallel' ? u[0] * v[1] - u[1] * v[0] : u[0] * v[0] + u[1] * v[1];
        direction = Math.max(direction, Math.abs(product) / (Math.hypot(...u) * Math.hypot(...v)));
        break;
      }
      case 'radius': break; // Checked against the separately declared radius map above.
      case 'concentric': {
        const a = requiredPoint(actual, `${curveId(constraint.a)}:center`), b = requiredPoint(actual, `${curveId(constraint.b)}:center`);
        length = Math.max(length, Math.hypot(a[0] - b[0], a[1] - b[1]));
        break;
      }
      case 'tangent': {
        const [a, b] = segment(constraint.line), id = curveId(constraint.circle);
        const center = requiredPoint(actual, `${id}:center`), dx = b[0] - a[0], dy = b[1] - a[1];
        const norm = Math.hypot(dx, dy), nx = dy / norm, ny = -dx / norm;
        const support = id.endsWith('ellipse')
          ? Math.hypot(radius(id, '.rmajor') * nx, radius(id, '.rminor') * ny) : radius(id, '.r');
        length = Math.max(length, Math.abs((center[0] - a[0]) * nx + (center[1] - a[1]) * ny - support));
        break;
      }
      default: throw new Error(`Unimplemented independent oracle check: ${constraint.kind}`);
    }
  }
  // Arc endpoints must lie on the declared circle as well as match coordinates.
  for (const [id, expected] of fixture.radii) {
    if (!id.endsWith('-arc.r')) continue;
    const featureId = id.slice(0, -2), center = requiredPoint(actual, `${featureId}:center`);
    for (const endpoint of ['start', 'end']) {
      const p = requiredPoint(actual, `${featureId}:${endpoint}`);
      length = Math.max(length, Math.abs(Math.hypot(p[0] - center[0], p[1] - center[1]) - expected));
    }
  }
  return { coordinate, length, direction };
}

export function extraDimension(fixture: GeometryOracle, contradictory: boolean): SketchConstraint {
  const original = fixture.document.constraints?.find(constraint => constraint.id === fixture.duplicateOf);
  const id = contradictory ? 'oracle-impossible' : 'oracle-duplicate';
  if (original?.kind === 'distance') return { ...original, ...base(id), length: num(original.length.value + (contradictory ? 1 : 0)) };
  if (original?.kind === 'radius') return { ...original, ...base(id), size: num(original.size.value + (contradictory ? 1 : 0)) };
  throw new Error('The negative oracle needs an existing dimension');
}
