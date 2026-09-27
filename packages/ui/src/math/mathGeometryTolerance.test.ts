import { describe, expect, it } from 'vitest';
import { DEFAULT_MATH_GEOMETRY_TOLERANCE } from '@pointercad/model';
import {
  mathGeometryToleranceFields,
  mathGeometryToleranceText,
  readMathGeometryTolerance,
} from './mathGeometryTolerance.js';

describe('comparison margin fields (GR-19a)', () => {
  it('formats the default mm/radian margins as mm/degrees with 12 significant digits', () => {
    expect(mathGeometryToleranceFields()).toEqual({ linear: '0.000001', angular: '0.0000572957795131' });
    expect(mathGeometryToleranceText(DEFAULT_MATH_GEOMETRY_TOLERANCE))
      .toBe('長さ 0.000001 mm / 角度 0.0000572957795131 度');
  });

  it('formats finite margins without rounding the original values', () => {
    const tolerance = Object.freeze({ linearMm: 1.23456789012345, angularRadians: Math.PI / 6 });
    expect(mathGeometryToleranceFields(tolerance)).toEqual({ linear: '1.23456789012', angular: '30' });
    expect(tolerance.linearMm).toBe(1.23456789012345);
    expect(tolerance.angularRadians).toBe(Math.PI / 6);
  });

  it('evaluates arithmetic and converts degrees to radians before validation', () => {
    const result = readMathGeometryTolerance({ linear: '1 / 1000000', angular: '90 / 3' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected valid margins');
    expect(result.tolerance.linearMm).toBe(0.000001);
    expect(result.tolerance.angularRadians).toBeCloseTo(Math.PI / 6, 15);
  });

  it('keeps unrounded input precision for storage', () => {
    const result = readMathGeometryTolerance({ linear: '1.23456789012345', angular: '0.123456789012345' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected valid margins');
    expect(result.tolerance.linearMm).toBe(1.23456789012345);
    expect(result.tolerance.angularRadians).toBe(0.123456789012345 * (Math.PI / 180));
  });

  it.each(['0', '-1', '', ' ', '1 / 0', 'sqrt(-1)', 'unknown', '1 +'])('reports only the invalid length field: %j', linear => {
    expect(readMathGeometryTolerance({ linear, angular: '1' })).toEqual({
      ok: false, errors: { linear: 'mathGeometry.tolerance.error.linear', angular: null },
    });
  });

  it.each(['0', '-0.1', '45', '90 / 2', '46', '180', '', '1 / 0', 'unknown'])('reports only the invalid angular field: %j', angular => {
    expect(readMathGeometryTolerance({ linear: '1', angular })).toEqual({
      ok: false, errors: { linear: null, angular: 'mathGeometry.tolerance.error.angular' },
    });
  });

  it('returns both errors in the same read', () => {
    expect(readMathGeometryTolerance({ linear: '-1', angular: '45' })).toEqual({
      ok: false, errors: { linear: 'mathGeometry.tolerance.error.linear', angular: 'mathGeometry.tolerance.error.angular' },
    });
  });

  it('accepts values just inside the model limit and a tiny positive length', () => {
    expect(readMathGeometryTolerance({ linear: '0.000000000001', angular: '44.999999999' }).ok).toBe(true);
  });

  it('resets edited fields from the model default, and the displayed values remain readable', () => {
    const edited = mathGeometryToleranceFields({ linearMm: 2, angularRadians: 0.1 });
    expect(edited).not.toEqual(mathGeometryToleranceFields());
    const reset = mathGeometryToleranceFields();
    const result = readMathGeometryTolerance(reset);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected readable defaults');
    expect(result.tolerance.linearMm).toBe(DEFAULT_MATH_GEOMETRY_TOLERANCE.linearMm);
    expect(result.tolerance.angularRadians).toBeCloseTo(DEFAULT_MATH_GEOMETRY_TOLERANCE.angularRadians, 16);
    // The reset command uses the constant directly, never the rounded display values.
    expect(DEFAULT_MATH_GEOMETRY_TOLERANCE).toEqual({ linearMm: 1e-6, angularRadians: 1e-6 });
  });
});
