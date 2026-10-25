import type { BRepBuilderAPI_Transform, BRepBuilderAPI_MakeShape, BRepBuilderAPI_Copy, BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakePrism, BRepPrimAPI_MakeSphere, BRepPrimAPI_MakeCone, BRepPrimAPI_MakeTorus,
  OpenCascadeInstance, TopLoc_Location, TopoDS_Edge, TopoDS_Shape,
  TopTools_IndexedMapOfShape, TopTools_ListOfShape } from 'opencascade.js/dist/opencascade.full.js';
import { OriginHistoryLimitError } from './subShapeHistory.js';
import { withinOriginLimits } from './composeSubShapeOrigins.js';
import { createAllocations, type Allocations } from './allocations.js';
import type { BoxEdgeRole, BoxFaceRole, BoxVertexRole, CylinderEdgeRole, CylinderFaceRole,
  CylinderVertexRole, CurrentOriginIndex,
  OriginBinding, SubShapeOrigin, FaceOrigin, HoleFaceOrigin, HoleThreadGrooveOrigin, ProfileLineAnchor, ProfileRegionAnchor, ShapeAddress } from '../subShapeOrigin.js';

/** A failed naming map does not invalidate successful native geometry. */
export class HoleOriginMapError extends Error {}

type Kind = ShapeAddress['kind'];
type Maps = Readonly<Record<Kind, TopTools_IndexedMapOfShape>>;
const faceRoles: readonly BoxFaceRole[] = ['bottom', 'top', 'front', 'back', 'left', 'right'];
const edgeRoles: readonly BoxEdgeRole[] = [
  'bottom-front', 'bottom-back', 'bottom-left', 'bottom-right',
  'top-front', 'top-back', 'top-left', 'top-right',
  'front-left', 'front-right', 'back-left', 'back-right',
];
const vertexRoles: readonly BoxVertexRole[] = [
  'bottom-front-left', 'bottom-front-right', 'bottom-back-left', 'bottom-back-right',
  'top-front-left', 'top-front-right', 'top-back-left', 'top-back-right',
];
const untracked = (reason: 'missing-native-map' | 'unsupported-profile-piece' | 'limit'): CurrentOriginIndex =>
  ({ version: 1, state: 'untracked', reason });

function kindOf(oc: OpenCascadeInstance, shape: TopoDS_Shape): Kind | null {
  const value = shape.ShapeType();
  if (value === oc.TopAbs_ShapeEnum.TopAbs_FACE) return 'face';
  if (value === oc.TopAbs_ShapeEnum.TopAbs_EDGE) return 'edge';
  if (value === oc.TopAbs_ShapeEnum.TopAbs_VERTEX) return 'vertex';
  return null;
}

function mapShape(oc: OpenCascadeInstance, shape: TopoDS_Shape, owned: Allocations, maximumNativeMembers?: number): Maps {
  const maps: Record<Kind, TopTools_IndexedMapOfShape> = {
    face: owned.keep(new oc.TopTools_IndexedMapOfShape_1()),
    edge: owned.keep(new oc.TopTools_IndexedMapOfShape_1()),
    vertex: owned.keep(new oc.TopTools_IndexedMapOfShape_1()),
  };
  const all = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
  oc.TopExp.MapShapes_2(shape, all, true, true);
  if (maximumNativeMembers !== undefined && all.Size() > maximumNativeMembers) throw new OriginHistoryLimitError();
  for (let index = 1; index <= all.Size(); index++) {
    const member = owned.keep(all.FindKey(index));
    const kind = kindOf(oc, member);
    if (kind !== null) maps[kind].Add(member);
  }
  return maps;
}

function address(maps: Maps, shape: TopoDS_Shape, kind: Kind): ShapeAddress | null {
  if (shape.IsNull()) return null;
  const index = maps[kind].FindIndex(shape);
  return index > 0 ? { kind, index: index - 1 } : null;
}

/** The six face roles come only from the live maker; edge and vertex roles come from native incidence. */
export function boxSubShapeOrigins(oc: OpenCascadeInstance, maker: BRepPrimAPI_MakeBox,
  output: TopoDS_Shape, featureId: string): CurrentOriginIndex {
  if (featureId.length > 256) return untracked('limit');
  const owned = createAllocations();
  try {
    const outputMaps = mapShape(oc, output, owned);
    if (outputMaps.face.Size() !== 6 || outputMaps.edge.Size() !== 12 || outputMaps.vertex.Size() !== 8) {
      return untracked('missing-native-map');
    }
    const nativeFaces: Readonly<Record<BoxFaceRole, TopoDS_Shape>> = {
      bottom: owned.keep(maker.BottomFace()), top: owned.keep(maker.TopFace()),
      front: owned.keep(maker.FrontFace()), back: owned.keep(maker.BackFace()),
      left: owned.keep(maker.LeftFace()), right: owned.keep(maker.RightFace()),
    };
    const faceMaps: Partial<Record<BoxFaceRole, Maps>> = {};
    const bindings: OriginBinding[] = [];
    const seenFaces = new Set<number>();
    for (const role of faceRoles) {
      const current = address(outputMaps, nativeFaces[role], 'face');
      if (current === null || seenFaces.has(current.index)) return untracked('missing-native-map');
      seenFaces.add(current.index);
      faceMaps[role] = mapShape(oc, nativeFaces[role], owned);
      bindings.push({ origin: { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId, role } },
        state: 'unique', current });
    }
    const seenEdges = new Set<string>(), seenVertices = new Set<string>();
    for (const kind of ['edge', 'vertex'] as const) {
      const map = outputMaps[kind];
      for (let index = 1; index <= map.Size(); index++) {
        const member = owned.keep(map.FindKey(index));
        const incident = faceRoles.filter(role => (faceMaps[role]?.[kind].FindIndex(member) ?? 0) > 0);
        const role = incident.join('-');
        const allowed: readonly string[] = kind === 'edge' ? edgeRoles : vertexRoles;
        const seen = kind === 'edge' ? seenEdges : seenVertices;
        if (!allowed.includes(role) || seen.has(role)) return untracked('missing-native-map');
        seen.add(role);
        const current: ShapeAddress = { kind, index: index - 1 };
        if (kind === 'edge') bindings.push({ origin: { version: 1, shapeKind: 'edge',
          identity: { kind: 'box-edge', featureId, role: role as BoxEdgeRole } }, state: 'unique', current });
        else bindings.push({ origin: { version: 1, shapeKind: 'vertex',
          identity: { kind: 'box-vertex', featureId, role: role as BoxVertexRole } }, state: 'unique', current });
      }
    }
    if (seenEdges.size !== edgeRoles.length || seenVertices.size !== vertexRoles.length) return untracked('missing-native-map');
    return { version: 1, state: 'tracked', bindings };
  } finally { owned.release(); }
}

