import { describe, expect, it } from 'vitest';
import type { SolidBody, SolidFaceEntry } from '../../kernelBridge.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { applyPlacementToDirection, applyPlacementToPoint } from '../placementMath.js';
import { rigidPlacementOf } from '../fastening/frames.js';
import { applyFilletWeld } from './applyFilletWeld.js';
import { cylindricalWeldContact, cylindricalWeldSection, selectedWeldCylinder } from './cylindricalWeld.js';
import { buildFilletWeldPart, createFilletWeldSource } from './filletWeldPart.js';
import { lineEdge, plainTee, teeBodies, teeJoint, teeRequest, WELD_TEST_REVISIONS, weldTestBody, weldTestPlacement } from './filletWeld.testSupport.js';
import { planFilletWeld, planFilletWeldEdit } from './planFilletWeld.js';
import type { FilletWeldRequest, WeldFrame } from './types.js';

describe('exterior cylindrical weld section', () => {
  it.each([[10, 2, 3], [2, 1.4, 1], [1e9, 1, 2]])(
    'agrees with independent Cartesian area integration R=%s arc=%s radial=%s', (radius, arc, height) => {
      const section = cylindricalWeldSection(radius, arc, height);
      expect(section).not.toBeNull();
      if (section === null) throw new Error('Valid section refused');
      const theta = arc / radius, xEnd = radius * Math.sin(theta);
      const yEnd = -xEnd * xEnd / (radius + Math.sqrt(radius * radius - xEnd * xEnd));
      const slices = 4000, dx = xEnd / slices;
      let integral = 0;
      for (let index = 0; index <= slices; index += 1) {
        const x = index * dx;
        const lower = -x * x / (radius + Math.sqrt(radius * radius - x * x));
        const upper = height + (yEnd - height) * x / xEnd;
        expect(upper - lower).toBeGreaterThanOrEqual(-1e-12);
        integral += (upper - lower) * (index === 0 || index === slices ? 1 : index % 2 === 0 ? 2 : 4);
      }
      integral *= dx / 3;
      expect(Math.abs(section.area - integral) / integral).toBeLessThan(1e-10);
      expect(Math.hypot(section.toe[0], radius + section.toe[1])).toBeCloseTo(radius, 8);
    },
  );

  it('refuses a free side crossing material although both prescribed contact toes lie on their faces', () => {
    const radius = 10, angle = 0.6, height = 1;
    const toe = [radius * Math.sin(angle), radius * Math.cos(angle) - radius];
    const x = toe[0] * 0.99, y = height + (toe[1] - height) * 0.99;
    expect(x * x + (radius + y) ** 2).toBeLessThan(radius ** 2);
    expect(cylindricalWeldSection(radius, radius * angle, height)).toBeNull();
    expect(cylindricalWeldSection(radius, radius * angle, 3)).not.toBeNull();
  });

  it.each([
    [0, 2, 3], [-1, 2, 3], [10, 0, 3], [10, 2, 0], [10, 5 * Math.PI, 30],
    [10, 20, 30], [Infinity, 2, 3], [10, NaN, 3], [10, 2, Infinity], [1e200, 1e199, 1e200],
  ])('refuses invalid or non-finite section %s/%s/%s', (r, arc, h) => {
    expect(cylindricalWeldSection(r, arc, h)).toBeNull();
  });
});

