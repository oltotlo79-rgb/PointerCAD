import { drawingViewBasis, type ClipRegion, type DrawingView, type Point2, type Vector3 } from '@pointercad/drawing';
import { drawingModelPointToPaper, type DimensionResolveContext } from './dimensionTarget.js';
import type { ConstructedDrawingView } from './viewConstruction.js';

type Polygon = readonly Vector3[];
type Distance = (point: Vector3) => number;
const EPS = 1e-9;
const dot = (a: Vector3, b: Vector3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Point2, b: Point2, c: Point2): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const mean = (points: Polygon): Vector3 => {
  const coordinate = (axis: number): number => points.reduce((sum, point) => sum + point[axis], 0) / points.length;
  return [coordinate(0), coordinate(1), coordinate(2)];
};

/** 平面の正側へ凸多角形を切り詰める。元面上の3D点を補間して保持する。 */
function clip(polygon: Polygon, distance: Distance): Polygon {
  const result: Vector3[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length], da = distance(a), db = distance(b);
    if (da >= -EPS) result.push(a);
    if ((da < -EPS && db > EPS) || (da > EPS && db < -EPS)) {
      const t = da / (da - db);
      result.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
  }
  return result.length < 3 ? [] : result;
}

/** 凹領域を凸な三角形へ分ける。穴はなく、入力は図の構築時に検証済み。 */
function triangles(input: readonly Point2[]): readonly (readonly Point2[])[] | null {
  const points = [...input];
  let signed = 0;
  for (let i = 0; i < points.length; i++) signed += cross([0, 0], points[i], points[(i + 1) % points.length]);
  if (Math.abs(signed) <= EPS) return null;
  if (signed < 0) points.reverse();
  const output: Point2[][] = [];
  while (points.length > 3) {
    let removed = false;
    for (let i = 0; i < points.length; i++) {
      const before = (i + points.length - 1) % points.length, after = (i + 1) % points.length;
      const a = points[before], b = points[i], c = points[after], area = cross(a, b, c);
      if (Math.abs(area) <= EPS) { points.splice(i, 1); removed = true; break; }
      if (area < 0 || points.some((point, index) => index !== before && index !== i && index !== after
        && cross(a, b, point) >= -EPS && cross(b, c, point) >= -EPS && cross(c, a, point) >= -EPS)) continue;
      output.push([a, b, c]); points.splice(i, 1); removed = true; break;
    }
    if (!removed) return null;
  }
  if (points.length === 3 && cross(points[0], points[1], points[2]) > EPS) output.push(points);
  return output;
}

function edges(region: readonly Point2[], project: (point: Vector3) => Point2): readonly Distance[] {
  return region.map((a, i) => (point: Vector3) => cross(a, region[(i + 1) % region.length], project(point)));
}
function intersection(polygon: Polygon, limits: readonly Distance[]): Polygon {
  let current = polygon;
  for (const distance of limits) { current = clip(current, distance); if (current.length === 0) break; }
  return current;
}
function subtract(polygon: Polygon, limits: readonly Distance[]): readonly Polygon[] {
  const outside: Polygon[] = []; let inside = polygon;
  for (const distance of limits) {
    const piece = clip(inside, (point) => -distance(point)); if (piece.length > 0) outside.push(piece);
    inside = clip(inside, distance); if (inside.length === 0) break;
  }
  return outside;
}