/** A whole sphere has one native surface. No seam/pole identities are inferred. */
export function sphereSubShapeOrigins(oc: OpenCascadeInstance, maker: BRepPrimAPI_MakeSphere,
  output: TopoDS_Shape, featureId: string): CurrentOriginIndex {
  if (featureId.length > 256) return untracked('limit');
  const owned = createAllocations();
  try {
    const maps = mapShape(oc, output, owned);
    if (maps.face.Size() !== 1) return untracked('missing-native-map');
    const sphere = owned.keep(maker.Sphere());
    const surface = owned.keep(sphere.LateralFace()), alias = owned.keep(maker.Face());
    if (kindOf(oc, surface) !== 'face' || kindOf(oc, alias) !== 'face') return untracked('missing-native-map');
    const current = address(maps, surface, 'face'), other = address(maps, alias, 'face');
    if (current === null || other === null || current.index !== other.index) return untracked('missing-native-map');
    const member = owned.keep(maps.face.FindKey(current.index + 1));
    if (!member.IsSame(surface) || !member.IsSame(alias)) return untracked('missing-native-map');
    return { version: 1, state: 'tracked', bindings: [{
      origin: { version: 1, shapeKind: 'face', identity: { kind: 'sphere-face', featureId, role: 'surface' } },
      state: 'unique', current,
    }] };
  } finally { owned.release(); }
}

/** Native caps exist only at non-apex ends; current face indexes never name a producer. */
export function coneSubShapeOrigins(oc: OpenCascadeInstance, maker: BRepPrimAPI_MakeCone,
  output: TopoDS_Shape, featureId: string): CurrentOriginIndex {
  if (featureId.length > 256) return untracked('limit');
  const owned = createAllocations();
  try {
    const produced = owned.keep(maker.Shape());
    if (output.IsNull() || !output.IsSame(produced) || output.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SOLID) {
      return untracked('missing-native-map');
    }
    const cone = owned.keep(maker.Cone());
    if (cone.HasSides()) return untracked('missing-native-map');
    const hasStart = cone.HasBottom(), hasEnd = cone.HasTop();
    if (!hasStart && !hasEnd) return untracked('missing-native-map');
    const maps = mapShape(oc, output, owned);
    if (maps.face.Size() !== 1 + Number(hasStart) + Number(hasEnd)) return untracked('missing-native-map');
    const side = owned.keep(cone.LateralFace()), alias = owned.keep(maker.Face());
    if (kindOf(oc, side) !== 'face' || kindOf(oc, alias) !== 'face' || !side.IsSame(alias)) {
      return untracked('missing-native-map');
    }
    const faces: { readonly role: 'side' | 'start' | 'end'; readonly shape: TopoDS_Shape }[] = [
      { role: 'side', shape: side },
    ];
    if (hasStart) faces.push({ role: 'start', shape: owned.keep(cone.BottomFace()) });
    if (hasEnd) faces.push({ role: 'end', shape: owned.keep(cone.TopFace()) });
    const bindings: OriginBinding[] = [], seen = new Set<number>();
    for (const { role, shape } of faces) {
      if (kindOf(oc, shape) !== 'face') return untracked('missing-native-map');
      const current = address(maps, shape, 'face');
      if (current === null || seen.has(current.index)) return untracked('missing-native-map');
      const member = owned.keep(maps.face.FindKey(current.index + 1));
      if (!member.IsSame(shape)) return untracked('missing-native-map');
      seen.add(current.index);
      bindings.push({ origin: { version: 1, shapeKind: 'face', identity: {
        kind: 'cone-face', featureId, role,
      } }, state: 'unique', current });
    }
    return seen.size === maps.face.Size() ? { version: 1, state: 'tracked', bindings } : untracked('missing-native-map');
  } finally { owned.release(); }
}

/** Both toroidal periods must be closed; the whole maker solid owns its sole surface. */
export function torusSubShapeOrigins(oc: OpenCascadeInstance, maker: BRepPrimAPI_MakeTorus,
  output: TopoDS_Shape, featureId: string): CurrentOriginIndex {
  if (featureId.length > 256) return untracked('limit');
  const owned = createAllocations();
  try {
    const produced = owned.keep(maker.Shape());
    if (output.IsNull() || !output.IsSame(produced) || output.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SOLID) {
      return untracked('missing-native-map');
    }
    const torus = owned.keep(maker.Torus());
    if (torus.HasSides() || torus.HasBottom() || torus.HasTop() || !torus.MeridianClosed()) {
      return untracked('missing-native-map');
    }
    const maps = mapShape(oc, output, owned);
    if (maps.face.Size() !== 1) return untracked('missing-native-map');
    const surface = owned.keep(torus.LateralFace()), alias = owned.keep(maker.Face());
    if (kindOf(oc, surface) !== 'face' || kindOf(oc, alias) !== 'face') return untracked('missing-native-map');
    const current = address(maps, surface, 'face'), other = address(maps, alias, 'face');
    if (current === null || other === null || current.index !== other.index) return untracked('missing-native-map');
    const member = owned.keep(maps.face.FindKey(current.index + 1));
    if (!member.IsSame(surface) || !member.IsSame(alias)) return untracked('missing-native-map');
    return { version: 1, state: 'tracked', bindings: [{
      origin: { version: 1, shapeKind: 'face', identity: { kind: 'torus-face', featureId, role: 'surface' } },
      state: 'unique', current,
    }] };
  } finally { owned.release(); }
}

