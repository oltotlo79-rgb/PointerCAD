import type { SteelProduct } from './steelCatalog.js';
import { steelSectionProfile, type SteelProfilePoint, type SteelProfileSegment } from './steelSectionProfiles.js';

export interface SteelBendDimensions {
  /** Original expressions, when available from the authoring caller. Each must evaluate to its numeric input. */
  readonly sources?: {
    readonly radius?: string;
    readonly angleDegrees?: string;
    readonly directionDegrees?: string;
    readonly firstLeg?: string;
    readonly secondLeg?: string;
  };
  /** Bend towards this angle in the fixed section XY frame; omitted means +X. */
  readonly directionDegrees?: number;
  readonly radius: number;
  readonly radiusConvention: 'inside' | 'outside';
  /** Change of tangent direction in degrees, strictly between 0 and 180. */
  readonly angleDegrees: number;
  readonly firstLeg: number;
  readonly secondLeg: number;
  /** Inside/outside dimensions end at the intersection of the extended straight edges. */
  readonly legDimension: 'tangent' | 'inside' | 'outside';
}
export interface SteelBendSection {
  readonly loops: readonly (readonly SteelProfileSegment[])[];
  readonly areaMm2: number;
  readonly centroid: SteelProfilePoint;
  readonly minX: number;
  readonly maxX: number;
  /** Same orientation-independent conservative criterion as the existing native sweep. */
  readonly boundaryRadius: number;
}
export type SteelBendPoint = readonly [number, number, number];
export interface SteelBendGeometry {
  /** Canonical nonzero direction; absent preserves the legacy +X result. */
  readonly directionDegrees?: number;
  readonly insideRadiusMm: number;
  readonly outsideRadiusMm: number;
  readonly centrelineRadiusMm: number;
  readonly firstTangentLengthMm: number;
  readonly secondTangentLengthMm: number;
  readonly arcLengthMm: number;
  /** Geometric area-centroid path length, not a manufacturing neutral-axis allowance. */
  readonly centrelineLengthMm: number;
  readonly firstTangent: SteelBendPoint;
  readonly arcCentre: SteelBendPoint;
  readonly secondTangent: SteelBendPoint;
  readonly end: SteelBendPoint;
  readonly endDirection: SteelBendPoint;
}
export type SteelBendGeometryResult =
  | { readonly ok: true; readonly geometry: SteelBendGeometry }
  | { readonly ok: false; readonly reason: 'invalidRadius' | 'invalidAngle' | 'invalidLength'
      | 'invalidSection' | 'invalidDirection' | 'insufficientLegLength' | 'radiusTooTight' };

function rectangle(width: number, height: number): readonly SteelProfileSegment[] {
  const points: readonly SteelProfilePoint[] = [[0, 0], [width, 0], [width, height], [0, height]];
  return points.map((from, index) => ({ kind: 'line', from, to: points[(index + 1) % points.length] }));
}
function circle(radius: number): readonly SteelProfileSegment[] {
  return [{ kind: 'arc', from: [radius, 0], to: [radius, 0], center: [0, 0], radius,
    startAngle: 0, endAngle: 2 * Math.PI }];
}

/** Green's first moments, integrating circular arcs analytically rather than tessellating them. */
function firstMoments(segments: readonly SteelProfileSegment[]): SteelProfilePoint {
  let xMoment = 0;
  let yMoment = 0;
  for (const segment of segments) {
    if (segment.kind === 'line') {
      const [x0, y0] = segment.from;
      const [x1, y1] = segment.to;
      xMoment += (y1 - y0) * (x0 * x0 + x0 * x1 + x1 * x1) / 6;
      yMoment -= (x1 - x0) * (y0 * y0 + y0 * y1 + y1 * y1) / 6;
    } else {
      const { radius: r, startAngle: a, endAngle: b, center: [x, y] } = segment;
      const sinA = Math.sin(a);
      const sinB = Math.sin(b);
      const cosA = Math.cos(a);
      const cosB = Math.cos(b);
      const doubleSin = Math.sin(2 * b) - Math.sin(2 * a);
      xMoment += r / 2 * (x * x * (sinB - sinA)
        + 2 * x * r * ((b - a) / 2 + doubleSin / 4)
        + r * r * (sinB - sinA - (sinB ** 3 - sinA ** 3) / 3));
      yMoment += r / 2 * (y * y * (cosA - cosB)
        + 2 * y * r * ((b - a) / 2 - doubleSin / 4)
        + r * r * (cosA - cosB + (cosB ** 3 - cosA ** 3) / 3));
    }
  }
  return [xMoment, yMoment];
}

