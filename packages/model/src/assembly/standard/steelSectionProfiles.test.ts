import { describe, expect, it } from 'vitest';

import { steelSectionProfile, STEEL_PROFILE_EVIDENCE, type SteelProfileSegment } from './steelSectionProfiles.js';

const cornerArea = 1 - Math.PI / 4;
const channelTurn = 85 * Math.PI / 180;
const channelCorrection = 2 * (8 ** 2 - 4 ** 2) * (Math.tan(channelTurn / 2) - channelTurn / 2);
const fixtures = [
  { catalog: 'equalAngle', size: 'L 40×40×5', width: 40, height: 40, root: 4.5, tip: 3,
    area: 375 + cornerArea * (4.5 ** 2 - 2 * 3 ** 2), printedArea: 375.5, rounding: 0.1, arcs: 3 },
  { catalog: 'equalAngle', size: 'L 50×50×6', width: 50, height: 50, root: 6.5, tip: 4.5,
    area: 564 + cornerArea * (6.5 ** 2 - 2 * 4.5 ** 2), printedArea: 564.4, rounding: 0.1, arcs: 3 },
  { catalog: 'equalAngle', size: 'L 65×65×6', width: 65, height: 65, root: 8.5, tip: 4,
    area: 744 + cornerArea * (8.5 ** 2 - 2 * 4 ** 2), printedArea: 752.7, rounding: 0.1, arcs: 3 },
  { catalog: 'channel', size: '[ 75×40×5×7', width: 40, height: 75, root: 8, tip: 4,
    area: 865 + channelCorrection, printedArea: 881.8, rounding: 0.1, arcs: 4 },
  { catalog: 'channel', size: '[ 100×50×5×7.5', width: 50, height: 100, root: 8, tip: 4,
    area: 1175 + channelCorrection, printedArea: 1192, rounding: 0.5, arcs: 4 },
  { catalog: 'channel', size: '[ 125×65×6×8', width: 65, height: 125, root: 8, tip: 4,
    area: 1694 + channelCorrection, printedArea: 1711, rounding: 0.5, arcs: 4 },
  { catalog: 'hBeam', size: 'H 150×150×7×10', width: 150, height: 150, root: 8, tip: 0,
    area: 3910 + 4 * cornerArea * 8 ** 2, printedArea: 3965, rounding: 0.5, arcs: 4 },
  { catalog: 'hBeam', size: 'H 200×200×8×12', width: 200, height: 200, root: 13, tip: 0,
    area: 6208 + 4 * cornerArea * 13 ** 2, printedArea: 6353, rounding: 0.5, arcs: 4 },
  { catalog: 'hBeam', size: 'H 300×300×10×15', width: 300, height: 300, root: 13, tip: 0,
    area: 11700 + 4 * cornerArea * 13 ** 2, printedArea: 11850, rounding: 5, arcs: 4 },
] as const;

function tangent(segment: SteelProfileSegment, end: boolean): readonly [number, number] {
  if (segment.kind === 'line') {
    const dx = segment.to[0] - segment.from[0];
    const dy = segment.to[1] - segment.from[1];
    const norm = Math.hypot(dx, dy);
    return [dx / norm, dy / norm];
  }
  const angle = end ? segment.endAngle : segment.startAngle;
  const sign = Math.sign(segment.endAngle - segment.startAngle);
  return [-Math.sin(angle) * sign, Math.cos(angle) * sign];
}