// No display triangles: cylindrical coverage must come from the current analytic trim contract.
const CYLINDER: SolidFaceEntry = {
  index: 0, surfaceKind: 'cylinder', radius: 10, axis: [1, 0, 0], axisOrigin: [0, 34, 0],
  cylinderSpan: [0, 100], cylinderExterior: true, centroid: [50, 34, 0], area: 2000 * Math.PI,
  triangleOffset: 0, triangleCount: 0,
};
const FRAME: WeldFrame = { origin: [0, 34, 10], xAxis: [0, 1, 0], yAxis: [0, 0, 1], zAxis: [1, 0, 0] };
function cylinderBody(face: SolidFaceEntry = CYLINDER): SolidBody {
  return { ...weldTestBody([], []), bodyKind: 'solid', faces: [face], volume: 10000 * Math.PI };
}
function cylinderRequest(): FilletWeldRequest {
  return teeRequest({ legOnSecond: 2, legOnFirst: 3, second: {
    componentId: 'component-2', sourceKey: 'part:base@rev-b', centroid: CYLINDER.centroid, normal: null,
    face: { bodyFeatureId: 'extrude-1', index: 0, fingerprint: {
      kind: 'face', surfaceKind: 'cylinder', area: CYLINDER.area, radius: 10, axis: [1, 0, 0], position: CYLINDER.centroid,
    } },
  } });
}

