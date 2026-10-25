import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { evaluateExpression, expressionValueFromNumber as number } from '@pointercad/expression';
import { createKernelApi } from '@pointercad/kernel';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge } from '../kernelBridge.js';
import { absoluteCoordinate } from '../sketch/createSketchDocument.js';
import type { SketchArcFeature, SketchEllipseFeature, SketchLineFeature } from '../sketch/types.js';
import { createUndoStack, pushUndo } from '../history/undoStack.js';
import { appendSolid, consumedTargetsOf, createEmptyPartDocument, DEFAULT_PRIMITIVE_AXIS,
  isMachiningFeature, SOLID_FEATURE_KINDS } from './createPartDocument.js';
import { resolvePart } from './resolvePart.js';
import { recomputePart } from './recomputePart.js';
import { reevaluatePartDocument } from './reevaluatePart.js';
import { referencedSketchIds } from './solidSketchReferences.js';
import { dependenciesOf } from './timelineOrder.js';
import type { PartDocument, PrimitiveFeature, SurfaceCutBlade, SurfaceCutFeature, SurfaceFeature } from './types.js';

const box: PrimitiveFeature = { id: 'box', name: 'Box', kind: 'primitive', suppressed: false,
  origin: { kind: 'coordinate', value: absoluteCoordinate(5, 5, 5) }, axis: DEFAULT_PRIMITIVE_AXIS,
  shape: { kind: 'box', sizeX: number(10), sizeY: number(10), sizeZ: number(10) } };
const plane = (x = 5): SurfaceCutBlade => ({ kind: 'plane', plane: { kind: 'workPlane', planeId: 'yz', offset: number(x) } });
function cut(blade: SurfaceCutBlade = plane(), id = 'cut-positive', keep: SurfaceCutFeature['keep'] = 'positive',
  pairedWith: string | null = null): SurfaceCutFeature {
  return { kind: 'surfaceCut', id, name: id, suppressed: false, targetFeatureId: box.id, blade, keep, pairedWith };
}
function base(): PartDocument { return appendSolid(createEmptyPartDocument(), box); }
function withCuts(document: PartDocument, blade: SurfaceCutBlade, both = false): PartDocument {
  return { ...document, solids: [...document.solids, cut(blade),
    ...(both ? [cut(blade, 'cut-negative', 'negative', 'cut-positive')] : [])] };
}
function curved(kind: 'arc' | 'ellipse'): { document: PartDocument; blade: SurfaceCutBlade } {
  const document = base(), sketch = document.sketches[0];
  const common = { id: 'curve', name: 'Blade', planeId: 'xy', center: absoluteCoordinate(5, 0, 0),
    startAngle: number(0), endAngle: number(180), construction: false };
  const curve: SketchArcFeature | SketchEllipseFeature = kind === 'arc'
    ? { ...common, kind, radius: number(3) }
    : { ...common, kind, majorRadius: number(4), minorRadius: number(2), rotation: number(0) };
  return { document: { ...document, sketches: [{ ...sketch, features: [curve] }] },
    blade: { kind: 'extrusion', profile: { sketchId: sketch.id, curveIds: [curve.id] } } };
}
function finiteSurface(): { document: PartDocument; blade: SurfaceCutBlade } {
  const document = base(), sketch = document.sketches[0];
  const line: SketchLineFeature = { kind: 'line', id: 'line', name: 'Line', planeId: 'xy',
    from: absoluteCoordinate(5, -1, 0), to: absoluteCoordinate(5, 5, 0), construction: false };
  const surface: SurfaceFeature = { kind: 'surface', id: 'blade-surface', name: 'Blade surface', suppressed: false,
    operation: { kind: 'extrude', profile: { sketchId: sketch.id, curveIds: [line.id] }, distance: number(10), reversed: false } };
  return { document: { ...document, sketches: [{ ...sketch, features: [line] }], solids: [box, surface] },
    blade: { kind: 'surface', surfaceFeatureId: surface.id } };
}
function cutKey(document: PartDocument): string {
  const resolved = resolvePart(document);
  expect(resolved.errors).toEqual([]);
  const step = resolved.steps.find(entry => entry.featureId === 'cut-positive');
  if (step === undefined) throw new Error('Missing cut step');
  return step.key;
}
const sha = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const relative = (actual: number, expected: number): void => {
  expect(Math.abs(actual - expected) / expected).toBeLessThanOrEqual(1e-9);
};

