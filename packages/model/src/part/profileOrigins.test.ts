import { describe, expect, it } from 'vitest';
import { absoluteCoordinate } from '../sketch/createSketchDocument.js';
import type { ResolvedFace, SketchDocument, SketchLineFeature } from '../sketch/types.js';
import { independentFourLineProfile, independentProfileOrigin } from './profileOrigins.js';

const points = [[0, 0, 0], [10, 0, 0], [10, 6, 0], [0, 6, 0]] as const;
const lines: readonly SketchLineFeature[] = points.map((point, index) => ({
  id: `line-${index}`, name: `Line ${index}`, kind: 'line' as const, planeId: 'xy',
  from: absoluteCoordinate(point[0], point[1], point[2]),
  to: absoluteCoordinate(points[(index + 1) % 4][0], points[(index + 1) % 4][1],
    points[(index + 1) % 4][2]), construction: false,
}));
const document: SketchDocument = { id: 'sketch', name: 'Sketch', features: [
  ...lines,
  { id: 'face', name: 'Face', kind: 'face', planeId: 'xy', color: '#ffffff',
    boundary: lines.map((line) => ({ featureId: line.id })) },
] };
const face: ResolvedFace = { featureId: 'face', color: '#ffffff', curves: points.map((point, index) => ({
  kind: 'segment' as const, featureId: `line-${index}`, from: point,
  to: points[(index + 1) % 4],
})) };

describe('independentFourLineProfile', () => {
  it('preserves saved line IDs paired with resolved edge order', () => {
    expect(independentFourLineProfile(document, face)).toEqual({
      sketchId: 'sketch', faceFeatureId: 'face',
      lineFeatureIds: ['line-0', 'line-1', 'line-2', 'line-3'],
    });
  });

  it('rejects indexed, grouped, repeated, or construction sources and a mismatched resolved curve', () => {
    const savedFace = document.features[4];
    if (savedFace?.kind !== 'face') throw new Error('fixture');
    const replaceFace = (boundary: typeof savedFace.boundary): SketchDocument => ({
      ...document, features: [...lines, { ...savedFace, boundary }],
    });
    expect(independentFourLineProfile(replaceFace([
      { featureId: 'line-0', index: 0 }, ...savedFace.boundary.slice(1),
    ]), face)).toBeNull();
    expect(independentFourLineProfile(replaceFace([
      { featureId: 'face' }, ...savedFace.boundary.slice(1),
    ]), face)).toBeNull();
    expect(independentFourLineProfile(replaceFace([
      savedFace.boundary[0], savedFace.boundary[0], ...savedFace.boundary.slice(2),
    ]), face)).toBeNull();
    expect(independentFourLineProfile({ ...document, features: [
      { ...lines[0], construction: true }, ...document.features.slice(1),
    ] }, face)).toBeNull();
    expect(independentFourLineProfile(document, { ...face, curves: [
      { ...face.curves[0], featureId: 'other' }, ...face.curves.slice(1),
    ] })).toBeNull();
  });
});


describe('saved whole-curve profile origin', () => {
  const spline = { id: 'curve', name: 'Curve', kind: 'spline', planeId: 'xy', mode: 'control',
    construction: false, closed: false,
    points: [absoluteCoordinate(0, 0, 0), absoluteCoordinate(0.5, 0, 0), absoluteCoordinate(1, 1, 0)] } as const;
  const a = { ...lines[0], id: 'a', from: absoluteCoordinate(1, 1, 0), to: absoluteCoordinate(1, 0, 0) };
  const b = { ...lines[1], id: 'b', from: absoluteCoordinate(1, 0, 0), to: absoluteCoordinate(0, 0, 0) };
  const savedFace = { id: 'region', name: 'Region', kind: 'face', planeId: 'xy', color: '#ffffff',
    boundary: [{ featureId: 'curve' }, { featureId: 'a' }, { featureId: 'b' }] } as const;
  const saved: SketchDocument = { id: 'saved-sketch', name: 'Sketch', features: [spline, a, b, savedFace] };
  const resolved: ResolvedFace = { featureId: 'region', color: '#ffffff', curves: [
    { kind: 'spline', featureId: 'curve', mode: 'control', closed: false, points: [[0, 0, 0], [0.5, 0, 0], [1, 1, 0]] },
    { kind: 'segment', featureId: 'a', from: [1, 1, 0], to: [1, 0, 0] },
    { kind: 'segment', featureId: 'b', from: [1, 0, 0], to: [0, 0, 0] },
  ] };
  it('retains old four-line identity and admits genuinely saved whole spline/line identities', () => {
    expect(independentProfileOrigin(document, face)).toEqual(independentFourLineProfile(document, face));
    expect(independentFourLineProfile(saved, resolved)).toBeNull();
    expect(independentProfileOrigin(saved, resolved)).toEqual({ sketchId: 'saved-sketch',
      faceFeatureId: 'region', curveFeatureIds: ['curve', 'a', 'b'] });
  });
  it('refuses ambiguous, indexed, constructed, derived or multiply split sources', () => {
    const variants: SketchDocument[] = [
      { ...saved, features: [spline, a, b, { ...savedFace, boundary: [{ featureId: 'curve', index: 0 }, ...savedFace.boundary.slice(1)] }] },
      { ...saved, features: [{ ...spline, construction: true }, a, b, savedFace] },
      { ...saved, features: [{ ...spline, closed: true }, a, b, savedFace] },
      { ...saved, features: [spline, spline, a, b, savedFace] },
      { ...saved, features: [a, b, savedFace] },
      { ...saved, features: [spline, a, b, savedFace, savedFace] },
    ];
    for (const variant of variants) expect(independentProfileOrigin(variant, resolved)).toBeNull();
    const curve = resolved.curves[0];
    if (curve?.kind !== 'spline') throw new Error('Spline fixture');
    for (const altered of [{ ...curve, featureId: 'foreign' }, { ...curve, degree: 1 as const },
      { ...curve, degree: 3 as const, knots: [0, 1] }]) {
      expect(independentProfileOrigin(saved, { ...resolved, curves: [altered, ...resolved.curves.slice(1)] })).toBeNull();
    }
    expect(independentProfileOrigin(saved, { ...resolved, curves: [curve, curve, ...resolved.curves.slice(1)] })).toBeNull();
  });
});
