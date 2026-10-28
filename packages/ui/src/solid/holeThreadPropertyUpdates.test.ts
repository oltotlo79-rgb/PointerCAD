import { evaluateExpression, expressionValueFromNumber } from '@pointercad/expression';
import type { HoleFeature, ThreadHoleFeature } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import {
  setHoleField, setThreadDesignation, setThreadHoleField, setThreadSeries,
} from './holeThreadPropertyUpdates.js';

const formula = (source: string, value: number) => ({ ...expressionValueFromNumber(value), source });
const positions = [
  { height: formula('8 + 4', 12), angle: formula('-30 * 2', -60) },
  { height: formula('7 * 3', 21), angle: formula('360 + 45', 405) },
  { height: formula('60 / 2', 30), angle: formula('-720 - 15', -735) },
];
const hole: HoleFeature = {
  id: 'hole-1', name: 'Hole', kind: 'hole', suppressed: false, targetFeatureId: 'body-1',
  face: { bodyFeatureId: 'body-1', index: 2, fingerprint: { kind: 'face', surfaceKind: 'cylinder',
    area: 1000, position: [10, 20, 30], axis: [0, 0, 1], radius: 20 } },
  centers: [], diameter: formula('2 * 3', 6), depth: { kind: 'blind', depth: formula('12 / 3', 4) },
  entry: { kind: 'counterbore', diameter: formula('6 + 4', 10), depth: formula('6 / 3', 2) },
  tiltAngle: formula('0 * 2', 0), tiltAzimuth: formula('0 + 0', 0),
  cylindrical: { kind: 'cylinder-face', locations: positions },
};
const thread: ThreadHoleFeature = {
  ...hole, kind: 'threadHole', designation: 'M6', series: 'fine',
  pitch: formula('3 / 4', 0.75), drillDiameter: formula('6 - 0.75', 5.25),
  threadLength: formula('3 + 1', 4), representation: 'modeled',
};
const features = [hole, thread] as const;
const keys = ['holeCylinderHeight', 'holeCylinderAngle'] as const;

describe('EX05 indexed cylindrical property updates', () => {
  for (const feature of features) {
    for (const index of [0, 1, 2]) {
      for (const key of keys) {
        it(`${feature.kind}: ${key} at index ${index} preserves every other field and location`, () => {
          const before = structuredClone(feature);
          const value = key === 'holeCylinderHeight' ? formula('9 * 2 + 1', 19) : formula('-360 + 17', -343);
          const next = feature.kind === 'hole'
            ? setHoleField(feature, key, value, index)
            : setThreadHoleField(feature, key, value, index);
          const member = key === 'holeCylinderHeight' ? 'height' : 'angle';
          expect(next).toEqual({ ...before, cylindrical: { kind: 'cylinder-face', locations:
            positions.map((location, slot) => slot === index ? { ...location, [member]: value } : location) } });
          expect(feature).toEqual(before);
          if (next.kind !== 'hole' && next.kind !== 'threadHole') throw new Error('Expected hole');
          expect(next.cylindrical?.locations[index]?.[member]).toBe(value);
          positions.forEach((location, slot) => {
            if (slot !== index) expect(next.cylindrical?.locations[slot]).toBe(location);
          });
        });
      }
    }
    it(`${feature.kind}: missing, invalid indices and nonfinite values never rewrite a location`, () => {
      const update = (index?: number, value = formula('18 / 2', 9)) => feature.kind === 'hole'
        ? setHoleField(feature, 'holeCylinderHeight', value, index)
        : setThreadHoleField(feature, 'holeCylinderHeight', value, index);
      for (const index of [undefined, -1, 3, 0.5, NaN, Infinity]) expect(update(index)).toBe(feature);
      for (const value of [NaN, Infinity, -Infinity]) expect(update(1, formula('bad', value))).toBe(feature);
    });
    it(`${feature.kind}: one location retains its index-free behavior and exact source`, () => {
      const single = { ...feature, cylindrical: { kind: 'cylinder-face' as const, locations: [positions[0]] } };
      const value = formula('360 * 2 + 11', 731);
      const next = single.kind === 'hole'
        ? setHoleField(single, 'holeCylinderAngle', value)
        : setThreadHoleField(single, 'holeCylinderAngle', value);
      expect(next).toEqual({ ...single, cylindrical: { kind: 'cylinder-face', locations: [{ ...positions[0], angle: value }] } });
    });
  }
});

