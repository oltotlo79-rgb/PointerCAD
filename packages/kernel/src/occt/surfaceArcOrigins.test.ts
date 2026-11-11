import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ArcSpec } from '../types.js';
import { createAllocations } from './allocations.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeArcEdge } from './makeSketchEdges.js';
import { surfaceArcAnchorValid, surfaceArcPrismOrigins } from './surfaceArcOrigins.js';

const anchor = { sketchId: 'sketch', curveFeatureId: 'arc', role: 'whole-curve' } as const;
const arc: ArcSpec = { kind: 'arc', center: [0, 0, 0], normal: [1, 0, 0], xAxis: [0, 1, 0],
  radius: 25, startAngle: 50 * Math.PI / 180, endAngle: Math.PI / 2 };

describe('single saved arc native surface history', () => {
  let oc: OpenCascadeInstance;
  beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);

  it.each([
    { ...arc, startAngle: -0.1 }, { ...arc, endAngle: 2 * Math.PI + 0.1 },
    { ...arc, startAngle: 0, endAngle: 2 * Math.PI }, { ...arc, endAngle: arc.startAngle },
  ])('does not claim noncanonical, wrapped, closed or degenerate intervals', invalid => {
    expect(surfaceArcAnchorValid([invalid], anchor)).toBe(false);
  });

  it('does not accept multiple profiles or line-shaped anchors', () => {
    expect(surfaceArcAnchorValid([arc, arc], anchor)).toBe(false);
    expect(surfaceArcAnchorValid([arc], undefined)).toBe(false);
    expect(surfaceArcAnchorValid([arc], null)).toBe(false);
    expect(surfaceArcAnchorValid([arc], { ...anchor, role: 'whole-line' })).toBe(false);
    expect(surfaceArcAnchorValid([arc], { ...anchor, faceFeatureId: 'invented' })).toBe(false);
    expect(surfaceArcAnchorValid([arc], { ...anchor, curveFeatureId: '' })).toBe(false);
  });

  it('refuses real foreign output members and mismatched source endpoint roles', () => {
    const owned = createAllocations();
    const build = () => {
      const edge = owned.keep(makeArcEdge(oc, arc)).edge;
      const wireMaker = owned.keep(new oc.BRepBuilderAPI_MakeWire_1());
      wireMaker.Add_1(edge);
      const wire = owned.keep(wireMaker.Wire());
      const vector = owned.keep(new oc.gp_Vec_4(25, 0, 0));
      const prism = owned.keep(new oc.BRepPrimAPI_MakePrism_1(wire, vector, false, true));
      return { edge, wire, prism, output: owned.keep(prism.Shape()) };
    };
    try {
      const first = build(), second = build();
      expect(surfaceArcPrismOrigins(oc, first.prism, first.wire, first.output,
        first.edge, arc, anchor, 'sheet').state).toBe('tracked');
      expect(surfaceArcPrismOrigins(oc, first.prism, first.wire, second.output,
        first.edge, arc, anchor, 'sheet').state).toBe('untracked');
      expect(surfaceArcPrismOrigins(oc, first.prism, first.wire, first.output,
        first.edge, { ...arc, startAngle: arc.endAngle, endAngle: arc.startAngle }, anchor, 'sheet').state)
        .toBe('untracked');
    } finally { owned.release(); }
  });
});
