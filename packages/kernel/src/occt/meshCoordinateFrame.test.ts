import { describe, expect, it } from 'vitest';

import type { Vec3Tuple } from '../types.js';
import {
  createMeshCoordinateFrame,
  localFloat32Coordinates,
  localToWorld,
  worldToLocal,
  writeLocalFloat32,
} from './meshCoordinateFrame.js';

const MILLIMETRES_PER_CSS_PIXEL = 8 / 600;
const CSS_PIXELS_PER_MILLIMETRE = 600 / 8;

function translatedBox(x: number): { minimum: Vec3Tuple; maximum: Vec3Tuple } {
  return { minimum: [x, -4, -4], maximum: [x + 8, 4, 4] };
}

describe('local mesh coordinate frame', () => {
  it.each([
    { base: 1e6, detail: 0.03, lostCssPixels: 2.25 },
    { base: 1e9, detail: 1, lostCssPixels: 75 },
  ])('keeps $detail mm detail at $base mm before Float32 admission', ({ base, detail, lostCssPixels }) => {
    const direct = new Float32Array([base, base + detail]);
    expect((detail - (direct[1] - direct[0])) * CSS_PIXELS_PER_MILLIMETRE)
      .toBeCloseTo(lostCssPixels, 8);

    const frame = createMeshCoordinateFrame(translatedBox(base), MILLIMETRES_PER_CSS_PIXEL);
    const local = new Float32Array(6);
    writeLocalFloat32(local, 0, [base, 0, 0], frame);
    writeLocalFloat32(local, 3, [base + detail, 0, 0], frame);
    const pixelError = Math.abs((local[3] - local[0]) - detail) * CSS_PIXELS_PER_MILLIMETRE;
    expect(pixelError).toBeLessThanOrEqual(1);
    expect(localToWorld([local[3], local[4], local[5]], frame)[0])
      .toBeCloseTo(base + detail, 5);
  });

  it('preserves the zero-origin path and signed coordinates', () => {
    const frame = createMeshCoordinateFrame(
      { minimum: [-4, -4, -4], maximum: [4, 4, 4] },
      MILLIMETRES_PER_CSS_PIXEL,
    );
    expect(frame.origin).toEqual([0, 0, 0]);
    const target = new Float32Array(3);
    writeLocalFloat32(target, 0, [-0.03, 0.03, -4], frame);
    expect([...target]).toEqual([Math.fround(-0.03), Math.fround(0.03), -4]);
    expect(worldToLocal([-1, 2, -3], frame)).toEqual([-1, 2, -3]);
  });

  it('keeps each body origin explicit through local and inverse world conversion', () => {
    const right = createMeshCoordinateFrame(translatedBox(1e9), MILLIMETRES_PER_CSS_PIXEL);
    const left = createMeshCoordinateFrame(translatedBox(-1e9), MILLIMETRES_PER_CSS_PIXEL);
    const rightClipPoint: Vec3Tuple = [1e9 + 2, 0, 0];
    const rightLocal = worldToLocal(rightClipPoint, right);
    expect(localToWorld(rightLocal, right)).toEqual(rightClipPoint);
    expect(localToWorld(rightLocal, left)).not.toEqual(rightClipPoint);
    expect(worldToLocal([-1e9 + 2, 0, 0], left)).toEqual(rightLocal);
    const vertexWorldX = 1e9 + 3;
    const vertexLocalX = worldToLocal([vertexWorldX, 0, 0], right)[0];
    expect(vertexLocalX - rightLocal[0]).toBe(vertexWorldX - rightClipPoint[0]);
  });

  it('rejects a box whose extent cannot honor the pixel error budget', () => {
    expect(() => createMeshCoordinateFrame(
      { minimum: [0, 0, 0], maximum: [1e6, 8, 8] },
      MILLIMETRES_PER_CSS_PIXEL,
    )).toThrow(RangeError);
    expect(() => createMeshCoordinateFrame(
      { minimum: [-1e308, 0, 0], maximum: [1e308, 8, 8] },
      MILLIMETRES_PER_CSS_PIXEL,
    )).toThrow(RangeError);
  });

  it('rejects nonfinite or reversed bounds and invalid budgets', () => {
    expect(() => createMeshCoordinateFrame(
      { minimum: [0, 0, 0], maximum: [Number.NaN, 1, 1] }, 1,
    )).toThrow(RangeError);
    expect(() => createMeshCoordinateFrame(
      { minimum: [0, 0, 0], maximum: [Number.POSITIVE_INFINITY, 1, 1] }, 1,
    )).toThrow(RangeError);
    expect(() => createMeshCoordinateFrame(
      { minimum: [2, 0, 0], maximum: [1, 1, 1] }, 1,
    )).toThrow(RangeError);
    expect(() => createMeshCoordinateFrame(translatedBox(0), 0)).toThrow(RangeError);
    expect(() => createMeshCoordinateFrame(translatedBox(0), Number.NaN)).toThrow(RangeError);
  });

  it('validates the target boundary and all coordinates before writing', () => {
    const frame = createMeshCoordinateFrame(translatedBox(1e9), MILLIMETRES_PER_CSS_PIXEL);
    const target = new Float32Array([7, 7, 7, 7]);
    for (const offset of [-1, 1.5, 2, Number.NaN]) {
      expect(() => writeLocalFloat32(target, offset, [1e9, 0, 0], frame)).toThrow(RangeError);
      expect([...target]).toEqual([7, 7, 7, 7]);
    }
    expect(() => writeLocalFloat32(new Float32Array(2), 0, [1e9, 0, 0], frame))
      .toThrow(RangeError);
    expect(() => writeLocalFloat32(target, 0, [1e9, Number.NaN, 0], frame)).toThrow(RangeError);
    expect(() => writeLocalFloat32(target, 0, [1e9, 0, Number.POSITIVE_INFINITY], frame))
      .toThrow(RangeError);
    expect(() => writeLocalFloat32(target, 0, [1e9 + 1e6, 0, 0], frame)).toThrow(RangeError);
    expect([...target]).toEqual([7, 7, 7, 7]);
  });

  it('rejects forged budgets and origins at the writer without partial mutation', () => {
    const target = new Float32Array([7, 8, 9]);
    const origin: Vec3Tuple = [1e9, 0, 0];
    for (const budget of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
      expect(() => writeLocalFloat32(target, 0, [1e9 + 1, 0, 0],
        { origin, maximumFloat32ErrorMm: budget })).toThrow(RangeError);
      expect([...target]).toEqual([7, 8, 9]);
      expect(origin).toEqual([1e9, 0, 0]);
    }
    for (const invalidOrigin of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => writeLocalFloat32(target, 0, [1e9 + 1, 0, 0],
        { origin: [invalidOrigin, 0, 0], maximumFloat32ErrorMm: 1 })).toThrow(RangeError);
      expect([...target]).toEqual([7, 8, 9]);
    }
    const frame = createMeshCoordinateFrame(translatedBox(1e9), 0.01);
    expect(() => writeLocalFloat32(target, 0, [1e9, 0, 1e6], frame)).toThrow(RangeError);
    expect([...target]).toEqual([7, 8, 9]);
  });

  it('converts complete native-double triples before Float32 rounding', () => {
    const frame = createMeshCoordinateFrame(translatedBox(1e9), 0.01);
    const world = [1e9, 0, 0, 1e9 + 1, 0.03, -0.03];
    const local = localFloat32Coordinates(world, frame);
    expect([...local]).toEqual([-4, 0, 0, -3, Math.fround(0.03), Math.fround(-0.03)]);
    expect(world).toEqual([1e9, 0, 0, 1e9 + 1, 0.03, -0.03]);
    expect(() => localFloat32Coordinates([1, 2], frame)).toThrow(RangeError);
  });

  it('keeps a deterministic negative origin and admits only bounded subnormals', () => {
    const negative = createMeshCoordinateFrame(
      { minimum: [-1e9 - 8, -1, -1], maximum: [-1e9, 1, 1] }, 0.01);
    expect(negative.origin).toEqual([-1e9 - 4, 0, 0]);
    const target = new Float32Array(3);
    writeLocalFloat32(target, 0, [-1e9, 0, 0], negative);
    expect([...target]).toEqual([4, 0, 0]);

    const subnormal = 2 ** -149;
    writeLocalFloat32(target, 0, [subnormal, 0, 0],
      { origin: [0, 0, 0], maximumFloat32ErrorMm: 2 ** -150 });
    expect(target[0]).toBe(subnormal);
    expect(() => writeLocalFloat32(target, 0, [subnormal, 0, 0],
      { origin: [0, 0, 0], maximumFloat32ErrorMm: 2 ** -151 })).toThrow(RangeError);
    expect(target[0]).toBe(subnormal);
    expect(() => writeLocalFloat32(target, 0, [3.5e38, 0, 0],
      { origin: [0, 0, 0], maximumFloat32ErrorMm: 1e39 })).toThrow(RangeError);
    expect(target[0]).toBe(subnormal);
  });
});