describe('source-backed analytic steel section boundaries', () => {
  it.each(fixtures)('$size matches independent area, source radii and outer dimensions', (input) => {
    const result = steelSectionProfile(input.catalog, input.size);
    if (result === undefined) throw new Error('Missing sourced profile');
    expect(result).toMatchObject({ width: input.width, height: input.height,
      rootRadius: input.root, tipRadius: input.tip, taperDegrees: input.catalog === 'channel' ? 5 : 0 });
    expect(result.areaMm2).toBeCloseTo(input.area, 8);
    // Printed performance tables are rounded; the analytic area is not rounded to those tables.
    expect(Math.abs(result.areaMm2 - input.printedArea)).toBeLessThan(input.rounding);
    const arcs = result.segments.filter((segment) => segment.kind === 'arc');
    expect(arcs).toHaveLength(input.arcs);
    expect(arcs.filter((arc) => arc.endAngle < arc.startAngle)).toHaveLength(input.catalog === 'equalAngle' ? 1 : input.catalog === 'channel' ? 2 : 4);
    expect(new Set(arcs.map((arc) => arc.radius))).toEqual(new Set(input.tip === 0 ? [input.root] : [input.root, input.tip]));
    const points = result.segments.flatMap((segment) => [segment.from, segment.to]);
    expect(Math.min(...points.map((point) => point[0]))).toBe(0);
    expect(Math.min(...points.map((point) => point[1]))).toBe(0);
    expect(Math.max(...points.map((point) => point[0]))).toBe(input.width);
    expect(Math.max(...points.map((point) => point[1]))).toBe(input.height);
    for (let index = 0; index < result.segments.length; index++) {
      const current = result.segments[index];
      const next = result.segments[(index + 1) % result.segments.length];
      expect(current.to[0]).toBeCloseTo(next.from[0], 10);
      expect(current.to[1]).toBeCloseTo(next.from[1], 10);
      if (current.kind === 'arc' || next.kind === 'arc') {
        const first = tangent(current, true);
        const second = tangent(next, false);
        expect(first[0] * second[0] + first[1] * second[1]).toBeCloseTo(1, 10);
      }
      if (current.kind === 'arc') {
        for (const point of [current.from, current.to]) {
          expect(Math.hypot(point[0] - current.center[0], point[1] - current.center[1])).toBeCloseTo(current.radius, 10);
        }
      }
    }
  });

  it.each(['[ 75×40×5×7', '[ 100×50×5×7.5', '[ 125×65×6×8'])('keeps %s flange taper at 5 degrees and midpoint thickness', (size) => {
    const profile = steelSectionProfile('channel', size);
    if (profile === undefined) throw new Error('Missing channel');
    const lower = profile.segments.find((segment) => segment.kind === 'line'
      && segment.from[0] > segment.to[0] && segment.from[1] < segment.to[1]);
    if (lower === undefined || lower.kind !== 'line') throw new Error('Missing inclined flange');
    expect((lower.to[1] - lower.from[1]) / (lower.to[0] - lower.from[0])).toBeCloseTo(-Math.tan(5 * Math.PI / 180), 12);
    const dimensions = size.slice(2).split('×').map(Number);
    const midpoint = (dimensions[1] + dimensions[2]) / 2;
    const y = lower.from[1] + (midpoint - lower.from[0]) * (lower.to[1] - lower.from[1]) / (lower.to[0] - lower.from[0]);
    expect(y).toBeCloseTo(dimensions[3], 10);
  });

  it('does not infer profiles for old-only sizes, a different family or malformed sizes', () => {
    expect(steelSectionProfile('hBeam', 'H 100×100×6×8')).toBeUndefined();
    expect(steelSectionProfile('channel', 'L 50×50×6')).toBeUndefined();
    expect(steelSectionProfile('equalAngle', 'L -1×-1×2')).toBeUndefined();
    expect(steelSectionProfile('equalAngle', 'toString')).toBeUndefined();
    expect(steelSectionProfile('channel', '__proto__')).toBeUndefined();
    expect(steelSectionProfile('hBeam', 'constructor')).toBeUndefined();
    for (const evidence of Object.values(STEEL_PROFILE_EVIDENCE)) {
      expect(evidence.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(evidence.url).toMatch(/^https:/);
      expect(evidence.locator).toContain('PDF p');
    }
  });
});
