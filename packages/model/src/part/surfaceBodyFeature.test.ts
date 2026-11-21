import { expressionValueFromNumber as mm } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { toSolidStepRequest } from '../kernelBridge/solidRequests.js';
import { absoluteCoordinate } from '../sketch/createSketchDocument.js';
import type { SketchLineFeature } from '../sketch/types.js';
import { appendSolid, consumedBodyIds, createEmptyPartDocument, liveBodyIds, nextSolidId, nextSolidName,
  removeSolid, replaceSolid } from './createPartDocument.js';
import { reevaluatePartDocument } from './reevaluatePart.js';
import { resolvePart } from './resolvePart.js';
import { dependenciesOf } from './timelineOrder.js';
import type { PartDocument, SurfaceFeature, ThickenFeature } from './types.js';

function sheet(width = 100): PartDocument {
  const document = createEmptyPartDocument(), sketch = document.sketches[0];
  const edge: SketchLineFeature = { kind: 'line', id: 'edge', name: '輪郭', planeId: 'xy', construction: false,
    from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(width, 0, 0) };
  const surface: SurfaceFeature = { kind: 'surface', id: 'sheet', name: '曲面1', suppressed: false,
    operation: { kind: 'extrude', profile: { sketchId: sketch.id, curveIds: [edge.id] }, distance: mm(100), reversed: false } };
  return appendSolid({ ...document, sketches: [{ ...sketch, features: [edge] }] }, surface);
}

function offset(distance = -2, targetFeatureId = 'sheet'): SurfaceFeature {
  return { kind: 'surface', id: 'offset', name: '曲面2', suppressed: false,
    operation: { kind: 'offsetBody', targetFeatureId, distance: mm(distance) } };
}

function wall(thickness = 5, side: ThickenFeature['side'] = 'normal', targetFeatureId = 'offset'): ThickenFeature {
  return { kind: 'thicken', id: 'thicken-1', name: '厚み付け1', suppressed: false, targetFeatureId, thickness: mm(thickness), side };
}

function stack(width = 100, distance = -2, thickness = 5, side: ThickenFeature['side'] = 'normal') {
  const document = appendSolid(appendSolid(sheet(width), offset(distance)), wall(thickness, side));
  const resolved = resolvePart(document);
  expect(resolved.errors).toEqual([]);
  return { document, steps: resolved.steps.map(toSolidStepRequest) };
}

describe('面だけのボディの厚み付けとオフセット', () => {
  it('オフセットは元の面を残し、厚み付けは選んだ面だけを消費する', () => {
    const { document, steps } = stack();
    const [source, shifted, thickened] = steps;
    expect(shifted.step).toEqual({ kind: 'offsetBody', targetKey: source.key, distance: -2 });
    expect(thickened.step).toEqual({ kind: 'thicken', targetKey: shifted.key, side: 'normal', thickness: 5 });
    expect(steps.filter(step => step.visible).map(step => step.id)).toEqual(['sheet', 'thicken-1']);
    expect([...consumedBodyIds(document)]).toEqual(['offset']);
    expect(liveBodyIds(document)).toEqual(['sheet', 'thicken-1']);
    expect(dependenciesOf(document, 'offset')).toContain('sheet');
    expect(dependenciesOf(document, 'thicken-1')).toContain('offset');
    expect(nextSolidName(document, 'surface')).toBe('曲面3');
    expect(nextSolidName(document, 'thicken')).toBe('厚み付け2');
    expect(nextSolidId(document, 'thicken')).toBe('thicken-2');
  });

  it('距離・厚み・側・上流の形が変わると該当する段から鍵が変わる', () => {
    const keys = (result: ReturnType<typeof stack>) => result.steps.map(step => step.key);
    const original = keys(stack()), distance = keys(stack(100, 2));
    expect(distance[0]).toBe(original[0]);
    expect(distance[1]).not.toBe(original[1]);
    expect(distance[2]).not.toBe(original[2]);
    expect(keys(stack(100, -2, 6))[2]).not.toBe(original[2]);
    const sides = (['normal', 'reverse', 'both'] as const).map(side => keys(stack(100, -2, 5, side))[2]);
    expect(new Set(sides).size).toBe(3);
    const wider = keys(stack(110));
    original.forEach((key, index) => expect(wider[index]).not.toBe(key));
  });

  it('解決できない対象、重複消費、ゼロ距離と非正の厚みを断る', () => {
    const base = sheet();
    const rejected = (document: PartDocument) => resolvePart(document).errors.map(error => error.code);
    expect(rejected(appendSolid(base, offset(1, 'missing')))).toEqual(['missingBody']);
    expect(rejected(appendSolid(base, wall()))).toEqual(['missingBody']);
    expect(rejected(appendSolid(base, offset(0)))).toEqual(['invalidValue']);
    expect(rejected(appendSolid(base, wall(-1, 'normal', 'sheet')))).toEqual(['invalidValue']);
    const first = wall(5, 'both', 'sheet');
    expect(rejected(appendSolid(appendSolid(base, first), { ...first, id: 'second' }))).toEqual(['consumedTwice']);
    expect(liveBodyIds(appendSolid(base, { ...first, suppressed: true }))).toEqual(['sheet']);
  });

  it('係数を変えると距離と厚みを再評価して段へ渡す', () => {
    const value = { source: 'a', value: 1, display: '1' };
    const shifted: SurfaceFeature = { ...offset(), operation: { kind: 'offsetBody', distance: value, targetFeatureId: 'sheet' } };
    const document = appendSolid(appendSolid(sheet(), shifted), { ...wall(), thickness: value });
    const evaluated = reevaluatePartDocument(document, new Map([['a', 7]]));
    expect(evaluated.failures).toEqual([]);
    const resolved = resolvePart(evaluated.document);
    expect(resolved.errors).toEqual([]);
    expect(resolved.steps[1].plan).toMatchObject({ kind: 'offsetBody', distance: 7 });
    expect(resolved.steps[2].plan).toMatchObject({ kind: 'thicken', thickness: 7 });
  });

  it.each([22, 23])('元の版 %i から新しい種類を追加・差し替えた時だけ 24 へ上げる', version => {
    const base = { ...sheet(), schemaVersion: version };
    const [ordinary] = base.solids;
    expect(replaceSolid(base, ordinary.id, ordinary).schemaVersion).toBe(version);
    for (const feature of [offset(), wall()]) {
      const added = appendSolid(base, feature);
      expect(added.schemaVersion).toBe(24);
      expect(removeSolid(added, feature.id).schemaVersion).toBe(24);
      expect(replaceSolid(base, ordinary.id, { ...feature, id: ordinary.id }).schemaVersion).toBe(24);
      expect(replaceSolid(base, 'missing', feature)).toBe(base);
      expect(appendSolid({ ...base, schemaVersion: 25 }, feature).schemaVersion).toBe(25);
    }
    expect(base.schemaVersion).toBe(version);
  });
});