function angleOnArc(angle: number, start: number, end: number): boolean {
  const turn = 2 * Math.PI;
  const span = Math.abs(end - start);
  const forward = end >= start ? angle - start : start - angle;
  const normalized = ((forward % turn) + turn) % turn;
  return span >= turn || normalized <= span + 1e-12;
}
function boundaryRadius(segments: readonly SteelProfileSegment[], centroid: SteelProfilePoint): number {
  let maximum = 0;
  for (const segment of segments) {
    const points = [segment.from, segment.to];
    if (segment.kind === 'arc') {
      const angle = Math.atan2(segment.center[1] - centroid[1], segment.center[0] - centroid[0]);
      if (angleOnArc(angle, segment.startAngle, segment.endAngle)) {
        points.push([segment.center[0] + segment.radius * Math.cos(angle),
          segment.center[1] + segment.radius * Math.sin(angle)]);
      }
    }
    for (const point of points) maximum = Math.max(maximum, Math.hypot(point[0] - centroid[0], point[1] - centroid[1]));
  }
  return maximum;
}

/** Preserves the actual sourced outline. Old simplified section revisions are intentionally not reinterpreted. */
export function steelBendSection(product: SteelProduct): SteelBendSection | null {
  const profile = product.geometry === 'profileSection' ? steelSectionProfile(product.catalog, product.size) : undefined;
  if (profile !== undefined) {
    const moments = firstMoments(profile.segments);
    const centroid: SteelProfilePoint = [moments[0] / profile.areaMm2, moments[1] / profile.areaMm2];
    return { loops: [profile.segments], areaMm2: profile.areaMm2, centroid,
      minX: 0, maxX: profile.width, boundaryRadius: boundaryRadius(profile.segments, centroid) };
  }
  const d = product.dimensions;
  if (product.catalog === 'flatBar' && d?.width !== undefined && d.thickness !== undefined) {
    return { loops: [rectangle(d.width, d.thickness)], areaMm2: d.width * d.thickness,
      centroid: [d.width / 2, d.thickness / 2], minX: 0, maxX: d.width,
      boundaryRadius: Math.hypot(d.width, d.thickness) / 2 };
  }
  const radius = product.catalog === 'roundBar' ? (d?.diameter ?? NaN) / 2 : (d?.outsideDiameter ?? NaN) / 2;
  if (!Number.isFinite(radius) || radius <= 0) return null;
  const inner = product.catalog === 'steelPipe' ? radius - (d?.wallThickness ?? NaN) : 0;
  if (!Number.isFinite(inner) || inner < 0 || inner >= radius) return null;
  return { loops: inner === 0 ? [circle(radius)] : [circle(radius), circle(inner)],
    areaMm2: Math.PI * (radius * radius - inner * inner), centroid: [0, 0],
    minX: -radius, maxX: radius, boundaryRadius: radius };
}

/** Exact support of analytic section edges in the bend direction, including circular extrema. */
function directionalBounds(section: SteelBendSection, dx: number, dy: number): readonly [number, number] | null {
  let minimum = Infinity;
  let maximum = -Infinity;
  const direction = Math.atan2(dy, dx);
  for (const loop of section.loops) {
    if (loop.length === 0) return null;
    for (const segment of loop) {
      const points = [segment.from, segment.to];
      if (segment.kind === 'arc') {
        if (![...segment.center, segment.radius, segment.startAngle, segment.endAngle].every(Number.isFinite)
          || segment.radius <= 0 || segment.startAngle === segment.endAngle) return null;
        for (const angle of [direction, direction + Math.PI]) {
          if (angleOnArc(angle, segment.startAngle, segment.endAngle)) {
            // At a support extremum the projection is center dot direction +/- radius.
            const projection = segment.center[0] * dx + segment.center[1] * dy
              + (angle === direction ? segment.radius : -segment.radius);
            minimum = Math.min(minimum, projection);
            maximum = Math.max(maximum, projection);
          }
        }
      }
      for (const point of points) {
        if (!point.every(Number.isFinite)) return null;
        const projection = point[0] * dx + point[1] * dy;
        minimum = Math.min(minimum, projection);
        maximum = Math.max(maximum, projection);
      }
    }
  }
  return Number.isFinite(minimum) && Number.isFinite(maximum) ? [minimum, maximum] : null;
}

