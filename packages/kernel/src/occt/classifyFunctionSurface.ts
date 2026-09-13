/** Classify real, already XYZ-clipped faces without adding boundary caps or welding gaps. */
import type { OpenCascadeInstance, TopoDS_Shape, TopoDS_Shell } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations, type Allocations } from './allocations.js';
import { isValidShape, measureArea, measureVolume } from './solidMesh.js';
import type { Vec3Tuple } from '../types.js';
import { MAX_FUNCTION_SURFACE_FACES } from './functionSurfaceGeometrySpec.js';
import { hasFunctionSurfaceProjectionCertificate, type FunctionSurfaceProjectionCertificate } from './functionSurfaceProjection.js';

interface FaceGroup { readonly faces: readonly TopoDS_Shape[]; readonly closed: boolean; readonly witness: Vec3Tuple }
interface ClosedGroup { readonly shell: TopoDS_Shell; readonly solid: TopoDS_Shape; readonly volume: number; readonly witness: Vec3Tuple }
export interface FunctionSurfaceBody {
  readonly shape: TopoDS_Shape;
  readonly bodyKind: 'solid' | 'shell';
  readonly area: number;
  readonly volume: number;
}
export type FunctionSurfaceBodies = { readonly status: 'bodies'; readonly bodies: readonly FunctionSurfaceBody[]; readonly delete: () => void }
  | { readonly status: 'cancelled' };
const INVALID = '関数の面が交差・重複しているか、面のつながりが不正です。式と範囲を見直してください。';
const MAX_COMPONENTS = 64;
class SurfaceClassificationCancelled extends Error {}

function faceGroups(oc: OpenCascadeInstance, source: TopoDS_Shape, owner: Allocations,
  isCancelled: () => boolean): readonly FaceGroup[] {
  const scratch = createAllocations();
  try {
    const all = scratch.keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(source, all, true, true);
    const faces: TopoDS_Shape[] = [], edgeFaces = new Map<number, number[]>(), witnesses: Vec3Tuple[] = [];
    for (let index = 1; index <= all.Size(); index++) {
      if (index % 64 === 0 && isCancelled()) throw new SurfaceClassificationCancelled();
      const local = createAllocations();
      try {
        const item = local.keep(all.FindKey(index));
        if (item.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_FACE) continue;
        if (faces.length >= MAX_FUNCTION_SURFACE_FACES) throw new Error('切断後の関数曲面の面数が上限を超えています。描画範囲を狭めてください。');
        const face = owner.keep(oc.TopoDS.Face_1(item)), faceIndex = faces.length; faces.push(face);
        const parts = local.keep(new oc.TopTools_IndexedMapOfShape_1());
        oc.TopExp.MapShapes_2(face, parts, true, true);
        let witness: Vec3Tuple | undefined;
        for (let part = 1; part <= parts.Size(); part++) {
          const child = local.keep(parts.FindKey(part));
          if (child.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_EDGE) {
            const edge=local.keep(oc.TopoDS.Edge_1(child));
            if(oc.BRep_Tool.Degenerated(edge)) continue;
            const key = all.FindIndex(child), adjacent = edgeFaces.get(key) ?? [];
            // Count actual occurrences in the trimmed face. Two pcurves alone can survive a trim.
            const uses=oc.BRepTools.IsReallyClosed(edge,face)?2:1;
            if (key === 0 || adjacent.length+uses>2) throw new Error(INVALID);
            for(let use=0;use<uses;use++) adjacent.push(faceIndex);edgeFaces.set(key, adjacent);
          } else if (witness === undefined && child.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_VERTEX) {
            const point = local.keep(oc.BRep_Tool.Pnt(local.keep(oc.TopoDS.Vertex_1(child))));
            witness = [point.X(), point.Y(), point.Z()];
          }
        }
        if (witness === undefined) throw new Error(INVALID);
        witnesses.push(witness);
      } finally { local.release(); }
    }
    const neighbours: number[][] = faces.map(() => []), open = new Set<number>();
    for (const adjacent of edgeFaces.values()) {
      if (adjacent.length === 1) open.add(adjacent[0]);
      else { neighbours[adjacent[0]].push(adjacent[1]); neighbours[adjacent[1]].push(adjacent[0]); }
    }
    const visited = new Set<number>(), groups: FaceGroup[] = [];
    for (let start = 0; start < faces.length; start++) {
      if (visited.has(start)) continue;
      const pending = [start], members: TopoDS_Shape[] = []; let closed = true;
      visited.add(start);
      while (pending.length > 0) {
        const index = pending.pop(); if (index === undefined) throw new Error(INVALID);
        members.push(faces[index]); if (open.has(index)) closed = false;
        for (const neighbour of neighbours[index]) if (!visited.has(neighbour)) { visited.add(neighbour); pending.push(neighbour); }
      }
      groups.push({ faces: members, closed, witness: witnesses[start] });
      if (groups.length > MAX_COMPONENTS) throw new Error('関数の面が64個を超えて分かれています。描画範囲を狭めてください。');
    }
    if (groups.length === 0) throw new Error(INVALID);
    return groups;
  } finally { scratch.release(); }
}