describe('EX05 planar indexed expression updates', () => {
  const planar: HoleFeature = { ...hole, cylindrical: undefined,
    face: { bodyFeatureId: 'body-1', index: 2, fingerprint: { kind: 'face', surfaceKind: 'plane',
      area: 1000, position: [11, -7, 5], axis: [-0.48, 0.36, 0.8], radius: null } },
    planar: { kind: 'plane-face', locations: [
      { x: formula('2 * 3', 6), y: formula('-2 * 2', -4) },
      { x: formula('-6 / 2', -3), y: formula('10 / 2', 5) },
    ] } };
  const planarThread: ThreadHoleFeature = { ...thread, cylindrical: undefined, face: planar.face, planar: planar.planar };
  it.each([planar, planarThread])('$kind: selected XY preserves other source, reference and entry', feature => {
    const value = formula('-12 / 2', -6);
    const update = (index?: number, next = value) => feature.kind === 'hole'
      ? setHoleField(feature, 'holePlanarX', next, undefined, index)
      : setThreadHoleField(feature, 'holePlanarX', next, undefined, index);
    const changed = update(1);
    if (changed.kind !== 'hole' && changed.kind !== 'threadHole') throw new Error('Expected hole');
    expect(changed.planar?.locations[0]).toBe(feature.planar?.locations[0]);
    expect(changed.planar?.locations[1]?.x).toBe(value);
    expect(changed.planar?.locations[1]?.y).toBe(feature.planar?.locations[1]?.y);
    expect(changed.face).toBe(feature.face);
    expect(changed.entry).toBe(feature.entry);
    for (const index of [undefined, -1, 2, 0.5, NaN, Infinity]) expect(update(index)).toBe(feature);
    for (const invalid of [formula('', 0), formula('bad', NaN), formula('bad', Infinity)]) expect(update(1, invalid)).toBe(feature);
    expect(feature.planar?.locations[1]?.x.source).toBe('-6 / 2');
  });
  it('one planar location permits omitted index without changing the original expression', () => {
    const feature: HoleFeature = { ...planar, planar: { kind: 'plane-face', locations: [{ x: formula('6', 6), y: formula('-4', -4) }] } };
    const value = formula('10 - 17', -7);
    const changed = setHoleField(feature, 'holePlanarY', value);
    if (changed.kind !== 'hole') throw new Error('Expected hole');
    expect(changed.planar?.locations[0]?.y).toBe(value);
    expect(changed.planar?.locations[0]?.x).toBe(feature.planar?.locations[0]?.x);
  });
});

describe('自動計算する下穴径の厳密な式を保つ', () => {
  it.each([
    { designation: 'M6', diameter: 6, series: 'coarse', pitch: 1, display: '4.91746824527' },
    { designation: 'M6', diameter: 6, series: 'fine', pitch: 0.75, display: '5.18810118395' },
    { designation: 'M8', diameter: 8, series: 'coarse', pitch: 1.25, display: '6.64683530659' },
    { designation: 'M8', diameter: 8, series: 'fine', pitch: 1, display: '6.91746824527' },
  ] as const)('$designation $series は呼びと系列の両入口で丸めない', row => {
    // ISO基本三角形から D1 = D - 5√3P/8 を独立に求める。
    const expected = row.diameter - (5 * Math.sqrt(3) / 8) * row.pitch;
    const byDesignation: ThreadHoleFeature = { ...thread, series: row.series };
    const bySeries: ThreadHoleFeature = { ...thread, designation: row.designation };
    for (const [input, update] of [
      [byDesignation, () => setThreadDesignation(byDesignation, row.designation)],
      [bySeries, () => setThreadSeries(bySeries, row.series)],
    ] as const) {
      const before = structuredClone(input);
      const result = update();
      if (result.kind !== 'threadHole') throw new Error('Expected thread hole');
      expect(result.drillDiameter.value).toBe(expected);
      expect(result.drillDiameter.source).toBe(String(expected));
      expect(result.drillDiameter.display).toBe(row.display);
      const evaluated = evaluateExpression(result.drillDiameter.source);
      if (!evaluated.ok) throw new Error('Expected valid drill diameter');
      expect(evaluated.value.value).toBe(expected);
      expect(result).toEqual({ ...before, designation: row.designation, series: row.series,
        pitch: expressionValueFromNumber(row.pitch), drillDiameter: result.drillDiameter });
      expect(input).toEqual(before);
    }
  });

  it('下穴径の手入力式は自動計算で置き換えない', () => {
    const manual = formula('6 - 1 / 3', 6 - 1 / 3);
    const before = structuredClone(thread);
    const result = setThreadHoleField(thread, 'drillDiameter', manual);
    if (result.kind !== 'threadHole') throw new Error('Expected thread hole');
    expect(result.drillDiameter).toBe(manual);
    expect(result).toEqual({ ...before, drillDiameter: manual });
    expect(thread).toEqual(before);
  });
});
