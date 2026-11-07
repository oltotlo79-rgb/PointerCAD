/**
 * Traceable faces, edges and vertices of a planar sheet (FR-428 `planar`).
 *
 * **First target only: a closed profile made of straight lines** (3 to 32 saved, non-construction line
 * features of one sketch). Circles, arcs, ellipses and splines are not given this identity; their sheets keep
 * the ordinary `makePlanarFace` path and no origins (untracked), so no curve is shown as traceable by mistake.
 *
 * Saved names come only from the sheet feature and the source line features:
 * - face   = sheet feature + the set of source line IDs (ascending, unique),
 * - edge   = one whole source line,
 * - vertex = the unordered pair of source lines that meet at the native shared vertex.
 * Current face/edge/vertex numbers are runtime addresses only; coordinates, areas, lengths and proximity are
 * never used to name or match anything. Every binding is proven by native membership (IndexedMap `FindIndex`,
 * which compares with `IsSame`) of the edges that were actually inserted into the wire; anything that is not
 * one-to-one returns untracked instead of a guess.
 */
import type { OpenCascadeInstance, TopoDS_Edge, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import type { CurveSpec } from '../types.js';
import type { CurrentOriginIndex, FaceOrigin, OriginBinding } from '../subShapeOrigin.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import { makeCurveEdge } from './makeSketchEdges.js';
import { address, mapShape } from './subShapeOrigins.js';

/** The saved owner of one profile line (the same closed DTO the open-profile surface already uses). */
type PlanarSurfaceLineAnchor = Extract<FaceOrigin, { readonly kind: 'surface-side' }>['profile'];

const MINIMUM_LINES = 3;
const MAXIMUM_LINES = 32;
const MAXIMUM_ID_LENGTH = 256;

// The refusal texts are the same as makePlanarFace.ts (checked by planarSurfaceOrigins.test.ts).
const DISCONNECTED_MESSAGE = '選んだ線・円弧がつながっていないため、輪郭を作れませんでした。';
const OPEN_MESSAGE = '輪郭が閉じていないため、面を張れませんでした。';
const NOT_PLANAR_MESSAGE = '輪郭が同じ平面に乗っていないため、面を張れませんでした。';
const SELF_INTERSECTING_MESSAGE = '輪郭が自分自身と交わっているため、面を張れませんでした。';

const untracked = (reason: 'missing-native-map' | 'unsupported-profile-piece' | 'limit'): CurrentOriginIndex =>
  ({ version: 1, state: 'untracked', reason });

function validId(id: string): boolean {
  return id.length > 0 && id.length <= MAXIMUM_ID_LENGTH
    && [...id].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
}

function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Whether these anchors may name this profile. `null` = the straight-line path applies; otherwise the reason
 * the sheet stays untracked. Pure (no OCCT), so the refusals are testable without the native kernel.
 */
export function planarSurfaceAnchorRefusal(profile: readonly CurveSpec[],
  anchors: readonly PlanarSurfaceLineAnchor[], featureId: string): 'limit' | 'unsupported-profile-piece' | null {
  if (!validId(featureId) || anchors.length < MINIMUM_LINES || anchors.length > MAXIMUM_LINES) return 'limit';
  if (anchors.length !== profile.length || profile.some(curve => curve.kind !== 'segment')) {
    return 'unsupported-profile-piece';
  }
  const sketchId = anchors[0].sketchId;
  if (new Set(anchors.map(anchor => anchor.lineFeatureId)).size !== anchors.length
    || anchors.some(anchor => anchor.role !== 'whole-line' || anchor.sketchId !== sketchId
      || !validId(anchor.sketchId) || !validId(anchor.lineFeatureId))) return 'unsupported-profile-piece';
  return null;
}

/** The planar sheet built from exactly one native edge per source line, in the given order. */
 interface TrackedPlanarFace {
  readonly face: TopoDS_Shape;
  /** `insertedEdges[i]` is the edge MakeWire actually inserted for `profile[i]` (never a geometric guess). */
  readonly insertedEdges: readonly TopoDS_Edge[];
}

/**
 * Same construction and refusals as makePlanarFace for a straight-line profile, but one edge per curve
 * (no merging) and the actually inserted edge (`MakeWire.Edge()`) is kept for each source line.
 * All allocations belong to `keep` (the caller's makeSurface allocation scope).
 */
export function makeTrackedPlanarFace(oc: OpenCascadeInstance, keep: Allocations['keep'],
  profile: readonly CurveSpec[]): TrackedPlanarFace {
  const wireMaker = keep(new oc.BRepBuilderAPI_MakeWire_1());
  const insertedEdges: TopoDS_Edge[] = [];
  for (const curve of profile) {
    wireMaker.Add_1(keep(makeCurveEdge(oc, curve)).edge);
    if (!wireMaker.IsDone()) throw new Error(DISCONNECTED_MESSAGE);
    insertedEdges.push(keep(wireMaker.Edge()));
  }
  const wire = keep(wireMaker.Wire());
  if (!wire.Closed_1()) throw new Error(OPEN_MESSAGE);
  // Second argument true = planar only (same as makePlanarFace).
  const faceMaker = keep(new oc.BRepBuilderAPI_MakeFace_15(wire, true));
  if (!faceMaker.IsDone()) throw new Error(NOT_PLANAR_MESSAGE);
  const face = keep(faceMaker.Face());
  if (!oc.BRepAlgo.IsValid_1(face)) throw new Error(SELF_INTERSECTING_MESSAGE);
  return { face, insertedEdges };
}

/**
 * Bind the saved face/edge/vertex identities to the actual sheet. `anchors[i]` owns `insertedEdges[i]`.
 * Requires exactly 1 face, n edges and n vertices on the output, each inserted edge a distinct output edge,
 * and each output vertex shared by exactly two distinct source lines with a distinct pair.
 */
export function planarSurfaceSubShapeOrigins(oc: OpenCascadeInstance, output: TopoDS_Shape,
  insertedEdges: readonly TopoDS_Edge[], anchors: readonly PlanarSurfaceLineAnchor[],
  featureId: string): CurrentOriginIndex {
  if (insertedEdges.length !== anchors.length) return untracked('missing-native-map');
  const sorted = anchors.map(anchor => anchor.lineFeatureId).sort(byCodeUnit);
  const [first, second, third, ...rest] = sorted;
  if (first === undefined || second === undefined || third === undefined) return untracked('limit');
  const sketchId = anchors[0].sketchId;
  const owned = createAllocations();
  try {
    const maps = mapShape(oc, output, owned);
    const count = anchors.length;
    if (maps.face.Size() !== 1 || maps.edge.Size() !== count || maps.vertex.Size() !== count) {
      return untracked('missing-native-map');
    }
    const faceAddress = address(maps, output, 'face');
    if (faceAddress === null) return untracked('missing-native-map');
    const bindings: OriginBinding[] = [{ origin: { version: 1, shapeKind: 'face', identity: {
      kind: 'planar-surface-face', featureId, profile: { sketchId, lineFeatureIds: [first, second, third, ...rest] },
    } }, state: 'unique', current: faceAddress }];
    // Edge: the inserted edge itself must be a member of the output (no new or replaced edge).
    const edgeIndices: number[] = [];
    for (let line = 0; line < count; line++) {
      const current = address(maps, insertedEdges[line], 'edge');
      if (current === null || edgeIndices.includes(current.index)) return untracked('missing-native-map');
      edgeIndices.push(current.index);
      bindings.push({ origin: { version: 1, shapeKind: 'edge', identity: {
        kind: 'planar-surface-edge', featureId, profile: anchors[line],
      } }, state: 'unique', current });
    }
    // Vertex: native incidence of the output edges (first/last vertex), never coordinates.
    const linesAtVertex = new Map<number, number[]>();
    for (let line = 0; line < count; line++) {
      const edge = owned.keep(oc.TopoDS.Edge_1(owned.keep(maps.edge.FindKey(edgeIndices[line] + 1))));
      const start = address(maps, owned.keep(oc.TopExp.FirstVertex(edge, false)), 'vertex');
      const end = address(maps, owned.keep(oc.TopExp.LastVertex(edge, false)), 'vertex');
      if (start === null || end === null || start.index === end.index) return untracked('missing-native-map');
      for (const current of [start, end]) {
        const lines = linesAtVertex.get(current.index) ?? [];
        lines.push(line);
        linesAtVertex.set(current.index, lines);
      }
    }
    if (linesAtVertex.size !== count) return untracked('missing-native-map');
    const pairs = new Set<string>();
    for (let vertexIndex = 0; vertexIndex < count; vertexIndex++) {
      const lines = linesAtVertex.get(vertexIndex);
      if (lines === undefined || lines.length !== 2 || lines[0] === lines[1]) return untracked('missing-native-map');
      const [low, high] = [anchors[lines[0]].lineFeatureId, anchors[lines[1]].lineFeatureId].sort(byCodeUnit);
      const pair = JSON.stringify([low, high]);
      if (pairs.has(pair)) return untracked('missing-native-map');
      pairs.add(pair);
      bindings.push({ origin: { version: 1, shapeKind: 'vertex', identity: {
        kind: 'planar-surface-vertex', featureId, profile: { sketchId, lineFeatureIds: [low, high] },
      } }, state: 'unique', current: { kind: 'vertex', index: vertexIndex } });
    }
    return { version: 1, state: 'tracked', bindings };
  } finally { owned.release(); }
}
