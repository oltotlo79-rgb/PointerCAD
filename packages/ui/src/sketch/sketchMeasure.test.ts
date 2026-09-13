import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyPartDocument, resolveSketch, WORK_PLANES, type ResolvedSketch } from '@pointercad/model';
import { partMeasureReadiness } from './sketchMeasure.js';
import { measureToolReadiness, runMeasure } from '../solid/measureCommands.js';
import { collectSnapCandidates } from './snapMath.js';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
const document = createEmptyPartDocument();
const empty = resolveSketch(document.sketches[0]);
function geometry(): ResolvedSketch {
  return { ...empty, points: [
    { id: 'on-function', featureId: 'on-function', position: [1, 2, 3] },
    { id: 'other-point', featureId: 'other-point', position: [4, 6, 15] },
  ], segments: [
    { kind: 'segment', featureId: 'normal', from: [1, 2, 3], to: [1, 2, 13] },
    { kind: 'segment', featureId: 'tangent', from: [1, 2, 3], to: [7, 2, 3] },
  ] };
}
beforeEach(resetTestStore);
describe('ADD-13 resolved sketch measurement through the ordinary measure action', () => {
  it('measures two current 3D points with the same IDs used by snapping, without a CAD call', async () => {
    const sketch = geometry(), before = JSON.stringify(sketch), measurer = vi.fn();
    const selection = ['on-function', 'other-point'];
    expect(measureToolReadiness(selection, [], sketch).ready).toBe(true);
    const result = await runMeasure({ document, selection, bodies: [], measurer, sketch });
    expect(result).toMatchObject({ ok: true, measurement: { result: { kind: 'pointDistance', value: 13, segment: [[1, 2, 3], [4, 6, 15]] } } });
    const candidates = collectSnapCandidates(sketch, WORK_PLANES.xy, 1, null);
    expect(candidates).toContainEqual({ kind: 'endpoint', position: [1, 2, 3], featureId: 'on-function', elementId: 'on-function' });
    expect(measurer).not.toHaveBeenCalled(); expect(JSON.stringify(sketch)).toBe(before);
  });
  it('measures direction length and normal/tangent angle from the current endpoints', () => {
    const length = partMeasureReadiness(['normal'], [], geometry());
    expect(length).toMatchObject({ source: 'sketch', measurement: { result: { kind: 'edgeLength', value: 10 } } });
    const angle = partMeasureReadiness(['normal', 'tangent'], [], geometry());
    expect(angle).toMatchObject({ source: 'sketch', measurement: { result: { kind: 'edgeAngle', value: 90 }, angle: { apex: [1, 2, 3] } } });
  });
  it('reads the latest evaluated points and converts only the displayed length to inches', () => {
    const sketch = geometry(), updated = { ...sketch, points: sketch.points.map(point => point.id === 'other-point' ? { ...point, position: [26.4, 2, 3] as const } : point) };
    expect(partMeasureReadiness(['on-function', 'other-point'], [], updated, 'inch')).toMatchObject({ measurement: { result: { value: 25.4 }, text: '1.000 in' } });
  });
  it.each(['missing', 'duplicate', 'compound', 'nonfinite', 'zero-angle'] as const)('does not produce an invented measurement for %s', issue => {
    const sketch = geometry();
    const selection = issue === 'duplicate' ? ['normal', 'normal'] : issue === 'zero-angle' ? ['normal', 'tangent'] : [issue === 'missing' ? 'absent' : 'normal'];
    const changed = issue === 'compound' ? { ...sketch, curvesByFeature: new Map([['normal', []]]) }
      : issue === 'nonfinite' || issue === 'zero-angle' ? { ...sketch, segments: sketch.segments.map(line => line.featureId === 'normal' ? { ...line, to: issue === 'nonfinite' ? [Infinity, 0, 0] as const : line.from } : line) } : sketch;
    expect(partMeasureReadiness(selection, [], changed).ready).toBe(false);
  });
  it('the store connects current geometry, keeps the document and Undo unchanged, and clears stale asynchronous output', async () => {
    useAppStore.setState({ resolvedSketch: geometry(), selection: ['normal'] });
    const before = useAppStore.getState(); before.measureSelection();
    await Promise.resolve(); await Promise.resolve();
    expect(useAppStore.getState().measurement?.result.value).toBe(10);
    expect(useAppStore.getState().document).toBe(before.document); expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    useAppStore.getState().clearMeasurement(); useAppStore.getState().measureSelection();
    useAppStore.getState().resetDocument(createEmptyPartDocument());
    await Promise.resolve(); await Promise.resolve();
    expect(useAppStore.getState().measurement).toBeNull();
  });
});
