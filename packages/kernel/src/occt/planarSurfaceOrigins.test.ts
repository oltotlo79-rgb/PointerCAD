import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';

import type { CurrentOriginIndex, SubShapeOrigin } from '../subShapeOrigin.js';
import type { CurveSpec, Vec3Tuple } from '../types.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makePlanarFace } from './makePlanarFace.js';
import { makeSurface } from './makeSurface.js';
import { planarSurfaceAnchorRefusal } from './planarSurfaceOrigins.js';
import {
  anchorsOf, expectedCorners, expectedFaceLineIds, expectedMidpoints, PLANAR_FEATURE_ID, PLANAR_SKETCH_ID,
  profileOf, RECTANGLE_AREA, RECTANGLE_LINES, renamedLoop, reorderedLoop, type SourceLine,
} from './planarSurfaceOrigins.testSupport.js';
import type { SubShapeTables } from './subShapes.js';
import { collectSubShapes } from './subShapes.js';
import { tessellate } from './tessellate.js';

/**
 * Planar sheet origins on the real OCCT kernel (FR-428 `planar`, closed straight-line profile only).
 * Expected counts, IDs, midpoints and corner pairs all come from planarSurfaceOrigins.testSupport.ts (the input);
 * the kernel output is only compared against them, never used as an expectation.
 */
const TOLERANCE_DIGITS = 9;

interface Observed {
  readonly origins: CurrentOriginIndex | undefined;
  readonly area: number;
  readonly tables: SubShapeTables;
}

