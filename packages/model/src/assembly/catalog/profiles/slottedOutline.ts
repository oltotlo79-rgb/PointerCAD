/**
 * 溝つきの外周の断面(長方形の格子で表せない溝つきフレーム: L 形・1 つの角の大きな R・斜面・間隔が一定でない溝。設計は担当の記録
 * profile-ext-design.md)。外周は頂点の並び(反時計回り)と頂点ごとの角の丸み R で表し、辺 i(頂点 i から頂点 i + 1)の上の溝を、
 * 辺の始まりの頂点からの距離 at で置く。溝の切り欠きの形は T スロットの簡略形状(tSlot.ts の slotPoints)と同じ: 口(幅 w・深さ s〔肩〕)と
 * その下の台形の部屋(上の幅 wi・深さ d、両側 45°)。穴は中心と径の並び。内側の中空・細部は作らない(中実。質量は単位質量で出す族が使う)。
 * 角の丸みの円弧の作り方は鋼材の断面(steelSectionProfiles.ts の roundedBoundary)と同じ符号つきの回り方(へこんだ角は逆回り)。
 * 長方形の格子の断面は今までどおり tSlot.ts が作る(この台本は、行が外周の指定を持つ時だけ使う)。
 */
import type { FrameSectionBounds } from '../../frame/frameMembers.js';
import type { FrameSectionSlot } from '../../frame/frameSlots.js';
import type { ProfileLoops } from '../../standard/profileExtrusion.js';
import type { SteelProfilePoint, SteelProfileSegment } from '../../standard/steelSectionProfiles.js';

type Point = SteelProfilePoint;

/** 辺の上の溝 1 本。edge は辺の番号(頂点 edge から頂点 edge + 1)、at は辺の始まりの頂点から口の中心までの距離。 */
export interface OutlineSlot {
  readonly edge: number;
  readonly at: number;
}

/** 穴 1 つ(中心は断面の座標)。 */
export interface OutlineHole {
  readonly x: number;
  readonly y: number;
  readonly diameter: number;
}

export interface SlottedOutline {
  /** 外周の頂点(反時計回り。原点は行が決める。外形の中心を原点にする)。 */
  readonly vertices: readonly Point[];
  /** 頂点ごとの角の丸み R(0 は角のまま)。 */
  readonly radii: readonly number[];
  /** 溝の口の幅 w。 */
  readonly slotOpening: number;
  /** 肩の厚さ s。 */
  readonly shoulder: number;
  /** 溝の部屋の上の幅 wi。 */
  readonly slotInnerWidth: number;
  /** 溝の部屋の深さ d。 */
  readonly slotDepth: number;
  readonly slots: readonly OutlineSlot[];
  readonly holes: readonly OutlineHole[];
}

/** 長さの比べの端数(浮動小数の端数だけを許す)。 */
const GEOMETRY_EPSILON = 1e-9;

interface Corner {
  readonly from: Point;
  readonly to: Point;
  readonly center: Point;
  readonly radius: number;
  readonly tangent: number;
  readonly startAngle: number;
  readonly endAngle: number;
}

interface Edge {
  readonly start: Point;
  readonly u: Point;
  readonly v: Point;
  readonly length: number;
  /** 辺の上の直線の部分(角の丸みを除く)の、始まりの頂点からの範囲。 */
  readonly straightFrom: number;
  readonly straightTo: number;
}

const cross = (a: Point, b: Point): number => a[0] * b[1] - a[1] * b[0];
const distance = (a: Point, b: Point): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
const along = (edge: Edge, at: number, depth: number): Point =>
  [edge.start[0] + edge.u[0] * at + edge.v[0] * depth, edge.start[1] + edge.u[1] * at + edge.v[1] * depth];

function edgesOf(vertices: readonly Point[]): readonly Edge[] | null {
  const edges: Edge[] = [];
  for (const [index, start] of vertices.entries()) {
    const end = vertices[(index + 1) % vertices.length];
    if (end === undefined) return null;
    const length = distance(start, end);
    if (!(length > GEOMETRY_EPSILON)) return null;
    const u: Point = [(end[0] - start[0]) / length, (end[1] - start[1]) / length];
    edges.push({ start, u, v: [-u[1], u[0]], length, straightFrom: 0, straightTo: length });
  }
  return edges;
}

