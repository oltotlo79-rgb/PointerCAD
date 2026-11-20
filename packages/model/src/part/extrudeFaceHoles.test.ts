import { describe, expect, it } from 'vitest';
import { expressionValueFromNumber as num } from '@pointercad/expression';
import { absoluteCoordinate } from '../sketch/createSketchDocument.js';
import type { SketchFeature } from '../sketch/types.js';
import { toFaceRequest } from '../kernelBridge/curveConversions.js';
import { toSolidStepRequest } from '../kernelBridge/solidRequests.js';
import { createEmptyPartDocument } from './createPartDocument.js';
import { independentProfileOrigin } from './profileOrigins.js';
import { sketchProfileFeatureIds } from './solidSketchReferences.js';
import { resolvePart } from './resolvePart.js';
import type { ExtrudeFeature, SolidFeature, SweepFeature } from './types.js';

const profile = { sketchId: 'sketch-1', faceFeatureId: 'face' };
const extrude: ExtrudeFeature = { id: 'extrude', name: 'extrude', kind: 'extrude', suppressed: false,
  profile, distance: num(8), reversed: false, symmetric: false };
function documentWith(radius: number | null, solid: SolidFeature = extrude) {
  const part = createEmptyPartDocument();
  const outer: SketchFeature = { id: 'outer', name: 'outer', kind: 'rectangle', planeId: 'xy',
    corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(60, 40, 0), construction: false };
  const inner: SketchFeature = { id: 'inner', name: 'inner', kind: 'arc', planeId: 'xy',
    center: absoluteCoordinate(30, 20, 0), radius: num(radius ?? 5), startAngle: num(0), endAngle: num(360), construction: false };
  const face = { id: 'face', name: 'face', kind: 'face' as const, planeId: 'xy', boundary: [{ featureId: 'outer' }],
    color: '#eeeeee', ...(radius === null ? {} : { holes: [[{ featureId: 'inner' }]] }) };
  return { ...part, sketches: [{ ...part.sketches[0], features: [outer, inner, face] }], solids: [solid] };
}

describe('穴つきの面の押し出し計画', () => {
  it.each([false, true])('両側%jで外周と穴を同じだけ動かし、依頼にも穴を渡す', symmetric => {
    const document = documentWith(5, { ...extrude, symmetric });
    const result = resolvePart(document), step = result.steps[0];
    expect(result.errors).toEqual([]);
    if (step?.plan.kind !== 'extrude') throw new Error('押し出しの計画がありません');
    expect(step.plan).toMatchObject({ holes: [[{ kind: 'arc', radius: 5, center: [30, 20, symmetric ? -4 : 0] }]] });
    expect(step.plan.profile[0]).toMatchObject({ from: [0, 0, symmetric ? -4 : 0] });
    expect(step.plan.direction).toEqual([0, 0, 1]);
    expect(toSolidStepRequest(step).step).toMatchObject({ holes: [[{ kind: 'arc', radius: 5 }]] });
    const face = result.sketches[0].resolved.faces[0];
    expect(toFaceRequest(face)).toMatchObject({ holes: [[{ kind: 'arc', radius: 5 }]] });
    expect(independentProfileOrigin(document.sketches[0], face)).toBeNull();
    expect(sketchProfileFeatureIds(document.sketches[0], 'face')).toEqual(new Set(['face', 'outer', 'inner']));
  });

  it('穴だけの変更で鍵が変わり、穴なしの依頼には欄を足さない', () => {
    const first = resolvePart(documentWith(5)).steps[0], second = resolvePart(documentWith(6)).steps[0];
    expect(first.key).not.toBe(second.key);
    const plain = resolvePart(documentWith(null)), step = plain.steps[0];
    // 穴の対応前の先行RUNで記録した鍵。穴なしの材料の字面も維持する。
    expect(step.key).toBe('38a7927f15f72f4a');
    expect(toSolidStepRequest(step).step).not.toHaveProperty('holes');
    expect(toFaceRequest(plain.sketches[0].resolved.faces[0])).not.toHaveProperty('holes');
  });

  it('エンボスは穴つきの面を理由つきで断る', () => {
    const document = documentWith(5);
    const emboss: SolidFeature = { id: 'emboss', name: 'emboss', kind: 'emboss', suppressed: false,
      targetFeatureId: extrude.id, profile, height: num(1), raised: false,
      face: { bodyFeatureId: extrude.id, index: 0, fingerprint: { kind: 'face', surfaceKind: 'plane',
        area: 2400, position: [30, 20, 8], axis: [0, 0, 1], radius: null } } };
    const result = resolvePart({ ...document, solids: [extrude, emboss] });
    expect(result.steps).toHaveLength(1);
    expect(result.errors.find(error => error.featureId === 'emboss')?.message).toContain('穴つき');
  });

  const unsupported: readonly SolidFeature[] = [
    { ...extrude, thickness: num(1) },
    { id: 'revolve', name: 'revolve', kind: 'revolve', suppressed: false, profile,
      axis: { kind: 'world', axis: 'x' }, angle: num(360), reversed: false },
    { id: 'sew', name: 'sew', kind: 'sew', suppressed: false, faces: [profile, profile], tolerance: num(0.01) },
    { id: 'loft', name: 'loft', kind: 'loft', suppressed: false, smooth: true, twist: num(0),
      sections: [{ kind: 'sketchFace', ref: profile }, { kind: 'sketchFace', ref: profile }] },
  ];
  it('スイープは穴つきの面の穴の線を plan と段へ載せ、肉厚と一緒なら理由つきで断る(M-07)', () => {
    const sweep: SweepFeature = { id: 'sweep', name: 'sweep', kind: 'sweep', suppressed: false, profile, frenet: false,
      path: { sketchId: 'sketch-1', curveIds: ['outer'] } };
    const result = resolvePart(documentWith(5, sweep)), step = result.steps[0];
    expect(result.errors).toEqual([]);
    if (step?.plan.kind !== 'sweep') throw new Error('スイープの計画がありません');
    expect(step.plan).toMatchObject({ holes: [[{ kind: 'arc', radius: 5, center: [30, 20, 0] }]] });
    expect(toSolidStepRequest(step).step).toMatchObject({ kind: 'sweep', holes: [[{ kind: 'arc', radius: 5 }]] });
    const plain = resolvePart(documentWith(null, sweep)).steps[0];
    if (plain === undefined) throw new Error('スイープの段がありません');
    expect(toSolidStepRequest(plain).step).not.toHaveProperty('holes');
    const walled = resolvePart(documentWith(5, { ...sweep, wallThickness: num(1) }));
    expect(walled.steps).toEqual([]);
    expect(walled.errors.find(error => error.featureId === 'sweep')?.message).toBe('穴つきの面を断面にする時は、肉厚を使えません。');
  });

  it.each(unsupported)('$kindは穴つきの面を理由つきで断る', feature => {
    const result = resolvePart(documentWith(5, feature));
    expect(result.steps).toEqual([]);
    expect(result.errors.find(error => error.featureId === feature.id)?.message).toContain('穴つき');
  });
});