describe('current native cylinder band and saved curved weld', () => {
  it('plans an exact arc section, saves revision 3 and rechecks the band when editing', () => {
    const document = plainTee(), request = cylinderRequest(), bodies = teeBodies({ base: [cylinderBody()] });
    const result = planFilletWeld(document, request, WELD_TEST_REVISIONS, bodies);
    if (!result.ok) throw new Error(JSON.stringify(result.rejections));
    expect(result.plan.frame).toEqual(FRAME);
    expect(result.plan.cylindricalRadius).toBe(10);
    // Independent circular-sector subtraction, not the product section helper.
    const area = (30 * Math.sin(0.2) - 100 * (0.2 - Math.sin(0.2))) / 2;
    expect(result.plan.nominalVolume).toBeCloseTo(area * 60, 9);
    expect(result.plan.contact.filter(entry => entry.side === 'second').map(entry => entry.coveredRatio)).toEqual([1, 1, 1]);
    const applied = applyFilletWeld(document, result.plan, WELD_TEST_REVISIONS);
    if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
    for (const id of applied.componentIds) {
      const source = applied.document.components.find(component => component.id === id)?.source;
      if (source?.kind !== 'standardPart') throw new Error('Missing saved weld');
      expect(source.generatorRevision).toBe('fillet-weld-3');
      expect(source.options.weldCylinderRadius).toBe('10');
      expect(source.options.weldAngle).toBeUndefined();
      const part = buildFilletWeldPart(source);
      expect(part).not.toBeNull();
      const features = part?.sketches.flatMap(sketch => sketch.features) ?? [];
      expect(features.filter(feature => feature.kind === 'arc')).toHaveLength(1);
      expect(features.filter(feature => feature.kind === 'line')).toHaveLength(2);
    }
    const edit = { weldId: result.plan.weldId, legOnSecond: 2.5, legOnFirst: 4, segments: request.segments, materialId: 'steel' };
    const edited = planFilletWeldEdit(applied.document, edit, WELD_TEST_REVISIONS, bodies);
    expect(edited.ok ? edited.plan.cylindricalRadius : edited.rejections).toBe(10);
    const damaged = { ...applied.document, components: applied.document.components.map(component =>
      component.source.kind !== 'standardPart' ? component : { ...component,
        source: { ...component.source, generatorRevision: 'fillet-weld-1' } }) };
    const refusedVersion = planFilletWeldEdit(damaged, edit, WELD_TEST_REVISIONS, bodies);
    expect(refusedVersion.ok ? [] : refusedVersion.rejections.map(rejection => rejection.code)).toEqual(['weldDamaged']);
    const missing = planFilletWeldEdit(applied.document, edit, WELD_TEST_REVISIONS,
      teeBodies({ base: [cylinderBody({ ...CYLINDER, cylinderSpan: null })] }));
    expect(missing.ok ? [] : missing.rejections.map(rejection => rejection.code))
      .toEqual(['contactNotCovered', 'contactNotCovered', 'contactNotCovered']);
    expect(applyFilletWeld(document, result.plan, new Map([['standing', 'rev-s'], ['base', 'changed']])).ok).toBe(false);
  });

  it('uses axis origin and one rigid placement; refuses changed identity, missing trim, inward or duplicate bands', () => {
    const placement = rigidPlacementOf(weldTestPlacement([7, -2, 5], [0, 0, Math.SQRT1_2, Math.SQRT1_2]));
    const reference = cylinderRequest().second.face;
    const actual = selectedWeldCylinder([cylinderBody()], reference, placement, [-27, 48, 15]);
    expect(actual).not.toBeNull();
    if (actual === null) throw new Error('Expected selected cylinder');
    for (const [index, expected] of [0, 0, 1].entries()) {
      expect(actual.normal[index]).toBeCloseTo(expected, 12);
    }
    expect(actual?.radius).toBe(10);
    expect(selectedWeldCylinder([cylinderBody()], { ...reference, bodyFeatureId: 'missing' }, placement, [-27, 48, 15])).toBeNull();
    const identity = rigidPlacementOf(weldTestPlacement([0, 0, 0]));
    for (const change of [
      { cylinderSpan: null }, { cylinderExterior: false }, { axisOrigin: [0, 0, 0] as const },
      { radius: 9 }, { cylinderSpan: [0, 15] as const },
    ]) expect(cylindricalWeldContact([cylinderBody({ ...CYLINDER, ...change })], identity, FRAME, 10, 2, 3, { start: 10, length: 20 })).toBe(false);
    expect(cylindricalWeldContact([cylinderBody(), cylinderBody()], identity, FRAME, 10, 2, 3, { start: 10, length: 20 })).toBe(false);
    expect(cylindricalWeldContact([cylinderBody()], identity, FRAME, NaN, 2, 3, { start: 10, length: 20 })).toBe(false);
    // Oriented cylinder V is reversed together with its axis; the physical band stays identical.
    expect(cylindricalWeldContact([cylinderBody({ ...CYLINDER, axis: [-1, 0, 0], cylinderSpan: [-100, 0] })], identity,
      FRAME, 10, 2, 3, { start: 10, length: 20 })).toBe(true);
  });

  it('pairs radius and generator version strictly and rejects free-side material penetration on reopen', () => {
    const source = createFilletWeldSource(2, 3, { weldId: 'weld-1', segment: 0, station: 0, length: 10,
      contactLength: 100, parts: ['a', 'b'], cylindricalRadius: 10 });
    expect(buildFilletWeldPart(source)).not.toBeNull();
    for (const generatorRevision of ['fillet-weld-1', 'fillet-weld-2', 'fillet-weld-4']) {
      expect(buildFilletWeldPart({ ...source, generatorRevision })).toBeNull();
    }
    const { weldCylinderRadius: removedRadius, ...withoutRadius } = source.options;
    expect(removedRadius).toBe('10');
    expect(buildFilletWeldPart({ ...source, options: withoutRadius })).toBeNull();
    for (const value of ['0', '-1', 'NaN', 'Infinity', '']) {
      expect(buildFilletWeldPart({ ...source, options: { ...source.options, weldCylinderRadius: value } })).toBeNull();
    }
    expect(buildFilletWeldPart({ ...source, options: { ...source.options, weldAngle: '60' } })).toBeNull();
    expect(buildFilletWeldPart({ ...source, size: '6x1' })).toBeNull();
  });
});