/** 頂点の角の丸み(鋼材の roundedBoundary と同じ式。回る向き turn の符号で、へこんだ角の円弧は逆回り)。 */
function cornersOf(vertices: readonly Point[], radii: readonly number[], edges: readonly Edge[]): readonly Corner[] | null {
  const corners: Corner[] = [];
  for (const [index, point] of vertices.entries()) {
    const incoming = edges[(index + edges.length - 1) % edges.length];
    const outgoing = edges[index];
    const radius = radii[index];
    if (incoming === undefined || outgoing === undefined || radius === undefined || !(radius >= 0)) return null;
    const turn = Math.atan2(cross(incoming.u, outgoing.u), incoming.u[0] * outgoing.u[0] + incoming.u[1] * outgoing.u[1]);
    const tangent = radius * Math.tan(Math.abs(turn) / 2);
    if (!Number.isFinite(tangent)) return null;
    const from: Point = [point[0] - incoming.u[0] * tangent, point[1] - incoming.u[1] * tangent];
    const to: Point = [point[0] + outgoing.u[0] * tangent, point[1] + outgoing.u[1] * tangent];
    const center: Point = [from[0] - incoming.u[1] * Math.sign(turn) * radius, from[1] + incoming.u[0] * Math.sign(turn) * radius];
    const startAngle = Math.atan2(from[1] - center[1], from[0] - center[0]);
    corners.push({ from, to, center, radius, tangent, startAngle, endAngle: startAngle + turn });
  }
  return corners;
}

/** 溝の切り欠きの点(辺の上の口の中心 at、進む順。tSlot.ts の slotPoints と同じ形)。 */
function slotPoints(outline: SlottedOutline, edge: Edge, at: number): readonly Point[] {
  const { slotOpening: w, shoulder: s, slotInnerWidth: wi, slotDepth: d } = outline;
  const bottom = wi - 2 * d;
  const local: readonly (readonly [number, number])[] = [[-w / 2, 0], [-w / 2, s], [-wi / 2, s], [-bottom / 2, s + d], [bottom / 2, s + d],
    [wi / 2, s], [w / 2, s], [w / 2, 0]];
  return local.map(([a, b]) => along(edge, at + a, b));
}

/** 外の輪(反時計回り): 辺の直線の部分に溝の切り欠きを入れ、角を円弧でつなぐ。 */
function outerLoop(outline: SlottedOutline, edges: readonly Edge[], corners: readonly Corner[]): readonly SteelProfileSegment[] {
  const segments: SteelProfileSegment[] = [];
  for (const [index, edge] of edges.entries()) {
    const startCorner = corners[index];
    const endCorner = corners[(index + 1) % corners.length];
    if (startCorner === undefined || endCorner === undefined) continue;
    const ats = outline.slots.filter((slot) => slot.edge === index).map((slot) => slot.at).sort((a, b) => a - b);
    const points: readonly Point[] = [startCorner.to, ...ats.flatMap((at) => slotPoints(outline, edge, at)), endCorner.from];
    for (let at = 0; at + 1 < points.length; at += 1) {
      const from = points[at];
      const to = points[at + 1];
      if (from !== undefined && to !== undefined && distance(from, to) > GEOMETRY_EPSILON) segments.push({ kind: 'line', from, to });
    }
    if (endCorner.radius > 0) {
      segments.push({ kind: 'arc', from: endCorner.from, to: endCorner.to, center: endCorner.center, radius: endCorner.radius,
        startAngle: endCorner.startAngle, endAngle: endCorner.endAngle });
    }
  }
  return segments;
}

function circleLoop(hole: OutlineHole): readonly SteelProfileSegment[] {
  const r = hole.diameter / 2;
  return [
    { kind: 'arc', from: [hole.x + r, hole.y], to: [hole.x - r, hole.y], center: [hole.x, hole.y], radius: r, startAngle: 0, endAngle: Math.PI },
    { kind: 'arc', from: [hole.x - r, hole.y], to: [hole.x + r, hole.y], center: [hole.x, hole.y], radius: r, startAngle: Math.PI,
      endAngle: 2 * Math.PI },
  ];
}

