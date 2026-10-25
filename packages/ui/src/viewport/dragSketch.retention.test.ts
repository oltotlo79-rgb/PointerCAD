import { expressionValueFromNumber } from '@pointercad/expression';
import { readPcadFile, writePcadFile } from '@pointercad/io';
import { absoluteCoordinate, collectVariables, CONSTRAINT_TOLERANCE, createEmptyPartDocument,
  replaceSketch, resolveSketch, SKETCH_TOLERANCE_MM, WORK_PLANES, type CoordinateInput,
  type PartDocument, type SketchDocument, type Vec3 } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { commitDrag, draggableAt, isDraggable, solveWithDrag } from './dragSketch.js';
import { recomputeRetention } from './dragSketch.retentionSupport.js';

const num = expressionValueFromNumber;
function linePart(from: CoordinateInput = absoluteCoordinate(0, 0, 0),
  to: CoordinateInput = absoluteCoordinate(10, 0, 0)): PartDocument {
  const part = createEmptyPartDocument(), sketch = part.sketches[0];
  return replaceSketch(part, { ...sketch, features: [{ id: 'line', name: 'line', planeId: 'xy', kind: 'line',
    from, to, construction: false }], constraints: [{ id: 'horizontal', name: 'horizontal', kind: 'horizontal',
    target: { kind: 'curve', element: { featureId: 'line' } } }] });
}
function moved(sketch: SketchDocument, target: readonly [number, number] = [14, 6]): SketchDocument {
  const variables = collectVariables(sketch, resolveSketch(sketch), WORK_PLANES.xy);
  const drag = draggableAt(sketch, variables, { kind: 'vertex', featureId: 'line', vertex: 'end' }, [10, 0]);
  if (!isDraggable(drag)) throw new Error('Expected free numeric endpoint');
  const solved = solveWithDrag(sketch, drag, target);
  return commitDrag(sketch, drag, solved.solution, solved.resolved, WORK_PLANES.xy);
}
async function assertLine(document: PartDocument, expectedFrom: Vec3, expectedTo: Vec3): Promise<void> {
  const result = await recomputeRetention(document), segment = result.sketches[0].resolved.segments[0];
  if (segment === undefined) throw new Error('Missing recomputed line');
  for (const [actual, expected] of [[segment.from, expectedFrom], [segment.to, expectedTo]] as const) {
    for (let axis = 0; axis < 3; axis += 1) expect(Math.abs(actual[axis] - expected[axis])).toBeLessThanOrEqual(SKETCH_TOLERANCE_MM);
  }
  expect(Math.abs(segment.from[1] - segment.to[1])).toBeLessThanOrEqual(CONSTRAINT_TOLERANCE);
}
async function roundTrip(document: PartDocument): Promise<PartDocument> {
  const read = readPcadFile(writePcadFile(document));
  if (!read.ok) throw new Error(read.error.message);
  expect(read.document.sketches[0].constraints).toEqual(document.sketches[0].constraints);
  await assertLine(read.document, [0, 6, 0], [14, 6, 0]);
  return read.document;
}

