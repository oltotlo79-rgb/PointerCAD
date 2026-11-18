/**
 * 平面から安全柵(E-12 第 1 段)の計画: 床の平面の線と高さ・柱の間隔の上限から、柱・横の材の線とパネルの寸法・置き方を決める純関数。
 * 柵の部材を並べるだけで、機械の安全の規格(柵の高さ・隙間・距離など)への適合は確かめない(統括の決定 2026-11-18 15:2x)。
 *
 * - 区画: 辺ごとに、柱の間隔が上限以下になる最小の数で等分する。柱は点と等分した点に置き、点の柱は隣の辺と共有する。
 * - 柱: 床(z = 0)から高さ H までの縦の線。断面の局所 +Y を、その柱の辺の向き(点の柱は前の辺、開いた線の最初の点は最初の辺)へ向ける。
 * - 横の材: 区画ごと・高さごとに、2 本の柱の面の間の水平の線(断面の局所 +Y は上)。
 * - パネル: 区画ごと・上下に並ぶ横の材の間ごとに 1 枚。枠の内側から各辺の隙間を引いた寸法で、枠の中心の面に置く
 *   (板の形は外形の中心が原点で、板厚を局所 +Z へ押し出す形。局所 X = 辺の向き、Y = 上、Z = 辺に直交する水平の向き)。
 * - 第 3 段: パネルの板の大きさの上限(max)を渡すと、パネルが上限に収まるまで辺の区画の数を増やす(中間の柱を足す)。出入口の区画(openBays)
 *   には横の材もパネルも置かない(柱は置く)。
 * - 足(第 2 段): 足の高さを入れた時は、柱の下端を床からその高さに上げ(柱を短くし)、柱の下の床の点に足を 1 つずつ置く。
 * 部材の断面は `planFrameMembers` と同じく外形の中心を線に乗せる前提で、柱の面までの距離は外形の半分の幅で求める。
 */