describe('surfaceCut definition, dependencies and keys', () => {
  it('registers the new kind, consumes only the target and tracks the drawing sketch', () => {
    const fixture = curved('arc'), feature = cut(fixture.blade);
    expect(SOLID_FEATURE_KINDS).toContain('surfaceCut');
    expect(isMachiningFeature(feature)).toBe(true);
    expect(consumedTargetsOf(feature)).toEqual(['box']);
    expect(referencedSketchIds(feature, fixture.document.sketches)).toEqual([fixture.document.sketches[0].id]);
    const finite = finiteSurface(), document = withCuts(finite.document, finite.blade);
    expect(dependenciesOf(document, 'cut-positive')).toEqual(expect.arrayContaining(['box', 'blade-surface']));
    expect(resolvePart(document).liveBodyIds).toEqual(['blade-surface', 'cut-positive']);
  });

  it('gives each side one body, and excludes pair IDs and labels from geometric keys', () => {
    const single = withCuts(base(), plane()), paired = withCuts(base(), plane(), true);
    const resolved = resolvePart(paired);
    expect(resolved.errors).toEqual([]);
    expect(resolved.liveBodyIds).toEqual(['cut-positive', 'cut-negative']);
    expect(cutKey(single)).toBe(cutKey(paired));
    expect(resolved.steps[1].key).not.toBe(resolved.steps[2].key);
    const renamed = { ...paired, solids: paired.solids.map(feature => feature.kind === 'surfaceCut'
      ? { ...feature, id: feature.id === 'cut-positive' ? 'renamed' : feature.id,
        name: 'Renamed', pairedWith: feature.pairedWith === 'cut-positive' ? 'renamed' : feature.pairedWith } : feature) };
    expect(resolvePart(renamed).steps.map(step => step.key)).toEqual(resolved.steps.map(step => step.key));
  });

  it.each(['same-side', 'different-blade', 'third-cut', 'unpaired'] as const)('rejects invalid double consumption: %s', mode => {
    const document = withCuts(base(), plane(), true), first = cut();
    const second = cut(mode === 'different-blade' ? plane(4) : plane(), 'cut-negative',
      mode === 'same-side' ? 'positive' : 'negative', mode === 'unpaired' ? null : first.id);
    const solids = [box, first, second, ...(mode === 'third-cut' ? [cut(plane(), 'third', 'negative', first.id)] : [])];
    expect(resolvePart({ ...document, solids }).errors.length).toBeGreaterThan(0);
  });

  it.each(['missing-target', 'forward-target', 'self-target', 'missing-blade', 'forward-blade', 'self-blade'] as const)(
    'rejects %s before kernel dispatch', mode => {
      const finite = finiteSurface(), feature = cut(finite.blade);
      const changed: SurfaceCutFeature = mode.endsWith('target')
        ? { ...feature, targetFeatureId: mode === 'self-target' ? feature.id : mode === 'missing-target' ? 'missing' : box.id }
        : { ...feature, blade: { kind: 'surface', surfaceFeatureId: mode === 'self-blade' ? feature.id
          : mode === 'missing-blade' ? 'missing' : 'blade-surface' } };
      const solids = mode === 'forward-target' ? [changed, ...finite.document.solids]
        : mode === 'forward-blade' ? [box, changed, finite.document.solids[1]] : [...finite.document.solids, changed];
      const resolved = resolvePart({ ...finite.document, solids });
      expect(resolved.errors.some(error => error.featureId === feature.id)).toBe(true);
      expect(resolved.steps.some(step => step.featureId === feature.id)).toBe(false);
    });

  it('rejects a missing curve and a missing drawing plane', () => {
    const fixture = curved('arc');
    expect(resolvePart(withCuts(base(), fixture.blade)).errors).not.toEqual([]);
    const sketch = fixture.document.sketches[0];
    const missingPlane = { ...fixture.document, sketches: [{ ...sketch,
      features: sketch.features.map(feature => ({ ...feature, planeId: 'missing-plane' })) }] };
    expect(resolvePart(withCuts(missingPlane, fixture.blade)).errors).not.toEqual([]);
  });

  it('reevaluates plane expressions and curve radii from their sources, changing downstream keys', () => {
    const expression = evaluateExpression('位置', { variables: new Map([['位置', 5]]) });
    if (!expression.ok) throw new Error('Invalid fixture expression');
    const document = withCuts(base(), { kind: 'plane', plane: { kind: 'workPlane', planeId: 'yz', offset: expression.value } });
    const changed = reevaluatePartDocument(document, new Map([['位置', 4]]));
    expect(changed.failures).toEqual([]);
    expect(cutKey(changed.document)).not.toBe(cutKey(document));
    const fixture = curved('arc'), sketch = fixture.document.sketches[0];
    const bigger = { ...fixture.document, sketches: [{ ...sketch, features: sketch.features.map(feature => feature.kind === 'arc'
      ? { ...feature, radius: number(4) } : feature) }] };
    expect(cutKey(withCuts(bigger, fixture.blade))).not.toBe(cutKey(withCuts(fixture.document, fixture.blade)));
  });
});

