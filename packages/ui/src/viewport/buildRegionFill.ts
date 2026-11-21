/**
 * 押し出しの領域の塗り(M-01 の M01-3)を描画用の並びへ組み立てる純関数。
 *
 * 押し出しで面を選んでいない間だけ、作図面の閉じた領域を薄く塗り、カーソルの下を濃くし、選んだ領域を選択の
 * 濃さにする。塗りは面と同じ形(`SketchFaceDraw`)で返すので、描く側(`createSketchLayer.ts`)は面と同じ濃さ・
 * 発光の決まり(none / hovered / selected)で描き、新しい色や濃さの定数を持たない(`buildSketchGeometry.ts` と
 * 同じ流れ。穴つきの三角形分割はthree.jsの純粋なShapeUtilsを使い、描画資源やDOMには触れない)。
 *
 * - 領域の折れ線(model の `findSketchRegions` の標本)は輪の内側が単純な多角形なので、耳を切る方法で三角形に割る。
 * - 同じ線の上に並ぶ標本(線分の途中の点)は先に除き、三角形の数を減らす。
 * - 三角形の並びは折れ線ごとに覚えて使い回す。ホバーが変わっただけなら同じ並びを返すので、描く側は作り直さずに
 *   色だけを塗り替える(`createSketchLayer.ts` の `hasSameFaceGeometry`)。
 */
import { belowMagnitude, withinMagnitude, type Vec3 } from '@pointercad/model';
import { ShapeUtils, Vector2 } from 'three';
import type { SketchEmphasis, SketchFaceDraw, SketchGeometryBundle } from './buildSketchGeometry.js';

/** 塗る領域 1 つ。`elementId` はホバーの欄に入る領域の id(`solid/regionPick.ts` の `regionElementId`)。 */
interface RegionFillRegion {
  readonly elementId: string;
  /** 領域の標本の折れ線(世界座標、閉じた輪。最後の点から最初の点へ戻る辺を含む)。 */
  readonly polygon: readonly Vec3[];
  readonly holes?: readonly (readonly Vec3[])[];
}

export interface RegionFillInput {
  readonly regions: readonly RegionFillRegion[];
  /** カーソルの下の領域(領域の id の時だけ。要素の id は入れない)。 */
  readonly hoveredElementId: string | null;
  /** 押し出しの欄が選んでいる領域。 */
  readonly chosenElementId: string | null;
  /** 塗りの色。面の既定の色(model の DEFAULT_FACE_COLOR)を渡す。 */
  readonly color: string;
}

interface FillGeometry {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
}

type Point2 = readonly [number, number];

/** 折れ線ごとの三角形の並び(折れ線は検出の結果をスケッチごとに覚えた物なので、同じ実体が渡り続ける)。 */
const geometryCache = new WeakMap<readonly Vec3[], { readonly holes: readonly (readonly Vec3[])[]; readonly geometry: FillGeometry }>();
const NO_HOLES: readonly (readonly Vec3[])[] = [];

function sameHoles(first: readonly (readonly Vec3[])[], second: readonly (readonly Vec3[])[]): boolean {
  return first.length === second.length && first.every((hole, index) => hole === second[index]);
}

/** 長さに対する相対の、同じ線の上とみなす外積の大きさ。 */
const COLLINEAR_RELATIVE = 1e-9;

/** 折れ線の法線(Newell の方法。凹んでいても向きが安定する)。長さ 0 なら null。 */
function polygonNormal(points: readonly Vec3[]): Vec3 | null {
  let x = 0, y = 0, z = 0;
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length];
    x += (point[1] - next[1]) * (point[2] + next[2]);
    y += (point[2] - next[2]) * (point[0] + next[0]);
    z += (point[0] - next[0]) * (point[1] + next[1]);
  });
  const length = Math.hypot(x, y, z);
  return length === 0 ? null : [x / length, y / length, z / length];
}

function cross2(origin: Point2, a: Point2, b: Point2): number {
  return (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0]);
}

/** 同じ点が続く所と、同じ線の上に並ぶ途中の点を除いた添字の並び。 */
function simplify(flat: readonly Point2[]): number[] {
  let kept = flat.map((_, index) => index);
  let changed = true;
  while (changed && kept.length > 3) {
    changed = false;
    const next: number[] = [];
    kept.forEach((index, at) => {
      const previous = flat[kept[(at - 1 + kept.length) % kept.length]], following = flat[kept[(at + 1) % kept.length]];
      const point = flat[index];
      const scale = Math.hypot(following[0] - previous[0], following[1] - previous[1]) ** 2;
      if (withinMagnitude(cross2(previous, point, following), COLLINEAR_RELATIVE * Math.max(scale, Number.MIN_VALUE))) changed = true;
      else next.push(index);
    });
    if (next.length < 3) break;
    kept = next;
  }
  return kept;
}

function insideTriangle(point: Point2, a: Point2, b: Point2, c: Point2): boolean {
  return cross2(a, b, point) >= 0 && cross2(b, c, point) >= 0 && cross2(c, a, point) >= 0;
}

/**
 * 反時計回りに並べた単純な多角形を、耳を切って三角形に割る(添字は `flat` の添字)。耳の三角形の中に入り得るのは
 * へこんだ角だけなので、中に入るかはへこんだ角だけで調べる(円の標本のような凸の領域は角の数の 2 乗で済む)。
 */