import { addVec3, crossVec3, dotVec3, lengthVec3, scaleVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import { quaternionFromBasis, type RigidPlacement } from '../placementMath.js';
import { fitsPanelMax } from '../catalog/profiles/panelBoard.js';
import type { FrameLine, FrameSectionBounds } from './frameMembers.js';

interface SafetyFenceInput {
  /** 床の平面の線の点(Z は使わない)。 */
  readonly points: readonly Vec3[];
  readonly closed: boolean;
  /** 床から柱の上端までの高さ(mm)。 */
  readonly height: number;
  /** 柱の間隔の上限(mm。柱の中心どうし)。 */
  readonly maxSpacing: number;
  readonly post: FrameSectionBounds;
  readonly rail: FrameSectionBounds;
  /** 横の材の中心の高さ(mm)。 */
  readonly railHeights: readonly number[];
  /** パネルの板厚と各辺の隙間(mm)。パネルを入れない時は null。 */
  readonly panel: { readonly thickness: number; readonly gap: number; readonly max?: readonly [number, number] | null } | null;
  /** 足の高さ(床から柱の下端まで、mm)。足を置かない時は null。 */
  readonly foot: { readonly height: number } | null;
  /** 出入口の区画の番号(0 から。横の材もパネルも置かない)。 */
  readonly openBays?: readonly number[];
}

/** 柱 1 本: 縦の線と、断面の局所 +Y を向ける水平の向き。 */
interface FencePost {
  readonly line: FrameLine;
  readonly up: Vec3;
}

/** パネル 1 枚: 区画の番号・幅・高さ(mm)・置き方。 */
interface FencePanel {
  readonly bay: number;
  readonly width: number;
  readonly height: number;
  readonly placement: RigidPlacement;
}

/** 点が 2 つ未満・数が正でない・長さ 0 の辺・柱の面の間が 0 以下・横の材が柱の高さの外・パネルの高さが 0 以下・置く数が上限を超える。 */
type SafetyFenceRejection = 'tooFewPoints' | 'invalidNumber' | 'degenerateEdge' | 'noRoom' | 'railOutOfRange' | 'noPanelRoom' | 'tooMany';

export type SafetyFenceResult =
  | { readonly ok: true; readonly bays: number; readonly posts: readonly FencePost[]; readonly rails: readonly FrameLine[];
    readonly panels: readonly FencePanel[];
    /** 足を置く床の点(柱の並びと同じ順。足を置かない時は空)。 */
    readonly feet: readonly Vec3[] }
  | { readonly ok: false; readonly reason: SafetyFenceRejection; readonly bay: number | null };

/** 置く数の上限(統括の決定 2026-11-18 15:2x の ③)。 */
const SAFETY_FENCE_LIMITS = { posts: 500, components: 3000 } as const;
/** 同じ点・長さ 0 とみなす距離(mm)。 */
const TOLERANCE = 1e-6;
/** 長さと位置を丸める桁(mm の 1e-6。一括配置と同じ)。 */
const ROUNDING = 1e6;
const UP: Vec3 = [0, 0, 1];

const round = (value: number): number => Math.round(value * ROUNDING) / ROUNDING + 0;
const roundPoint = (point: Vec3): Vec3 => [round(point[0]), round(point[1]), round(point[2])];
const refused = (reason: SafetyFenceRejection, bay: number | null = null): SafetyFenceResult => ({ ok: false, reason, bay });
const positive = (...values: readonly number[]): boolean => values.every((value) => Number.isFinite(value) && value > 0);
const flat = (point: Vec3): Vec3 => [point[0], point[1], 0];

interface Edge {
  readonly from: Vec3;
  readonly direction: Vec3;
  readonly length: number;
  /** 区画の数(柱の間隔が上限以下になる最小の数)。 */
  readonly bays: number;
}

/** 柱の断面(局所 +Y = up)の外形の、水平の向き d の半分の幅。外形の中心は線の上。 */
function postHalfAlong(post: FrameSectionBounds, up: Vec3, direction: Vec3): number {
  const x = crossVec3(up, UP);
  return Math.abs(dotVec3(direction, x)) * (post.maxX - post.minX) / 2 + Math.abs(dotVec3(direction, up)) * (post.maxY - post.minY) / 2;
}

/** 区画の数を増やす上限(1 つの辺の上で)。 */
const MAX_BAYS_PER_EDGE = 1000;

/**
 * パネルが板の大きさの上限に収まる、最小の区画の数(第 3 段)。幅は柱の中心の間から柱の外形の半分の大きい方を 2 つと隙間を引いた値で
 * 見積もる(角の柱の向きに依らず、収まる側に倒す)。高さが上限に収まらない時は、区画を増やしても収まらないので、今の数のまま。
 */
function baysForPanel(length: number, bays: number, input: SafetyFenceInput, panelHeights: readonly number[]): number {
  const max = input.panel?.max ?? null;
  if (input.panel === null || max === null || panelHeights.length === 0) return bays;
  const gap = input.panel.gap;
  const half = Math.max(input.post.maxX - input.post.minX, input.post.maxY - input.post.minY) / 2;
  const fits = (count: number): boolean => panelHeights.every((height) => fitsPanelMax(length / count - 2 * half - 2 * gap, height, max));
  if (!panelHeights.every((height) => fitsPanelMax(1, height, max))) return bays;
  let count = bays;
  while (!fits(count) && count < MAX_BAYS_PER_EDGE) count++;
  return count;
}

function edgesOf(input: SafetyFenceInput, panelHeights: readonly number[] = []): readonly Edge[] | SafetyFenceRejection {
  const points = input.points.map(flat);
  const count = input.closed ? points.length : points.length - 1;
  const edges: Edge[] = [];
  for (let index = 0; index < count; index++) {
    const from = points[index], to = points[(index + 1) % points.length];
    if (from === undefined || to === undefined) return 'tooFewPoints';
    const span = subVec3(to, from), length = lengthVec3(span);
    if (!(length > TOLERANCE)) return 'degenerateEdge';
    const bays = Math.max(1, Math.ceil(length / input.maxSpacing - TOLERANCE));
    edges.push({ from, direction: scaleVec3(span, 1 / length), length, bays: baysForPanel(length, bays, input, panelHeights) });
  }
  return edges;
}

/** 安全柵の柱・横の材・パネルの計画。作れない時は何も決めずに理由(区画の番号は 0 から)。 */
export function planSafetyFence(input: SafetyFenceInput): SafetyFenceResult {
  if (input.points.length < 2 || (input.closed && input.points.length < 3)) return refused('tooFewPoints');
  if (!positive(input.height, input.maxSpacing) || !input.railHeights.every((value) => Number.isFinite(value))
    || (input.panel !== null && (!positive(input.panel.thickness) || !(input.panel.gap >= 0)))
    || (input.foot !== null && !(input.foot.height >= 0 && input.foot.height < input.height))) return refused('invalidNumber');
  const bottom = input.foot?.height ?? 0;
  const railHalfForBays = (input.rail.maxY - input.rail.minY) / 2;
  const sortedHeights = [...input.railHeights].sort((a, b) => a - b);
  const panelHeights = input.panel === null ? [] : sortedHeights.slice(0, -1)
    .map((lower, index) => (sortedHeights[index + 1] ?? lower) - lower - 2 * railHalfForBays - 2 * (input.panel?.gap ?? 0));
  const edges = edgesOf(input, panelHeights);
  if (typeof edges === 'string') return refused(edges);
  const railHalf = (input.rail.maxY - input.rail.minY) / 2;
  const heights = [...input.railHeights].sort((a, b) => a - b);
  if (heights.some((h) => h - railHalf < bottom - TOLERANCE || h + railHalf > input.height + TOLERANCE)) return refused('railOutOfRange');
  // 柱: 各辺の始まりの点(前の辺の向き。開いた線の最初は最初の辺)と等分の点。開いた線は最後の点にも置く。
  const posts: FencePost[] = [];
  const postAt = (point: Vec3, up: Vec3): number => {
    posts.push({ line: { start: roundPoint(addVec3(point, scaleVec3(UP, bottom))), end: roundPoint(addVec3(point, scaleVec3(UP, input.height))) },
      up });
    return posts.length - 1;
  };
  const bayPosts: { readonly edge: Edge; readonly start: number; readonly end: number }[] = [];
  let first = -1;
  edges.forEach((edge, index) => {
    const previous = index > 0 ? edges[index - 1] : input.closed ? edges.at(-1) : undefined;
    let start = index === 0 ? postAt(edge.from, (previous ?? edge).direction) : posts.length - 1;
    if (index === 0) first = start;
    for (let bay = 1; bay <= edge.bays; bay++) {
      const last = bay === edge.bays;
      const end = last && input.closed && index === edges.length - 1 ? first
        : postAt(addVec3(edge.from, scaleVec3(edge.direction, edge.length * bay / edge.bays)), edge.direction);
      bayPosts.push({ edge, start, end });
      start = end;
    }
  });
  const panelsPerBay = input.panel === null ? 0 : Math.max(0, heights.length - 1);
  if (posts.length > SAFETY_FENCE_LIMITS.posts
    || posts.length + bayPosts.length * (heights.length + panelsPerBay) > SAFETY_FENCE_LIMITS.components) return refused('tooMany');
  const rails: FrameLine[] = [];
  const panels: FencePanel[] = [];
  for (const [bay, { edge, start, end }] of bayPosts.entries()) {
    const a = posts[start], b = posts[end];
    if (a === undefined || b === undefined) return refused('noRoom', bay);
    // 横の材とパネルの高さは床から測る(柱の下端は足の高さだけ上がっている)。
    const floorA = flat(a.line.start), floorB = flat(b.line.start);
    const from = addVec3(floorA, scaleVec3(edge.direction, postHalfAlong(input.post, a.up, edge.direction)));
    const to = subVec3(floorB, scaleVec3(edge.direction, postHalfAlong(input.post, b.up, edge.direction)));
    const inner = dotVec3(subVec3(to, from), edge.direction);
    if (!(inner > TOLERANCE)) return refused('noRoom', bay);
    // 出入口の区画は横の材もパネルも置かない(第 3 段)。
    if (input.openBays?.includes(bay) === true) continue;
    for (const h of heights) rails.push({ start: roundPoint(addVec3(from, scaleVec3(UP, h))), end: roundPoint(addVec3(to, scaleVec3(UP, h))) });
    if (input.panel === null) continue;
    const normal = crossVec3(edge.direction, UP);
    const rotation = quaternionFromBasis(edge.direction, UP, normal, 1e-9);
    if (rotation === null) return refused('invalidNumber', bay);
    for (const [index, lower] of heights.slice(0, -1).entries()) {
      const upper = heights[index + 1] ?? lower;
      const width = round(inner - 2 * input.panel.gap), height = round(upper - lower - 2 * railHalf - 2 * input.panel.gap);
      if (!(width > 0 && height > 0)) return refused('noPanelRoom', bay);
      const center = addVec3(scaleVec3(addVec3(from, to), 0.5), scaleVec3(UP, (lower + upper) / 2));
      panels.push({ bay, width, height, placement: { position: roundPoint(subVec3(center, scaleVec3(normal, input.panel.thickness / 2))), rotation } });
    }
  }
  return { ok: true, bays: bayPosts.length, posts, rails, panels,
    feet: input.foot === null ? [] : posts.map((post) => flat(post.line.start)) };
}
