/**
 * 長さを持つ断面の部材の端を、留めの 45° に切る(J-01 包み 5)。部材は作図面 XY の断面を +Z へ長さ L だけ押し出した形
 * (`buildProfileSection`)。
 *
 * 短くする側(角の内側)が断面の局所の ±X なら XZ の作図面に、±Y なら YZ の作図面に、端で切り落とす三角(斜辺が切る面)を書き、
 * 断面の外まで両側へ押し出して部材から引く。切る面は、長い側の面の端(z = 0 か L)と、短い側の面の z = 2h(か L − 2h)を通る
 * (h は短くする向きの断面の外形の半分の幅。45°)。三角は断面の外形の外へ余白だけ大きくして、面が重ならないようにする。
 */
import { expressionValueFromNumber } from '@pointercad/expression';

import { appendSolid, nextSolidId, nextSolidName, replaceSketch } from '../../part/createPartDocument.js';
import type { ExtrudeFeature, PartDocument } from '../../part/types.js';
import {
  absoluteCoordinate, appendFeature, DEFAULT_FACE_COLOR, nextFeatureId, nextFeatureName,
} from '../../sketch/createSketchDocument.js';
import type { BaseWorkPlaneId } from '../../sketch/planeMath.js';
import type { SketchFaceFeature, SketchLineFeature } from '../../sketch/types.js';
import { FRAME_MITERS, type FrameMiter, type FrameSectionBounds } from '../frame/frameMembers.js';
import { activeSketch, appendBoolean } from './partPrimitives.js';
import type { ProfileLoops } from './profileExtrusion.js';

/** 留めで切る端と向き。 */
export interface ProfileMiterEnd {
  readonly end: 'start' | 'end';
  readonly side: FrameMiter;
}

/** 三角を断面の外形の外へ大きくする余白(mm)。形の面が切る面と重ならないための量で、切る面の位置は変えない。 */
const MITER_MARGIN_MM = 1;

function miterSideOf(value: string | undefined): FrameMiter | null {
  return FRAME_MITERS.find((side) => side === value) ?? null;
}

/** 保存の欄(startMiter・endMiter)の値の留めの端(切らない端は入れない)。族の部品と鋼材が共に使う。 */
export function miterEndsOf(values: Readonly<Record<string, string>>): readonly ProfileMiterEnd[] {
  const cuts: ProfileMiterEnd[] = [];
  const start = miterSideOf(values.startMiter), end = miterSideOf(values.endMiter);
  if (start !== null) cuts.push({ end: 'start', side: start });
  if (end !== null) cuts.push({ end: 'end', side: end });
  return cuts;
}

/** 留めの端の短くする向きの断面の外形の半分の幅の和。 */
function miterHalfWidths(bounds: FrameSectionBounds, cuts: readonly ProfileMiterEnd[]): number {
  return cuts.reduce((sum, cut) => sum + (cut.side === 'x+' || cut.side === 'x-' ? bounds.maxX - bounds.minX : bounds.maxY - bounds.minY) / 2, 0);
}

/** 留めの端ごとに短い側の面が 2h 短くなっても面が残るか(残らない形は作らない)。 */
export function miterFits(bounds: FrameSectionBounds, cuts: readonly ProfileMiterEnd[], length: number): boolean {
  return length - 2 * miterHalfWidths(bounds, cuts) > 0;
}

/**
 * 押し出しの形 `document` の端を、留めの端 `cuts` の順に切る。切らない時はそのまま。外形が無い・面が残らない時は null。
 * 族の部品(`catalog/miterOption.ts`)と鋼材(`buildStandardPart.ts`)が共に使う。
 */
export function applyMiterCuts(document: PartDocument, bounds: FrameSectionBounds | null, cuts: readonly ProfileMiterEnd[],
  length: number): PartDocument | null {
  if (cuts.length === 0) return document;
  if (bounds === null || !miterFits(bounds, cuts, length)) return null;
  let current = document;
  let targetId = current.solids.at(-1)?.id ?? '';
  for (const cut of cuts) ({ document: current, targetId } = appendMiterCut(current, targetId, bounds, cut, length));
  return current;
}

/** 短くする向きの断面の軸の中心・半分の幅と、横切る向きの断面の外形の両端からの最大の距離。 */
function miterAxes(bounds: FrameSectionBounds, side: FrameMiter): { readonly center: number; readonly half: number; readonly across: number } {
  const alongX = side === 'x+' || side === 'x-';
  const [min, max] = alongX ? [bounds.minX, bounds.maxX] : [bounds.minY, bounds.maxY];
  const [otherMin, otherMax] = alongX ? [bounds.minY, bounds.maxY] : [bounds.minX, bounds.maxX];
  return { center: (min + max) / 2, half: (max - min) / 2, across: Math.max(-otherMin, otherMax) };
}

/** 切り落とす三角の 3 点(作図面の中の [u, z]。u は短くする向きの断面の軸の座標)。 */
function miterTriangle(bounds: FrameSectionBounds, cut: ProfileMiterEnd, length: number): readonly (readonly [number, number])[] {
  const { center, half } = miterAxes(bounds, cut.side);
  const sign = cut.side === 'x+' || cut.side === 'y+' ? 1 : -1;
  const u = (t: number): number => center + sign * t;
  const reach = half + MITER_MARGIN_MM;
  // 長い側(t = −h)の端は z = 0、短い側(t = +h)は z = 2h。斜辺は z = h + t(終点の側は z = L − h − t)。
  if (cut.end === 'start') return [[u(-reach), -MITER_MARGIN_MM], [u(reach), -MITER_MARGIN_MM], [u(reach), 2 * half + MITER_MARGIN_MM]];
  return [[u(-reach), length + MITER_MARGIN_MM], [u(reach), length + MITER_MARGIN_MM], [u(reach), length - 2 * half - MITER_MARGIN_MM]];
}