function sectionPieces(polygon: Polygon, section: ConstructedDrawingView['section']): readonly Polygon[] {
  if (section === undefined) return [polygon];
  if (section.kind === 'revolved') return [];
  const relative = (point: Vector3): Vector3 => [point[0] - section.plane.origin[0], point[1] - section.plane.origin[1], point[2] - section.plane.origin[2]];
  const u = (point: Vector3): number => dot(relative(point), section.plane.axisU);
  const v = (point: Vector3): number => dot(relative(point), section.plane.axisV);
  const depth = (point: Vector3): number => dot(relative(point), section.plane.normal);
  const sign = section.keepSide === 'positive' ? 1 : -1;
  const keep: Distance = (point) => sign * depth(point);
  const boundary = section.boundary ?? [];
  if (section.kind === 'half') {
    const [a, b] = boundary; if (a === undefined || b === undefined) return [];
    const side: Distance = (point) => cross(a, b, [u(point), v(point)]);
    return [clip(polygon, (point) => -side(point)), intersection(polygon, [side, keep])].filter((piece) => piece.length > 0);
  }
  if (section.kind === 'local') {
    const regions = triangles(boundary); if (regions === null) return [];
    const retained = clip(polygon, keep); let outside: readonly Polygon[] = [clip(polygon, (point) => -keep(point))];
    for (const region of regions) outside = outside.flatMap((piece) => subtract(piece, edges(region, (point) => [u(point), v(point)])));
    return [retained, ...outside].filter((piece) => piece.length > 0);
  }
  if (section.kind === 'stepped') {
    if (boundary.length < 2) return [];
    let strips: readonly Polygon[] = [polygon];
    for (const position of new Set(boundary.map((point) => point[0]))) strips = strips.flatMap((piece) => {
      const values = piece.map(u);
      if (Math.min(...values) >= position - EPS || Math.max(...values) <= position + EPS) return [piece];
      return [clip(piece, (point) => u(point) - position), clip(piece, (point) => position - u(point))].filter((item) => item.length > 0);
    });
    return strips.map((piece) => {
      const center = u(mean(piece)); let slope = 0, offset = center < boundary[0][0] ? boundary[0][1] : boundary[boundary.length - 1][1];
      for (let i = 1; i < boundary.length; i++) {
        const a = boundary[i - 1], b = boundary[i];
        if (center < a[0] || center > b[0] || b[0] - a[0] <= EPS) continue;
        slope = (b[1] - a[1]) / (b[0] - a[0]); offset = a[1] - slope * a[0]; break;
      }
      return clip(piece, (point) => sign * (depth(point) - offset - slope * u(point)));
    }).filter((piece) => piece.length > 0);
  }
  const kept = clip(polygon, keep); return kept.length === 0 ? [] : [kept];
}

type Disk = Extract<ClipRegion, { kind: 'circle' }>;
/** 凸多角形と円盤群の共通領域上の点。円を折れ線へ近似しない。 */
function diskAnchor(polygon: readonly Point2[], disks: readonly Disk[]): Point2 | null {
  const orientation = polygon.reduce((area, a, i) => area + cross([0, 0], a, polygon[(i + 1) % polygon.length]), 0) >= 0 ? 1 : -1;
  const inside = (point: Point2): boolean => polygon.every((a, i) => orientation * cross(a, polygon[(i + 1) % polygon.length], point) >= -EPS)
    && disks.every((disk) => Math.hypot(point[0] - disk.center[0], point[1] - disk.center[1]) <= disk.radius + EPS);
  const candidates: Point2[] = [];
  const add = (point: Point2): void => { if (point.every(Number.isFinite) && inside(point)) candidates.push(point); };
  polygon.forEach(add);
  for (const disk of disks) {
    add(disk.center);
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length], dx = b[0] - a[0], dy = b[1] - a[1];
      const x = a[0] - disk.center[0], y = a[1] - disk.center[1], aa = dx * dx + dy * dy, bb = 2 * (x * dx + y * dy);
      const determinant = bb * bb - 4 * aa * (x * x + y * y - disk.radius * disk.radius);
      if (aa <= EPS || determinant < -EPS) continue;
      for (const t of [(-bb - Math.sqrt(Math.max(0, determinant))) / (2 * aa), (-bb + Math.sqrt(Math.max(0, determinant))) / (2 * aa)]) {
        if (t >= -EPS && t <= 1 + EPS) add([a[0] + t * dx, a[1] + t * dy]);
      }
    }
  }
  for (let i = 0; i < disks.length; i++) for (let j = i + 1; j < disks.length; j++) {
    const a = disks[i], b = disks[j], dx = b.center[0] - a.center[0], dy = b.center[1] - a.center[1], d = Math.hypot(dx, dy);
    if (d <= EPS || d > a.radius + b.radius + EPS || d < Math.abs(a.radius - b.radius) - EPS) continue;
    const along = (a.radius * a.radius - b.radius * b.radius + d * d) / (2 * d), h = Math.sqrt(Math.max(0, a.radius * a.radius - along * along));
    const x = a.center[0] + along * dx / d, y = a.center[1] + along * dy / d;
    add([x - h * dy / d, y + h * dx / d]); add([x + h * dy / d, y - h * dx / d]);
  }
  if (candidates.length === 0) return null;
  const point: Point2 = [candidates.reduce((sum, item) => sum + item[0], 0) / candidates.length,
    candidates.reduce((sum, item) => sum + item[1], 0) / candidates.length];
  return inside(point) ? point : null;
}

