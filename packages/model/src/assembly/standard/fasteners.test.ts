import { describe, expect, it } from 'vitest';

import { findMetricThread } from '../../thread/metricThread.js';
import {
  findHexBolt, findHexNut, findPanHeadScrew, findPlainWasher, findSocketHeadCapScrew,
  findSpringWasher, HEX_BOLT_TABLE, HEX_NUT_TABLE, PAN_HEAD_SCREW_TABLE, PLAIN_WASHER_TABLE,
  SOCKET_HEAD_CAP_SCREW_TABLE, SPRING_WASHER_TABLE,
} from './fasteners.js';

function expectUniqueAscending(rows: readonly { readonly key: string; readonly d: number }[]): void {
  expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  for (let index = 1; index < rows.length; index += 1) {
    expect(rows[index].d).toBeGreaterThan(rows[index - 1].d);
  }
}

describe('JIS fastener dimension tables', () => {
  it('keeps the approved main and Annex JA bolt series separately', () => {
    const main = HEX_BOLT_TABLE.filter((row) => row.dimensionSeries === 'main');
    const annex = HEX_BOLT_TABLE.filter((row) => row.dimensionSeries === 'annexJA');
    expect(main).toHaveLength(11);
    expect(annex).toHaveLength(9);
    expectUniqueAscending(main);
    expectUniqueAscending(annex);
  });

  it('keeps the available main and Annex JA nut series separately', () => {
    const main = HEX_NUT_TABLE.filter((row) => row.dimensionSeries === 'main');
    const annex = HEX_NUT_TABLE.filter((row) => row.dimensionSeries === 'annexJA');
    expect(main).toHaveLength(11);
    expect(annex).toHaveLength(6);
    expectUniqueAscending(main);
    expectUniqueAscending(annex);
  });

  it.each([
    ['plain washer', PLAIN_WASHER_TABLE],
    ['spring washer', SPRING_WASHER_TABLE],
    ['socket-head screw', SOCKET_HEAD_CAP_SCREW_TABLE],
  ])('%s keeps M3 through M20 in ascending order', (_name, rows) => {
    expectUniqueAscending(rows);
    expect(rows[0].size).toBe('M3');
    expect(rows.at(-1)?.size).toBe('M20');
    expect(rows).toHaveLength(11);
  });

  it('uses Annex JA by default while retaining main-standard M8 dimensions', () => {
    expect(findHexBolt('M8')).toMatchObject({ dimensionSeries: 'annexJA', s: 13, k: 5.5 });
    expect(findHexBolt('M8', 'main')).toMatchObject({ dimensionSeries: 'main', s: 13, k: 5.3 });
    expect(findHexNut('M8')).toMatchObject({ dimensionSeries: 'annexJA', s: 13, mMax: 6.5 });
    expect(findHexNut('M8', 'main')).toMatchObject({ dimensionSeries: 'main', s: 13, mMax: 6.8, mMin: 6.44 });
  });

  it('matches every stored coarse pitch with the shared metric-thread table', () => {
    for (const row of [...HEX_BOLT_TABLE, ...HEX_NUT_TABLE, ...SOCKET_HEAD_CAP_SCREW_TABLE,
      ...PAN_HEAD_SCREW_TABLE]) {
      expect(findMetricThread(row.size)?.coarsePitch).toBe(row.pitch);
    }
  });

  it('keeps every head or nut wider than its thread', () => {
    expect(HEX_BOLT_TABLE.every((row) => row.s > row.d)).toBe(true);
    expect(HEX_NUT_TABLE.every((row) => row.s > row.d
      && (row.mMin === null || row.mMax >= row.mMin))).toBe(true);
  });

  it('keeps JIS B 1111 pan-head screws at M3, M4, M5, M6, and M8', () => {
    expect(PAN_HEAD_SCREW_TABLE.map((row) => row.size)).toEqual(['M3', 'M4', 'M5', 'M6', 'M8']);
    expect(findPanHeadScrew('M8')).toMatchObject({
      d: 8, headDiameter: 14, headHeight: 5.2, recessNumber: 3, verified: false,
    });
    expect(PAN_HEAD_SCREW_TABLE.every((row) => row.note.includes('\u8981\u78ba\u8a8d'))).toBe(true);
  });

  it('keeps washer geometry valid and preserves verification notes', () => {
    expect(findPlainWasher('M8')).toMatchObject({ d1: 8.4, d2: 16, thickness: 1.6, verified: false });
    expect(findPlainWasher('M8')?.note).toContain('\u8981\u78ba\u8a8d');
    expect(PLAIN_WASHER_TABLE.every((row) => row.d1 > row.d && row.d2 > row.d1)).toBe(true);
    expect(SPRING_WASHER_TABLE.every((row) => row.outsideDiameter > row.insideDiameter)).toBe(true);
  });

  it('keeps representative spring-washer and socket-head dimensions', () => {
    expect(findSpringWasher('M8')).toMatchObject({
      insideDiameter: 8.2, outsideDiameter: 15.4, width: 3.2, thickness: 2,
    });
    expect(findSocketHeadCapScrew('M8')).toMatchObject({
      headDiameter: 13, headHeight: 8, socketWidth: 6, socketDepth: 4,
    });
  });

  it('does not expose the incomplete M18 socket-head row', () => {
    expect(SOCKET_HEAD_CAP_SCREW_TABLE.find((row) => row.size === 'M18'))
      .toMatchObject({ available: false, socketDepth: null, verified: false });
    expect(findSocketHeadCapScrew('M18')).toBeUndefined();
  });

  it('returns undefined for unavailable designations and unavailable Annex nut sizes', () => {
    expect(findHexBolt('M7')).toBeUndefined();
    expect(findHexNut('M3')).toBeUndefined();
    expect(findHexNut('M3', 'main')).toBeDefined();
    expect(findPanHeadScrew('M10')).toBeUndefined();
    expect(findPlainWasher('M7')).toBeUndefined();
    expect(findSpringWasher('M7')).toBeUndefined();
    expect(findSocketHeadCapScrew('M7')).toBeUndefined();
  });
});