/** The source remains owned by the caller until the returned bodies have been released. */
export function classifyFunctionSurface(oc: OpenCascadeInstance, source: TopoDS_Shape,
  isCancelled: () => boolean = () => false, projection?: FunctionSurfaceProjectionCertificate): FunctionSurfaceBodies {
  const owner = createAllocations(), { keep } = owner;
  const cancelled = (): FunctionSurfaceBodies => { owner.release(); return { status: 'cancelled' }; };
  try {
    if (isCancelled()) return cancelled();
    // BRepAlgoAPI_Check::Perform already runs BRepCheck_Analyzer as well as the
    // self-intersection analysis. Do not traverse all faces with the same analyzer twice.
    // https://github.com/Open-Cascade-SAS/OCCT/blob/V7_7_0/src/BRepAlgoAPI/BRepAlgoAPI_Check.cxx
    // This also rejects intersections between disconnected shells before deciding containment.
    const checkStarted = performance.now();
    console.debug('[pcad:function-phase]', JSON.stringify({ phase: 'validity-and-intersections', event: 'start' }));
    const projected=hasFunctionSurfaceProjectionCertificate(projection,source);
    if(projected) {
      // The exact disk projection already proves nonintersection; native geometric/topological
      // validity remains mandatory. Unproved surfaces and all standalone calls keep both checks.
      if(!isValidShape(oc,source)) throw new Error(INVALID);
    } else {
      const check = keep(new oc.BRepAlgoAPI_Check_1());
      check.SetData_1(source, false, true);
      check.Perform(keep(new oc.Message_ProgressRange_1()));
      if (check.HasErrors() || !check.IsValid()) throw new Error(INVALID);
    }
    console.debug('[pcad:function-phase]', JSON.stringify({ phase: 'validity-and-intersections', projected, elapsedMs: performance.now() - checkStarted }));
    if (isCancelled()) return cancelled();
    const groups = faceGroups(oc, source, owner, isCancelled), builder = keep(new oc.BRep_Builder());
    const closed: ClosedGroup[] = [], bodies: FunctionSurfaceBody[] = [];
    for (const group of groups) {
      if (isCancelled()) return cancelled();
      const shell = keep(new oc.TopoDS_Shell()); builder.MakeShell(shell);
      for (const face of group.faces) builder.Add(shell, face);
      if (!group.closed) {
        bodies.push({ shape: shell, bodyKind: 'shell', area: measureArea(oc, shell), volume: 0 });
        continue;
      }
      const maker = keep(new oc.BRepBuilderAPI_MakeSolid_3(shell));
      if (!maker.IsDone()) throw new Error(INVALID);
      const raw = keep(maker.Solid()), volume = measureVolume(oc, raw);
      if (!Number.isFinite(volume) || Math.abs(volume) < 1e-9 || !isValidShape(oc, raw)) throw new Error(INVALID);
      const positive = volume < 0 ? keep(raw.Reversed()) : raw;
      const outward = volume < 0 ? keep(oc.TopoDS.Shell_1(keep(shell.Reversed()))) : shell;
      closed.push({ shell: outward, solid: positive, volume: Math.abs(volume), witness: group.witness });
    }
    const parent = closed.map(() => -1);
    for (let child = 0; child < closed.length; child++) {
      const scratch = createAllocations();
      try {
        const point = scratch.keep(new oc.gp_Pnt_3(...closed[child].witness));
        for (let candidate = 0; candidate < closed.length; candidate++) {
          if (isCancelled()) return cancelled();
          if (candidate === child || closed[candidate].volume <= closed[child].volume) continue;
          const classifier = scratch.keep(new oc.BRepClass3d_SolidClassifier_3(closed[candidate].solid, point, 1e-7));
          const state = classifier.State();
          // Rejected() means a valid OUT, not failure:
          // https://dev.opencascade.org/doc/occt-7.7.0/refman/html/class_b_rep_class3d___solid_classifier.html
          if (state === oc.TopAbs_State.TopAbs_UNKNOWN || state === oc.TopAbs_State.TopAbs_ON) throw new Error(INVALID);
          if (state === oc.TopAbs_State.TopAbs_IN && (parent[child] < 0 || closed[candidate].volume < closed[parent[child]].volume)) parent[child] = candidate;
        }
      } finally { scratch.release(); }
    }
    const depth = (index: number): number => {
      let result = 0;
      for (let next = parent[index]; next >= 0; next = parent[next]) {
        if (++result > closed.length) throw new Error(INVALID);
      }
      return result;
    };
    for (let index = 0; index < closed.length; index++) {
      if (isCancelled()) return cancelled();
      if (depth(index) % 2 !== 0) continue;
      const solid = keep(new oc.TopoDS_Solid()); builder.MakeSolid(solid);
      builder.Add(solid, closed[index].shell);
      let expected = closed[index].volume;
      for (let hole = 0; hole < closed.length; hole++) if (parent[hole] === index) {
        builder.Add(solid, keep(closed[hole].shell.Reversed())); expected -= closed[hole].volume;
      }
      const volume = measureVolume(oc, solid);
      if (!isValidShape(oc, solid) || !(volume > 1e-9) || Math.abs(volume - expected) > Math.max(1e-8, expected * 1e-9)) throw new Error(INVALID);
      bodies.push({ shape: solid, bodyKind: 'solid', area: measureArea(oc, solid), volume });
    }
    if (isCancelled()) return cancelled();
    return { status: 'bodies', bodies, delete: owner.release };
  } catch (error) { owner.release(); if (error instanceof SurfaceClassificationCancelled) return { status: 'cancelled' }; throw error; }
}