/** 紙面の省略・円/凹領域クリップ・断面で残る実面の内部だけを指示候補にする。 */
export function createDrawingSurfaceAnchor(view: DrawingView, sheetScale: number, context: DimensionResolveContext) {
  const frame = context.viewFrames?.get(view.id), basis = drawingViewBasis({ normal: view.direction, xDir: view.xDir });
  if (basis === null) return null;
  const raw = (point: Vector3): Point2 => [dot(point, basis.x), dot(point, basis.y)];
  const polygonRegions = (frame?.clips ?? []).filter((region): region is Extract<ClipRegion, { kind: 'polygon' }> => region.kind === 'polygon')
    .map((region) => triangles(region.points));
  if (polygonRegions.some((region) => region === null)) return null;
  const disks = (frame?.clips ?? []).filter((region): region is Disk => region.kind === 'circle');
  return (triangle: readonly [Vector3, Vector3, Vector3]): { readonly paperPoint: Point2; readonly area: number } | null => {
    if (!triangle.every((point) => point.every(Number.isFinite))) return null;
    const [a, b, c] = triangle.map(raw), fullArea = cross(a, b, c); if (Math.abs(fullArea) <= EPS) return null;
    const world = (point: Point2): Vector3 => {
      const u = cross(point, b, c) / fullArea, v = cross(point, c, a) / fullArea, w = 1 - u - v;
      const coordinate = (axis: number): number => u * triangle[0][axis] + v * triangle[1][axis] + w * triangle[2][axis];
      return [coordinate(0), coordinate(1), coordinate(2)];
    };
    let pieces = sectionPieces(triangle, frame?.section);
    for (const regions of polygonRegions) pieces = pieces.flatMap((piece) => (regions ?? []).map((region) => intersection(piece, edges(region, raw))))
      .filter((piece) => piece.length > 0);
    const spec = frame?.breakSpec;
    if (spec !== undefined) {
      const axis = spec.axis === 'u' ? 0 : 1, center = raw(frame?.modelCenter ?? context.modelCenter), scale = view.scale ?? sheetScale;
      const at: Distance = (point) => view.position[axis] + (raw(point)[axis] - center[axis]) * scale;
      pieces = pieces.flatMap((piece) => [clip(piece, (point) => spec.from - at(point)), clip(piece, (point) => at(point) - spec.to)])
        .filter((piece) => piece.length > 0);
    }
    let best: { readonly paperPoint: Point2; readonly area: number } | null = null;
    for (const piece of pieces) {
      const polygon = piece.map(raw), area = Math.abs(polygon.reduce((value, point, i) => value + cross([0, 0], point, polygon[(i + 1) % polygon.length]), 0));
      if (area <= EPS) continue;
      const candidate = diskAnchor(polygon, disks); if (candidate === null) continue;
      const paperPoint = drawingModelPointToPaper(world(candidate), view, sheetScale, context);
      if (paperPoint !== null && paperPoint.every(Number.isFinite) && (best === null || area > best.area)) best = { paperPoint, area };
    }
    return best;
  };
}
