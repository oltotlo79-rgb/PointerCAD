/**
 * パネルと扉(E-10 第 1 段): 選んだ部材 4 本の枠(同じ面の上で直交する 2 組の平行な部材)の開口と、そこにはめる板の寸法・置き方を決める純関数。
 * 部材は `placedFrameMembers` の箱(軸の始点・終点・断面の局所 x・y の向き・外形の範囲)で受け取る。形は作らない。
 *
 * - 開口: 向かい合う 2 本の箱を相手の向きへ写した範囲の、内側どうしの間(幅は u の向き、高さは v の向き。u は 1 本目の部材の軸の向き)。
 *   中心は内側の範囲の中央。面の法線の向き n = u × v の位置は、4 本の箱の中心の平均。
 * - 板: 幅・高さから各辺の隙間を引き、局所 X = u・Y = v・Z = n で置く(板の形は外形の中心が原点で板厚を局所 +Z へ押し出す形なので、
 *   原点は中心から n × 板厚 / 2 だけ戻す)。安全柵の第 1 段のパネルと同じ置き方。
 */
import { exceedsMagnitude, withinMagnitude } from '../../numericTolerance.js';
import { addVec3, crossVec3, dotVec3, lengthVec3, scaleVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import { quaternionFromBasis, type RigidPlacement } from '../placementMath.js';
import type { PlacedFrameMember } from './frameJoints.js';

/** 部材が 4 本でない・直交する 2 組にならない・同じ面に無い・内側の寸法が 0 以下・数が正しくない。 */
export type FramePanelRejection = 'notFour' | 'notRectangle' | 'notCoplanar' | 'noRoom' | 'invalidNumber';

export type FramePanelOpeningResult =
  | { readonly ok: true; readonly width: number; readonly height: number; readonly placement: RigidPlacement }
  | { readonly ok: false; readonly reason: FramePanelRejection };

/** 向き・面の上とみなす差(向きの成分と mm)。 */
const AXIS_TOLERANCE = 1e-6;
const PLANE_TOLERANCE_MM = 0.01;
/** 長さと位置を丸める桁(mm の 1e-6。一括配置と同じ)。 */
const ROUNDING = 1e6;

const round = (value: number): number => Math.round(value * ROUNDING) / ROUNDING + 0;
const refused = (reason: FramePanelRejection): FramePanelOpeningResult => ({ ok: false, reason });

function directionOf(member: PlacedFrameMember): Vec3 | null {
  const span = subVec3(member.end, member.start), length = lengthVec3(span);
  return length > 0 ? scaleVec3(span, 1 / length) : null;
}

/** 部材の箱の 8 つの角。 */
function cornersOf(member: PlacedFrameMember): readonly Vec3[] {
  return [member.start, member.end].flatMap((end) => [member.bounds.minX, member.bounds.maxX].flatMap((x) =>
    [member.bounds.minY, member.bounds.maxY].map((y): Vec3 => addVec3(end, addVec3(scaleVec3(member.xAxis, x), scaleVec3(member.yAxis, y))))));
}

/** 箱を向き d へ写した範囲。 */
export function frameMemberRange(member: PlacedFrameMember, d: Vec3): readonly [number, number] {
  const values = cornersOf(member).map((corner) => dotVec3(corner, d));
  return [Math.min(...values), Math.max(...values)];
}

/** 向かい合う 2 本の箱の、向き d の内側どうしの間(手前の箱の奥の端から、奥の箱の手前の端まで)。 */
function inner(pair: readonly PlacedFrameMember[], d: Vec3): readonly [number, number] | null {
  const [a, b] = pair;
  if (a === undefined || b === undefined) return null;
  const ra = frameMemberRange(a, d), rb = frameMemberRange(b, d);
  return ra[0] + ra[1] <= rb[0] + rb[1] ? [ra[1], rb[0]] : [rb[1], ra[0]];
}

/** 枠の開口: 幅の向き u・高さの向き v・面の法線 n = u × v と、内側の範囲(u・v の向きの値)と、面の位置(n の向きの値)。 */
export interface FrameOpening {
  readonly u: Vec3;
  readonly v: Vec3;
  readonly n: Vec3;
  readonly width: readonly [number, number];
  readonly height: readonly [number, number];
  readonly level: number;
}

/** 選んだ 4 本の枠の開口(E-10 の第 1 段のパネルと第 2 段の扉が使う)。作れない時は理由。 */
export function openingFrame(members: readonly PlacedFrameMember[]): FrameOpening | Exclude<FramePanelRejection, 'invalidNumber' | 'noRoom'> {
  if (members.length !== 4) return 'notFour';
  if (!members.every((member) => [...member.start, ...member.end, ...member.xAxis, ...member.yAxis,
    member.bounds.minX, member.bounds.minY, member.bounds.maxX, member.bounds.maxY].every(Number.isFinite))) return 'notRectangle';
  const directions = members.map(directionOf);
  const u = directions[0];
  if (u === null || u === undefined || directions.some((d) => d === null)) return 'notRectangle';
  const along = (d: Vec3 | null): boolean => d !== null && withinMagnitude(Math.abs(dotVec3(d, u)) - 1, AXIS_TOLERANCE);
  const across = (d: Vec3 | null): boolean => d !== null && withinMagnitude(dotVec3(d, u), AXIS_TOLERANCE);
  const pairU = members.filter((_, index) => along(directions[index] ?? null));
  const pairV = members.filter((_, index) => across(directions[index] ?? null));
  const vRaw = pairV[0] === undefined ? null : directionOf(pairV[0]);
  if (pairU.length !== 2 || pairV.length !== 2 || vRaw === null || !across(pairV[1] === undefined ? null : directionOf(pairV[1]))
    || pairV.some((member) => exceedsMagnitude(Math.abs(dotVec3(directionOf(member) ?? [0, 0, 0], vRaw)) - 1, AXIS_TOLERANCE))) return 'notRectangle';
  // v は u に直交する向きのうち、u の組の 2 本が並ぶ向き(v の組の軸の向き)。n = u × v。
  const v = vRaw, n = crossVec3(u, v);
  const levels = members.map((member) => dotVec3(scaleVec3(addVec3(member.start, member.end), 0.5), n));
  if (Math.max(...levels) - Math.min(...levels) > PLANE_TOLERANCE_MM) return 'notCoplanar';
  const width = inner(pairV, u), height = inner(pairU, v);
  if (width === null || height === null || ![...width, ...height, ...levels].every(Number.isFinite)) return 'notRectangle';
  return { u, v, n, width, height, level: levels.reduce((sum, value) => sum + value, 0) / levels.length };
}

/** 開口の中の点(u・v の向きの値と、n の向きの面の位置から)。 */
export function openingPoint(opening: FrameOpening, along: number, up: number, depth = 0): Vec3 {
  return addVec3(addVec3(scaleVec3(opening.u, along), scaleVec3(opening.v, up)), scaleVec3(opening.n, opening.level + depth));
}

/** A rail must reach both inside corners of the opening along its own axis. */
function spansPanelOpening(member: PlacedFrameMember, opening: FrameOpening): boolean {
  const direction = directionOf(member);
  if (direction === null) return false;
  const alongWidth = withinMagnitude(Math.abs(dotVec3(direction, opening.u)) - 1, AXIS_TOLERANCE);
  const [start, end] = frameMemberRange(member, alongWidth ? opening.u : opening.v);
  const [firstCorner, lastCorner] = alongWidth ? opening.width : opening.height;
  return start <= firstCorner + PLANE_TOLERANCE_MM && end >= lastCorner - PLANE_TOLERANCE_MM;
}

/** 選んだ 4 本の枠の開口と、はめる板(板厚・各辺の隙間)の寸法と置き方。作れない時は理由。 */
export function framePanelOpening(members: readonly PlacedFrameMember[], panel: { readonly thickness: number; readonly gap: number; readonly flip?: boolean }):
FramePanelOpeningResult {
  if (members.length !== 4) return refused('notFour');
  if (!(Number.isFinite(panel.thickness) && panel.thickness > 0 && Number.isFinite(panel.gap) && panel.gap >= 0)) return refused('invalidNumber');
  const opening = openingFrame(members);
  if (typeof opening === 'string') return refused(opening);
  const w = round(opening.width[1] - opening.width[0] - 2 * panel.gap), h = round(opening.height[1] - opening.height[0] - 2 * panel.gap);
  if (!(Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0)) return refused('noRoom');
  if (!members.every((member) => spansPanelOpening(member, opening))) return refused('notRectangle');
  const faceSign = panel.flip === true ? -1 : 1;
  const rotation = quaternionFromBasis(opening.u, scaleVec3(opening.v, faceSign), scaleVec3(opening.n, faceSign), 1e-9);
  if (rotation === null) return refused('notRectangle');
  const origin = openingPoint(opening, (opening.width[0] + opening.width[1]) / 2, (opening.height[0] + opening.height[1]) / 2,
    -faceSign * panel.thickness / 2);
  const position = [round(origin[0]), round(origin[1]), round(origin[2])] as const;
  if (!position.every(Number.isFinite)) return refused('invalidNumber');
  return { ok: true, width: w, height: h, placement: { position, rotation } };
}