/** Only the full native 3/3/2 output can acquire cylinder origins. Full-turn aliases must agree. */
export function cylinderSubShapeOrigins(oc: OpenCascadeInstance, maker: BRepPrimAPI_MakeCylinder,
  output: TopoDS_Shape, featureId: string): CurrentOriginIndex {
  if (featureId.length > 256) return untracked('limit');
  const owned = createAllocations();
  try {
    const maps = mapShape(oc, output, owned);
    if (maps.face.Size() !== 3 || maps.edge.Size() !== 3 || maps.vertex.Size() !== 2) {
      return untracked('missing-native-map');
    }
    const cylinder = owned.keep(maker.Cylinder());
    const nativeFaces: Readonly<Record<CylinderFaceRole, TopoDS_Shape>> = {
      side: owned.keep(cylinder.LateralFace()), start: owned.keep(cylinder.BottomFace()),
      end: owned.keep(cylinder.TopFace()),
    };
    const nativeEdges: Readonly<Record<CylinderEdgeRole, TopoDS_Shape>> = {
      'start-ring': owned.keep(cylinder.BottomEdge()), 'end-ring': owned.keep(cylinder.TopEdge()),
      seam: owned.keep(cylinder.StartEdge()),
    };
    const nativeVertices: Readonly<Record<CylinderVertexRole, TopoDS_Shape>> = {
      'seam-start': owned.keep(cylinder.BottomStartVertex()),
      'seam-end': owned.keep(cylinder.TopStartVertex()),
    };
    const sameMember = (shape: TopoDS_Shape, alias: TopoDS_Shape, kind: Kind): boolean => {
      if (kindOf(oc, shape) !== kind || kindOf(oc, alias) !== kind) return false;
      const first = address(maps, shape, kind), second = address(maps, alias, kind);
      if (first === null || second === null || first.index !== second.index) return false;
      const member = owned.keep(maps[kind].FindKey(first.index + 1));
      return member.IsSame(shape) && member.IsSame(alias);
    };
    if (!sameMember(nativeFaces.side, owned.keep(maker.Face()), 'face')
      || !sameMember(nativeEdges.seam, owned.keep(cylinder.EndEdge()), 'edge')
      || !sameMember(nativeVertices['seam-start'], owned.keep(cylinder.BottomEndVertex()), 'vertex')
      || !sameMember(nativeVertices['seam-end'], owned.keep(cylinder.TopEndVertex()), 'vertex')) {
      return untracked('missing-native-map');
    }
    const bindings: OriginBinding[] = [], seen = new Set<string>();
    const bind = (kind: Kind, role: string, shape: TopoDS_Shape): ShapeAddress | null => {
      if (kindOf(oc, shape) !== kind) return null;
      const current = address(maps, shape, kind);
      if (current === null || seen.has(`${kind}:${current.index}`)) return null;
      const member = owned.keep(maps[kind].FindKey(current.index + 1));
      if (!member.IsSame(shape)) return null;
      seen.add(`${kind}:${current.index}`);
      if (kind === 'face') bindings.push({ origin: { version: 1, shapeKind: 'face', identity: {
        kind: 'cylinder-face', featureId, role: role as CylinderFaceRole } }, state: 'unique', current });
      if (kind === 'edge') bindings.push({ origin: { version: 1, shapeKind: 'edge', identity: {
        kind: 'cylinder-edge', featureId, role: role as CylinderEdgeRole } }, state: 'unique', current });
      if (kind === 'vertex') bindings.push({ origin: { version: 1, shapeKind: 'vertex', identity: {
        kind: 'cylinder-vertex', featureId, role: role as CylinderVertexRole } }, state: 'unique', current });
      return current;
    };
    for (const role of ['side', 'start', 'end'] as const) {
      if (bind('face', role, nativeFaces[role]) === null) return untracked('missing-native-map');
    }
    for (const role of ['start-ring', 'end-ring', 'seam'] as const) {
      if (bind('edge', role, nativeEdges[role]) === null) return untracked('missing-native-map');
    }
    for (const role of ['seam-start', 'seam-end'] as const) {
      if (bind('vertex', role, nativeVertices[role]) === null) return untracked('missing-native-map');
    }
    return seen.size === 8 ? { version: 1, state: 'tracked', bindings } : untracked('missing-native-map');
  } finally { owned.release(); }
}

/** Rebinds every native primitive address through actual Copy mapping and optional Location. */
function rebindCopiedPrimitiveOrigins(oc: OpenCascadeInstance, source: CurrentOriginIndex,
  sourceShape: TopoDS_Shape, copier: BRepBuilderAPI_Copy, output: TopoDS_Shape,
  featureId: string, primitive: 'box' | 'cylinder', location?: TopLoc_Location): CurrentOriginIndex {
  if (source.state !== 'tracked') return source;
  if (featureId.length > 256) return untracked('limit');
  const owned = createAllocations();
  try {
    const before = mapShape(oc, sourceShape, owned), after = mapShape(oc, output, owned);
    const counts = primitive === 'box' ? [6, 12, 8] : [3, 3, 2];
    if ([before, after].some(maps => maps.face.Size() !== counts[0]
      || maps.edge.Size() !== counts[1] || maps.vertex.Size() !== counts[2])) return untracked('missing-native-map');
    const bindings: OriginBinding[] = [];
    const used = new Set<string>(), roles = new Set<string>();
    if (source.bindings.length !== counts[0] + counts[1] + counts[2]) return untracked('missing-native-map');
    for (const binding of source.bindings) {
      if (binding.state !== 'unique' || binding.origin.shapeKind !== binding.current.kind
        || binding.origin.identity.kind !== `${primitive}-${binding.current.kind}`) return untracked('missing-native-map');
      const { kind, index } = binding.current;
      const role = 'role' in binding.origin.identity ? binding.origin.identity.role : undefined;
      const roleKey = `${kind}:${role}`;
      const allowed: readonly string[] = primitive === 'box'
        ? kind === 'face' ? faceRoles : kind === 'edge' ? edgeRoles : vertexRoles
        : kind === 'face' ? ['side', 'start', 'end']
          : kind === 'edge' ? ['start-ring', 'end-ring', 'seam'] : ['seam-start', 'seam-end'];
      if (typeof role !== 'string' || !allowed.includes(role) || roles.has(roleKey)) return untracked('missing-native-map');
      roles.add(roleKey);
      if (index < 0 || index >= before[kind].Size()) return untracked('missing-native-map');
      const original = owned.keep(before[kind].FindKey(index + 1));
      const copied = owned.keep(copier.ModifiedShape(original));
      if (copied.IsNull() || kindOf(oc, copied) !== kind) return untracked('missing-native-map');
      const mapped = location === undefined ? copied : owned.keep(copied.Moved(location, true));
      const current = address(after, mapped, kind);
      if (current === null) return untracked('missing-native-map');
      const currentKey = `${kind}:${current.index}`;
      if (used.has(currentKey)) return untracked('missing-native-map');
      used.add(currentKey);
      const found = owned.keep(after[kind].FindKey(current.index + 1));
      if (!found.IsSame(mapped)) return untracked('missing-native-map');
      const identity = { ...binding.origin.identity, featureId };
      const origin = { version: 1 as const, shapeKind: kind, identity } as OriginBinding['origin'];
      bindings.push({ origin, state: 'unique', current });
    }
    if (bindings.length !== counts[0] + counts[1] + counts[2] || roles.size !== bindings.length
      || used.size !== after.face.Size() + after.edge.Size() + after.vertex.Size()) return untracked('missing-native-map');
    return { version: 1, state: 'tracked', bindings };
  } finally { owned.release(); }
}