/** 輪の符号つき面積(反時計回りが正。鋼材の断面と同じ計算)。 */
function loopArea(segments: readonly SteelProfileSegment[]): number {
  return segments.reduce((area, segment) => area + (segment.kind === 'line'
    ? (segment.from[0] * segment.to[1] - segment.from[1] * segment.to[0]) / 2
    : (segment.center[0] * (segment.to[1] - segment.from[1]) - segment.center[1] * (segment.to[0] - segment.from[0])
      + segment.radius ** 2 * (segment.endAngle - segment.startAngle)) / 2), 0);
}

function segmentDistance(point: Point, from: Point, to: Point): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const t = Math.max(0, Math.min(1, ((point[0] - from[0]) * dx + (point[1] - from[1]) * dy) / (dx ** 2 + dy ** 2)));
  return Math.hypot(point[0] - from[0] - t * dx, point[1] - from[1] - t * dy);
}

/** 円弧を細かい線分にした点(形の確かめにだけ使う)。 */
function polyline(segments: readonly SteelProfileSegment[]): readonly Point[] {
  return segments.flatMap((segment): Point[] => {
    if (segment.kind === 'line') return [segment.from];
    return Array.from({ length: 12 }, (_, index): Point => {
      const angle = segment.startAngle + (segment.endAngle - segment.startAngle) * index / 12;
      return [segment.center[0] + segment.radius * Math.cos(angle), segment.center[1] + segment.radius * Math.sin(angle)];
    });
  });
}

/** 折れ線の輪が自分と交わらないか(隣でない 2 本の線分の交わりを断る)。 */
function simple(points: readonly Point[]): boolean {
  const count = points.length;
  for (let i = 0; i < count; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % count];
    for (let j = i + 2; j < count; j += 1) {
      if (i === 0 && j === count - 1) continue;
      const c = points[j];
      const d = points[(j + 1) % count];
      if (a === undefined || b === undefined || c === undefined || d === undefined) return false;
      const d1 = cross([b[0] - a[0], b[1] - a[1]], [c[0] - a[0], c[1] - a[1]]);
      const d2 = cross([b[0] - a[0], b[1] - a[1]], [d[0] - a[0], d[1] - a[1]]);
      const d3 = cross([d[0] - c[0], d[1] - c[1]], [a[0] - c[0], a[1] - c[1]]);
      const d4 = cross([d[0] - c[0], d[1] - c[1]], [b[0] - c[0], b[1] - c[1]]);
      if (d1 * d2 < -GEOMETRY_EPSILON && d3 * d4 < -GEOMETRY_EPSILON) return false;
    }
  }
  return true;
}