/** Start tangent +Z; change only the bend plane relative to the fixed section XY frame. */
export function planSteelBend(section: SteelBendSection, input: SteelBendDimensions): SteelBendGeometryResult {
  const requestedDirection = input.directionDegrees === undefined ? 0 : input.directionDegrees;
  if (!Number.isFinite(requestedDirection)) return { ok: false, reason: 'invalidDirection' };
  const remainder = requestedDirection % 360;
  const directionDegrees = remainder === 0 ? 0 : remainder < 0 ? remainder + 360 : remainder;
  const directionRadians = directionDegrees * Math.PI / 180;
  const dx = directionDegrees === 90 || directionDegrees === 270 ? 0
    : directionDegrees === 180 ? -1 : directionDegrees === 0 ? 1 : Math.cos(directionRadians);
  const dy = directionDegrees === 0 || directionDegrees === 180 ? 0
    : directionDegrees === 90 ? 1 : directionDegrees === 270 ? -1 : Math.sin(directionRadians);
  const bounds = directionDegrees === 0 ? [section.minX, section.maxX] : directionalBounds(section, dx, dy);
  if (bounds === null) return { ok: false, reason: 'invalidSection' };
  const width = bounds[1] - bounds[0];
  const insideOffset = bounds[1] - (section.centroid[0] * dx + section.centroid[1] * dy);
  const values = [width, insideOffset, section.centroid[1], section.areaMm2, section.boundaryRadius];
  if (values.some((value) => !Number.isFinite(value)) || width <= 0 || insideOffset <= 0
    || insideOffset >= width || section.areaMm2 <= 0 || section.boundaryRadius <= 0) {
    return { ok: false, reason: 'invalidSection' };
  }
  if (!Number.isFinite(input.angleDegrees) || input.angleDegrees <= 0 || input.angleDegrees >= 180
    || 180 - input.angleDegrees === 180) {
    return { ok: false, reason: 'invalidAngle' };
  }
  if (!Number.isFinite(input.radius) || input.radius <= 0
    || (input.radiusConvention !== 'inside' && input.radiusConvention !== 'outside')) {
    return { ok: false, reason: 'invalidRadius' };
  }
  if (![input.firstLeg, input.secondLeg].every((value) => Number.isFinite(value) && value > 0)
    || !['tangent', 'inside', 'outside'].includes(input.legDimension)) return { ok: false, reason: 'invalidLength' };
  const insideRadiusMm = input.radiusConvention === 'inside' ? input.radius : input.radius - width;
  const outsideRadiusMm = insideRadiusMm + width;
  const centrelineRadiusMm = insideRadiusMm + insideOffset;
  if (insideRadiusMm <= 0 || !Number.isFinite(outsideRadiusMm)) return { ok: false, reason: 'invalidRadius' };
  if (centrelineRadiusMm <= section.boundaryRadius) return { ok: false, reason: 'radiusTooTight' };
  const radians = input.angleDegrees * Math.PI / 180;
  const setback = input.legDimension === 'tangent' ? 0
    : (input.legDimension === 'inside' ? insideRadiusMm : outsideRadiusMm) * Math.tan(radians / 2);
  const firstTangentLengthMm = input.firstLeg - setback;
  const secondTangentLengthMm = input.secondLeg - setback;
  // Subtracting a trigonometric setback can leave a few ulps at a mathematically zero leg.
  // This is relative floating roundoff, not a manufacturing or CAD length tolerance.
  const setbackRoundoff = 8 * Number.EPSILON * Math.abs(setback);
  if (firstTangentLengthMm <= setbackRoundoff || secondTangentLengthMm <= setbackRoundoff) {
    return { ok: false, reason: 'insufficientLegLength' };
  }
  const arcLengthMm = centrelineRadiusMm * radians;
  const centrelineLengthMm = firstTangentLengthMm + arcLengthMm + secondTangentLengthMm;
  const endDirection: SteelBendPoint = [dx * Math.sin(radians), dy * Math.sin(radians), Math.cos(radians)];
  const secondTangent: SteelBendPoint = [dx * centrelineRadiusMm * (1 - Math.cos(radians)),
    dy * centrelineRadiusMm * (1 - Math.cos(radians)),
    firstTangentLengthMm + centrelineRadiusMm * Math.sin(radians)];
  const end: SteelBendPoint = [secondTangent[0] + secondTangentLengthMm * endDirection[0],
    secondTangent[1] + secondTangentLengthMm * endDirection[1],
    secondTangent[2] + secondTangentLengthMm * endDirection[2]];
  if (![firstTangentLengthMm, secondTangentLengthMm, arcLengthMm, centrelineLengthMm, ...end].every(Number.isFinite)) {
    return { ok: false, reason: 'invalidLength' };
  }
  return { ok: true, geometry: { ...(directionDegrees === 0 ? {} : { directionDegrees }),
    insideRadiusMm, outsideRadiusMm, centrelineRadiusMm,
    firstTangentLengthMm, secondTangentLengthMm, arcLengthMm, centrelineLengthMm,
    firstTangent: [0, 0, firstTangentLengthMm], arcCentre: [dx * centrelineRadiusMm, dy * centrelineRadiusMm, firstTangentLengthMm],
    secondTangent, end, endDirection } };
}
