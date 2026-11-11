import { describe, expect, it } from 'vitest';

import type { AssemblyDocument } from '../types.js';
import { applyFilletWeld } from './applyFilletWeld.js';
import {
  lineEdge, planeFace, plainTee, TEE_BODIES, teeBodies, teeJoint, teeRequest, WELD_TEST_REVISIONS, weldTestBox, weldTestPlacement,
} from './filletWeld.testSupport.js';
import { filletWeldSegmentOptions } from './filletWeldPart.js';
import { planFilletWeld, planFilletWeldEdit, weldSegmentsOf, type WeldBodyLookup } from './planFilletWeld.js';
import type { FilletWeldPlanResult, FilletWeldRequest } from './types.js';

/**
 * A second weld may not cover a stretch of the same material contact that an existing weld already covers.
 * The tee (filletWeld.testSupport.ts) has weld-1 at stations 10..30, 40..55 and 70..95 along +X from (0,34,10).
 * Expected overlaps are the interval intersections of the requested and saved stations, computed here.
 */
function apply(document: AssemblyDocument, planned: FilletWeldPlanResult): AssemblyDocument {
  if (!planned.ok) throw new Error(JSON.stringify(planned.rejections));
  const applied = applyFilletWeld(document, planned.plan, WELD_TEST_REVISIONS);
  if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
  return applied.document;
}

function welded(): AssemblyDocument {
  const before = plainTee();
  return apply(before, planFilletWeld(before, teeRequest(), WELD_TEST_REVISIONS, TEE_BODIES));
}

function overlaps(result: FilletWeldPlanResult): (readonly [string, string | number | undefined, string | number | undefined, number])[] {
  if (result.ok) return [];
  return result.rejections.map((rejection) => [rejection.code, rejection.detail.weldId, rejection.detail.segment,
    Number(rejection.detail.overlap)] as const);
}

describe('a new fillet weld may not overlap an existing weld on the same material contact', () => {
  it('refuses welding the same beads again and leaves the document unchanged', () => {
    const after = welded();
    const snapshot = JSON.stringify(after);
    const again = planFilletWeld(after, teeRequest(), WELD_TEST_REVISIONS, TEE_BODIES);
    const found = overlaps(again);
    expect(found.map(([code, weldId, segment]) => [code, weldId, segment])).toEqual([
      ['overlapsExistingWeld', 'weld-1', 0], ['overlapsExistingWeld', 'weld-1', 1], ['overlapsExistingWeld', 'weld-1', 2]]);
    for (const [index, length] of [20, 15, 25].entries()) expect(found[index]?.[3]).toBeCloseTo(length, 9);
    expect(JSON.stringify(after)).toBe(snapshot);
    expect([...weldSegmentsOf(after).keys()]).toEqual(['weld-1']);
  });

  it('refuses a partial overlap, also when the edge was picked in the opposite direction', () => {
    const after = welded();
    for (const direction of [[1, 0, 0], [-1, 0, 0]] as const) {
      const partial = planFilletWeld(after, teeRequest({ edge: lineEdge([50, 8, 0], direction, 100),
        segments: [{ start: 25, length: 10 }] }), WELD_TEST_REVISIONS, TEE_BODIES);
      const found = overlaps(partial);
      expect(found.map(([code, weldId, segment]) => [code, weldId, segment])).toEqual([['overlapsExistingWeld', 'weld-1', 0]]);
      // 25..35 against the saved bead 10..30.
      expect(found[0]?.[3]).toBeCloseTo(5, 9);
    }
  });

  it('accepts beads that only touch the saved beads end to end, as a separate weld on the same contact', () => {
    const after = welded();
    const gaps = planFilletWeld(after, teeRequest({ segments: [{ start: 30, length: 10 }, { start: 55, length: 15 }] }),
      WELD_TEST_REVISIONS, TEE_BODIES);
    const next = apply(after, gaps);
    expect([...weldSegmentsOf(next).keys()]).toEqual(['weld-1', 'weld-2']);
  });

  it('accepts the same stations on the other side of the standing plate (a different contact line)', () => {
    const after = welded();
    // The standing plate's y=0 side face and its bottom edge meet the base top at y=26, not at y=34.
    const otherSide: FilletWeldRequest = teeRequest({
      first: planeFace('component-1', 'standing', [50, 0, 25], [0, -1, 0]),
      edge: lineEdge([50, 0, 0], [1, 0, 0], 100),
    });
    const next = apply(after, planFilletWeld(after, otherSide, WELD_TEST_REVISIONS, TEE_BODIES));
    expect([...weldSegmentsOf(next).keys()]).toEqual(['weld-1', 'weld-2']);
  });

  it('lets the existing weld be edited without refusing itself, and refuses an edit of another weld into it atomically', () => {
    const after = welded();
    const self = planFilletWeldEdit(after, { weldId: 'weld-1', legOnSecond: 6, legOnFirst: 8,
      segments: [{ start: 10, length: 25 }, { start: 40, length: 15 }, { start: 70, length: 25 }], materialId: 'aluminum' },
    WELD_TEST_REVISIONS, TEE_BODIES);
    expect(self.ok ? [] : self.rejections).toEqual([]);

    const two = apply(after, planFilletWeld(after, teeRequest({ segments: [{ start: 30, length: 10 }] }),
      WELD_TEST_REVISIONS, TEE_BODIES));
    const snapshot = JSON.stringify(two);
    const into = planFilletWeldEdit(two, { weldId: 'weld-2', legOnSecond: 6, legOnFirst: 8,
      segments: [{ start: 25, length: 15 }], materialId: 'aluminum' }, WELD_TEST_REVISIONS, TEE_BODIES);
    const found = overlaps(into);
    expect(found.map(([code, weldId, segment]) => [code, weldId, segment])).toEqual([['overlapsExistingWeld', 'weld-1', 0]]);
    expect(found[0]?.[3]).toBeCloseTo(5, 9);
    expect(JSON.stringify(two)).toBe(snapshot);
    expect((weldSegmentsOf(two).get('weld-2') ?? []).map((bead) => {
      const options = bead.source.kind === 'standardPart' ? filletWeldSegmentOptions(bead.source.options) : null;
      return options === null ? null : [options.station, options.length];
    })).toEqual([[30, 10]]);
  });
});