function inside(point: Point, polygon: readonly Point[]): boolean {
  let result = false;
  for (const [index, a] of polygon.entries()) {
    const b = polygon[(index + 1) % polygon.length];
    if (b !== undefined && (a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}

/**
 * 形が成り立つか: 寸法が正、頂点が 3 つ以上で反時計回り、角の丸みが辺に収まる、口 < 部屋・部屋の底 > 0、溝の口が辺の直線の部分に収まる、
 * 同じ辺の溝の部屋が重ならない、部屋の角が外周の内にあり、ほかの辺から離れている、輪が自分と交わらない、穴が外の輪に掛からず内にある。
 */
function valid(outline: SlottedOutline, edges: readonly Edge[], corners: readonly Corner[]): boolean {
  const { vertices, radii, slotOpening: w, shoulder: s, slotInnerWidth: wi, slotDepth: d } = outline;
  if (vertices.length < 3 || radii.length !== vertices.length || ![w, s, wi, d].every((value) => Number.isFinite(value) && value > 0)) return false;
  if (!(w < wi) || !(wi - 2 * d > 0)) return false;
  const polygonArea = vertices.reduce((sum, point, index) => sum + cross(point, vertices[(index + 1) % vertices.length] ?? point) / 2, 0);
  if (!(polygonArea > 0)) return false;
  for (const [index, edge] of edges.entries()) {
    const startCorner = corners[index];
    const endCorner = corners[(index + 1) % corners.length];
    if (startCorner === undefined || endCorner === undefined || startCorner.tangent + endCorner.tangent > edge.length + GEOMETRY_EPSILON) return false;
    const ats = outline.slots.filter((slot) => slot.edge === index).map((slot) => slot.at).sort((a, b) => a - b);
    for (const [at, value] of ats.entries()) {
      if (value - wi / 2 < startCorner.tangent - GEOMETRY_EPSILON || value + wi / 2 > edge.length - endCorner.tangent + GEOMETRY_EPSILON) return false;
      const next = ats[at + 1];
      if (next !== undefined && next - value <= wi) return false;
      const room = [along(edge, value - wi / 2, s), along(edge, value + wi / 2, s), along(edge, value - (wi - 2 * d) / 2, s + d),
        along(edge, value + (wi - 2 * d) / 2, s + d)];
      const others = edges.filter((_, other) => other !== index);
      if (!room.every((point) => inside(point, vertices)
        && others.every((other) => segmentDistance(point, other.start, along(other, other.length, 0)) > GEOMETRY_EPSILON))) return false;
    }
  }
  if (outline.slots.some((slot) => !Number.isInteger(slot.edge) || slot.edge < 0 || slot.edge >= edges.length)) return false;
  const outer = outerLoop(outline, edges, corners);
  const ring = polyline(outer);
  if (!simple(ring)) return false;
  return outline.holes.every((hole) => hole.diameter > 0 && inside([hole.x, hole.y], ring)
    && ring.every((point, index) => segmentDistance([hole.x, hole.y], point, ring[(index + 1) % ring.length] ?? point) > hole.diameter / 2));
}

function build(outline: SlottedOutline): { readonly edges: readonly Edge[]; readonly corners: readonly Corner[] } | null {
  const edges = edgesOf(outline.vertices);
  if (edges === null) return null;
  const corners = cornersOf(outline.vertices, outline.radii, edges);
  if (corners === null || !valid(outline, edges, corners)) return null;
  return { edges, corners };
}

/** 断面の輪と、正味の面積(mm²。外の輪 − 穴)。形が成り立たない時は null。 */
export function slottedOutlineProfile(outline: SlottedOutline): (ProfileLoops & { readonly areaMm2: number }) | null {
  const built = build(outline);
  if (built === null) return null;
  const segments = outerLoop(outline, built.edges, built.corners);
  const holes = outline.holes.map(circleLoop);
  return { segments, holes, areaMm2: loopArea(segments) - holes.reduce((sum, hole) => sum + loopArea(hole), 0) };
}

/** 断面の外形の箱(頂点の箱。角の丸みは外へ出ないので頂点の箱で足りる)。形が成り立たない時は null。 */
export function slottedOutlineBounds(outline: SlottedOutline): FrameSectionBounds | null {
  if (build(outline) === null) return null;
  const xs = outline.vertices.map((point) => point[0]);
  const ys = outline.vertices.map((point) => point[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** 内向きの法線に近い面の名前(斜めの辺は近い方。締結の溝の一覧の face は 4 つの名前だけを持つ)。 */
function faceOf(inward: Point): FrameSectionSlot['face'] {
  // 縦の成分の大きさが横以上なら上か下(大きさは 2 乗で比べる)。
  if (inward[1] ** 2 >= inward[0] ** 2) return inward[1] < 0 ? 'top' : 'bottom';
  return inward[0] > 0 ? 'left' : 'right';
}

/** 締結に出す溝の全部(辺の順、辺の中は at の順)。斜めの辺の溝は、内向きと口の向きをそのまま持つ。形が成り立たない時は null。 */
export function slottedOutlineSlots(outline: SlottedOutline): readonly FrameSectionSlot[] | null {
  const built = build(outline);
  if (built === null) return null;
  return built.edges.flatMap((edge, index) => outline.slots.filter((slot) => slot.edge === index).sort((a, b) => a.at - b.at)
    .map((slot): FrameSectionSlot => ({ face: faceOf(edge.v), center: along(edge, slot.at, 0), inward: edge.v, across: edge.u,
      opening: outline.slotOpening, shoulder: outline.shoulder, slotDepth: outline.slotDepth, roomSimplified: true })));
}