describe('drag numeric seeds survive actual part recompute and PCAD IO', () => {
  it('retains the horizontal two-point translation; old dragged-only seeds have the independent midpoint oracle', async () => {
    const original = linePart(), before = JSON.stringify(original);
    const sketch = moved(original.sketches[0]), committed = replaceSketch(original, sketch);
    expect(sketch.constraints).toBe(original.sketches[0].constraints);
    await assertLine(committed, [0, 6, 0], [14, 6, 0]);
    await roundTrip(committed);
    // Old commit stored y=(0,6). The unpinned horizontal solve has symmetric
    // normal equations, so its common y is their arithmetic mean, exactly 3.
    const legacy = linePart(absoluteCoordinate(0, 0, 0), absoluteCoordinate(14, 6, 0));
    await assertLine(legacy, [0, 3, 0], [14, 3, 0]);
    expect(JSON.stringify(original)).toBe(before);
  });

  it.each(['relative', 'polar'] as const)('retains %s reference identity through recompute and IO', async mode => {
    const base = { kind: 'previous' } as const;
    const to: CoordinateInput = mode === 'relative'
      ? { mode, base, dx: num(10), dy: num(0), dz: num(0) }
      : { mode, base, distance: num(10), azimuth: num(0), elevation: num(0) };
    const original = linePart(undefined, to), committed = replaceSketch(original, moved(original.sketches[0]));
    const feature = committed.sketches[0].features[0];
    if (feature.kind !== 'line' || feature.to.mode === 'absolute') throw new Error('Reference was flattened');
    expect(feature.to.mode).toBe(mode); expect(feature.to.base).toBe(base);
    await assertLine(committed, [0, 6, 0], [14, 6, 0]);
    const reopened = await roundTrip(committed), restored = reopened.sketches[0].features[0];
    if (restored.kind !== 'line' || restored.to.mode === 'absolute') throw new Error('IO flattened reference');
    expect(restored.to.mode).toBe(mode); expect(restored.to.base).toEqual(base);
  });

  it('preserves expression-defined coordinates and the fixed endpoint', async () => {
    const expression: CoordinateInput = { mode: 'absolute', x: { source: '2-2', value: 0, display: '0' }, y: num(0), z: num(0) };
    const original = linePart(expression), sketch = original.sketches[0];
    const fixed: SketchDocument = { ...sketch, constraints: [...(sketch.constraints ?? []),
      { id: 'fixed', name: 'fixed', kind: 'fix', target: { kind: 'vertex', featureId: 'line', vertex: 'start' } }] };
    const committed = moved(fixed, [14, 0]), line = committed.features[0];
    if (line.kind !== 'line') throw new Error('Missing line');
    expect(line.from).toBe(expression); expect(committed.constraints).toBe(fixed.constraints);
    const saved = replaceSketch(original, committed);
    await assertLine(saved, [0, 0, 0], [14, 0, 0]);
    const read = readPcadFile(writePcadFile(saved));
    if (!read.ok) throw new Error(read.error.message);
    const restored = read.document.sketches[0].features[0];
    if (restored.kind !== 'line') throw new Error('Missing reopened line');
    expect(restored.from).toEqual(expression);
    await assertLine(read.document, [0, 0, 0], [14, 0, 0]);
  });
  it('keeps a numeric fixed seed and unrelated free feature unchanged', async () => {
    const original = linePart(), sketch = original.sketches[0];
    const unrelated = { id: 'unrelated', name: 'unrelated', planeId: 'xy', kind: 'point', at: absoluteCoordinate(77, 88, 0) } as const;
    const fixed: SketchDocument = { ...sketch, features: [...sketch.features, unrelated],
      constraints: [...(sketch.constraints ?? []), { id: 'fixed', name: 'fixed', kind: 'fix',
        target: { kind: 'vertex', featureId: 'line', vertex: 'start' } }] };
    const next = moved(fixed, [14, 0]), before = fixed.features[0], after = next.features[0];
    if (before.kind !== 'line' || after.kind !== 'line') throw new Error('Missing line');
    expect(after.from).toBe(before.from); expect(next.features[1]).toBe(unrelated);
    await assertLine(replaceSketch(original, next), [0, 0, 0], [14, 0, 0]);
  });

  it('refuses a non-finite solved seed atomically', () => {
    const sketch = linePart().sketches[0], variables = collectVariables(sketch, resolveSketch(sketch), WORK_PLANES.xy);
    const drag = draggableAt(sketch, variables, { kind: 'vertex', featureId: 'line', vertex: 'end' }, [10, 0]);
    if (!isDraggable(drag)) throw new Error('Expected draggable endpoint');
    const solution = new Map<string, Vec3>([['line:end', [14, 6, 0]], ['line:start', [0, Number.NaN, 0]]]);
    expect(commitDrag(sketch, drag, solution, resolveSketch(sketch), WORK_PLANES.xy)).toBe(sketch);
  });
});