describe('the comparison does not depend on which plate was picked first', () => {
  // L joint: the standing plate (y 26..34 in the world) on a base strip that starts at its face (world y 34..60).
  // Either plate can then be the first face: both orders form a valid concave corner along the same line.
  const document = (): AssemblyDocument => teeJoint(weldTestPlacement([0, 26, 10]), weldTestPlacement([0, 34, 0]));
  const bodies: WeldBodyLookup = teeBodies({ base: [weldTestBox([0, 0, 0], [100, 26, 10])] });
  const standingFirst: FilletWeldRequest = teeRequest({
    second: planeFace('component-2', 'base', [50, 13, 10], [0, 0, 1]),
    segments: [{ start: 10, length: 20 }],
  });
  const baseFirst: FilletWeldRequest = {
    first: planeFace('component-2', 'base', [50, 13, 10], [0, 0, 1]),
    second: planeFace('component-1', 'standing', [50, 8, 25], [0, 1, 0]),
    edge: lineEdge([50, 0, 10], [1, 0, 0], 100),
    legOnSecond: 6, legOnFirst: 8, materialId: 'aluminum',
    // The reversed order's weld line runs along -X from x=100, so station s is world x = 100 - s.
    segments: [{ start: 75, length: 10 }],
  };

  it('refuses the reversed-order weld over world x 15..25 against the saved bead at x 10..30', () => {
    const before = document();
    const after = apply(before, planFilletWeld(before, standingFirst, WELD_TEST_REVISIONS, bodies));
    const found = overlaps(planFilletWeld(after, baseFirst, WELD_TEST_REVISIONS, bodies));
    expect(found.map(([code, weldId, segment]) => [code, weldId, segment])).toEqual([['overlapsExistingWeld', 'weld-1', 0]]);
    expect(found[0]?.[3]).toBeCloseTo(10, 9);
  });

  it('accepts the reversed-order weld on a free stretch (world x 0..10) of the same line', () => {
    const before = document();
    const after = apply(before, planFilletWeld(before, standingFirst, WELD_TEST_REVISIONS, bodies));
    const free = planFilletWeld(after, { ...baseFirst, segments: [{ start: 90, length: 10 }] }, WELD_TEST_REVISIONS, bodies);
    expect([...weldSegmentsOf(apply(after, free)).keys()]).toEqual(['weld-1', 'weld-2']);
  });
});
