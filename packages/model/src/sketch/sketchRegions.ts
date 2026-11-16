/**
 * 面を張らずに押し出す(M-01)の領域の検出。作図面の上の、構築線でない曲線の**全体だけ**でできた閉じた輪を探す。
 *
 * - 輪の境界は、今の面の境界(`SketchFaceFeature.boundary`)と同じ `SketchElementRef` の並びで返す。領域を選んだ時は、
 *   今の形の面を作るだけで済み、保存の形を変えない。複数の曲線を生むフィーチャー(矩形など)の全部の曲線が、元の順で
 *   1 つの輪になる時は、面の道具でその図形を押した時と同じ `{ featureId }`(index なし)にまとめる。
 * - 交わる曲線(端点以外で交わる・接する)は、曲線の全体の参照では領域を書けないので、領域にせず
 *   `crossingFeatureIds` に返す(画面は分割・トリムへ案内する。統括の決定 2026-11-16 04:0x の (2) a)。
 * - 端点で 3 本以上が集まる所は、どの輪か決まらないので領域にしない。
 * - 輪の中の輪は、外の輪の穴の候補(`holes`)として返す。穴つきの押し出しは M01-5(保存の形の変更)までは断る。
 * - 結果は保存しない(導出できる物は保存しない。rules/04)。許容差の比較は既存の isSamePoint・isPlanar に任せる。
 */
import { curveSamplePoints } from './curvePlaneSamples.js';
import { curveEnd, curveIntersections, curvePointAt, curveStart, isClosedCurve } from './intersectionMath.js';
import { fitPlaneNormal, isPlanar } from './resolveSketch.js';
import type { ResolvedCurve, ResolvedSketch, SketchDocument, SketchElementRef } from './types.js';
import { crossVec3, dotVec3, isSamePoint, normalizeVec3, subVec3, type Vec3 } from './vec3.js';

/** 1 つの閉じた領域。`polygon` は表示と押した点の判定に使う標本の折れ線(世界座標)。 */
export interface SketchRegion {
  readonly boundary: readonly SketchElementRef[];
  readonly holes: readonly (readonly SketchElementRef[])[];
  /** 面積(mm²)。標本の折れ線から求める近似で、表示と内外の判定にだけ使う。 */
  readonly area: number;
  readonly polygon: readonly Vec3[];
}

export interface SketchRegionScan {
  readonly regions: readonly SketchRegion[];
  /** 端点以外で交わる・接する曲線のフィーチャー(領域にしなかった理由)。 */
  readonly crossingFeatureIds: ReadonlySet<string>;
  /** 領域を平面へ写す枠。作図面に乗らない時は null(領域は空)。 */
  readonly frame: RegionFrame | null;
}

interface RegionFrame { readonly origin: Vec3; readonly u: Vec3; readonly v: Vec3 }
interface Candidate { readonly ref: SketchElementRef; readonly curve: ResolvedCurve }
interface Loop { readonly members: readonly Candidate[]; readonly polygon: readonly Vec3[]; readonly flat: readonly (readonly [number, number])[]; readonly area: number }

/** 曲線 1 本あたりの標本の数。円の面積の近似の誤差は 0.2% 未満(表示と内外の判定だけに使う)。 */
const SAMPLES_PER_CURVE = 64;
const EMPTY: SketchRegionScan = { regions: [], crossingFeatureIds: new Set(), frame: null };

/** 構築線でない曲線を、面の境界と同じ参照の付け方で集める(複数の曲線を生む物は index つき)。 */
function candidates(document: SketchDocument, resolved: ResolvedSketch): readonly Candidate[] {
  const singles = new Map<string, ResolvedCurve>();
  for (const curve of [...resolved.segments, ...resolved.arcs, ...resolved.ellipses, ...resolved.splines]) {
    if (!singles.has(curve.featureId)) singles.set(curve.featureId, curve);
  }
  const found: Candidate[] = [];
  for (const feature of document.features) {
    if ('construction' in feature && feature.construction) continue;
    const group = resolved.curvesByFeature.get(feature.id);
    if (group !== undefined) {
      group.forEach((curve, index) => found.push({ ref: { featureId: feature.id, index }, curve }));
      continue;
    }
    const single = singles.get(feature.id);
    if (single !== undefined) found.push({ ref: { featureId: feature.id }, curve: single });
  }
  return found;
}