export function rebindCopiedBoxOrigins(oc: OpenCascadeInstance, source: CurrentOriginIndex,
  sourceShape: TopoDS_Shape, copier: BRepBuilderAPI_Copy, output: TopoDS_Shape,
  featureId: string, location?: TopLoc_Location): CurrentOriginIndex {
  return rebindCopiedPrimitiveOrigins(oc, source, sourceShape, copier, output, featureId, 'box', location);
}

export function rebindCopiedCylinderOrigins(oc: OpenCascadeInstance, source: CurrentOriginIndex,
  sourceShape: TopoDS_Shape, copier: BRepBuilderAPI_Copy, output: TopoDS_Shape,
  featureId: string, location?: TopLoc_Location): CurrentOriginIndex {
  return rebindCopiedPrimitiveOrigins(oc, source, sourceShape, copier, output, featureId, 'cylinder', location);
}

/**
 * A rigid transform (BRepBuilderAPI_Transform with copy) keeps every native member of its target. Each address of a
 * tracked target index is carried through the actual transform history (ModifiedShape) into the output maps, with the
 * same membership, IsSame and uniqueness proof as the copied-primitive rebind. Producer identities stay unchanged: a
 * rigid move creates no new semantic identity. The same exact mapping admits an identity BRepBuilderAPI_Copy;
 * no index/order shortcut is used. Any member the history does not prove leaves the result untracked.
 */
export function rebindTransformedOrigins(oc: OpenCascadeInstance, source: CurrentOriginIndex,
  sourceShape: TopoDS_Shape, maker: Pick<BRepBuilderAPI_Transform, 'ModifiedShape'>, output: TopoDS_Shape): CurrentOriginIndex {
  if (source.state !== 'tracked') return source;
  const owned = createAllocations();
  try {
    const before = mapShape(oc, sourceShape, owned), after = mapShape(oc, output, owned);
    const kinds: readonly Kind[] = ['face', 'edge', 'vertex'];
    if (kinds.some(kind => before[kind].Size() !== after[kind].Size())) return untracked('missing-native-map');
    const move = (current: ShapeAddress): ShapeAddress | null => {
      if (current.index < 0 || current.index >= before[current.kind].Size()) return null;
      const original = owned.keep(before[current.kind].FindKey(current.index + 1));
      const moved = owned.keep(maker.ModifiedShape(original));
      if (moved.IsNull() || kindOf(oc, moved) !== current.kind) return null;
      const mapped = address(after, moved, current.kind);
      if (mapped === null) return null;
      const found = owned.keep(after[current.kind].FindKey(mapped.index + 1));
      return found.IsSame(moved) ? mapped : null;
    };
    const unique = new Set<string>();
    const bindings: OriginBinding[] = [];
    for (const binding of source.bindings) {
      switch (binding.state) {
        case 'unique': {
          const current = move(binding.current);
          if (current === null) return untracked('missing-native-map');
          const key = `${current.kind}:${current.index}`;
          if (unique.has(key)) return untracked('missing-native-map');
          unique.add(key);
          bindings.push({ ...binding, current });
          break;
        }
        case 'merged': {
          const current = move(binding.current);
          if (current === null) return untracked('missing-native-map');
          bindings.push({ ...binding, current });
          break;
        }
        case 'split': {
          const candidates: ShapeAddress[] = [];
          for (const candidate of binding.candidates) {
            const mapped = move(candidate);
            if (mapped === null) return untracked('missing-native-map');
            candidates.push(mapped);
          }
          const [first, second, ...rest] = candidates;
          if (first === undefined || second === undefined) return untracked('missing-native-map');
          bindings.push({ ...binding, candidates: [first, second, ...rest] });
          break;
        }
        case 'missing':
        case 'untracked':
          bindings.push(binding);
          break;
      }
    }
    return { version: 1, state: 'tracked', bindings };
  } finally { owned.release(); }
}

export interface NativeProfileLine { readonly edge: TopoDS_Edge; readonly anchor: ProfileLineAnchor }
export interface NativeProfileCurve {
  readonly edge: TopoDS_Edge;
  readonly anchor: Extract<FaceOrigin, { readonly kind: 'extrude-curve-side' }>['profile'];
}

function readGeneratedFaces(oc: OpenCascadeInstance, list: TopTools_ListOfShape,
  output: Maps, owned: Allocations): readonly ShapeAddress[] | null {
  owned.keep(list);
  const copy = owned.keep(new oc.TopTools_ListOfShape_3(list));
  const addresses: ShapeAddress[] = [];
  while (copy.Size() > 0) {
    const face = owned.keep(copy.First_1());
    if (kindOf(oc, face) !== 'face') return null;
    const current = address(output, face, 'face');
    if (current === null) return null;
    addresses.push(current);
    copy.RemoveFirst();
  }
  return addresses;
}

export interface NativeSurfaceLine {
  readonly edge: TopoDS_Edge;
  readonly anchor: Extract<FaceOrigin, { readonly kind: 'surface-side' }>['profile'];
}