describe('interior cylindrical weld section and revision 4', () => {
  it.each([[10, 2, 3], [2, 1.4, 3], [1e9, 1, 2]])(
    'integrates the actual lower circular wall independently R=%s arc=%s height=%s', (radius, arc, height) => {
      const section = cylindricalWeldSection(radius, arc, height, 'interior');
      if (section === null) throw new Error('Inner section refused');
      const xEnd = radius * Math.sin(arc / radius);
      const yEnd = xEnd * xEnd / (radius + Math.sqrt(radius * radius - xEnd * xEnd));
      const slices = 4000, dx = xEnd / slices;
      let integral = 0;
      for (let index = 0; index <= slices; index += 1) {
        const x = index * dx;
        const lower = x * x / (radius + Math.sqrt(radius * radius - x * x));
        const upper = height + (yEnd - height) * x / xEnd;
        expect(upper - lower).toBeGreaterThanOrEqual(-1e-12);
        expect(x * x + (upper - radius) ** 2).toBeLessThanOrEqual(radius ** 2 * (1 + 1e-14));
        integral += (upper - lower) * (index === 0 || index === slices ? 1 : index % 2 === 0 ? 2 : 4);
      }
      integral *= dx / 3;
      expect(Math.abs(section.area - integral) / integral).toBeLessThan(1e-10);
      expect(section.toe[1]).toBeGreaterThan(0);
    },
  );

  it('refuses the opposite wall including the existing length tolerance clearance', () => {
    for (const height of [20, 21, 20 - 0.5e-6, Infinity, NaN]) {
      expect(cylindricalWeldSection(10, 2, height, 'interior')).toBeNull();
    }
    expect(cylindricalWeldSection(10, 2, 20 - 2e-6, 'interior')).not.toBeNull();
    expect(cylindricalWeldSection(10, 6, 1, 'interior')).not.toBeNull();
    expect(cylindricalWeldSection(10, 6, 1)).toBeNull();
  });

  const innerFace: SolidFaceEntry = { ...CYLINDER, cylinderExterior: false,
    axisOrigin: [0, 34, 20], centroid: [50, 34, 20] };
  const innerRequest = (): FilletWeldRequest => {
    const request = cylinderRequest();
    return { ...request, segments: [{ start: 5, length: 25 }], second: { ...request.second,
      centroid: innerFace.centroid, face: { ...request.second.face, fingerprint: {
        kind: 'face', surfaceKind: 'cylinder', area: innerFace.area, radius: 10, axis: innerFace.axis, position: innerFace.centroid,
      } } } };
  };

  it('carries the actual inward material normal through plan/apply/reopen/edit and refuses changed side', () => {
    const document = plainTee(), request = innerRequest(), bodies = teeBodies({ base: [cylinderBody(innerFace)] });
    const result = planFilletWeld(document, request, WELD_TEST_REVISIONS, bodies);
    if (!result.ok) throw new Error(JSON.stringify(result.rejections));
    for (const key of ['origin', 'xAxis', 'yAxis', 'zAxis'] as const) {
      for (const [index, expected] of FRAME[key].entries()) {
        expect(result.plan.frame[key][index]).toBeCloseTo(expected, 12);
      }
    }
    expect(result.plan.cylindricalSide).toBe('interior');
    const area = (30 * Math.sin(0.2) + 100 * (0.2 - Math.sin(0.2))) / 2;
    expect(result.plan.nominalVolume).toBeCloseTo(area * 25, 9);
    const applied = applyFilletWeld(document, result.plan, WELD_TEST_REVISIONS);
    if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
    const component = applied.document.components.find(item => item.id === applied.componentIds[0]);
    if (component?.source.kind !== 'standardPart') throw new Error('Missing inner source');
    expect(component.source.generatorRevision).toBe('fillet-weld-4');
    expect(component.source.options.weldCylinderSide).toBe('interior');
    expect(component.source.options.weldCylinderRadius).toBe('10');
    expect(buildFilletWeldPart(component.source)).not.toBeNull();
    const edit = { weldId: result.plan.weldId, legOnSecond: 2.5, legOnFirst: 4, segments: request.segments, materialId: 'steel' };
    expect(planFilletWeldEdit(applied.document, edit, WELD_TEST_REVISIONS, bodies).ok).toBe(true);
    for (const face of [{ ...innerFace, cylinderExterior: true }, { ...innerFace, cylinderSpan: null }]) {
      const refused = planFilletWeldEdit(applied.document, edit, WELD_TEST_REVISIONS, teeBodies({ base: [cylinderBody(face)] }));
      expect(refused.ok ? [] : refused.rejections.map(item => item.code)).toEqual(['contactNotCovered']);
    }
    for (const generatorRevision of ['fillet-weld-1', 'fillet-weld-2', 'fillet-weld-3']) {
      expect(buildFilletWeldPart({ ...component.source, generatorRevision })).toBeNull();
    }
    const { weldCylinderSide: side, ...noSide } = component.source.options;
    expect(side).toBe('interior');
    expect(buildFilletWeldPart({ ...component.source, options: noSide })).toBeNull();
    for (const options of [{ ...component.source.options, weldCylinderSide: 'exterior' },
      { ...component.source.options, weldCylinderSide: 'unknown' },
      { ...component.source.options, weldCylinderRadius: '' }, { ...component.source.options, weldAngle: '60' }]) {
      expect(buildFilletWeldPart({ ...component.source, options })).toBeNull();
    }
  });

  it('distinguishes an unknown orientation from a known cavity and requires positive signed native volume', () => {
    const placement = rigidPlacementOf(weldTestPlacement([0, 0, 0])), ref = innerRequest().second.face;
    expect(selectedWeldCylinder([cylinderBody(innerFace)], ref, placement, FRAME.origin)?.side).toBe('interior');
    const { cylinderExterior: removed, ...unknown } = innerFace;
    expect(removed).toBe(false);
    expect(selectedWeldCylinder([cylinderBody(unknown)], ref, placement, FRAME.origin)).toBeNull();
    for (const volume of [-1, 0, NaN, Infinity]) {
      const body = { ...cylinderBody(innerFace), volume };
      expect(selectedWeldCylinder([body], ref, placement, FRAME.origin)).toBeNull();
      expect(cylindricalWeldContact([body], placement, FRAME, 10, 2, 3, { start: 5, length: 25 }, 'interior')).toBe(false);
    }
  });

  it('classifies invalid inner dimensions before coverage in both create and saved edit', () => {
    const document = plainTee(), request = innerRequest(), bodies = teeBodies({ base: [cylinderBody(innerFace)] });
    const good = planFilletWeld(document, request, WELD_TEST_REVISIONS, bodies);
    if (!good.ok) throw new Error(JSON.stringify(good.rejections));
    const saved = applyFilletWeld(document, good.plan, WELD_TEST_REVISIONS);
    if (!saved.ok) throw new Error(JSON.stringify(saved.rejections));
    for (const [height, code] of [[20, 'degenerateCrossSection'], [0, 'invalidDimension']] as const) {
      const created = planFilletWeld(document, { ...request, legOnFirst: height }, WELD_TEST_REVISIONS, bodies);
      const edited = planFilletWeldEdit(saved.document, { weldId: good.plan.weldId, legOnSecond: 2,
        legOnFirst: height, segments: request.segments, materialId: 'steel' }, WELD_TEST_REVISIONS, bodies);
      expect(created.ok ? [] : created.rejections.map(item => item.code)).toEqual([code]);
      expect(edited.ok ? [] : edited.rejections.map(item => item.code)).toEqual([code]);
    }
  });

  it('reserves actual opposite-wall clearance in new plans and saved edits, including placement and reversed axes', () => {
    const shift = 0.9e-6, badHeight = 20 - 1.1e-6, goodHeight = 20 - 3e-6;
    // Actual root z=10+shift, actual opposite wall z=30: no helper supplies this oracle.
    expect(30 - (10 + shift + badHeight)).toBeLessThan(1e-6);
    expect(30 - (10 + shift + goodHeight)).toBeGreaterThan(1e-6);
    const rotation = [0, 0, Math.SQRT1_2, Math.SQRT1_2] as const;
    for (const document of [teeJoint(weldTestPlacement([0, 26, 10 + shift]), weldTestPlacement([0, 0, 0])),
      teeJoint(weldTestPlacement([-19, -2, 15 + shift], rotation), weldTestPlacement([7, -2, 5], rotation))]) {
      for (const reverse of [false, true]) {
        const face: SolidFaceEntry = reverse ? { ...innerFace, axis: [-1, 0, 0], cylinderSpan: [-100, 0] } : innerFace;
        const original = innerRequest();
        const request = { ...original, second: { ...original.second, face: { ...original.second.face,
          fingerprint: { ...original.second.face.fingerprint, axis: face.axis } } } };
        const bodies = teeBodies({ base: [cylinderBody(face)] });
        const bad = planFilletWeld(document, { ...request, legOnFirst: badHeight }, WELD_TEST_REVISIONS, bodies);
        expect(bad.ok ? [] : bad.rejections.map(item => item.code)).toEqual(['contactNotCovered']);
        const good = planFilletWeld(document, { ...request, legOnFirst: goodHeight }, WELD_TEST_REVISIONS, bodies);
        if (!good.ok) throw new Error(JSON.stringify(good.rejections));
        const saved = applyFilletWeld(document, good.plan, WELD_TEST_REVISIONS);
        if (!saved.ok) throw new Error(JSON.stringify(saved.rejections));
        for (const height of [badHeight, goodHeight]) {
          const edit = planFilletWeldEdit(saved.document, { weldId: good.plan.weldId, legOnSecond: 2,
            legOnFirst: height, segments: request.segments, materialId: 'steel' }, WELD_TEST_REVISIONS, bodies);
          expect(edit.ok).toBe(height === goodHeight);
          if (!edit.ok) expect(edit.rejections.map(item => item.code)).toEqual(['contactNotCovered']);
        }
      }
    }
  });
});

