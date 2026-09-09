import type { Bnd_Box, OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import { createAllocations, type OcctDeletable } from '../occt/allocations.js';
import { booleanOp } from '../occt/booleanOp.js';
import { buildExportMesh } from '../occt/exportMesh.js';
import { intersectionVolume, MIN_INTERFERENCE_VOLUME_MM3 } from '../occt/intersectionVolume.js';
import { boundingBoxRange, boundingBoxesOverlap, placeShape, transformedBoundingBox } from '../occt/placeBodies.js';
import { DEFAULT_ANGULAR_DEFLECTION, DEFAULT_LINEAR_DEFLECTION } from '../types.js';
import type {
  InterferenceComponentSpec, InterferenceMesh, InterferencePair, InterferencePairFailure, InterferencePairId,
  InterferenceProgress, InterferenceReport, InterferenceRequest, InterferenceResult,
  InterferenceRootFailure, InterferenceSkip, PlacementSpec, Vec3Tuple,
} from '../types.js';
import type { CachedSolid, SolidCancelToken } from './recomputeSolids.js';

export type InterferenceProgressCallback = (progress: InterferenceProgress) => void | Promise<void>;
export const INTERFERENCE_AABB_PADDING_MM = 1e-6;

interface ReferencedMessagePort extends MessagePort {
  ref?(): void;
  unref?(): void;
}

function detail(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function hasPortReferences(port: MessagePort): boolean {
  return 'ref' in port && typeof port.ref === 'function' && 'unref' in port && typeof port.unref === 'function';
}

/** 呼出し前の変更可能な配列を読むのはここだけ。native/Promiseを持たない。 */
export function snapshotInterferenceRequest(request: InterferenceRequest): InterferenceRequest {
  return {
    requestId: request.requestId,
    components: request.components.map((component) => {
      if (component.kind === 'ready') return {
        ...component, bodyKeys: [...new Set(component.bodyKeys)].sort(),
        placement: { position: [...component.placement.position], rotation: [...component.placement.rotation] },
      };
      if (component.kind === 'unavailable') return {
        ...component, ...(component.missingKeys === undefined ? {} : { missingKeys: [...component.missingKeys] }),
      };
      return { ...component };
    }),
    ...(request.pairs === undefined ? {} : { pairs: request.pairs.map(([a, b]): InterferencePairId => [a, b]) }),
    ...(request.ignoredPairs === undefined ? {} : { ignoredPairs: request.ignoredPairs.map(([a, b]): InterferencePairId => [a, b]) }),
  };
}

interface PairJob { readonly pair: InterferencePairId; readonly a: InterferenceComponentSpec; readonly b: InterferenceComponentSpec }
export interface InterferencePreparation {
  readonly jobs: readonly PairJob[];
  readonly skips: readonly InterferenceSkip[];
  readonly total: number;
  readonly failure: InterferenceRootFailure | null;
}

/** 順序は文書順。reverse/重複pairを同じordinalへ揃え、除外理由を一度だけ決める。 */
export function prepareInterference(request: InterferenceRequest): InterferencePreparation {
  const invalid = (): InterferencePreparation => ({ jobs: [], skips: [], total: 0,
    failure: { code: 'invalidRequest', message: '調べる部品の組み合わせが正しくありません。' } });
  const components = request.components;
  const ids = new Map(components.map((component, index) => [component.componentId, index]));
  if (request.requestId.trim() === '' || ids.size !== components.length || components.some((c) => c.componentId.trim() === '')) return invalid();
  function normalize(pairs: readonly InterferencePairId[]): Map<string, PairJob> | null {
    const normalized = new Map<string, PairJob>();
    for (const [first, second] of pairs) {
      const a = ids.get(first); const b = ids.get(second);
      if (a === undefined || b === undefined || a === b) return null;
      const low = Math.min(a, b); const high = Math.max(a, b);
      normalized.set(`${low}:${high}`, { a: components[low], b: components[high],
        pair: [components[low].componentId, components[high].componentId] });
    }
    return normalized;
  }
  const ignored = normalize(request.ignoredPairs ?? []);
  const selected = request.pairs === undefined ? undefined : normalize(request.pairs);
  if (ignored === null || selected === null) return invalid();
  if (components.length === 0) return { jobs: [], skips: [], total: 0,
    failure: { code: 'noComponents', message: '調べる部品がありません。' } };
  const jobs: PairJob[] = []; const skips: InterferenceSkip[] = [];
  let total = 0;
  for (let a = 0; a < components.length; a += 1) for (let b = a + 1; b < components.length; b += 1) {
    const key = `${a}:${b}`;
    if (selected !== undefined && !selected.has(key)) continue;
    total += 1;
    const first = components[a]; const second = components[b];
    const pair: InterferencePairId = [first.componentId, second.componentId];
    const excluded = [first, second].filter((c) => c.kind === 'excluded');
    const reason = excluded.some((c) => c.reason === 'suppressed') ? 'suppressed'
      : excluded.some((c) => c.reason === 'hidden') ? 'hidden' : ignored.has(key) ? 'ignored' : null;
    if (reason !== null) skips.push({ pair, reason });
    else jobs.push({ pair, a: first, b: second });
  }
  return { jobs, skips, total, failure: null };
}

export function initialInterferenceResult(request: InterferenceRequest, preparation = prepareInterference(request)): InterferenceResult {
  const report: InterferenceReport = { requestId: request.requestId, pairs: [], totalPairCount: preparation.total,
    checkedPairCount: 0, skippedPairCount: preparation.skips.length,
    pendingPairCount: preparation.jobs.length, failures: [], skips: preparation.skips, cancelled: false };
  return preparation.failure === null ? { ...report, kind: 'checked', failure: null }
    : { ...report, kind: 'failed', failure: preparation.failure };
}

export function interferenceRootFailure(result: InterferenceResult, failure: InterferenceRootFailure): InterferenceResult {
  return { ...result, kind: 'failed', failure };
}

function validPlacement(placement: PlacementSpec): boolean {
  return [...placement.position, ...placement.rotation].every(Number.isFinite)
    && Number.isFinite(Math.hypot(...placement.rotation)) && Math.hypot(...placement.rotation) > 0;
}

function containsSolid(oc: OpenCascadeInstance, shape: TopoDS_Shape): boolean {
  const { keep, release } = createAllocations();
  try {
    const map = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, map, true, true);
    for (let index = 1; index <= map.Size(); index += 1) {
      if (keep(map.FindKey(index)).ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SOLID) return true;
    }
    return false;
  } finally { release(); }
}

function releaseAll(items: OcctDeletable[]): string[] {
  const messages: string[] = [];
  for (const item of items.reverse()) {
    try { item.delete(); } catch (error) { messages.push(detail(error)); }
  }
  items.length = 0;
  return messages;
}

/** Add(false)で元Locationと公差を含める。元のgapへ余白を加算し、縮めない。 */
export function conservativeBodyBounds(oc: OpenCascadeInstance, shape: TopoDS_Shape): Bnd_Box {
  const box = new oc.Bnd_Box_1();
  try {
    oc.BRepBndLib.Add(shape, box, false);
    if (box.IsVoid()) throw new Error('部品の大きさが取れません。');
    const gap = box.GetGap();
    if (!Number.isFinite(gap) || gap < 0) throw new Error('部品の公差が正しくありません。');
    box.SetGap(gap + INTERFERENCE_AABB_PADDING_MM);
    return box;
  } catch (error) {
    const cleanup = releaseAll([box]);
    throw new Error([detail(error), ...cleanup].join('\n'), { cause: error });
  }
}

/**
 * gap込みの角を独立箱へ実体化してから既存の変換口を使う。回転後に元のscalar gapだけを
 * 戻す実装にも依存せず、斜めの配置でも元の公差付き8隅を全て含む。入力箱は非変更。
 * CornerMin/Max、Transformedの戻りは独立した所有wrapperである。
 */
export function conservativeWorldBounds(oc: OpenCascadeInstance, box: Bnd_Box, placement: PlacementSpec): Bnd_Box | null {
  if (box.IsWhole() || box.IsOpen()) return null;
  const allocations = createAllocations();
  let result: Bnd_Box | undefined;
  try {
    const range = boundingBoxRange(box);
    if (![...range.min, ...range.max].every(Number.isFinite) || range.min.some((value, axis) => value > range.max[axis])) {
      throw new Error('部品の大きさが正しくありません。');
    }
    const min = allocations.keep(box.CornerMin()); const max = allocations.keep(box.CornerMax());
    const expanded = allocations.keep(new oc.Bnd_Box_2(min, max));
    const transformed = allocations.keep(transformedBoundingBox(oc, expanded, placement));
    result = new oc.Bnd_Box_1();
    result.Add_1(transformed.box);
    const worldRange = boundingBoxRange(result);
    if (![...worldRange.min, ...worldRange.max].every(Number.isFinite)) throw new Error('配置後の大きさが正しくありません。');
  } catch (error) {
    const messages = releaseAll([{ delete: allocations.release }, ...(result === undefined ? [] : [result])]);
    throw new Error([detail(error), ...messages].join('\n'), { cause: error });
  }
  try { allocations.release(); } catch (error) {
    const messages = releaseAll(result === undefined ? [] : [result]);
    throw new Error([detail(error), ...messages].join('\n'), { cause: error });
  }
  if (result === undefined) throw new Error('配置後の大きさが取れません。');
  return result;
}

type ComponentFailure = Omit<InterferencePairFailure, 'pair'>;
interface PreparedComponent { readonly shapes: readonly TopoDS_Shape[]; readonly keys: string; readonly box: Bnd_Box | null; readonly spec: Extract<InterferenceComponentSpec, { kind: 'ready' }> }
type Prepared = PreparedComponent | ComponentFailure;

/** 非負の演算結果を上へ広げる。有限な正規数/非正規数の丸めを共に含む。 */
function upper(value: number): number {
  return value === 0 ? 0 : value + Math.max(Number.MIN_VALUE, value * Number.EPSILON * 4);
}
export interface InterferenceBoxProof {
  readonly surfaceAreaUpper: number;
  readonly min: Vec3Tuple;
  readonly max: Vec3Tuple;
  readonly extent: Vec3Tuple;
  readonly extentLower: Vec3Tuple;
  readonly coordinateMagnitude: number;
}
function lower(value: number): number {
  return Math.max(0, value - Math.max(Number.MIN_VALUE, Math.abs(value) * Number.EPSILON * 4));
}

/**
 * 任意B-repを受ける十分条件。局所軸に平行な直方体だけを認証し、それ以外は未認証。
 * 頂点/辺/面の数だけでは認めず、8隅、12本の直線区間、6面の閉じた矩形と対向法線を読む。
 * 元LocationはBRepAdaptor/Pntが一度適用済み。許容差で幾何の一致を丸めない。
 */
export function certifyInterferenceBox(oc: OpenCascadeInstance, shape: TopoDS_Shape): InterferenceBoxProof | null {
  const { keep, release } = createAllocations();
  try {
    if (shape.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SOLID || !keep(new oc.BRepCheck_Analyzer(shape, true, false)).IsValid_2()) return null;
    function members(item: TopoDS_Shape): TopoDS_Shape[] {
      const map = keep(new oc.TopTools_IndexedMapOfShape_1()); oc.TopExp.MapShapes_2(item, map, true, true);
      return Array.from({ length: map.Size() }, (_, index) => keep(map.FindKey(index + 1)));
    }
    const all = members(shape);
    const vertices = all.filter((item) => item.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_VERTEX);
    const edges = all.filter((item) => item.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_EDGE);
    const faces = all.filter((item) => item.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_FACE);
    const shells = all.filter((item) => item.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SHELL);
    if (vertices.length !== 8 || edges.length !== 12 || faces.length !== 6 || shells.length !== 1 || !oc.BRep_Tool.IsClosed_1(shells[0])) return null;
    let tolerance = 0;
    function acceptable(value: number): boolean {
      tolerance = Math.max(tolerance, value); return Number.isFinite(value) && value >= 0 && value <= 1e-7;
    }
    function vertexPoint(item: TopoDS_Shape): Vec3Tuple | null {
      const vertex = keep(oc.TopoDS.Vertex_1(item));
      if (!acceptable(oc.BRep_Tool.Tolerance_3(vertex))) return null;
      const point = keep(oc.BRep_Tool.Pnt(vertex));
      const xyz: Vec3Tuple = [point.X(), point.Y(), point.Z()]; return xyz.every(Number.isFinite) ? xyz : null;
    }
    const points: Vec3Tuple[] = [];
    for (const vertex of vertices) { const point = vertexPoint(vertex); if (point === null) return null; points.push(point); }
    const min = [0, 1, 2].map((axis) => Math.min(...points.map((point) => point[axis])));
    const max = [0, 1, 2].map((axis) => Math.max(...points.map((point) => point[axis])));
    function corner(point: Vec3Tuple): number | null {
      let id = 0;
      for (let axis = 0; axis < 3; axis += 1) {
        if (point[axis] === max[axis]) id += 2 ** axis;
        else if (point[axis] !== min[axis]) return null;
      }
      return id;
    }
    const corners = points.map(corner);
    if (corners.includes(null) || new Set(corners).size !== 8) return null;
    const edgeIds = new Set<string>();
    for (const item of edges) {
      const edge = keep(oc.TopoDS.Edge_1(item));
      if (!acceptable(oc.BRep_Tool.Tolerance_2(edge)) || oc.BRep_Tool.Degenerated(edge)) return null;
      const curve = keep(new oc.BRepAdaptor_Curve_2(edge));
      if (curve.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line) return null;
      const start = vertexPoint(keep(oc.TopExp.FirstVertex(edge, true))); const end = vertexPoint(keep(oc.TopExp.LastVertex(edge, true)));
      if (start === null || end === null) return null;
      const first = corner(start); const last = corner(end);
      if (first === null || last === null || ![1, 2, 4].includes(first ^ last)) return null;
      const low = keep(curve.Value(curve.FirstParameter())); const high = keep(curve.Value(curve.LastParameter()));
      const matches = (point: Vec3Tuple, xyz: readonly number[]): boolean => point.every((value, axis) => value === xyz[axis]);
      if (!(matches(start, [low.X(), low.Y(), low.Z()]) && matches(end, [high.X(), high.Y(), high.Z()]))
        && !(matches(end, [low.X(), low.Y(), low.Z()]) && matches(start, [high.X(), high.Y(), high.Z()]))) return null;
      edgeIds.add(`${Math.min(first, last)}:${Math.max(first, last)}`);
    }
    if (edgeIds.size !== 12) return null;
    const sides = new Set<string>();
    for (const item of faces) {
      const face = keep(oc.TopoDS.Face_1(item));
      if (!acceptable(oc.BRep_Tool.Tolerance_1(face))) return null;
      const orientation = face.Orientation_1();
      if (orientation !== oc.TopAbs_Orientation.TopAbs_FORWARD && orientation !== oc.TopAbs_Orientation.TopAbs_REVERSED) return null;
      const surface = keep(new oc.BRepAdaptor_Surface_2(face, false));
      if (surface.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Plane) return null;
      const plane = keep(surface.Plane()); const axis = keep(plane.Axis()); const direction = keep(axis.Direction()); const origin = keep(plane.Location());
      const sign = orientation === oc.TopAbs_Orientation.TopAbs_FORWARD ? 1 : -1;
      const normal = [direction.X() * sign, direction.Y() * sign, direction.Z() * sign];
      const sideAxis = normal.findIndex((value) => Math.abs(value) === 1);
      if (sideAxis < 0 || normal.some((value, index) => index !== sideAxis && value !== 0)) return null;
      const side = normal[sideAxis] > 0 ? max[sideAxis] : min[sideAxis];
      if ([origin.X(), origin.Y(), origin.Z()][sideAxis] !== side) return null;
      const pieces = members(face); const facePoints: Vec3Tuple[] = [];
      if (pieces.filter((piece) => piece.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_EDGE).length !== 4
        || pieces.filter((piece) => piece.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_WIRE).length !== 1) return null;
      for (const piece of pieces) {
        if (piece.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_WIRE && !oc.BRep_Tool.IsClosed_1(piece)) return null;
        if (piece.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_EDGE) {
          const edge = keep(oc.TopoDS.Edge_1(piece)); const trim = keep(new oc.BRepAdaptor_Curve_3(edge, face));
          if (trim.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line) return null;
          const start = vertexPoint(keep(oc.TopExp.FirstVertex(edge, true))); const end = vertexPoint(keep(oc.TopExp.LastVertex(edge, true)));
          if (start === null || end === null) return null;
          const low = keep(trim.Value(trim.FirstParameter())); const high = keep(trim.Value(trim.LastParameter()));
          const p = [low.X(), low.Y(), low.Z()]; const q = [high.X(), high.Y(), high.Z()];
          if (!(start.every((value, index) => value === p[index]) && end.every((value, index) => value === q[index]))
            && !(end.every((value, index) => value === p[index]) && start.every((value, index) => value === q[index]))) return null;
        }
      }
      for (const piece of pieces) if (piece.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_VERTEX) {
        const point = vertexPoint(piece); if (point === null || point[sideAxis] !== side || corner(point) === null) return null; facePoints.push(point);
      }
      if (facePoints.length !== 4 || new Set(facePoints.map(corner)).size !== 4) return null;
      sides.add(`${sideAxis}:${Math.sign(normal[sideAxis])}`);
    }
    if (sides.size !== 6) return null;
    const extent: Vec3Tuple = [upper(max[0] - min[0]), upper(max[1] - min[1]), upper(max[2] - min[2])];
    if (!extent.every((value) => Number.isFinite(value) && value > 2 * tolerance)) return null;
    const surfaceAreaUpper = upper(2 * upper(upper(extent[0] * extent[1]) + upper(upper(extent[1] * extent[2]) + upper(extent[2] * extent[0]))));
    const extentLower: Vec3Tuple = [lower(max[0] - min[0]), lower(max[1] - min[1]), lower(max[2] - min[2])];
    const coordinateMagnitude = Math.max(...min.map(Math.abs), ...max.map(Math.abs));
    return Number.isFinite(surfaceAreaUpper) ? {
      surfaceAreaUpper,
      min: [min[0], min[1], min[2]],
      max: [max[0], max[1], max[2]],
      extent,
      extentLower,
      coordinateMagnitude,
    } : null;
  } finally { release(); }
}

/** TwoDiff。丸められた差だけで異なる配置を同じキーへ入れない。 */
function exactDifference(a: number, b: number): readonly [number, number] {
  const high = a - b; const virtualB = a - high; const virtualA = high + virtualB;
  return [high, (a - virtualA) + (virtualB - b)];
}
interface TranslationSignature { readonly key: string; readonly family: string; readonly difference: readonly number[] }
function translationSignature(a: PreparedComponent, b: PreparedComponent): TranslationSignature | null {
  const difference = b.spec.placement.position.flatMap((value, axis) => exactDifference(value, a.spec.placement.position[axis]));
  if (!difference.every(Number.isFinite)) return null;
  const family = JSON.stringify([a.keys, b.keys, a.spec.placement.rotation, b.spec.placement.rotation]);
  return { key: JSON.stringify([family, difference]), family, difference };
}

/**
 * 同じ認証済み軸平行直方体B=I0×I1×I2を、1軸kだけずらしたB+δekに限る。
 * k以外の区間は完全一致。平行面は離隔/一致、直交面の交線はどちらかの既存端辺で、
 * 面内部を横切る新しい交線を作らない。OCCT GlueShiftが省略するFace/Face計算の十分条件。
 * 回転/多軸/同位置/接触/閾値近傍は通常Common。公差で「同じ軸」と丸めない。
 * 下地Locationは認証側が読んだものをplaceShapeで1度だけ動かす。
 */
function canGlueTranslatedBox(a: PreparedComponent, b: PreparedComponent, proof: InterferenceBoxProof | null | undefined): boolean {
  if (proof == null || a.shapes.length !== 1 || b.shapes.length !== 1 || a.shapes[0] !== b.shapes[0]) return false;
  const first = a.spec.placement; const second = b.spec.placement;
  // 非単位のwも既存配置口が正規化する。xyz=0は厳密に恒等回転。
  if ([first.rotation, second.rotation].some((q) => q[0] !== 0 || q[1] !== 0 || q[2] !== 0 || q[3] === 0)) return false;
  const differences = second.position.map((value, axis) => exactDifference(value, first.position[axis]));
  const axes = differences.flatMap((value, axis) => value[0] !== 0 || value[1] !== 0 ? [axis] : []);
  if (axes.length !== 1) return false;
  const axis = axes[0]; const delta = differences[axis];
  const shiftUpper = upper(Math.abs(delta[0]) + Math.abs(delta[1]));
  const shiftLower = lower(Math.abs(delta[0]) - Math.abs(delta[1]));
  const coordinateMagnitude = Math.max(...first.position.map(Math.abs), ...second.position.map(Math.abs));
  const arithmeticError = upper(upper(proof.coordinateMagnitude + coordinateMagnitude) * Number.EPSILON * 16);
  if (!Number.isFinite(shiftUpper) || arithmeticError >= 1e-7) return false;
  const margin = upper(INTERFERENCE_AABB_PADDING_MM + arithmeticError);
  const overlapLower = lower(proof.extentLower[axis] - shiftUpper);
  if (shiftLower <= margin || overlapLower <= margin) return false;
  let volumeLower = 1;
  for (let index = 0; index < 3; index += 1) volumeLower = lower(volumeLower * (index === axis ? overlapLower : proof.extentLower[index]));
  return Number.isFinite(volumeLower)
    && volumeLower > upper(MIN_INTERFERENCE_VOLUME_MM3 + upper(proof.surfaceAreaUpper * margin));
}

/**
 * Common が重なりを確定した後の表示用だけを、認証済み直方体の厳密な区間積から作る。
 * 判定と体積は常に非破壊 Common の結果を使い、この経路は任意 B-rep や回転へ広げない。
 */
function translatedBoxMesh(
  a: PreparedComponent,
  b: PreparedComponent,
  proof: InterferenceBoxProof | null | undefined,
): InterferenceMesh | null {
  if (!canGlueTranslatedBox(a, b, proof) || proof == null) return null;
  const minAt = (axis: number): number => Math.max(
    proof.min[axis] + a.spec.placement.position[axis],
    proof.min[axis] + b.spec.placement.position[axis],
  );
  const maxAt = (axis: number): number => Math.min(
    proof.max[axis] + a.spec.placement.position[axis],
    proof.max[axis] + b.spec.placement.position[axis],
  );
  const min: Vec3Tuple = [minAt(0), minAt(1), minAt(2)];
  const max: Vec3Tuple = [maxAt(0), maxAt(1), maxAt(2)];
  if (![...min, ...max].every(Number.isFinite) || min.some((value, axis) => value >= max[axis])) return null;
  const [x0, y0, z0] = min; const [x1, y1, z1] = max;
  const faces = [
    { normal: [-1, 0, 0], corners: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]] },
    { normal: [1, 0, 0], corners: [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]] },
    { normal: [0, -1, 0], corners: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]] },
    { normal: [0, 1, 0], corners: [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]] },
    { normal: [0, 0, -1], corners: [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]] },
    { normal: [0, 0, 1], corners: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] },
  ] as const;
  const positions = new Float32Array(faces.flatMap((face) => face.corners.flatMap((corner) => corner)));
  const normals = new Float32Array(faces.flatMap((face) => face.corners.flatMap(() => face.normal)));
  const indices = new Uint32Array(faces.flatMap((_, face) => {
    const start = face * 4;
    return [start, start + 1, start + 2, start, start + 2, start + 3];
  }));
  return { positions, normals, indices, triangleCount: 12 };
}
interface SharedPairResult { readonly pair: InterferencePair; readonly origin: Vec3Tuple; readonly displacementUpper: number }
interface PairCluster { readonly shared: SharedPairResult; readonly difference: readonly number[]; readonly surfaceAreaUpper: number }
export function interferenceTranslationDeltaUpper(first: readonly number[], second: readonly number[]): number {
  let bound = 0;
  for (let index = 0; index < first.length; index += 1) {
    const difference = exactDifference(first[index], second[index]);
    bound = upper(bound + upper(Math.abs(difference[0]) + Math.abs(difference[1])));
  }
  return bound;
}
/** 新しいFloat32への通常丸めとは別に、再利用で足される誤差だけを上界する。 */
function canTranslateMesh(shared: SharedPairResult, a: PreparedComponent, displacementUpper = 0): boolean {
  const delta = a.spec.placement.position.map((value, axis) => exactDifference(value, shared.origin[axis]));
  return shared.pair.mesh.positions.every((value, index) => {
    const offset = delta[index % 3];
    const halfUlp = value === 0 ? 0 : 2 ** (Math.floor(Math.log2(Math.abs(value))) - 24);
    const arithmetic = upper((Math.abs(value) + Math.abs(offset[0]) + Math.abs(offset[1])) * Number.EPSILON * 4);
    const extraError = upper(upper(halfUlp + arithmetic) + displacementUpper);
    return Number.isFinite(Math.fround(value + offset[0] + offset[1])) && extraError < INTERFERENCE_AABB_PADDING_MM;
  });
}
function translatedPair(shared: SharedPairResult, a: PreparedComponent, pair: InterferencePairId): InterferencePair {
  const delta = a.spec.placement.position.map((value, axis) => exactDifference(value, shared.origin[axis]));
  const positions = shared.pair.mesh.positions.map((value, index) => value + delta[index % 3][0] + delta[index % 3][1]);
  return { aComponentId: pair[0], bComponentId: pair[1], volume: shared.pair.volume,
    mesh: { positions, normals: shared.pair.mesh.normals.slice(), indices: shared.pair.mesh.indices.slice(), triangleCount: shared.pair.mesh.triangleCount } };
}

