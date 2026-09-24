import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { absoluteCoordinate, appendSolid, createPrimitiveFeature, type PartDocument } from '@pointercad/model';
import { expressionValueFromNumber as number } from '@pointercad/expression';
import { sphereGridSphereOf } from '../sketch/sketchCommands.js';
import '../shell/propertyFieldUnits.js';
import type { AppState } from '../store/appState.js';
import { partWithPoint, resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { sphereGridNeedsUpdate } from './ViewportCanvas.js';

beforeEach(resetTestStore);
afterEach(resetTestStore);

describe('GR-20c A6 sphere grid invalidation', () => {
  it.each([
    ['request generation', { requestedGeneration: 17 }],
    ['completion generation', { completedGeneration: 17 }],
    ['history position', { timelineIndex: 0 }],
    ['computing', { isComputing: true }],
    ['cancellation', { recomputeCancelled: true }],
    ['failure', { lastOutcome: 'failed' }],
  ] satisfies readonly (readonly [string, Partial<AppState>])[])('notifies on %s alone', (_label, patch) => {
    const previous = useAppStore.getState();
    const next = { ...previous, ...patch };
    expect(next.document).toBe(previous.document);
    expect(next.resolvedSketch).toBe(previous.resolvedSketch);
    expect(next.selection).toBe(previous.selection);
    expect(sphereGridNeedsUpdate(next, previous)).toBe(true);
  });
  it('does not rebuild for an unrelated error message or an identical state', () => {
    const previous = useAppStore.getState();
    expect(sphereGridNeedsUpdate(previous, previous)).toBe(false);
    expect(sphereGridNeedsUpdate({ ...previous, errorMessage: 'unrelated' }, previous)).toBe(false);
  });
  it('removes stale lines on a generation change and restores them on a fresh result', () => {
    const document = partWithPoint();
    const source = 'coef("Measured")';
    const parameter = { name: 'P', mathId: 'coefficient:1', unit: 'mm' as const, description: '', value: {
      ...number(10), source, mathDefinition: { format: 'pointercad-math/1' as const, source,
        inputNotation: 'text' as const, angleUnit: 'degree' as const,
        expression: { kind: 'symbol' as const, reference: { role: 'coefficient' as const, id: 'math-geometry:measure', label: 'Measured' } } },
    } };
    const sphere = { ...createPrimitiveFeature(document, 'sphere', { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) }),
      shape: { kind: 'sphere' as const, radius: { ...number(10), source: 'P' } } };
    const owner: PartDocument = { ...appendSolid(document, sphere), parameters: [parameter] };
    useAppStore.getState().resetDocument(owner);
    useAppStore.setState({ requestedGeneration: 1, completedGeneration: 1,
      mathGeometryResult: { document: owner, generation: 1, evaluated: true, outcomes: new Map() } });
    let grid = sphereGridSphereOf(sphere, useAppStore.getState().resolvedSketch);
    expect(grid?.radius).toBe(10);
    // The viewport's real decision controls the same sphere-building call as the subscription.
    const unsubscribe = useAppStore.subscribe((next, previous) => {
      if (sphereGridNeedsUpdate(next, previous)) grid = sphereGridSphereOf(sphere, next.resolvedSketch);
    });
    try {
      useAppStore.getState().recordRecomputeRequest(2);
      expect(grid).toBeNull();
      useAppStore.setState({ completedGeneration: 2,
        mathGeometryResult: { document: owner, generation: 2, evaluated: true, outcomes: new Map() } });
      expect(grid?.radius).toBe(10);
      useAppStore.setState({ timelineIndex: 0 });
      expect(grid).toBeNull();
      useAppStore.setState({ timelineIndex: null });
      expect(grid?.radius).toBe(10);
      useAppStore.setState({ recomputeCancelled: true });
      expect(grid).toBeNull();
    } finally { unsubscribe(); }
  });
});