/**
 * 輪の面積の 1 次のモーメント [∫x dA, ∫y dA](反時計回りが正。グリーンの定理 ∫x dA = ∮x²/2 dy、∫y dA = −∮y²/2 dx)。
 * 線分は端点の式、円弧は角度の式で厳密に数える。
 */
function loopFirstMoment(segments: ProfileLoops['segments']): readonly [number, number] {
  let mx = 0, my = 0;
  for (const segment of segments) {
    if (segment.kind === 'line') {
      const [x0, y0] = segment.from, dx = segment.to[0] - x0, dy = segment.to[1] - y0;
      mx += dy / 2 * (x0 ** 2 + x0 * dx + dx ** 2 / 3);
      my -= dx / 2 * (y0 ** 2 + y0 * dy + dy ** 2 / 3);
      continue;
    }
    const [cx, cy] = segment.center, r = segment.radius;
    const sinTerm = (a: number): number => cx ** 2 * Math.sin(a) + cx * r * (a + Math.sin(2 * a) / 2) + r ** 2 * (Math.sin(a) - Math.sin(a) ** 3 / 3);
    const cosTerm = (a: number): number => -(cy ** 2) * Math.cos(a) + cy * r * (a - Math.sin(2 * a) / 2) - r ** 2 * (Math.cos(a) - Math.cos(a) ** 3 / 3);
    // x = cx + r cosθ、dy = r cosθ dθ。y = cy + r sinθ、dx = −r sinθ dθ。
    mx += r / 2 * (sinTerm(segment.endAngle) - sinTerm(segment.startAngle));
    my += r / 2 * (cosTerm(segment.endAngle) - cosTerm(segment.startAngle));
  }
  return [mx, my];
}

/**
 * 留めで切った後の体積(実カーネルの体積の検査の独立した期待値)。端 1 つで切り落とす量は ∫(h + s·(u − c)) dA
 * = 面積 × h + s × (u の 1 次のモーメント − c × 面積)(c・h は短くする向きの外形の中心と半分の幅、s は短くする側の符号)。
 */
export function miteredVolume(profile: ProfileLoops, area: number, bounds: FrameSectionBounds, cuts: readonly ProfileMiterEnd[],
  length: number): number {
  const loops = [profile.segments, ...profile.holes];
  const moments = loops.map(loopFirstMoment).reduce<readonly [number, number]>((sum, [mx, my], index) =>
    (index === 0 ? [sum[0] + mx, sum[1] + my] : [sum[0] - mx, sum[1] - my]), [0, 0]);
  return cuts.reduce((volume, cut) => {
    const { center, half } = miterAxes(bounds, cut.side);
    const sign = cut.side === 'x+' || cut.side === 'y+' ? 1 : -1;
    const moment = cut.side === 'x+' || cut.side === 'x-' ? moments[0] : moments[1];
    return volume - (area * half + sign * (moment - center * area));
  }, area * length);
}

/** 作図面の中の [u, z] を世界の座標の入力にする(XZ は y = 0、YZ は x = 0)。 */
function planePoint(planeId: BaseWorkPlaneId, [u, z]: readonly [number, number]): ReturnType<typeof absoluteCoordinate> {
  return planeId === 'xz' ? absoluteCoordinate(u, 0, z) : absoluteCoordinate(0, u, z);
}

/**
 * 部材の形 `document`(最後の立体 `targetId`)の端を留めで切り、切った後の最後の立体の id を返す。
 * 断面の外形 `bounds` と長さ `length`(mm)は形を作った値と同じ物を渡す。
 */
export function appendMiterCut(document: PartDocument, targetId: string, bounds: FrameSectionBounds, cut: ProfileMiterEnd,
  length: number): { readonly document: PartDocument; readonly targetId: string } {
  const planeId: BaseWorkPlaneId = cut.side === 'x+' || cut.side === 'x-' ? 'xz' : 'yz';
  const points = miterTriangle(bounds, cut, length);
  let sketch = activeSketch(document);
  const boundary: { featureId: string }[] = [];
  points.forEach((from, index) => {
    const to = points[(index + 1) % points.length] ?? from;
    const line: SketchLineFeature = { id: nextFeatureId(sketch, 'line'), name: nextFeatureName(sketch, 'line'), planeId, kind: 'line',
      construction: false, from: planePoint(planeId, from), to: planePoint(planeId, to) };
    sketch = appendFeature(sketch, line);
    boundary.push({ featureId: line.id });
  });
  const face: SketchFaceFeature = { id: nextFeatureId(sketch, 'face'), name: nextFeatureName(sketch, 'face'), planeId, kind: 'face',
    boundary, color: DEFAULT_FACE_COLOR };
  sketch = appendFeature(sketch, face);
  const withSketch = replaceSketch(document, sketch);
  // 断面の外形を横切る向きへ、外形の外まで両側へ押し出す(長さの半分ずつ)。
  const across = miterAxes(bounds, cut.side).across + MITER_MARGIN_MM;
  const tool: ExtrudeFeature = { id: nextSolidId(withSketch, 'extrude'), name: nextSolidName(withSketch, 'extrude'), suppressed: false,
    kind: 'extrude', profile: { sketchId: sketch.id, faceFeatureId: face.id }, distance: expressionValueFromNumber(2 * across),
    reversed: false, symmetric: true };
  const cutDocument = appendBoolean(appendSolid(withSketch, tool), 'subtract', targetId, tool.id);
  return { document: cutDocument.document, targetId: cutDocument.feature.id };
}