/** Saved open-profile lines are bound only through actual prism history and full output membership. */
export function surfacePrismSubShapeOrigins(oc: OpenCascadeInstance, prism: BRepPrimAPI_MakePrism,
  wire: TopoDS_Shape, output: TopoDS_Shape, lines: readonly NativeSurfaceLine[],
  featureId: string): CurrentOriginIndex {
  const validId = (id: string): boolean => id.length > 0 && id.length <= 256
    && [...id].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
  if (lines.length < 1 || lines.length > 32 || !validId(featureId)) return untracked('limit');
  if (new Set(lines.map(line => line.anchor.lineFeatureId)).size !== lines.length
    || lines.some(line => !validId(line.anchor.sketchId) || !validId(line.anchor.lineFeatureId)
      || line.anchor.sketchId !== lines[0].anchor.sketchId || line.anchor.role !== 'whole-line')) {
    return untracked('unsupported-profile-piece');
  }
  const owned = createAllocations();
  try {
    const inputMaps = mapShape(oc, wire, owned), outputMaps = mapShape(oc, output, owned);
    if (inputMaps.edge.Size() !== lines.length || outputMaps.face.Size() !== lines.length) {
      return untracked('missing-native-map');
    }
    const inputs = new Set<number>(), faces = new Set<number>(), bindings: OriginBinding[] = [];
    for (const line of lines) {
      const inputIndex = inputMaps.edge.FindIndex(line.edge);
      if (inputIndex < 1 || inputs.has(inputIndex)) return untracked('missing-native-map');
      inputs.add(inputIndex);
      const generated = readGeneratedFaces(oc, prism.Generated(line.edge), outputMaps, owned);
      if (generated === null || generated.length !== 1 || faces.has(generated[0].index)) {
        return untracked('missing-native-map');
      }
      faces.add(generated[0].index);
      bindings.push({ origin: { version: 1, shapeKind: 'face', identity: {
        kind: 'surface-side', featureId, profile: line.anchor } }, state: 'unique', current: generated[0] });
    }
    return { version: 1, state: 'tracked', bindings };
  } finally { owned.release(); }
}

/** Input edges must still be native members of the actual face after MakeWire/MakeFace. */
export function prismSubShapeOrigins(oc: OpenCascadeInstance, prism: BRepPrimAPI_MakePrism,
  profileFace: TopoDS_Shape, output: TopoDS_Shape, lines: readonly NativeProfileLine[],
  region: ProfileRegionAnchor, featureId: string): CurrentOriginIndex {
  if (lines.length < 3 || lines.length > 32 || featureId.length > 256) return untracked('limit');
  const lineIds = new Set(lines.map(line => line.anchor.lineFeatureId));
  if (lineIds.size !== lines.length || region.lineFeatureIds.length !== lines.length
    || new Set(region.lineFeatureIds).size !== lines.length
    || region.lineFeatureIds.some(id => !lineIds.has(id))
    || lines.some(line => line.anchor.sketchId !== region.sketchId
      || line.anchor.faceFeatureId !== region.faceFeatureId
      || line.anchor.role !== 'whole-line')) return untracked('unsupported-profile-piece');
  const owned = createAllocations();
  try {
    const faceMaps = mapShape(oc, profileFace, owned), outputMaps = mapShape(oc, output, owned);
    if (faceMaps.edge.Size() !== lines.length || outputMaps.face.Size() !== lines.length + 2) {
      return untracked('missing-native-map');
    }
    const bindings: OriginBinding[] = [], used = new Set<number>();
    for (const line of lines) {
      if (faceMaps.edge.FindIndex(line.edge) < 1) return untracked('missing-native-map');
      const generated = readGeneratedFaces(oc, prism.Generated(line.edge), outputMaps, owned);
      if (generated === null || generated.length !== 1 || used.has(generated[0].index)) return untracked('missing-native-map');
      used.add(generated[0].index);
      bindings.push({ origin: { version: 1, shapeKind: 'face', identity: {
        kind: 'extrude-side', featureId, profile: line.anchor } }, state: 'unique', current: generated[0] });
    }
    const first = owned.keep(prism.FirstShape_1()), last = owned.keep(prism.LastShape_1());
    const start = address(outputMaps, first, 'face'), end = address(outputMaps, last, 'face');
    if (start === null || end === null || start.index === end.index
      || used.has(start.index) || used.has(end.index)) return untracked('missing-native-map');
    bindings.push({ origin: { version: 1, shapeKind: 'face', identity: {
      kind: 'extrude-cap', featureId, end: 'start', profile: region } }, state: 'unique', current: start });
    bindings.push({ origin: { version: 1, shapeKind: 'face', identity: {
      kind: 'extrude-cap', featureId, end: 'end', profile: region } }, state: 'unique', current: end });
    return { version: 1, state: 'tracked', bindings };
  } finally { owned.release(); }
}

