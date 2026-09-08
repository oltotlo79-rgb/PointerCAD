import { describe, expect, it } from 'vitest';

import {
  CHANNEL_TABLE, EQUAL_ANGLE_TABLE, findChannel, findEqualAngle, findHBeam, H_BEAM_TABLE,
  sectionMassFromArea,
} from './sections.js';

const ALL_SECTIONS = [...EQUAL_ANGLE_TABLE, ...CHANNEL_TABLE, ...H_BEAM_TABLE];

describe('JIS structural-section dimension tables', () => {
  it('keeps every approved section: 26 angles, 8 channels, and 7 wide-flange H beams', () => {
    expect(EQUAL_ANGLE_TABLE).toHaveLength(26);
    expect(CHANNEL_TABLE).toHaveLength(8);
    expect(H_BEAM_TABLE).toHaveLength(7);
  });

  it('has 41 unique stable row and size keys', () => {
    expect(new Set(ALL_SECTIONS.map((row) => row.size)).size).toBe(41);
    expect(new Set(ALL_SECTIONS.map((row) => row.key)).size).toBe(41);
  });

  it('fixes the reference L 50x50x6 dimensions', () => {
    expect(findEqualAngle('L 50\u00d750\u00d76')).toMatchObject({ areaCm2: 5.644, massKgPerM: 4.43 });
  });

  it('keeps every thickness inside its section envelope', () => {
    expect(EQUAL_ANGLE_TABLE.every((row) => row.thickness < row.a && row.thickness < row.b)).toBe(true);
    expect(CHANNEL_TABLE.every((row) =>
      row.webThickness < row.width && row.flangeThickness * 2 < row.height,
    )).toBe(true);
    expect(H_BEAM_TABLE.every((row) =>
      row.webThickness < row.width && row.flangeThickness * 2 < row.height,
    )).toBe(true);
  });

  it('matches area times steel density to published mass within two percent', () => {
    for (const row of ALL_SECTIONS) {
      const calculated = sectionMassFromArea(row.areaCm2);
      expect(Math.abs(calculated - row.massKgPerM) / row.massKgPerM).toBeLessThan(0.02);
    }
  });

  it('converts the reference area independently', () => {
    expect(sectionMassFromArea(5.644)).toBeCloseTo(4.43054, 5);
  });

  it('finds representative channel and H-beam rows', () => {
    expect(findChannel('[ 100\u00d750\u00d75\u00d77.5')).toMatchObject({ areaCm2: 11.92, massKgPerM: 9.36 });
    expect(findHBeam('H 100\u00d7100\u00d76\u00d78')).toMatchObject({ areaCm2: 21.59, massKgPerM: 16.9 });
  });

  it('returns undefined for missing sizes', () => {
    expect(findEqualAngle('L 1\u00d71\u00d71')).toBeUndefined();
    expect(findChannel('[ 1\u00d71\u00d71\u00d71')).toBeUndefined();
    expect(findHBeam('H 1\u00d71\u00d71\u00d71')).toBeUndefined();
  });
});
