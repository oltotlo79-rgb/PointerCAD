import { expressionValueFromNumber } from '@pointercad/expression';
import type { HoleFeature, ThreadHoleFeature } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { setHoleField, setThreadHoleField } from './holeThreadPropertyUpdates.js';

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