/** 1job内だけの借用snapshot。キャッシュへ書き戻さず全nativeをjob終了時に返す。 */
export async function checkInterference(
  request: InterferenceRequest,
  oc: OpenCascadeInstance,
  bodies: ReadonlyMap<string, CachedSolid | undefined>,
  onProgress?: InterferenceProgressCallback,
  shouldCancel?: SolidCancelToken,
  callbackDelivery?: 'message',
): Promise<InterferenceResult> {
  const snapshot = snapshotInterferenceRequest(request);
  const preparation = prepareInterference(snapshot);
  let result = initialInterferenceResult(snapshot, preparation);
  if (result.kind === 'failed') return result;
  const borrowed = new Map(bodies);
  const pairs: InterferencePair[] = []; const failures: InterferencePairFailure[] = [];
  const boxes: OcctDeletable[] = []; const unions: OcctDeletable[] = []; const placed: OcctDeletable[] = [];
  const components = new Map<string, Prepared>();
  const localBoxes = new Map<string, Bnd_Box | ComponentFailure>();
  const validatedBodies = new Map<string, TopoDS_Shape | ComponentFailure>();
  const combined = new Map<string, TopoDS_Shape | ComponentFailure>();
  const worldShapes = new Map<string, TopoDS_Shape | ComponentFailure>();
  // job内の純JS結果だけ。shape/leaseや失敗・取消をcacheへ保持しない。
  const sharedPairs = new Map<string, SharedPairResult>();
  const clusters = new Map<string, PairCluster[]>();
  const boxProofs = new Map<string, InterferenceBoxProof | null>();
  let checked = 0; let completedComponents = 0; let cancelled = false;
  let checkpointFailureCode: 'callbackFailed' | 'unexpectedFailure' | undefined;
  const interruptedCleanup: string[] = [];
  let taskQueue: MessageChannel | undefined;
  let pendingTask: { resolve(): void; reject(error: Error): void } | undefined;
  let taskRelayed = false;
  async function queueMacrotask(): Promise<void> {
    if (typeof MessageChannel === 'undefined') return new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (taskQueue === undefined) {
      taskQueue = new MessageChannel();
      const runTask = (port: MessagePort): void => {
        const task = pendingTask;
        if (task === undefined) return;
        try {
          // 両portを一往復させ、別portへ届く取消messageにも実行機会を渡す。
          if (!taskRelayed) { taskRelayed = true; port.postMessage(null); return; }
          if (taskQueue !== undefined) for (const candidate of [taskQueue.port1, taskQueue.port2]) {
            const port: ReferencedMessagePort = candidate;
            if (hasPortReferences(port) && 'unref' in port && typeof port.unref === 'function') port.unref();
          }
          pendingTask = undefined;
          task.resolve();
        } catch (error) {
          // MessagePort callbackはPromise executorの外。必ず待機中のawaitへ戻す。
          pendingTask = undefined;
          task.reject(error instanceof Error ? error : new Error(detail(error)));
        }
      };
      const channel = taskQueue;
      channel.port1.onmessage = () => { runTask(channel.port1); };
      channel.port2.onmessage = () => { runTask(channel.port2); };
    }
    const channel = taskQueue;
    // 実timerを待つ。Nodeではcheck phaseを回してpollの粗い待機時間を避ける。
    // タイマー自身の発火を待つので、先行する取消timerの到達保証は変わらない。
    await new Promise<void>((resolve) => {
      let waiting = true;
      setTimeout(() => { waiting = false; resolve(); }, 0);
      if (typeof setImmediate === 'function') {
        const pump = (): void => { if (waiting) setImmediate(pump); };
        setImmediate(pump);
      }
    });
    return new Promise<void>((resolve, reject) => {
      pendingTask = { resolve, reject };
      try {
        taskRelayed = false;
        const port: ReferencedMessagePort = channel.port1;
        if (hasPortReferences(port) && 'ref' in port && typeof port.ref === 'function') port.ref();
        channel.port2.postMessage(null);
      } catch (error) { pendingTask = undefined; reject(error instanceof Error ? error : new Error(detail(error))); }
    });
  }
  const report = (): InterferenceReport => ({ ...result, pairs, failures, checkedPairCount: checked,
    pendingPairCount: preparation.jobs.length - checked - failures.length, cancelled });
  async function checkpoint(phase: InterferenceProgress['phase'], currentPair?: InterferencePairId, afterCommon = false): Promise<boolean> {
    try {
      // 同期nativeの間にWorkerの取消messageを配送する。microtaskだけでは届かない。
      // 実Comlink callbackはこの後のawait自体がMessagePort往復。directだけtimerを補う。
      if (shouldCancel !== undefined && (callbackDelivery !== 'message' || afterCommon)) await queueMacrotask();
    } catch (error) { checkpointFailureCode = 'unexpectedFailure'; throw error; }
    try {
      if (await shouldCancel?.()) { cancelled = true; return false; }
      await onProgress?.({ requestId: snapshot.requestId, phase, completedPairs: checked + failures.length + preparation.skips.length,
        totalPairs: preparation.total, completedComponents, totalComponents: snapshot.components.length,
        ...(currentPair === undefined ? {} : { currentPair }) });
      if (await shouldCancel?.()) { cancelled = true; return false; }
      return true;
    } catch (error) { checkpointFailureCode = 'callbackFailed'; throw error; }
  }
  async function prepareComponent(spec: InterferenceComponentSpec): Promise<Prepared | null> {
    if (spec.kind === 'unavailable') return { stage: 'input', code: spec.code, message: spec.message,
      ...(spec.missingKeys === undefined ? {} : { missingKeys: spec.missingKeys }) };
    if (spec.kind !== 'ready') return { stage: 'input', code: 'invalidInput', message: '除外済みの部品です。' };
    if (!validPlacement(spec.placement)) return { stage: 'input', code: 'invalidPlacement', message: '部品の位置や向きが正しくありません。' };
    const missing = spec.bodyKeys.filter((key) => borrowed.get(key) === undefined);
    if (missing.length > 0 || spec.bodyKeys.length === 0) return { stage: 'input', code: 'missingBody',
      message: 'もとになる立体が見つかりませんでした。', missingKeys: missing };
    const shapes: TopoDS_Shape[] = [];
    for (const key of spec.bodyKeys) {
      let validated = validatedBodies.get(key);
      if (validated === undefined) {
        if (!await checkpoint('prepare')) return null;
        const body = borrowed.get(key);
        if (body === undefined || body.shape.IsNull()) validated = { stage: 'input', code: 'missingBody', message: 'もとになる立体がありません。', missingKeys: [key] };
        else if (body.mesh.bodyKind !== 'solid' || !containsSolid(oc, body.shape)) validated = { stage: 'input', code: 'unsupportedBody', message: '面や三角形だけの部品は調べられません。' };
        else validated = body.shape;
        validatedBodies.set(key, validated);
        if (!('code' in validated)) boxProofs.set(key, certifyInterferenceBox(oc, validated));
      }
      if ('code' in validated) return validated;
      shapes.push(validated);
    }
    const bounds = new oc.Bnd_Box_1(); boxes.push(bounds);
    for (let index = 0; index < spec.bodyKeys.length; index += 1) {
      const key = spec.bodyKeys[index];
      let box = localBoxes.get(key);
      if (box === undefined) {
        if (!await checkpoint('prepare')) return null;
        try { box = conservativeBodyBounds(oc, shapes[index]); boxes.push(box); }
        catch (error) { box = { stage: 'bounds', code: 'boundsFailed', message: detail(error) }; }
        localBoxes.set(key, box);
      }
      if ('code' in box) return box;
      bounds.Add_1(box);
    }
    const world = conservativeWorldBounds(oc, bounds, spec.placement);
    if (world !== null) boxes.push(world);
    return { shapes, keys: JSON.stringify(spec.bodyKeys), box: world, spec };
  }
  async function worldShape(component: PreparedComponent, pair: InterferencePairId): Promise<TopoDS_Shape | ComponentFailure | null> {
    const cached = worldShapes.get(component.spec.componentId);
    if (cached !== undefined) return cached;
    let shape = combined.get(component.keys);
    if (shape === undefined) {
      shape = component.shapes[0];
      for (const next of component.shapes.slice(1)) {
        if (!await checkpoint('prepare', pair)) return null;
        try { const joined = booleanOp(oc, 'union', shape, next); unions.push(joined); shape = joined.shape; }
        catch (error) { shape = { stage: 'union', code: 'unionFailed', message: detail(error) }; break; }
      }
      combined.set(component.keys, shape);
    }
    if ('code' in shape) return shape;
    if (!await checkpoint('prepare', pair)) return null;
    let world: TopoDS_Shape | ComponentFailure;
    try { const handle = placeShape(oc, shape, component.spec.placement); placed.push(handle); world = handle.shape; }
    catch (error) { world = { stage: 'placement', code: 'invalidPlacement', message: detail(error) }; }
    worldShapes.set(component.spec.componentId, world);
    return world;
  }
  try {
    // 資源を取得した後はfinallyより前に返却値を確定しない。開始前取消も同じ出口へ送る。
    await checkpoint('prepare');
    const needed = new Set(preparation.jobs.flatMap((job) => job.pair));
    for (const spec of snapshot.components) {
      if (cancelled) break;
      if (!needed.has(spec.componentId)) continue;
      if (!await checkpoint('prepare')) break;
      try {
        const prepared = await prepareComponent(spec);
        if (prepared === null) break;
        components.set(spec.componentId, prepared);
      } catch (error) {
        if (checkpointFailureCode !== undefined) throw error;
        components.set(spec.componentId, { stage: 'bounds', code: 'boundsFailed', message: detail(error) });
      }
      completedComponents += 1;
    }
    const candidates: PairJob[] = [];
    if (!cancelled) for (let index = 0; index < preparation.jobs.length; index += 1) {
      const job = preparation.jobs[index];
      if (index % 64 === 0 && !await checkpoint('candidates', job.pair)) break;
      const a = components.get(job.pair[0]); const b = components.get(job.pair[1]);
      if (a === undefined || b === undefined) throw new Error('部品の準備が完了していません。');
      if (!('shapes' in a) || !('shapes' in b)) { failures.push({ ...(!('shapes' in a) ? a : !('shapes' in b) ? b : { stage: 'input', code: 'invalidInput', message: '' }), pair: job.pair }); continue; }
      try {
        if (a.box !== null && b.box !== null && !boundingBoxesOverlap(a.box, b.box)) { checked += 1; continue; }
        candidates.push(job);
      } catch (error) { failures.push({ pair: job.pair, stage: 'bounds', code: 'boundsFailed', message: detail(error) }); }
    }
    // 箱の解放失敗で候補を陰性に見せない。既確定結果を保ったroot failureへ送る。
    const boundsCleanup = releaseAll(boxes);
    if (boundsCleanup.length > 0) result = interferenceRootFailure(result, { code: 'cleanupFailed', message: '境界箱の片付けに失敗しました。', cleanupMessages: boundsCleanup });
    if (!cancelled && result.kind !== 'failed') for (const [candidateIndex, job] of candidates.entries()) {
      if (candidateIndex % 64 === 0 && !await checkpoint('candidates', job.pair)) break;
      const a = components.get(job.pair[0]); const b = components.get(job.pair[1]);
      if (a === undefined || b === undefined || !('shapes' in a) || !('shapes' in b)) throw new Error('部品の準備がありません。');
      const signature = translationSignature(a, b);
      const key = signature?.key;
      let shared = key === undefined ? undefined : sharedPairs.get(key);
      if (shared !== undefined && !canTranslateMesh(shared, a, shared.displacementUpper)) shared = undefined;
      if (shared === undefined && signature !== null) for (const cluster of clusters.get(signature.family) ?? []) {
        const displacement = interferenceTranslationDeltaUpper(signature.difference, cluster.difference);
        const volumeError = upper(cluster.surfaceAreaUpper * displacement);
        // 回転差0・平行な直方体の交差。max/minは1-Lipschitz、体積差はS||δ||以下。
        if (displacement < 1e-7 && volumeError < MIN_INTERFERENCE_VOLUME_MM3
          && cluster.shared.pair.volume > upper(MIN_INTERFERENCE_VOLUME_MM3 + volumeError)
          && canTranslateMesh(cluster.shared, a, displacement)) {
          shared = { ...cluster.shared, displacementUpper: displacement };
          sharedPairs.set(signature.key, shared); break;
        }
      }
      if (shared !== undefined) {
        // nativeを始めないJS複写は64組ずつ配送する。取消後にCommonを始めない。
        pairs.push(translatedPair(shared, a, job.pair));
        checked += 1;
        continue;
      }
      const first = await worldShape(a, job.pair); if (first === null) break;
      const second = await worldShape(b, job.pair); if (second === null) break;
      if ('code' in first || 'code' in second) { failures.push({ ...('code' in first ? first : 'code' in second ? second : { stage: 'input', code: 'invalidInput', message: '' }), pair: job.pair }); continue; }
      if (!await checkpoint('common', job.pair)) break;
      const certifiedMesh = translatedBoxMesh(a, b, boxProofs.get(a.spec.bodyKeys[0]));
      let common: ReturnType<typeof intersectionVolume>;
      try {
        common = certifiedMesh !== null
          ? intersectionVolume(oc, first, second, {
            glue: 'shift', collectHistory: false, nonInverted: true, certifiedBoxOverlap: true,
          }) : intersectionVolume(oc, first, second);
      }
      catch (error) { failures.push({ pair: job.pair, stage: 'common', code: 'occtException', message: detail(error) }); continue; }
      if (common.kind === 'failed') { failures.push({ ...common.failure, pair: job.pair, stage: 'common' }); continue; }
      if (common.kind === 'clear') { checked += 1; continue; }
      let overlap: InterferencePair | undefined; let failure: ComponentFailure | undefined;
      try {
        if (await checkpoint('mesh', job.pair, true)) {
          const mesh = certifiedMesh ?? buildExportMesh(oc, common.shape, DEFAULT_LINEAR_DEFLECTION, { angularDeflectionRad: DEFAULT_ANGULAR_DEFLECTION });
          overlap = { aComponentId: job.pair[0], bComponentId: job.pair[1], volume: common.volume,
            mesh: { positions: mesh.positions, normals: mesh.normals, indices: mesh.indices, triangleCount: mesh.triangleCount } };
        }
      } catch (error) {
        if (checkpointFailureCode !== undefined) throw error;
        failure = { stage: 'mesh', code: 'meshFailed', message: detail(error) };
      } finally {
        const cleanupMessages = releaseAll([common]);
        if (checkpointFailureCode !== undefined) interruptedCleanup.push(...cleanupMessages);
        else if (cleanupMessages.length > 0) failure = { ...(failure ?? { stage: 'release', code: 'cleanupFailed', message: '重なりの片付けに失敗しました。' }), cleanupMessages };
      }
      if (failure !== undefined) failures.push({ ...failure, pair: job.pair });
      else if (overlap !== undefined) {
        pairs.push(overlap); checked += 1;
        const sharedResult: SharedPairResult = { pair: overlap, origin: a.spec.placement.position, displacementUpper: 0 };
        if (key !== undefined && canTranslateMesh(sharedResult, a)) {
          sharedPairs.set(key, sharedResult);
          const proofA = a.shapes.length === 1 ? boxProofs.get(a.spec.bodyKeys[0]) : null;
          const proofB = b.shapes.length === 1 ? boxProofs.get(b.spec.bodyKeys[0]) : null;
          if (signature !== null && proofA != null && proofB != null
            && a.spec.placement.rotation.every((value, axis) => value === b.spec.placement.rotation[axis])) {
            const family = clusters.get(signature.family) ?? [];
            family.push({ shared: sharedResult, difference: signature.difference, surfaceAreaUpper: proofB.surfaceAreaUpper });
            clusters.set(signature.family, family);
          }
        }
      }
      if (cancelled || !await checkpoint('mesh', job.pair)) break;
    }
    if (!cancelled && result.kind !== 'failed') await checkpoint('mesh');
  } catch (error) {
    result = interferenceRootFailure(result, { code: checkpointFailureCode ?? 'unexpectedFailure', message: detail(error) });
  } finally {
    const channel = taskQueue;
    const taskCleanup = channel === undefined ? [] : releaseAll([
      { delete() { channel.port1.close(); } }, { delete() { channel.port2.close(); } },
      { delete() { channel.port1.onmessage = null; } }, { delete() { channel.port2.onmessage = null; } },
    ]);
    const cleanupMessages = [...interruptedCleanup, ...taskCleanup, ...releaseAll(boxes), ...releaseAll(placed), ...releaseAll(unions)];
    if (cleanupMessages.length > 0) result = interferenceRootFailure(result, result.kind === 'failed'
      ? { ...result.failure, cleanupMessages: [...(result.failure.cleanupMessages ?? []), ...cleanupMessages] }
      : { code: 'cleanupFailed', message: '干渉を調べた後の片付けに失敗しました。', cleanupMessages });
  }
  const ordinal = new Map(snapshot.components.map((component, index) => [component.componentId, index]));
  const compareIds = (a: InterferencePairId, b: InterferencePairId): number =>
    (ordinal.get(a[0]) ?? 0) - (ordinal.get(b[0]) ?? 0) || (ordinal.get(a[1]) ?? 0) - (ordinal.get(b[1]) ?? 0);
  pairs.sort((a, b) => b.volume - a.volume || compareIds([a.aComponentId, a.bComponentId], [b.aComponentId, b.bComponentId]));
  failures.sort((a, b) => compareIds(a.pair, b.pair));
  return { ...result, ...report() };
}