describe('planar sheet face/edge/vertex origins (real kernel)', () => {
  let oc: OpenCascadeInstance;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  function collectTables(shape: TopoDS_Shape): SubShapeTables {
    const surface = tessellate(oc, shape);
    const lines = extractEdges(oc, shape);
    return collectSubShapes(oc, shape, surface.faceRanges, lines.edgeRanges);
  }

  function build(lines: readonly SourceLine[], featureId: string | undefined = PLANAR_FEATURE_ID,
    anchors = anchorsOf(lines)): Observed {
    const handle = makeSurface(oc, { kind: 'planar', profile: profileOf(lines), profileOrigins: anchors },
      null, null, {}, featureId);
    try {
      return { origins: handle.origins, area: handle.area, tables: collectTables(handle.shape) };
    } finally { handle.delete(); }
  }

  function close(actual: Vec3Tuple, expected: Vec3Tuple): void {
    for (const axis of [0, 1, 2]) expect(actual[axis]).toBeCloseTo(expected[axis], TOLERANCE_DIGITS);
  }

  /** Checks one build against the input-derived expectations and returns the saved identities as JSON. */
  function expectTracked(lines: readonly SourceLine[], observed: Observed): ReadonlySet<string> {
    const count = lines.length;
    expect(observed.area).toBeCloseTo(RECTANGLE_AREA, TOLERANCE_DIGITS);
    expect(observed.tables.faces).toHaveLength(1);
    expect(observed.tables.edges).toHaveLength(count);
    expect(observed.tables.vertices).toHaveLength(count);
    const origins = observed.origins;
    if (origins?.state !== 'tracked') throw new Error(`Expected tracked origins, got ${JSON.stringify(origins)}`);
    expect(origins.bindings).toHaveLength(1 + count + count);
    const saved: string[] = [];
    const used = { face: new Set<number>(), edge: new Set<number>(), vertex: new Set<number>() };
    const midpoints = expectedMidpoints(lines);
    const corners = expectedCorners(lines);
    const seenEdges = new Set<string>(), seenCorners = new Set<string>();
    for (const binding of origins.bindings) {
      if (binding.state !== 'unique') throw new Error(`Expected unique binding, got ${binding.state}`);
      const { origin, current } = binding;
      expect(origin.version).toBe(1);
      expect(current.kind).toBe(origin.shapeKind);
      expect(used[current.kind].has(current.index)).toBe(false);
      used[current.kind].add(current.index);
      saved.push(JSON.stringify(origin));
      const identity = origin.identity;
      expect(identity.featureId).toBe(PLANAR_FEATURE_ID);
      switch (identity.kind) {
        case 'planar-surface-face':
          expect(identity.profile).toEqual({ sketchId: PLANAR_SKETCH_ID, lineFeatureIds: expectedFaceLineIds(lines) });
          expect(observed.tables.faces[current.index]?.index).toBe(current.index);
          break;
        case 'planar-surface-edge': {
          expect(identity.profile.sketchId).toBe(PLANAR_SKETCH_ID);
          expect(identity.profile.role).toBe('whole-line');
          const expected = midpoints.get(identity.profile.lineFeatureId);
          if (expected === undefined) throw new Error(`Unknown source line ${identity.profile.lineFeatureId}`);
          seenEdges.add(identity.profile.lineFeatureId);
          const edge = observed.tables.edges.find(item => item.index === current.index);
          if (edge === undefined) throw new Error('Bound edge missing from the current tables');
          close(edge.midpoint, expected);
          break;
        }
        case 'planar-surface-vertex': {
          expect(identity.profile.sketchId).toBe(PLANAR_SKETCH_ID);
          const corner = corners.find(item => item.lineFeatureIds[0] === identity.profile.lineFeatureIds[0]
            && item.lineFeatureIds[1] === identity.profile.lineFeatureIds[1]);
          if (corner === undefined) throw new Error(`Unexpected line pair ${identity.profile.lineFeatureIds.join(',')}`);
          seenCorners.add(identity.profile.lineFeatureIds.join(','));
          const vertex = observed.tables.vertices.find(item => item.index === current.index);
          if (vertex === undefined) throw new Error('Bound vertex missing from the current tables');
          close(vertex.position, corner.position);
          break;
        }
        default:
          throw new Error(`Unexpected identity kind ${identity.kind}`);
      }
    }
    expect([...seenEdges].sort()).toEqual(lines.map(line => line.id).sort());
    expect(seenCorners.size).toBe(corners.length);
    expect(used.face.size).toBe(1);
    expect(used.edge.size).toBe(count);
    expect(used.vertex.size).toBe(count);
    return new Set(saved);
  }

  it('gives the 40 x 30 sheet one face, four edges and four vertices from the same saved lines', () => {
    const identities = expectTracked(RECTANGLE_LINES, build(RECTANGLE_LINES));
    expect(identities.size).toBe(9);
  });

  it('keeps every saved meaning when only the native enumeration order changes', () => {
    const base = expectTracked(RECTANGLE_LINES, build(RECTANGLE_LINES));
    for (const reversed of [false, true]) {
      for (let start = 0; start < RECTANGLE_LINES.length; start++) {
        const loop = reorderedLoop(RECTANGLE_LINES, start, reversed);
        expect(expectTracked(loop, build(loop))).toEqual(base);
      }
    }
  });

  it('does not match the same geometry owned by other saved line IDs', () => {
    const base = expectTracked(RECTANGLE_LINES, build(RECTANGLE_LINES));
    const renamed = renamedLoop(RECTANGLE_LINES, 'other-');
    const other = expectTracked(renamed, build(renamed));
    expect([...other].filter(identity => base.has(identity))).toEqual([]);
  });

  it('keeps duplicated, mismatched or foreign-sketch owners untracked while still building the sheet', () => {
    const duplicate = anchorsOf(RECTANGLE_LINES).map((anchor, index) => index === 3
      ? { ...anchor, lineFeatureId: RECTANGLE_LINES[0].id } : anchor);
    const foreign = anchorsOf(RECTANGLE_LINES).map((anchor, index) => index === 2
      ? { ...anchor, sketchId: 'other-sketch' } : anchor);
    for (const anchors of [duplicate, foreign, anchorsOf(RECTANGLE_LINES).slice(0, 3)]) {
      const observed = build(RECTANGLE_LINES, PLANAR_FEATURE_ID, anchors);
      expect(observed.area).toBeCloseTo(RECTANGLE_AREA, TOLERANCE_DIGITS);
      expect(observed.origins).toEqual({ version: 1, state: 'untracked', reason: 'unsupported-profile-piece' });
    }
  });

  it('gives no origins without the saved owners or the creating feature (legacy path unchanged)', () => {
    // Call the production entry without featureId: passing undefined to build would activate its default owner.
    const anonymous = makeSurface(oc, { kind: 'planar', profile: profileOf(RECTANGLE_LINES),
      profileOrigins: anchorsOf(RECTANGLE_LINES) }, null, null, {});
    try {
      expect(anonymous.origins).toBeUndefined();
      expect(anonymous.area).toBeCloseTo(RECTANGLE_AREA, TOLERANCE_DIGITS);
    } finally { anonymous.delete(); }
    const handle = makeSurface(oc, { kind: 'planar', profile: profileOf(RECTANGLE_LINES) }, null, null, {}, PLANAR_FEATURE_ID);
    try {
      expect(handle.origins).toBeUndefined();
      expect(handle.area).toBeCloseTo(RECTANGLE_AREA, TOLERANCE_DIGITS);
    } finally { handle.delete(); }
  });

  it('does not pretend that a profile with an arc is traceable', () => {
    // Half disc of radius 10: the arc from (10,0,0) to (-10,0,0) through +y, closed by the diameter line.
    const profile: readonly CurveSpec[] = [
      { kind: 'arc', center: [0, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0], radius: 10, startAngle: 0, endAngle: Math.PI },
      { kind: 'segment', from: [-10, 0, 0], to: [10, 0, 0] },
    ];
    const anchors = [
      { sketchId: PLANAR_SKETCH_ID, lineFeatureId: 'arc', role: 'whole-line' as const },
      { sketchId: PLANAR_SKETCH_ID, lineFeatureId: 'diameter', role: 'whole-line' as const },
    ];
    const handle = makeSurface(oc, { kind: 'planar', profile, profileOrigins: anchors }, null, null, {}, PLANAR_FEATURE_ID);
    try {
      expect(handle.area).toBeCloseTo(Math.PI * 50, 6);
      expect(handle.origins?.state).toBe('untracked');
    } finally { handle.delete(); }
  });

  it('refuses open and self-intersecting straight profiles with the same reasons as makePlanarFace', () => {
    const open: readonly SourceLine[] = RECTANGLE_LINES.slice(0, 3);
    const bowtie: readonly SourceLine[] = [
      { id: 'a', from: [0, 0, 0], to: [40, 30, 0] },
      { id: 'b', from: [40, 30, 0], to: [40, 0, 0] },
      { id: 'c', from: [40, 0, 0], to: [0, 30, 0] },
      { id: 'd', from: [0, 30, 0], to: [0, 0, 0] },
    ];
    for (const lines of [open, bowtie]) {
      let expected = '';
      try { makePlanarFace(oc, profileOf(lines)).delete(); } catch (error) { expected = error instanceof Error ? error.message : ''; }
      expect(expected.length).toBeGreaterThan(0);
      expect(() => build(lines)).toThrow(expected);
    }
  });

  it('bounds the anchor count and checks the anchors before any native work', () => {
    const many = Array.from({ length: 33 }, (_, at) => ({ sketchId: PLANAR_SKETCH_ID,
      lineFeatureId: `line-${at}`, role: 'whole-line' as const }));
    const segments = many.map((_, at): CurveSpec => ({ kind: 'segment', from: [at, 0, 0], to: [at + 1, 0, 0] }));
    expect(planarSurfaceAnchorRefusal(segments, many, PLANAR_FEATURE_ID)).toBe('limit');
    expect(planarSurfaceAnchorRefusal(profileOf(RECTANGLE_LINES), anchorsOf(RECTANGLE_LINES), '')).toBe('limit');
    expect(planarSurfaceAnchorRefusal(profileOf(RECTANGLE_LINES), anchorsOf(RECTANGLE_LINES), PLANAR_FEATURE_ID)).toBeNull();
    const withControl = anchorsOf(RECTANGLE_LINES).map((anchor, index) => index === 0
      ? { ...anchor, lineFeatureId: `bad${String.fromCharCode(7)}` } : anchor);
    expect(planarSurfaceAnchorRefusal(profileOf(RECTANGLE_LINES), withControl, PLANAR_FEATURE_ID)).toBe('unsupported-profile-piece');
  });

  it('keeps the saved identities JSON-stable through a save/read roundtrip', () => {
    const observed = build(RECTANGLE_LINES);
    if (observed.origins?.state !== 'tracked') throw new Error('Expected tracked origins');
    const saved: readonly SubShapeOrigin[] = observed.origins.bindings.map(binding => binding.origin);
    const read: unknown = JSON.parse(JSON.stringify(saved));
    expect(read).toEqual(saved);
  });
});