function planeFrame(curves: readonly ResolvedCurve[]): RegionFrame | null {
  const samples = curves.flatMap(curve => curveSamplePoints(curve));
  const normal = fitPlaneNormal(samples);
  if (normal === null || !isPlanar(samples)) return null;
  const n = normalizeVec3(normal);
  const helper: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalizeVec3(crossVec3(helper, n));
  return { origin: samples[0], u, v: crossVec3(n, u) };
}

/** 端点だけで触れる組は交わりに数えない。どちらかの途中で触れる組は交わり(T 字・接する・横切る)。 */
function crossesAwayFromEnds(first: ResolvedCurve, second: ResolvedCurve): boolean {
  const ends = (curve: ResolvedCurve): readonly Vec3[] => (isClosedCurve(curve) ? [] : [curveStart(curve), curveEnd(curve)]);
  const firstEnds = ends(first), secondEnds = ends(second);
  return curveIntersections(first, second).some(hit =>
    !firstEnds.some(end => isSamePoint(end, hit.point)) || !secondEnds.some(end => isSamePoint(end, hit.point)));
}

/** 端点を同じ点(isSamePoint)ごとにまとめ、どの曲線がつながるかを引く。 */
function endpointNodes(curves: readonly Candidate[]): { readonly nodeOf: (point: Vec3) => number; readonly incident: readonly number[][] } {
  const nodes: Vec3[] = [];
  const nodeOf = (point: Vec3): number => {
    const index = nodes.findIndex(node => isSamePoint(node, point));
    if (index >= 0) return index;
    nodes.push(point);
    return nodes.length - 1;
  };
  const incident: number[][] = [];
  curves.forEach((candidate, index) => {
    for (const node of [nodeOf(curveStart(candidate.curve)), nodeOf(curveEnd(candidate.curve))]) {
      (incident[node] ??= []).push(index);
    }
  });
  return { nodeOf, incident };
}

/** 端点の次数がどこも 2 の連結な組を、たどる順に並べた輪にする。枝分かれ・開いた組は輪にしない。 */
function chainLoops(open: readonly Candidate[]): readonly (readonly Candidate[])[] {
  const { nodeOf, incident } = endpointNodes(open);
  const used = new Set<number>(), loops: Candidate[][] = [];
  for (let start = 0; start < open.length; start += 1) {
    if (used.has(start)) continue;
    const loop: Candidate[] = [];
    let current = start, tip = nodeOf(curveEnd(open[start].curve)), ok = true;
    const visited = new Set<number>();
    while (!visited.has(current)) {
      visited.add(current);
      loop.push(open[current]);
      const around = incident[tip] ?? [];
      if (around.length !== 2) { ok = false; break; }
      const next = around[0] === current ? around[1] : around[0];
      const nextStart = nodeOf(curveStart(open[next].curve));
      tip = nextStart === tip ? nodeOf(curveEnd(open[next].curve)) : nextStart;
      current = next;
    }
    visited.forEach(index => used.add(index));
    if (ok && current === start) loops.push(loop);
  }
  return loops;
}

function flatten(frame: RegionFrame, point: Vec3): readonly [number, number] {
  const offset = subVec3(point, frame.origin);
  return [dotVec3(offset, frame.u), dotVec3(offset, frame.v)];
}

/** 輪の標本の折れ線。曲線ごとに、前の曲線の終わりにつながる向きでたどる。 */
function loopPolygon(members: readonly Candidate[]): readonly Vec3[] {
  const points: Vec3[] = [];
  let tip: Vec3 | null = null;
  for (const { curve } of members) {
    const forward: boolean = tip === null || isSamePoint(curveStart(curve), tip) || !isSamePoint(curveEnd(curve), tip);
    for (let step = 0; step < SAMPLES_PER_CURVE; step += 1) {
      const ratio = step / SAMPLES_PER_CURVE;
      points.push(curvePointAt(curve, forward ? ratio : 1 - ratio));
    }
    tip = forward ? curveEnd(curve) : curveStart(curve);
  }
  return points;
}