const api = createKernelApi(loadOcctForNode);
const bridge = createDirectKernelBridge(api);
beforeAll(async () => { await loadOcctForNode(); }, 180_000);
afterAll(() => bridge.dispose());

describe('surfaceCut through model and the real kernel', () => {
  it.each([
    { kind: 'plane', negative: 500, positive: 500 },
    { kind: 'arc', negative: 45 * Math.PI, positive: 1000 - 45 * Math.PI },
    { kind: 'ellipse', negative: 40 * Math.PI, positive: 1000 - 40 * Math.PI },
  ] as const)('$kind retains analytic volume on one and both sides', async ({ kind, positive, negative }) => {
    const fixture = kind === 'plane' ? { document: base(), blade: plane() } : curved(kind);
    for (const both of [false, true]) {
      const document = withCuts(fixture.document, fixture.blade, both), before = sha(document);
      try {
        const result = await recomputePart(document, bridge, { partId: document.id });
        expect(result.errors).toEqual([]);
        expect(result.bodies).toHaveLength(both ? 2 : 1);
        for (const body of result.bodies) {
          expect(body.isValid).toBe(true);
          relative(body.volume, body.featureId === 'cut-positive' ? positive : negative);
        }
        expect(sha(document)).toBe(before);
      } finally { await bridge.releasePart(document.id); }
    }
  }, 60_000);

  it.each(['no-intersection', 'touch-only', 'incomplete-cut', 'cancelled'] as const)(
    '%s preserves document, references, existing geometry and history', async reason => {
      const fixture = reason === 'incomplete-cut' ? finiteSurface() : { document: base(), blade: plane(reason === 'touch-only' ? 10 : 11) };
      const original = fixture.document, candidate = withCuts(original, fixture.blade);
      const history = createUndoStack(original), before = sha(original), candidateBefore = sha(candidate);
      const references = original.references, solids = original.solids;
      const raw = vi.spyOn(api, 'recomputeSolids');
      try {
        const baseline = await recomputePart(original, bridge, { partId: original.id });
        expect(baseline.errors).toEqual([]);
        const geometry = baseline.bodies.map(body => ({ id: body.featureId, volume: body.volume, positions: Array.from(body.mesh.positions) }));
        const result = await recomputePart(candidate, bridge, { partId: original.id, shouldCancel: () => reason === 'cancelled' });
        if (reason === 'cancelled') expect(result.cancelled).toBe(true);
        else {
          expect(result.errors.some(error => error.featureId === 'cut-positive')).toBe(true);
          expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({
            featureId: 'cut-positive', code: 'kernelFailed', reason,
          })]));
          const last = raw.mock.results.at(-1);
          if (last?.type !== 'return') throw new Error('No real kernel reply');
          const reply = await last.value;
          expect(reply.failures).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'cut-positive', code: reason })]));
        }
        // recomputePart is pure with respect to saved documents; publication is a separate W12 step.
        expect(history.present).toBe(original); expect(history.past).toHaveLength(0);
        expect(sha(original)).toBe(before); expect(sha(candidate)).toBe(candidateBefore);
        expect(original.references).toBe(references); expect(original.solids).toBe(solids);
        const restored = await recomputePart(original, bridge, { partId: original.id });
        expect(restored.errors).toEqual([]);
        expect(restored.bodies.map(body => ({ id: body.featureId, volume: body.volume, positions: Array.from(body.mesh.positions) }))).toEqual(geometry);
      } finally { raw.mockRestore(); await bridge.releasePart(original.id); }
    }, 60_000);

  it('lets the caller adopt a successful two-sided candidate as one history entry', async () => {
    const original = base(), candidate = withCuts(original, plane(), true), history = createUndoStack(original);
    try {
      const result = await recomputePart(candidate, bridge, { partId: original.id });
      expect(result.errors).toEqual([]); expect(result.cancelled).toBe(false);
      const adopted = pushUndo(history, candidate);
      expect(adopted.past).toEqual([original]); expect(adopted.present).toBe(candidate);
      expect(history.past).toHaveLength(0); expect(history.present).toBe(original);
    } finally { await bridge.releasePart(original.id); }
  }, 60_000);
});
