import { applyPlacementToPoint, type SolidBody } from '@pointercad/model';
import { parseAssemblyTargetId } from '../assembly/mateCommands.js';
import { parseSubShapeId } from '../solid/subShapeSelection.js';
import type { SketchGeometryBundle } from './buildSketchGeometry.js';
import type { SolidDrawEntry, SolidGeometryBundle } from './buildSolidGeometry.js';
import { clamp, MAX_DISTANCE, MIN_DISTANCE, VERTICAL_FIELD_OF_VIEW, type OrbitState } from './cameraMath.js';
import type { AssemblyGeometryBundle } from './createAssemblyLayer.js';

/*
 * 「全体を表示」「選択に合わせる」(設計 2-3、B-08c)。表示中の形の外接箱を、scene が持つ描画の一式(部品の立体・
 * スケッチ・組立の配置)から求め、向き・上向き・レンズのズームを保ったまま、注視点を箱の中心へ、距離を外接球が
 * 画面に収まる長さへ変える。three.js にも DOM にも触れない純関数だけを置く(Node で検査できる)。
 */

type Point = readonly [number, number, number];

/** 外接箱(mm、ワールド座標)。 */
export interface ViewBounds {
  readonly min: Point;
  readonly max: Point;
}

/** 外接球の直径が画面の短い辺の約 9 割になる余白。 */
const FIT_MARGIN = 1.1;
/** 点 1 つ・線 1 本だけでも寄りすぎない最小の半径(mm)。 */
const MIN_FIT_RADIUS = 1;

/** 外接箱を点ごとに広げる入れ物。有限でない座標は数えない。 */
function createBoundsBuilder() {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const add = (x: number, y: number, z: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    min[0] = Math.min(min[0] ?? x, x); min[1] = Math.min(min[1] ?? y, y); min[2] = Math.min(min[2] ?? z, z);
    max[0] = Math.max(max[0] ?? x, x); max[1] = Math.max(max[1] ?? y, y); max[2] = Math.max(max[2] ?? z, z);
  };
  /** x, y, z の並びの [start, end) を origin だけずらして足す。 */
  const addPositions = (positions: ArrayLike<number>, origin: Point = [0, 0, 0], start = 0, end = positions.length): void => {
    for (let index = Math.max(0, start); index + 3 <= Math.min(end, positions.length); index += 3) {
      add((positions[index] ?? Number.NaN) + origin[0], (positions[index + 1] ?? Number.NaN) + origin[1],
        (positions[index + 2] ?? Number.NaN) + origin[2]);
    }
  };
  const result = (): ViewBounds | null => {
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    if (x0 === undefined || y0 === undefined || z0 === undefined || x1 === undefined || y1 === undefined || z1 === undefined
      || x0 > x1) return null;
    return { min: [x0, y0, z0], max: [x1, y1, z1] };
  };
  return { add, addPositions, result };
}
type BoundsBuilder = ReturnType<typeof createBoundsBuilder>;

function originOf(frame: SolidBody['coordinateFrame']): Point {
  return frame === undefined ? [0, 0, 0] : frame.origin;
}

/** 立体 1 つの、選んだ部分(面・辺・頂点)。部分の番号が無い時は何も足さない。 */
function addSubShape(builder: BoundsBuilder, entry: SolidDrawEntry, kind: string, index: number): void {
  const origin = originOf(entry.coordinateFrame);
  if (kind === 'face') {
    const face = entry.faces.find(item => item.index === index);
    if (face === undefined) return;
    for (let triangle = face.triangleOffset; triangle < face.triangleOffset + face.triangleCount; triangle += 1) {
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = entry.indices[triangle * 3 + corner];
        if (vertex !== undefined) builder.addPositions(entry.positions, origin, vertex * 3, vertex * 3 + 3);
      }
    }
  } else if (kind === 'edge') {
    const edge = entry.edges.find(item => item.index === index);
    if (edge !== undefined) builder.addPositions(entry.edgePositions, origin, edge.segmentOffset * 6, (edge.segmentOffset + edge.segmentCount) * 6);
  } else if (kind === 'vertex') {
    const vertex = entry.vertices.find(item => item.index === index);
    // 頂点の位置は部品座標の倍精度の値(描画の並びの局所の原点は掛からない)。
    if (vertex !== undefined) builder.add(...vertex.position);
  }
}