function earClip(flat: readonly Point2[], order: readonly number[]): number[] {
  const remaining = [...order], triangles: number[] = [];
  let guard = remaining.length * remaining.length;
  const around = (at: number): readonly [Point2, Point2, Point2] => [flat[remaining[(at - 1 + remaining.length) % remaining.length]],
    flat[remaining[at]], flat[remaining[(at + 1) % remaining.length]]];
  while (remaining.length > 3 && guard > 0) {
    guard -= 1;
    const reflex = remaining.filter((_, at) => { const [a, b, c] = around(at); return cross2(a, b, c) <= 0; });
    const ear = remaining.findIndex((index, at) => {
      const [a, b, c] = around(at);
      if (cross2(a, b, c) <= 0) return false;
      return !reflex.some(other => other !== index && flat[other] !== a && flat[other] !== c
        && insideTriangle(flat[other], a, b, c));
    });
    // 数値の揺れで耳が見つからない時は、扇に割って止まらないようにする(表示だけに使う塗りなので止めない)。
    const at = ear < 0 ? 1 : ear;
    triangles.push(remaining[(at - 1 + remaining.length) % remaining.length], remaining[at], remaining[(at + 1) % remaining.length]);
    remaining.splice(at, 1);
  }
  if (remaining.length === 3) triangles.push(remaining[0], remaining[1], remaining[2]);
  return triangles;
}

function fillGeometry(polygon: readonly Vec3[], holes: readonly (readonly Vec3[])[]): FillGeometry {
  const cached = geometryCache.get(polygon);
  if (cached !== undefined && sameHoles(cached.holes, holes)) return cached.geometry;
  const normal = polygonNormal(polygon) ?? [0, 0, 1];
  const helper: Vec3 = belowMagnitude(normal[0], 0.9) ? [1, 0, 0] : [0, 1, 0];
  const u: Vec3 = [helper[1] * normal[2] - helper[2] * normal[1], helper[2] * normal[0] - helper[0] * normal[2],
    helper[0] * normal[1] - helper[1] * normal[0]];
  const uLength = Math.hypot(u[0], u[1], u[2]);
  const ux = u[0] / uLength, uy = u[1] / uLength, uz = u[2] / uLength;
  const vx = normal[1] * uz - normal[2] * uy, vy = normal[2] * ux - normal[0] * uz, vz = normal[0] * uy - normal[1] * ux;
  const loops = [polygon, ...holes].map(loop => {
    const flat: Point2[] = loop.map(([x, y, z]) => [x * ux + y * uy + z * uz, x * vx + y * vy + z * vz]);
    const kept = simplify(flat);
    return { corners: kept.map(index => loop[index]), flat: kept.map(index => flat[index]) };
  });
  const corners = loops.flatMap(loop => loop.corners);
  const local = loops[0].flat;
  const projected = loops.map(loop => loop.flat.map(([x, y]) => new Vector2(x, y)));
  const triangles = holes.length === 0 ? earClip(local, local.map((_, index) => index))
    : ShapeUtils.triangulateShape(projected[0], projected.slice(1)).flat();
  const geometry: FillGeometry = {
    positions: new Float32Array(corners.flatMap(point => [point[0], point[1], point[2]])),
    normals: new Float32Array(corners.flatMap(() => [normal[0], normal[1], normal[2]])),
    indices: new Uint32Array(triangles),
  };
  geometryCache.set(polygon, { holes, geometry });
  return geometry;
}

function emphasisOfRegion(elementId: string, input: RegionFillInput): SketchEmphasis {
  if (elementId === input.chosenElementId) return 'selected';
  return elementId === input.hoveredElementId ? 'hovered' : 'none';
}

/**
 * 塗りの材料が同じか(塗る領域の id と折れ線の実体・カーソルの下・選んだ領域・色)。同じなら scene へ渡し直さない
 * (ストアが変わるたびに一式を作り直さない。NFR-PF-1)。
 */
export function sameRegionFillInput(first: RegionFillInput | null, second: RegionFillInput | null): boolean {
  if (first === null || second === null) return first === second;
  return first.hoveredElementId === second.hoveredElementId && first.chosenElementId === second.chosenElementId
    && first.color === second.color && first.regions.length === second.regions.length
    && first.regions.every((region, index) => region.elementId === second.regions[index].elementId
      && region.polygon === second.regions[index].polygon
      && sameHoles(region.holes ?? NO_HOLES, second.regions[index].holes ?? NO_HOLES));
}

/** スケッチの描画の一式の面の後ろへ、領域の塗りを足す。塗りが無ければ一式をそのまま返す(描く側が何も作り直さない)。 */
export function appendRegionFills(bundle: SketchGeometryBundle, fills: readonly SketchFaceDraw[]): SketchGeometryBundle {
  return fills.length === 0 ? bundle : { ...bundle, faces: [...bundle.faces, ...fills] };
}

/** 領域の塗りを、面と同じ形の並びにする。塗らない時(押し出しが領域を選ぶ状態でない時)は空。 */
export function buildRegionFills(input: RegionFillInput | null): readonly SketchFaceDraw[] {
  if (input === null) return [];
  return input.regions.filter(region => region.polygon.length >= 3).map((region): SketchFaceDraw => {
    const geometry = fillGeometry(region.polygon, region.holes ?? NO_HOLES);
    return { featureId: region.elementId, color: input.color, ...geometry, emphasis: emphasisOfRegion(region.elementId, input) };
  });
}