/** Whole saved curves use the same exact native history contract as legacy lines. */
export function prismCurveSubShapeOrigins(oc: OpenCascadeInstance, prism: BRepPrimAPI_MakePrism,
  profileFace: TopoDS_Shape, output: TopoDS_Shape, curves: readonly NativeProfileCurve[],
  region: Extract<FaceOrigin, { readonly kind: 'extrude-curve-cap' }>['profile'],
  featureId: string): CurrentOriginIndex {
  if (curves.length < 3 || curves.length > 32 || featureId.length > 256) return untracked('limit');
  const validId = (value: string): boolean => value.length > 0 && value.length <= 256
    && [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
  if (![featureId, region.sketchId, region.faceFeatureId, ...region.curveFeatureIds].every(validId)) {
    return untracked('unsupported-profile-piece');
  }
  const ids = new Set(curves.map(curve => curve.anchor.curveFeatureId));
  if (ids.size !== curves.length || region.curveFeatureIds.length !== curves.length
    || new Set(region.curveFeatureIds).size !== curves.length
    || region.curveFeatureIds.some(id => !ids.has(id))
    || curves.some(curve => curve.anchor.sketchId !== region.sketchId
      || curve.anchor.faceFeatureId !== region.faceFeatureId
      || curve.anchor.role !== 'whole-curve')) return untracked('unsupported-profile-piece');
  const owned = createAllocations();
  try {
    const before = mapShape(oc, profileFace, owned), after = mapShape(oc, output, owned);
    if (before.edge.Size() !== curves.length || after.face.Size() !== curves.length + 2) {
      return untracked('missing-native-map');
    }
    const bindings: OriginBinding[] = [], used = new Set<number>(), inputs = new Set<number>();
    for (const curve of curves) {
      const inputIndex = before.edge.FindIndex(curve.edge);
      if (inputIndex < 1 || inputs.has(inputIndex)) return untracked('missing-native-map');
      inputs.add(inputIndex);
      const generated = readGeneratedFaces(oc, prism.Generated(curve.edge), after, owned);
      if (generated === null || generated.length !== 1 || used.has(generated[0].index)) {
        return untracked('missing-native-map');
      }
      used.add(generated[0].index);
      bindings.push({ origin: { version: 1, shapeKind: 'face', identity: {
        kind: 'extrude-curve-side', featureId, profile: curve.anchor } },
      state: 'unique', current: generated[0] });
    }
    const first = owned.keep(prism.FirstShape_1()), last = owned.keep(prism.LastShape_1());
    const start = address(after, first, 'face'), end = address(after, last, 'face');
    if (kindOf(oc, first) !== 'face' || kindOf(oc, last) !== 'face'
      || start === null || end === null || start.index === end.index
      || used.has(start.index) || used.has(end.index)) return untracked('missing-native-map');
    bindings.push({ origin: { version: 1, shapeKind: 'face', identity: {
      kind: 'extrude-curve-cap', featureId, end: 'start', profile: region } }, state: 'unique', current: start });
    bindings.push({ origin: { version: 1, shapeKind: 'face', identity: {
      kind: 'extrude-curve-cap', featureId, end: 'end', profile: region } }, state: 'unique', current: end });
    if (bindings.some(binding => !withinOriginLimits(binding.origin))) return untracked('limit');
    return { version: 1, state: 'tracked', bindings };
  } finally { owned.release(); }
}

/** Borrowed native operation producers. They never enter the document or mesh. */
export type NativeHoleToolFace =
  | { readonly face: TopoDS_Shape; readonly origin: { readonly version: 1; readonly shapeKind: 'face'; readonly identity: HoleFaceOrigin | HoleThreadGrooveOrigin }; readonly reason?: never;
      /** Native pieces of one producer group (a modeled thread's own groove cut, or one hole face its own groove split).
       * All pieces of a group form one binding; distinct groups or producers with one identity still collide. */
      readonly group?: string }
  | { readonly face: TopoDS_Shape; readonly origin?: never; readonly reason: 'unsupported-producer'; readonly group?: never };

/** Enumerates the actual final unnamed machining tool; addresses are runtime membership only.
 * Budget exhaustion drops proof, never the successful geometry operation. */
export function anonymousToolFaceProducers(oc: OpenCascadeInstance, tool: TopoDS_Shape,
  keep: Allocations['keep']): { readonly faces: readonly NativeHoleToolFace[]; readonly limitExceeded: boolean } {
  const owned = createAllocations();
  try {
    const all = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(tool, all, true, true);
    if (all.Size() > 100_000) return { faces: [], limitExceeded: true };
    const faces: NativeHoleToolFace[] = [];
    for (let index = 1; index <= all.Size(); index++) {
      const local = createAllocations();
      try {
        const member = local.keep(all.FindKey(index));
        if (kindOf(oc, member) === 'face') {
          faces.push({ face: keep(all.FindKey(index)), reason: 'unsupported-producer' });
        }
      } finally { local.release(); }
    }
    return { faces, limitExceeded: false };
  } finally { owned.release(); }
}

/** Rigid placement uses the same live native transform as the actual tool. */
export function rebindTransformedHoleFaces(oc: OpenCascadeInstance, maker: BRepBuilderAPI_Transform,
  output: TopoDS_Shape, producers: readonly NativeHoleToolFace[], keep: Allocations['keep']): readonly NativeHoleToolFace[] {
  const owned = createAllocations();
  try {
    const maps = mapShape(oc, output, owned, 100_000);
    if (producers.length > 100_000 || maps.face.Size() + maps.edge.Size() + maps.vertex.Size() > 100_000) {
      throw new OriginHistoryLimitError();
    }
    const result: NativeHoleToolFace[] = [];
    for (const producer of producers) {
      const mapped = owned.keep(maker.ModifiedShape(producer.face));
      if (kindOf(oc, mapped) !== 'face' || address(maps, mapped, 'face') === null) throw new HoleOriginMapError('Transformed producer is absent from the native tool map');
      result.push({ ...producer, face: keep(maps.face.FindKey(maps.face.FindIndex(mapped))) });
    }
    return result;
  } finally { owned.release(); }
}

/** Entry fusion preserves only a single proved native stage face. Split stages remain unnamed. */
export function rebindHoleToolFaces(oc: OpenCascadeInstance, maker: Pick<BRepBuilderAPI_MakeShape, 'Modified' | 'Generated'>,
  output: TopoDS_Shape, producers: readonly NativeHoleToolFace[], keep: Allocations['keep']): readonly NativeHoleToolFace[] {
  const owned = createAllocations();
  try {
    const maps = mapShape(oc, output, owned, 100_000);
    if (producers.length > 100_000 || maps.face.Size() + maps.edge.Size() + maps.vertex.Size() > 100_000) {
      throw new OriginHistoryLimitError();
    }
    const result: NativeHoleToolFace[] = [];
    let links = 0;
    for (const producer of producers) {
      const candidates = new Map<number, TopoDS_Shape>();
      const add = (shape: TopoDS_Shape): void => {
        if (kindOf(oc, shape) !== 'face') return;
        const current = address(maps, shape, 'face');
        if (current === null) throw new HoleOriginMapError('Hole tool history does not belong to fused tool');
        candidates.set(current.index, shape);
      };
      for (const list of [maker.Modified(producer.face), maker.Generated(producer.face)]) {
        owned.keep(list);
        const copy = owned.keep(new oc.TopTools_ListOfShape_3(list));
        while (copy.Size() > 0) {
          if (++links > 400_000) throw new OriginHistoryLimitError();
          add(owned.keep(copy.First_1())); copy.RemoveFirst();
        }
      }
      if (address(maps, producer.face, 'face') !== null) add(producer.face);
      if (candidates.size !== 1) continue;
      const [index] = candidates.keys();
      if (index === undefined) continue;
      result.push({ ...producer, face: keep(maps.face.FindKey(index + 1)) });
    }
    return result;
  } finally { owned.release(); }
}

/** Modeled thread fusion only: a named hole face split by this operation's own groove keeps every proved native
 * piece as one group, and groove producers keep their cut group. The entry fusion above still drops split stages. */
export function rebindThreadToolFaces(oc: OpenCascadeInstance, maker: Pick<BRepBuilderAPI_MakeShape, 'Modified' | 'Generated'>,
  output: TopoDS_Shape, producers: readonly NativeHoleToolFace[], keep: Allocations['keep']): readonly NativeHoleToolFace[] {
  const owned = createAllocations();
  try {
    const maps = mapShape(oc, output, owned, 100_000);
    if (producers.length > 100_000 || maps.face.Size() + maps.edge.Size() + maps.vertex.Size() > 100_000) {
      throw new OriginHistoryLimitError();
    }
    const result: NativeHoleToolFace[] = [];
    let links = 0;
    for (const [serial, producer] of producers.entries()) {
      if (producer.origin === undefined) continue;
      const candidates = new Set<number>();
      const add = (shape: TopoDS_Shape): void => {
        if (kindOf(oc, shape) !== 'face') return;
        const current = address(maps, shape, 'face');
        if (current === null) throw new HoleOriginMapError('Thread tool history does not belong to fused tool');
        candidates.add(current.index);
      };
      for (const list of [maker.Modified(producer.face), maker.Generated(producer.face)]) {
        owned.keep(list);
        const copy = owned.keep(new oc.TopTools_ListOfShape_3(list));
        while (copy.Size() > 0) {
          if (++links > 400_000) throw new OriginHistoryLimitError();
          add(owned.keep(copy.First_1())); copy.RemoveFirst();
        }
      }
      if (address(maps, producer.face, 'face') !== null) add(producer.face);
      if (result.length + candidates.size > 100_000) throw new OriginHistoryLimitError();
      const group = producer.group ?? (candidates.size > 1 ? `split-${String(serial)}` : undefined);
      for (const index of candidates) {
        const face = keep(maps.face.FindKey(index + 1));
        result.push(group === undefined ? { face, origin: producer.origin } : { face, origin: producer.origin, group });
      }
    }
    return result;
  } finally { owned.release(); }
}

const originIdentityKey = (origin: SubShapeOrigin | FaceOrigin): string => JSON.stringify(origin,
  (_key: string, value: unknown): unknown => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);

/** New-operation proof, deliberately separate from old-origin continuation. */
export function holeOperationOrigins(oc: OpenCascadeInstance, maker: Pick<BRepBuilderAPI_MakeShape, 'Modified' | 'Generated'>,
  output: TopoDS_Shape, tool: TopoDS_Shape, inherited: CurrentOriginIndex, producers: readonly NativeHoleToolFace[],
  featureId: string): CurrentOriginIndex {
  if (inherited.state !== 'tracked') return inherited;
  if (producers.length + inherited.bindings.length > 100_000 || producers.some((producer) => (producer.origin !== undefined && !withinOriginLimits(producer.origin)))) return untracked('limit');
  const owned = createAllocations();
  try {
    const maps = mapShape(oc, output, owned, 100_000);
    const toolMaps = mapShape(oc, tool, owned, 100_000);
    if ([maps, toolMaps].some((group) => group.face.Size() + group.edge.Size() + group.vertex.Size() > 100_000)) return untracked('limit');
    if (producers.some((producer) => (producer.origin !== undefined && (producer.origin.identity.kind !== 'hole-face'
      || producer.origin.identity.featureId !== featureId)) || toolMaps.face.FindIndex(producer.face) < 1)) {
      return untracked('missing-native-map');
    }
    const bindings: OriginBinding[] = [...inherited.bindings];
    const identityCounts = new Map<string, number>();
    let historyLinks = 0;
    const anonymousClaims = new Map<number, number>();
    const anonymousFaces = new Set<number>();
    const fallback = new Map<string, NonNullable<typeof inherited.fingerprintFallback>[number]>();
    for (const item of inherited.fingerprintFallback ?? []) fallback.set(`${item.current.kind}:${String(item.current.index)}`, item);
    const duplicateClaims = new Map<number, SubShapeOrigin[]>();
    const countedGroups = new Set<string>();
    const pieces = new Map<string, { readonly origin: SubShapeOrigin; readonly candidates: Map<number, ShapeAddress> }>();
    const missingKeys = new Set<string>();
    for (const producer of producers) {
      if (producer.origin === undefined) continue;
      const key = originIdentityKey(producer.origin);
      // Pieces of one native group count once; distinct producers or groups with one identity still collide.
      if (producer.group !== undefined) {
        const groupKey = JSON.stringify([key, producer.group]);
        if (countedGroups.has(groupKey)) continue;
        countedGroups.add(groupKey);
      }
      identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1);
    }
    for (const producer of producers) {
      const candidates = new Map<number, ShapeAddress>();
      const add = (shape: TopoDS_Shape): void => {
        if (kindOf(oc, shape) !== 'face') return;
        const current = address(maps, shape, 'face');
        if (current === null) throw new Error('New hole history does not belong to the output');
        candidates.set(current.index, current);
      };
      for (const list of [maker.Modified(producer.face), maker.Generated(producer.face)]) {
        owned.keep(list);
        const copy = owned.keep(new oc.TopTools_ListOfShape_3(list));
        while (copy.Size() > 0) {
          if (++historyLinks > 400_000) return untracked('limit');
          add(owned.keep(copy.First_1())); copy.RemoveFirst();
        }
      }
      const unchanged = address(maps, producer.face, 'face');
      if (unchanged !== null) candidates.set(unchanged.index, unchanged);
      const [first, second, ...rest] = candidates.values();
      if (producer.origin === undefined) {
        // Runtime native proof without a fabricated persistent center/placement identity.
        for (const candidate of candidates.values()) anonymousClaims.set(candidate.index, (anonymousClaims.get(candidate.index) ?? 0) + 1);
        // These are fresh tool regions in this operation, not continuations of
        // saved anonymous or semantic references. Each current output face is
        // admitted separately only after exclusive producer/occupancy checks.
        for (const candidate of candidates.values()) anonymousFaces.add(candidate.index);
        continue;
      }
      const identityKey = originIdentityKey(producer.origin);
      if (identityCounts.get(identityKey) !== 1) {
        for (const candidate of candidates.values()) {
          const found = duplicateClaims.get(candidate.index) ?? [];
          found.push(producer.origin); duplicateClaims.set(candidate.index, found);
        }
        if (!missingKeys.has(identityKey)) bindings.push({ origin: producer.origin, state: 'missing', reason: 'history-missing' });
        missingKeys.add(identityKey);
        continue;
      }
      if (producer.group !== undefined) {
        // Only the native pieces this operation's history proves; never filled from extents or the saved feature.
        const piece = pieces.get(identityKey) ?? { origin: producer.origin, candidates: new Map<number, ShapeAddress>() };
        for (const candidate of candidates.values()) piece.candidates.set(candidate.index, candidate);
        pieces.set(identityKey, piece);
        continue;
      }
      bindings.push(first === undefined ? { origin: producer.origin, state: 'missing', reason: 'deleted' }
        : second === undefined ? { origin: producer.origin, state: 'unique', current: first }
        : { origin: producer.origin, state: 'split', candidates: [first, second, ...rest] });
    }
    for (const { origin, candidates } of pieces.values()) {
      const [first, second, ...rest] = candidates.values();
      bindings.push(first === undefined ? { origin, state: 'missing', reason: 'deleted' }
        : second === undefined ? { origin, state: 'unique', current: first }
        : { origin, state: 'split', candidates: [first, second, ...rest] });
    }
    // Colliding native claims are ambiguous even when their coordinates agree.
    const claims = new Map<string, SubShapeOrigin[]>();
    for (const [index, origins] of duplicateClaims) claims.set(`face:${String(index)}`, origins);
    for (const binding of bindings) {
      const addresses = binding.state === 'unique' || binding.state === 'merged' ? [binding.current]
        : binding.state === 'split' ? binding.candidates : [];
      for (const current of addresses) {
        const key = `${current.kind}:${String(current.index)}`;
        const found = claims.get(key) ?? [];
        found.push(binding.origin); claims.set(key, found);
      }
    }
    const resolved = bindings.map((binding): OriginBinding => {
      if (binding.state !== 'unique') return binding;
      if (binding.current.kind === 'face' && anonymousClaims.has(binding.current.index)) {
        return { origin: binding.origin, state: 'untracked', reason: 'unsupported-producer' };
      }
      const [first, second, ...rest] = claims.get(`${binding.current.kind}:${String(binding.current.index)}`) ?? [];
      return first !== undefined && second !== undefined
        ? { origin: binding.origin, state: 'merged', current: binding.current, coOrigins: [first, second, ...rest] }
        : binding;
    });
    if ([...claims.values()].some((origins) => origins.length > 32)) return untracked('limit');
    for (const [index, count] of anonymousClaims) {
      const key = `face:${String(index)}`;
      if (count === 1 && anonymousFaces.has(index) && !claims.has(key)) {
        fallback.set(key, { current: { kind: 'face', index }, reason: 'unsupported-producer' });
      } else { fallback.delete(key); anonymousFaces.delete(index); }
    }
    for (const key of claims.keys()) fallback.delete(key);
    const faceByIndex = new Map<number, FaceOrigin>();
    for (const binding of resolved) if (binding.state === 'unique' && binding.current.kind === 'face'
      && binding.origin.shapeKind === 'face') faceByIndex.set(binding.current.index, binding.origin.identity);
    const incident = new Map<number, number[]>();
    let links = 0;
    for (let index = 1; index <= maps.face.Size(); index += 1) {
      const faceAllocations = createAllocations();
      try {
      const face = faceAllocations.keep(maps.face.FindKey(index));
      const edges = mapShape(oc, face, faceAllocations, 100_000).edge;
      for (let edgeIndex = 1; edgeIndex <= edges.Size(); edgeIndex += 1) {
        if (++links > 400_000) return untracked('limit');
        const member = faceAllocations.keep(edges.FindKey(edgeIndex));
        const current = maps.edge.FindIndex(member) - 1;
        if (current < 0) return untracked('missing-native-map');
        const neighbors = incident.get(current) ?? [];
        neighbors.push(index - 1); incident.set(current, neighbors);
      }
      } finally { faceAllocations.release(); }
    }
    const edgeGroups = new Map<string, { origin: SubShapeOrigin; addresses: ShapeAddress[] }>();
    for (const [index, neighbors] of incident) {
      if (neighbors.length !== 2 || claims.has(`edge:${String(index)}`)) continue;
      const [firstNeighbor, secondNeighbor] = neighbors;
      if (firstNeighbor === undefined || secondNeighbor === undefined) continue;
      const a = faceByIndex.get(firstNeighbor), b = faceByIndex.get(secondNeighbor);
      const firstFallback = fallback.get(`face:${String(firstNeighbor)}`);
      const secondFallback = fallback.get(`face:${String(secondNeighbor)}`);
      const touchesHole = a?.kind === 'hole-face' || b?.kind === 'hole-face'
        || anonymousFaces.has(firstNeighbor) || anonymousFaces.has(secondNeighbor);
      if (!touchesHole) continue;
      if (a === undefined || b === undefined) {
        if ((a !== undefined || firstFallback !== undefined) && (b !== undefined || secondFallback !== undefined)) {
          const reason = firstFallback?.reason ?? secondFallback?.reason;
          if (reason !== undefined) fallback.set(`edge:${String(index)}`, { current: { kind: 'edge', index }, reason });
        }
        continue;
      }
      const faces: readonly [FaceOrigin, FaceOrigin] = originIdentityKey(a) < originIdentityKey(b) ? [a, b] : [b, a];
      const origin: SubShapeOrigin = { version: 1, shapeKind: 'edge', identity: { kind: 'face-intersection-edge', featureId, faces } };
      if (!withinOriginLimits(origin)) return untracked('limit');
      const key = originIdentityKey(origin), group = edgeGroups.get(key) ?? { origin, addresses: [] };
      group.addresses.push({ kind: 'edge', index }); edgeGroups.set(key, group);
    }
    for (const group of edgeGroups.values()) {
      const [first, second, ...rest] = group.addresses;
      if (first === undefined) continue;
      resolved.push(second === undefined ? { origin: group.origin, state: 'unique', current: first }
        : { origin: group.origin, state: 'split', candidates: [first, second, ...rest] });
    }
    if (resolved.length + fallback.size > 100_000) return untracked('limit');
    return { version: 1, state: 'tracked', bindings: resolved, fingerprintFallback: [...fallback.values()] };
  } finally { owned.release(); }
}