/** 部品の画面: 立体(選んだ id だけ、または全部)とスケッチ(選択の強調の並び、または全部)。 */
function partBounds(solid: SolidGeometryBundle, sketch: SketchGeometryBundle | null, selection: readonly string[] | null): ViewBounds | null {
  const builder = createBoundsBuilder();
  if (selection === null) {
    for (const entry of solid.entries) builder.addPositions(entry.positions, originOf(entry.coordinateFrame));
  } else {
    for (const id of selection) {
      const whole = solid.index.get(id);
      if (whole !== undefined) { builder.addPositions(whole.positions, originOf(whole.coordinateFrame)); continue; }
      const part = parseSubShapeId(id), entry = part === null ? undefined : solid.index.get(part.bodyFeatureId);
      if (part !== null && entry !== undefined) addSubShape(builder, entry, part.kind, part.index);
    }
  }
  if (sketch !== null) {
    // スケッチの選択は、描画の強調の並び(選択が最も強い)をそのまま使う。構築線も同じ。
    const emphases = selection === null ? (['none', 'constrained', 'hovered', 'selected'] as const) : (['selected'] as const);
    for (const emphasis of emphases) {
      for (const buffers of [sketch.points, sketch.curves, sketch.constructionCurves, sketch.faceOutlines]) builder.addPositions(buffers[emphasis]);
    }
    for (const face of sketch.faces) if (selection === null || face.emphasis === 'selected') builder.addPositions(face.positions);
  }
  return builder.result();
}

/** 組立の画面: 見えている配置ごとに、部品の形の外接箱の 8 隅を配置で写す(回した箱を囲む箱。少し大きめになる)。 */
function assemblyBounds(assembly: AssemblyGeometryBundle, selection: readonly string[] | null): ViewBounds | null {
  const partBoxes = new Map<string, ViewBounds | null>();
  const selected = selection === null ? null
    : new Set(selection.map(id => parseAssemblyTargetId(id)?.componentId ?? id));
  const builder = createBoundsBuilder();
  for (const instance of assembly.instances) {
    if (!instance.visible) continue;
    if (selected !== null && !selected.has(instance.componentId) && instance.emphasis !== 'selected'
      && (instance.subShapes?.selected.length ?? 0) === 0) continue;
    if (!partBoxes.has(instance.partKey)) {
      const local = createBoundsBuilder();
      for (const body of assembly.parts.find(part => part.partKey === instance.partKey)?.bodies ?? []) {
        local.addPositions(body.mesh.positions, originOf(body.coordinateFrame));
      }
      partBoxes.set(instance.partKey, local.result());
    }
    const box = partBoxes.get(instance.partKey) ?? null;
    if (box === null) continue;
    for (const x of [box.min[0], box.max[0]]) for (const y of [box.min[1], box.max[1]]) for (const z of [box.min[2], box.max[2]]) {
      builder.add(...applyPlacementToPoint(instance.placement, [x, y, z]));
    }
  }
  return builder.result();
}

/** 描画の一式。組立の画面では組立だけ、部品の画面では立体とスケッチを使う(呼ぶ側が今の画面で選ぶ)。 */
export type ViewFitSource =
  | { readonly kind: 'part'; readonly solid: SolidGeometryBundle; readonly sketch: SketchGeometryBundle | null }
  | { readonly kind: 'assembly'; readonly assembly: AssemblyGeometryBundle };

/** 収める外接箱。scope が 'selection' の時は選んだ物だけ。収める物が無ければ null。 */
export function viewFitBounds(source: ViewFitSource, scope: 'all' | 'selection', selection: readonly string[]): ViewBounds | null {
  const chosen = scope === 'all' ? null : selection;
  return source.kind === 'part' ? partBounds(source.solid, source.sketch, chosen) : assemblyBounds(source.assembly, chosen);
}

/**
 * 外接箱が収まる視点。向き・上向き・レンズのズームは今のまま、注視点を箱の中心へ、距離を外接球が縦と横の狭い方の
 * 画角に余白つきで収まる長さへ変える。平行投影の大きさも距離で決まる(orthographicFrustumHeight)ので同じ式で収まる。
 */
export function fitOrbitToBounds(current: OrbitState, bounds: ViewBounds, aspect: number): OrbitState | null {
  const target: Point = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2];
  const radius = Math.max(MIN_FIT_RADIUS, Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2]) / 2);
  const zoom = current.zoom ?? 1;
  if (![...target, radius, aspect, zoom].every(Number.isFinite) || aspect <= 0 || zoom <= 0) return null;
  const halfVertical = Math.atan(Math.tan(VERTICAL_FIELD_OF_VIEW / 2) / zoom);
  const halfHorizontal = Math.atan(Math.tan(halfVertical) * aspect);
  const distance = clamp(radius * FIT_MARGIN / Math.sin(Math.min(halfVertical, halfHorizontal)), MIN_DISTANCE, MAX_DISTANCE);
  return { ...current, target, distance };
}