describe('selected finite cylinder and full contact arc', () => {
  it.each([true, false])('sums saved-radius and root errors instead of accepting separate budgets; exterior=%s', exterior => {
    const sign = exterior ? 1 : -1, delta = 0.9e-6;
    const face: SolidFaceEntry = { ...CYLINDER, axisOrigin: [0, 0, 0], axis: [0, 0, 1],
      cylinderSpan: [-41, 41], cylinderExterior: exterior };
    const placement = rigidPlacementOf(weldTestPlacement([0, 0, 0]));
    for (const [offset, radiusDelta, expected] of [[delta, 0, true], [0, delta, true], [delta, delta, false]] as const) {
      const frame: WeldFrame = { origin: [0, sign * (10 + offset), 0], xAxis: [sign, 0, 0],
        yAxis: [0, 1, 0], zAxis: [0, 0, sign] };
      expect(offset).toBeLessThan(1e-6);
      expect(radiusDelta).toBeLessThan(1e-6);
      const theta = 2 / (10 + radiusDelta);
      expect(offset + radiusDelta * (Math.sin(theta) + 1 - Math.cos(theta)) <= 1e-6).toBe(expected);
      expect(cylindricalWeldContact([cylinderBody(face)], placement, frame, 10 + radiusDelta, 2, 3,
        { start: 0, length: 40 }, exterior ? 'exterior' : 'interior')).toBe(expected);
    }
  });

  it.each([true, false])('uses a true unit native axis at large axial coordinates; exterior=%s', exterior => {
    const sign = exterior ? 1 : -1, position = 1e8;
    const placement = rigidPlacementOf(weldTestPlacement([0, 0, 0]));
    const frame: WeldFrame = { origin: [0, sign * 10, position], xAxis: [sign, 0, 0],
      yAxis: [0, 1, 0], zAxis: [0, 0, sign] };
    for (const reverse of [false, true]) {
      const direction = reverse ? -1 : 1;
      for (const perturbation of [5e-10, 2e-9]) {
        const face: SolidFaceEntry = { ...CYLINDER, axisOrigin: [0, 0, 0], axis: [0, 0, direction * (1 + perturbation)],
          cylinderSpan: reverse ? [-position - 100, -position + 100] : [position - 100, position + 100], cylinderExterior: exterior };
        expect(cylindricalWeldContact([cylinderBody(face)], placement, frame, 10, 2, 3,
          { start: 0, length: 40 }, exterior ? 'exterior' : 'interior')).toBe(perturbation === 5e-10);
      }
    }
  });

  it.each([true, false])('does not replace the selected band by a disjoint coaxial band; exterior=%s', exterior => {
    const origin: Vec3 = exterior ? [0, 34, 0] : [0, 34, 20];
    const a: SolidFaceEntry = { ...CYLINDER, index: 0, axisOrigin: origin, cylinderExterior: exterior,
      centroid: [50, 34, origin[2]], cylinderSpan: [40, 60], area: 400 * Math.PI };
    const b: SolidFaceEntry = { ...a, index: 1, centroid: [85, 34, origin[2]], cylinderSpan: [70, 100], area: 600 * Math.PI };
    const body = { ...cylinderBody(a), faces: [a, b] };
    const requestFor = (face: SolidFaceEntry, start: number, length: number): FilletWeldRequest => {
      const request = cylinderRequest();
      return { ...request, segments: [{ start, length }], second: { ...request.second, centroid: face.centroid,
        face: { bodyFeatureId: body.featureId, index: face.index, fingerprint: {
          kind: 'face', surfaceKind: 'cylinder', area: face.area, radius: face.radius,
          axis: face.axis, position: face.centroid,
        } } } };
    };
    const bodies = teeBodies({ base: [body] });
    const rotation = [0, 0, Math.SQRT1_2, Math.SQRT1_2] as const;
    for (const document of [plainTee(), teeJoint(weldTestPlacement([-19, -2, 15], rotation), weldTestPlacement([7, -2, 5], rotation))]) {
      // The edge midpoint x=50 belongs to A. Only the requested segment differs.
      const wrong = planFilletWeld(document, requestFor(a, 75, 10), WELD_TEST_REVISIONS, bodies);
      expect(wrong.ok ? [] : wrong.rejections.map(item => item.code)).toEqual(['contactNotCovered']);
      const outsideMidpoint = { ...requestFor(a, 0, 10), edge: lineEdge([85, 8, 0], [1, 0, 0], 20) };
      expect(planFilletWeld(document, outsideMidpoint, WELD_TEST_REVISIONS, bodies).ok).toBe(false);
      expect(planFilletWeld(document, requestFor(a, 45, 10), WELD_TEST_REVISIONS, bodies).ok).toBe(true);
      // B is valid although the edge midpoint lies outside B: all actual bead points are inside B.
      expect(planFilletWeld(document, requestFor(b, 75, 10), WELD_TEST_REVISIONS, bodies).ok).toBe(true);
    }
    const reversed = { ...body, faces: body.faces.map(face => ({ ...face, axis: [-1, 0, 0] as const,
      cylinderSpan: face.index === 0 ? [-60, -40] as const : [-100, -70] as const })) };
    const reverseRequest = requestFor(a, 75, 10);
    const reversedRef = { ...reverseRequest, second: { ...reverseRequest.second, face: { ...reverseRequest.second.face,
      fingerprint: { ...reverseRequest.second.face.fingerprint, axis: [-1, 0, 0] as const } } } };
    expect(planFilletWeld(plainTee(), reversedRef, WELD_TEST_REVISIONS, teeBodies({ base: [reversed] })).ok).toBe(false);
  });

  it.each([true, false])('propagates a small tilt through the whole arc and length; exterior=%s', exterior => {
    const d = 2e-5, sine = Math.sin(d), cosine = Math.cos(d);
    // Independently evaluated outer toe penetrates by about 7.95e-5mm despite passing old dot tests.
    const toeRadius = Math.hypot(-20 * sine + 10 * Math.sin(0.2) * cosine, 10 * Math.cos(0.2));
    expect(10 - toeRadius).toBeGreaterThan(70e-6);
    expect(1 - cosine).toBeLessThan(1e-9);
    const sign = exterior ? 1 : -1;
    const face: SolidFaceEntry = { ...CYLINDER, axis: [0, 0, 1], axisOrigin: [0, 0, 0],
      centroid: [0, 0, 20], cylinderSpan: [-1, 41], cylinderExterior: exterior };
    const tilted: WeldFrame = { origin: [-20 * sine, sign * 10, 20 - 20 * cosine],
      xAxis: [sign * cosine, 0, -sign * sine], yAxis: [0, 1, 0], zAxis: [sine, 0, cosine] };
    // For the interior case reverse x and z together to keep x cross y = z.
    const frame: WeldFrame = exterior ? tilted : { ...tilted,
      origin: [20 * sine, -10, 20 + 20 * cosine], zAxis: [-sine, 0, -cosine] };
    const exact: WeldFrame = { origin: [0, sign * 10, exterior ? 0 : 40],
      xAxis: [sign, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, sign] };
    for (const placement of [rigidPlacementOf(weldTestPlacement([0, 0, 0])),
      rigidPlacementOf(weldTestPlacement([7, -2, 5], [0, 0, Math.SQRT1_2, Math.SQRT1_2]))]) {
      const world = (value: WeldFrame): WeldFrame => ({ origin: applyPlacementToPoint(placement, value.origin),
        xAxis: applyPlacementToDirection(placement, value.xAxis), yAxis: applyPlacementToDirection(placement, value.yAxis),
        zAxis: applyPlacementToDirection(placement, value.zAxis) });
      const side = exterior ? 'exterior' : 'interior';
      expect(cylindricalWeldContact([cylinderBody(face)], placement, world(exact), 10, 2, 3, { start: 0, length: 40 }, side)).toBe(true);
      expect(cylindricalWeldContact([cylinderBody(face)], placement, world(frame), 10, 2, 3, { start: 0, length: 40 }, side)).toBe(false);
      for (const length of [40, 4e6]) {
        const small = 1e-10, s = Math.sin(small), c = Math.cos(small);
        const almost: WeldFrame = { origin: [-sign * length * s / 2, sign * 10, length / 2 - sign * length * c / 2],
          xAxis: [sign * c, 0, -sign * s], yAxis: [0, 1, 0], zAxis: [sign * s, 0, sign * c] };
        const longFace: SolidFaceEntry = { ...face, cylinderSpan: [-1, length + 1] };
        // Same tiny angle: harmless on 40mm, more than 1e-6mm displacement on a 4km bead.
        expect(length * Math.sin(small) > 1e-6).toBe(length > 40);
        expect(cylindricalWeldContact([cylinderBody(longFace)], placement, world(almost), 10, 2, 3,
          { start: 0, length }, side)).toBe(length === 40);
      }
    }
  });

  it('includes the planar toe height in the complete-section error budget', () => {
    const placement = rigidPlacementOf(weldTestPlacement([0, 0, 0]));
    const angle = 1e-10, height = 1e6;
    const face: SolidFaceEntry = { ...CYLINDER, axis: [0, 0, 1], axisOrigin: [0, 0, 0], cylinderSpan: [0, 40] };
    const frame: WeldFrame = { origin: [0, 10, 0], xAxis: [Math.cos(angle), Math.sin(angle), 0],
      yAxis: [-Math.sin(angle), Math.cos(angle), 0], zAxis: [0, 0, 1] };
    expect(height * Math.sin(angle)).toBeGreaterThan(1e-6);
    expect(cylindricalWeldContact([cylinderBody(face)], placement, frame, 10, 2, height,
      { start: 0, length: 40 })).toBe(false);
    expect(cylindricalWeldContact([cylinderBody(face)], placement,
      { ...frame, xAxis: [1, 0, 0], yAxis: [0, 1, 0] }, 10, 2, height, { start: 0, length: 40 })).toBe(true);
  });
});