function signedArea(flat: readonly (readonly [number, number])[]): number {
  let twice = 0;
  flat.forEach(([x, y], index) => {
    const [nextX, nextY] = flat[(index + 1) % flat.length];
    twice += x * nextY - nextX * y;
  });
  return twice / 2;
}

/** 偶奇の規則で、点が折れ線の内側か。交わらない輪どうしの入れ子の判定に使う。 */
function contains(flat: readonly (readonly [number, number])[], [x, y]: readonly [number, number]): boolean {
  let inside = false;
  for (let index = 0, previous = flat.length - 1; index < flat.length; previous = index, index += 1) {
    const [xi, yi] = flat[index], [xj, yj] = flat[previous];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 輪の参照。1 つのフィーチャーの全部の曲線が元の順で輪になる時は、面の道具と同じ index なしの 1 つにまとめる。 */
function boundaryOf(members: readonly Candidate[], resolved: ResolvedSketch): readonly SketchElementRef[] {
  const featureId = members[0].ref.featureId;
  const group = resolved.curvesByFeature.get(featureId);
  const whole = group !== undefined && group.length === members.length
    && members.every((member, index) => member.ref.featureId === featureId && member.ref.index === index);
  return whole ? [{ featureId }] : members.map(member => member.ref);
}

/** 作図面の上の閉じた領域を探す(M-01)。 */
export function findSketchRegions(document: SketchDocument, resolved: ResolvedSketch): SketchRegionScan {
  const all = candidates(document, resolved);
  if (all.length === 0) return EMPTY;
  const frame = planeFrame(all.map(candidate => candidate.curve));
  if (frame === null) return EMPTY;
  const crossing = new Set<number>();
  for (let first = 0; first < all.length; first += 1) {
    for (let second = first + 1; second < all.length; second += 1) {
      if (crossesAwayFromEnds(all[first].curve, all[second].curve)) { crossing.add(first); crossing.add(second); }
    }
  }
  const usable = all.filter((_, index) => !crossing.has(index));
  const loopsOfMembers = [
    ...usable.filter(candidate => isClosedCurve(candidate.curve)).map(candidate => [candidate]),
    ...chainLoops(usable.filter(candidate => !isClosedCurve(candidate.curve))),
  ];
  const loops: Loop[] = loopsOfMembers.map(members => {
    const polygon = loopPolygon(members), flat = polygon.map(point => flatten(frame, point));
    return { members, polygon, flat, area: Math.abs(signedArea(flat)) };
  });
  const parentOf = loops.map((loop, index) => {
    const containers = loops.map((other, at) => ({ other, at }))
      .filter(({ other, at }) => at !== index && other.area > loop.area && contains(other.flat, loop.flat[0]));
    containers.sort((a, b) => a.other.area - b.other.area);
    return containers.length === 0 ? null : containers[0].at;
  });
  const regions = loops.map((loop, index): SketchRegion => ({
    boundary: boundaryOf(loop.members, resolved),
    holes: loops.filter((_, at) => parentOf[at] === index).map(child => boundaryOf(child.members, resolved)),
    area: loop.area,
    polygon: loop.polygon,
  }));
  return { regions, crossingFeatureIds: new Set([...crossing].map(index => all[index].ref.featureId)), frame };
}

/** 押した点(作図面の上の世界座標)を含む、いちばん内側の領域。無ければ null。 */
export function regionAtPoint(scan: SketchRegionScan, point: Vec3): SketchRegion | null {
  const frame = scan.frame;
  if (frame === null) return null;
  const at = flatten(frame, point);
  const inside = scan.regions.filter(region => contains(region.polygon.map(vertex => flatten(frame, vertex)), at));
  inside.sort((a, b) => a.area - b.area);
  return inside[0] ?? null;
}
