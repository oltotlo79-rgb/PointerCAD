import { describe, expect, it } from 'vitest';
import { projectSolidMode, solidModeBoundaryTriangles, type SolidModeResult, type SolidModeSource } from './solidModeView.js';

const source: SolidModeSource = { documentId: 'doc-1', revision: 7, meshKey: 'mesh-a' };

/** One positive-volume tetrahedron; node 0 fully restrained, node 3 restrained in z only. */
function result(): SolidModeResult {
  return {
    source,
    nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]],
    elements: [{ nodes: [0, 1, 2, 3] }],
    fixed: [[true, true, true], [false, false, false], [false, false, false], [false, false, true]],
    modes: [
      // Largest nodal vector length is |(3, 4, 0)| = 5.
      { number: 1, frequencyHz: 120.5, normalizedResidual: 1e-12, massNormalizedShapePerSqrtT: [[0, 0, 0], [3, 4, 0], [0, 0, -2], [1, 0, 0.5]] },
      { number: 2, frequencyHz: 310.25, normalizedResidual: 2e-12, massNormalizedShapePerSqrtT: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 8, 0]] },
    ],
  };
}

function corners(positions: readonly number[]): number[][] {
  const points: number[][] = [];
  for (let index = 0; index < positions.length; index += 3) points.push(positions.slice(index, index + 3));
  return points;
}

function expectPoints(actual: readonly (readonly number[])[], expected: readonly (readonly number[])[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((point, index) => point.forEach((value, axis) => expect(value).toBeCloseTo(expected[index][axis], 12)));
}

describe('projectSolidMode', () => {
  it('scales the largest nodal vector to the display amplitude and keeps restrained components', () => {
    const preview = projectSolidMode(result(), source, { modeNumber: 1, amplitudeMm: 2, phase: 1 });
    expect(preview.kind).toBe('preview');
    if (preview.kind !== 'preview') return;
    // Factor 2 mm / 5 = 0.4 per shape unit, computed by hand.
    expectPoints(preview.nodePositions, [[0, 0, 0], [11.2, 1.6, 0], [0, 10, -0.8], [0.4, 0, 10]]);
    expect(preview.frequencyHz).toBe(120.5);
    expect(preview.amplitudeMm).toBe(2);
    expect(preview.source).toEqual(source);
  });

  it('reverses every free component for the opposite phase and leaves restrained nodes in place', () => {
    const preview = projectSolidMode(result(), source, { modeNumber: 1, amplitudeMm: 2, phase: -1 });
    if (preview.kind !== 'preview') throw new Error('expected a preview');
    expectPoints(preview.nodePositions, [[0, 0, 0], [8.8, -1.6, 0], [0, 10, 0.8], [-0.4, 0, 10]]);
  });

  it('normalises each mode by its own largest vector', () => {
    const preview = projectSolidMode(result(), source, { modeNumber: 2, amplitudeMm: 3, phase: 1 });
    if (preview.kind !== 'preview') throw new Error('expected a preview');
    expectPoints(preview.nodePositions, [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 3, 10]]);
  });

  it('draws the boundary faces of the analysed connectivity in the field-view corner order', () => {
    const preview = projectSolidMode(result(), source, { modeNumber: 1, amplitudeMm: 0, phase: 1 });
    if (preview.kind !== 'preview') throw new Error('expected a preview');
    const n = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]];
    // Faces [a,c,b], [a,b,d], [a,d,c], [b,c,d] of element (0,1,2,3); amplitude 0 is the undeformed mesh.
    expectPoints(corners(preview.positions), [n[0], n[2], n[1], n[0], n[1], n[3], n[0], n[3], n[2], n[1], n[2], n[3]]);
    expect(preview.triangleElements).toEqual([0, 0, 0, 0]);
  });

  it('drops faces shared by two tetrahedra', () => {
    const boundary = solidModeBoundaryTriangles([{ nodes: [0, 1, 2, 3] }, { nodes: [1, 0, 2, 4] }], 5);
    expect(boundary?.triangleElements).toEqual([0, 0, 0, 1, 1, 1]);
  });

  it('does not mutate the result or the display choice', () => {
    const input = result();
    const before = JSON.stringify(input);
    const display = Object.freeze({ modeNumber: 1, amplitudeMm: 5, phase: -1 as const });
    projectSolidMode(input, source, display);
    expect(JSON.stringify(input)).toBe(before);
    expect(display).toEqual({ modeNumber: 1, amplitudeMm: 5, phase: -1 });
  });

  it('refuses a result of another document, revision or mesh', () => {
    for (const current of [{ ...source, documentId: 'doc-2' }, { ...source, revision: 8 }, { ...source, meshKey: 'mesh-b' }]) {
      expect(projectSolidMode(result(), current, { modeNumber: 1, amplitudeMm: 1, phase: 1 })).toEqual({ kind: 'none', reason: 'stale' });
    }
  });

  it('refuses an unknown mode, a bad amplitude, mismatched arrays and a zero shape', () => {
    const display = { modeNumber: 1, amplitudeMm: 1, phase: 1 as const };
    expect(projectSolidMode(result(), source, { ...display, modeNumber: 3 })).toEqual({ kind: 'none', reason: 'mode' });
    for (const amplitudeMm of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(projectSolidMode(result(), source, { ...display, amplitudeMm })).toEqual({ kind: 'none', reason: 'amplitude' });
    }
    const base = result();
    expect(projectSolidMode({ ...base, fixed: base.fixed.slice(1) }, source, display)).toEqual({ kind: 'none', reason: 'mesh' });
    const shortShape = { ...base, modes: [{ ...base.modes[0], massNormalizedShapePerSqrtT: base.modes[0].massNormalizedShapePerSqrtT.slice(1) }] };
    expect(projectSolidMode(shortShape, source, display)).toEqual({ kind: 'none', reason: 'mesh' });
    expect(projectSolidMode({ ...base, elements: [{ nodes: [0, 1, 2, 9] }] }, source, display)).toEqual({ kind: 'none', reason: 'mesh' });
    const zero = { ...base, modes: [{ ...base.modes[0], massNormalizedShapePerSqrtT: base.nodes.map((): [number, number, number] => [0, 0, 0]) }] };
    expect(projectSolidMode(zero, source, display)).toEqual({ kind: 'none', reason: 'shape' });
    const nonfinite = { ...base, modes: [{ ...base.modes[0], massNormalizedShapePerSqrtT: [[0, 0, 0], [Number.NaN, 0, 0], [0, 0, 0], [0, 0, 0]] as [number, number, number][] }] };
    expect(projectSolidMode(nonfinite, source, display)).toEqual({ kind: 'none', reason: 'shape' });
  });
});
