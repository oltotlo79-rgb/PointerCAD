import {
  absoluteCoordinate, createEmptySketchDocument, resolveSketch, WORK_PLANES, type SketchDocument,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { commitSketchStep } from './commitToStore.js';
import type { NumericInputCommit } from './numericInput.js';
import { continueFrom } from './sketchCommands.js';

function coordinate(step: 'point' | 'lineStart' | 'lineEnd', x: number, y: number): NumericInputCommit {
  const at = absoluteCoordinate(x, y, 0);
  return { kind: 'coordinate', step, mode: 'absolute', coordinate: at, values: [at.x, at.y, at.z],
    flags: {}, choices: {} };
}

const plane = WORK_PLANES.xy;
const context = { planeId: plane.id, plane, chaining: true, pendingStart: null };
const horizontal: SketchDocument = { ...createEmptySketchDocument(), features: [{
  id: 'line-1', name: '線分1', planeId: 'xy', kind: 'line', construction: false,
  from: absoluteCoordinate(-10, 0, 0), to: absoluteCoordinate(10, 0, 0),
}] };

describe('ストアに書き込む前のスケッチの 1 段', () => {
  it('点は新しい文書に置き、線の始点は文書を増やさず次に渡す', () => {
    const document = createEmptySketchDocument();
    const start = commitSketchStep(coordinate('lineStart', 2, 3), { ...context, document }, plane);
    const point = commitSketchStep(coordinate('point', 2, 3), { ...context, document }, plane);
    if (start.kind !== 'calculated' || point.kind !== 'calculated') throw new Error('座標を確定できません');
    expect(start.outcome.document).toBe(document);
    expect(start.outcome.pendingStart).toEqual(absoluteCoordinate(2, 3, 0));
    expect(point.outcome.pendingStart).toBeNull();
    expect(resolveSketch(point.outcome.document).points.map((entry) => entry.position)).toEqual([[2, 3, 0]]);
    expect(document.features).toEqual([]);
  });

  it('交点で 4 区間に分け、次の線は元の終点を指す。分割を切れば 2 本のまま', () => {
    const crossing = { ...context, document: horizontal, pendingStart: absoluteCoordinate(0, -10, 0) };
    const end = coordinate('lineEnd', 0, 10);
    const split = commitSketchStep(end, crossing, plane);
    const unsplit = commitSketchStep({ ...end, flags: { splitIntersections: false } }, crossing, plane);
    if (split.kind !== 'calculated' || unsplit.kind !== 'calculated') throw new Error('交点を確定できません');
    expect(split.connected).toBe(true);
    expect(split.outcome.pendingStart).toEqual(continueFrom('line-2'));
    const resolved = resolveSketch(split.outcome.document);
    expect(resolved.errors).toEqual([]);
    expect(resolved.segments).toHaveLength(4);
    expect(resolved.segments.find((line) => line.featureId === 'line-2')?.to).toEqual([0, 10, 0]);
    expect(unsplit.connected).toBe(false);
    expect(resolveSketch(unsplit.outcome.document).segments).toHaveLength(2);
    expect(horizontal.features).toHaveLength(1);
  });

  it('拘束が付いた線を分けられなければ途中の文書を返さない', () => {
    const document: SketchDocument = { ...horizontal, constraints: [{
      id: 'c1', name: '水平', kind: 'horizontal', target: { kind: 'curve', element: { featureId: 'line-1' } },
    }] };
    const before = structuredClone(document);
    const result = commitSketchStep(coordinate('lineEnd', 0, 10), {
      ...context, document, pendingStart: absoluteCoordinate(0, -10, 0),
    }, plane);
    expect(result).toEqual({ kind: 'splitError', key: 'splitLines.error.constrainedLine' });
    expect(document).toEqual(before);
  });
});
