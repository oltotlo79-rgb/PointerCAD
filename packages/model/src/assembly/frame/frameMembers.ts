/**
 * フレームの一括配置(J-01 包み 1)の純関数: 線の列から、長さを持つ部材(アルミフレームの族・鋼材)1 本ごとの
 * 長さ・配置・角の扱いを出す。保存の形は変えない(並べた部材は普通の部品。統括の決定 2026-11-16 15:3x)。
 *
 * 部材の形は、断面を部品の XY 面にかき、Z = 0 から +Z へ長さだけ押し出した物(族・鋼材の形の台本の共通の形)。
 * - 断面の外形(`FrameSectionBounds`)の中心を線に乗せる。
 * - 局所の Z を線の向き、局所の Y を「上の向き」を線に直交させた向き、局所の X を Y × Z にする。上の向きが線と平行なら、
 *   候補(+Z、+Y、+X)の順に、平行でない最初の物へ替える。`quarterTurns` は断面を線のまわりに 90° ずつ回す。
 * - 端の扱い: 両端の伸ばす量(負は縮める)。`corners: 'butt'` は、端どうしが重なる 2 本の線が直角の時だけ、先の線の部材を通し
 *   (相手の断面の外の面まで伸ばす)、後の線の部材を当てる(相手の断面の面まで縮める)。3 本以上が会う角と直角でない角は扱わず、理由を返す。
 */
import {
  addVec3 as add, crossVec3 as cross, dotVec3 as dot, lengthVec3 as norm, scaleVec3 as scale, subVec3 as sub, type Vec3,
} from '../../sketch/vec3.js';
import { exceedsMagnitude, withinMagnitude } from '../../numericTolerance.js';
import { quaternionFromBasis, type RigidPlacement } from '../placementMath.js';

/** 線 1 本(世界の座標、mm)。始点から終点へ部材を置く。 */
export interface FrameLine {
  readonly start: Vec3;
  readonly end: Vec3;
}

/** 断面の外形(部品の XY 面、mm)。族・鋼材の形の台本ごとに原点の位置が違うので、外形の中心を線に乗せるために持つ。 */
export interface FrameSectionBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** 角の扱い: そのまま・突き当て・留め(45° に切って合わせる。J-01 包み 5)。 */
export type FrameCornerRule = 'none' | 'butt' | 'miter';

/**
 * 留めで切る端の向き: 端を 45° に切って短くする側(角の内側)が、部材の局所の断面の軸のどちらか。
 * 例 'x+' は局所の +X の側の面が短く、-X の側の面が長い(長い側の面の長さが部材の長さ)。
 */
export type FrameMiter = 'x+' | 'x-' | 'y+' | 'y-';

/** 留めの端の向きの全部(保存の欄 startMiter・endMiter の値。族の部品と鋼材が共に確かめる)。 */
export const FRAME_MITERS: readonly FrameMiter[] = ['x+', 'x-', 'y+', 'y-'];

interface FrameMemberOptions {
  readonly section: FrameSectionBounds;
  /** 断面の局所の +Y を向ける方向(線に直交させて使う)。 */
  readonly up: Vec3;
  /** 断面を線のまわりに 90° ずつ回す回数(0〜3。省くと 0)。 */
  readonly quarterTurns?: number;
  /** 始点の側へ伸ばす量(mm。負は縮める)。 */
  readonly startExtension: number;
  /** 終点の側へ伸ばす量(mm。負は縮める)。 */
  readonly endExtension: number;
  readonly corners: FrameCornerRule;
  /** 突き当てで、通す部材を後の線の部材へ入れ替える角の番号(返す `corners` の並びの番号)。 */
  readonly swapThrough?: readonly number[];
}

/**
 * 部材 1 本の計画。`startAdjustment`・`endAdjustment` は線の端から伸ばした量(伸ばす量と角の扱いの和。負は縮めた量)。
 * `startMiter`・`endMiter` は留めで 45° に切る端の向き(切らない端は null)。`lengthMm` は長い側の面の長さ。
 */
interface FrameMemberPlan {
  readonly lineIndex: number;
  readonly lengthMm: number;
  readonly placement: RigidPlacement;
  readonly startAdjustment: number;
  readonly endAdjustment: number;
  readonly startMiter: FrameMiter | null;
  readonly endMiter: FrameMiter | null;
}

/**
 * 端が重なる所(2 本以上)。`through` は突き当てで通した線(扱わない角・留めの角は null)。
 * 留めは直角に会う 2 本で、角の内側の向きが両方の部材の断面の軸に沿い、両方の部材の角の面までの距離が同じ時だけ
 * (45° になる時だけ。そうでない角は 'miterNotAligned'・'miterUnequal' の理由で扱わない)。
 */
interface FrameCornerPlan {
  readonly point: Vec3;
  readonly lines: readonly number[];
  readonly treatment: 'butt' | 'miter' | 'none';
  readonly reason: 'rule' | 'moreThanTwo' | 'notPerpendicular' | 'miterNotAligned' | 'miterUnequal' | null;
  readonly through: number | null;
}

type FrameMembersRejection = 'noLines' | 'invalidSection' | 'invalidUp' | 'invalidNumber' | 'degenerateLine'
  | 'nonPositiveLength';

export type FrameMembersResult =
  | { readonly ok: true; readonly members: readonly FrameMemberPlan[]; readonly corners: readonly FrameCornerPlan[] }
  | { readonly ok: false; readonly reason: FrameMembersRejection; readonly lineIndex: number | null };

/** 端どうしを同じ点とみなす距離(mm)。 */
const POINT_TOLERANCE = 1e-6;
/** 直角とみなす向きの内積の大きさ。 */
const PERPENDICULAR_TOLERANCE = 1e-9;
/** 向きが断面の軸に沿うとみなす内積の 1 からの差。 */
const AXIS_TOLERANCE = 1e-9;
/** 長さと位置を丸める桁(mm の 1e-6。浮動小数の端数で切断の一覧の行が分かれないようにする)。 */
const ROUNDING = 1e6;
const UP_CANDIDATES: readonly Vec3[] = [[0, 0, 1], [0, 1, 0], [1, 0, 0]];

interface Basis {
  readonly x: Vec3;
  readonly y: Vec3;
  readonly z: Vec3;
}

interface LineFrame {
  readonly basis: Basis;
  readonly length: number;
}

interface EndRef {
  readonly lineIndex: number;
  readonly atEnd: boolean;
  readonly point: Vec3;
}

const round = (value: number): number => Math.round(value * ROUNDING) / ROUNDING;
const finite = (values: readonly number[]): boolean => values.every((value) => Number.isFinite(value));

function validSection(section: FrameSectionBounds): boolean {
  return finite([section.minX, section.minY, section.maxX, section.maxY]) && section.maxX > section.minX && section.maxY > section.minY;
}

/** 線の向き `z` に直交する局所の Y(上の向き、平行なら候補の次)と、X = Y × Z。90° ずつの回しを後から掛ける。 */
function basisFor(z: Vec3, up: Vec3, quarterTurns: number): Basis | null {
  for (const candidate of [up, ...UP_CANDIDATES]) {
    const projected = sub(candidate, scale(z, dot(candidate, z)));
    const length = norm(projected);
    if (length <= PERPENDICULAR_TOLERANCE * Math.max(1, norm(candidate))) continue;
    const y = scale(projected, 1 / length);
    const x = cross(y, z);
    const turns = ((Math.round(quarterTurns) % 4) + 4) % 4;
    const angle = turns * Math.PI / 2;
    const cos = Math.round(Math.cos(angle)), sin = Math.round(Math.sin(angle));
    return { x: add(scale(x, cos), scale(y, sin)), y: add(scale(x, -sin), scale(y, cos)), z };
  }
  return null;
}

/** 断面の外形の、中心から見た 4 隅を世界の向き `direction` へ写した時の最も遠い距離(部材の面までの距離)。 */
function sectionReach(section: FrameSectionBounds, basis: Basis, direction: Vec3): number {
  const halfX = (section.maxX - section.minX) / 2, halfY = (section.maxY - section.minY) / 2;
  return Math.abs(dot(basis.x, direction)) * halfX + Math.abs(dot(basis.y, direction)) * halfY;
}

function groupEnds(lines: readonly FrameLine[]): readonly (readonly EndRef[])[] {
  const groups: EndRef[][] = [];
  lines.forEach((line, lineIndex) => {
    for (const ref of [{ lineIndex, atEnd: false, point: line.start }, { lineIndex, atEnd: true, point: line.end }]) {
      const group = groups.find((candidate) => {
        const head = candidate[0];
        return head !== undefined && norm(sub(head.point, ref.point)) <= POINT_TOLERANCE;
      });
      if (group === undefined) groups.push([ref]); else group.push(ref);
    }
  });
  return groups.filter((group) => group.length >= 2);
}

/** 断面の局所の軸(±X・±Y)のうち、世界の向き `direction` に沿う物(沿わなければ null)。 */
function miterSide(basis: Basis, direction: Vec3): FrameMiter | null {
  const alongX = dot(basis.x, direction), alongY = dot(basis.y, direction);
  if (withinMagnitude(alongX - 1, AXIS_TOLERANCE)) return 'x+';
  if (withinMagnitude(alongX + 1, AXIS_TOLERANCE)) return 'x-';
  if (withinMagnitude(alongY - 1, AXIS_TOLERANCE)) return 'y+';
  return withinMagnitude(alongY + 1, AXIS_TOLERANCE) ? 'y-' : null;
}

type EndAdjust = (lineIndex: number, atEnd: boolean, amount: number, miter?: FrameMiter) => void;

/**
 * 留めの角(直角に会う 2 本 a・b)。どちらの部材も相手の断面の外の面まで伸ばし、角の内側(相手の部材の体のある向き)の面を
 * 45° に切って短くする。45° になるのは、角の内側の向きが自分の断面の軸に沿い、両方の部材の角の面までの距離が同じ時だけ。
 */
function planMiterCorner(a: EndRef, b: EndRef, frames: readonly LineFrame[], section: FrameSectionBounds, adjust: EndAdjust):
'miterNotAligned' | 'miterUnequal' | null {
  const frameA = frames[a.lineIndex], frameB = frames[b.lineIndex];
  if (frameA === undefined || frameB === undefined) return 'miterNotAligned';
  // 相手の部材の体のある向き(角から相手の線に沿って体の側へ)。
  const insideA = b.atEnd ? scale(frameB.basis.z, -1) : frameB.basis.z;
  const insideB = a.atEnd ? scale(frameA.basis.z, -1) : frameA.basis.z;
  const sideA = miterSide(frameA.basis, insideA), sideB = miterSide(frameB.basis, insideB);
  if (sideA === null || sideB === null) return 'miterNotAligned';
  const reachA = sectionReach(section, frameA.basis, insideA), reachB = sectionReach(section, frameB.basis, insideB);
  if (exceedsMagnitude(reachA - reachB, POINT_TOLERANCE)) return 'miterUnequal';
  adjust(a.lineIndex, a.atEnd, reachB, sideA);
  adjust(b.lineIndex, b.atEnd, reachA, sideB);
  return null;
}

/** 角ごとの扱いと、各線の端の伸び縮み(角の扱いの分)と留めの端を決める。 */
function planCorners(groups: readonly (readonly EndRef[])[], frames: readonly LineFrame[], options: FrameMemberOptions,
  adjust: EndAdjust): FrameCornerPlan[] {
  return groups.map((group, cornerIndex) => {
    const lines = [...new Set(group.map((ref) => ref.lineIndex))].sort((a, b) => a - b);
    const point = group[0]?.point ?? [0, 0, 0];
    const none = (reason: FrameCornerPlan['reason']): FrameCornerPlan => ({ point, lines, treatment: 'none', reason, through: null });
    if (options.corners === 'none') return none('rule');
    if (group.length !== 2 || lines.length !== 2) return none('moreThanTwo');
    if (options.corners === 'miter') {
      const [a, b] = [...group].sort((left, right) => left.lineIndex - right.lineIndex);
      const frameA = a === undefined ? undefined : frames[a.lineIndex], frameB = b === undefined ? undefined : frames[b.lineIndex];
      if (a === undefined || b === undefined || frameA === undefined || frameB === undefined) return none('moreThanTwo');
      if (exceedsMagnitude(dot(frameA.basis.z, frameB.basis.z), PERPENDICULAR_TOLERANCE)) return none('notPerpendicular');
      const refused = planMiterCorner(a, b, frames, options.section, adjust);
      return refused === null ? { point, lines, treatment: 'miter', reason: null, through: null } : none(refused);
    }
    // 既定は先の線の部材を通す。入れ替える角は後の線の部材を通す。
    const swapped = options.swapThrough?.includes(cornerIndex) === true;
    const [first, second] = [...group].sort((a, b) => swapped ? b.lineIndex - a.lineIndex : a.lineIndex - b.lineIndex);
    const through = first === undefined ? undefined : frames[first.lineIndex];
    const butting = second === undefined ? undefined : frames[second.lineIndex];
    if (first === undefined || second === undefined || through === undefined || butting === undefined) return none('moreThanTwo');
    if (exceedsMagnitude(dot(through.basis.z, butting.basis.z), PERPENDICULAR_TOLERANCE)) return none('notPerpendicular');
    // 通す部材: 角の外へ向かう向きに、当てる部材の断面の面まで伸ばす。当てる部材: 自分の体の向きに、通す部材の断面の面まで縮める。
    const outward = first.atEnd ? through.basis.z : scale(through.basis.z, -1);
    const inward = second.atEnd ? scale(butting.basis.z, -1) : butting.basis.z;
    adjust(first.lineIndex, first.atEnd, sectionReach(options.section, butting.basis, outward));
    adjust(second.lineIndex, second.atEnd, -sectionReach(options.section, through.basis, inward));
    return { point, lines, treatment: 'butt', reason: null, through: first.lineIndex };
  });
}

type Rejection = Extract<FrameMembersResult, { readonly ok: false }>;

function lineFrames(lines: readonly FrameLine[], options: FrameMemberOptions):
{ readonly ok: true; readonly frames: readonly LineFrame[] } | Rejection {
  const frames: LineFrame[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    if (!finite([...line.start, ...line.end])) return { ok: false, reason: 'invalidNumber', lineIndex };
    const vector = sub(line.end, line.start);
    const length = norm(vector);
    if (length <= POINT_TOLERANCE) return { ok: false, reason: 'degenerateLine', lineIndex };
    const basis = basisFor(scale(vector, 1 / length), options.up, options.quarterTurns ?? 0);
    if (basis === null) return { ok: false, reason: 'invalidUp', lineIndex: null };
    frames.push({ basis, length });
  }
  return { ok: true, frames };
}

/** 入力の数と外形・上の向きの確かめ(線の中身は `lineFrames`)。 */
function optionsRejection(lines: readonly FrameLine[], options: FrameMemberOptions): Rejection | null {
  if (lines.length === 0) return { ok: false, reason: 'noLines', lineIndex: null };
  if (!validSection(options.section)) return { ok: false, reason: 'invalidSection', lineIndex: null };
  if (!finite(options.up) || norm(options.up) === 0) return { ok: false, reason: 'invalidUp', lineIndex: null };
  if (!finite([options.startExtension, options.endExtension, options.quarterTurns ?? 0])) {
    return { ok: false, reason: 'invalidNumber', lineIndex: null };
  }
  return null;
}

/** 線の列から部材 1 本ごとの長さと配置を出す。作れない時は置かずに理由を返す。 */
export function planFrameMembers(lines: readonly FrameLine[], options: FrameMemberOptions): FrameMembersResult {
  const rejected = optionsRejection(lines, options);
  if (rejected !== null) return rejected;
  const planned = lineFrames(lines, options);
  if (!planned.ok) return planned;
  const frames = planned.frames;
  const starts = lines.map(() => options.startExtension), ends = lines.map(() => options.endExtension);
  const startMiters: (FrameMiter | null)[] = lines.map(() => null), endMiters: (FrameMiter | null)[] = lines.map(() => null);
  // 留めの端 1 つで短い側の面が 2h 短くなる(h は伸ばした量と同じ)。短い側の面が残らない部材は作らない。
  const miterLoss = lines.map(() => 0);
  const corners = planCorners(groupEnds(lines), frames, options, (lineIndex, atEnd, amount, miter) => {
    if (atEnd) ends[lineIndex] = (ends[lineIndex] ?? 0) + amount; else starts[lineIndex] = (starts[lineIndex] ?? 0) + amount;
    if (miter === undefined) return;
    (atEnd ? endMiters : startMiters)[lineIndex] = miter;
    miterLoss[lineIndex] = (miterLoss[lineIndex] ?? 0) + 2 * amount;
  });
  const centerX = (options.section.minX + options.section.maxX) / 2, centerY = (options.section.minY + options.section.maxY) / 2;
  const members: FrameMemberPlan[] = [];
  for (const [lineIndex, frame] of frames.entries()) {
    const startAdjustment = round(starts[lineIndex] ?? 0), endAdjustment = round(ends[lineIndex] ?? 0);
    const lengthMm = round(frame.length + startAdjustment + endAdjustment);
    if (!(lengthMm > 0) || !(lengthMm - (miterLoss[lineIndex] ?? 0) > 0)) return { ok: false, reason: 'nonPositiveLength', lineIndex };
    const rotation = quaternionFromBasis(frame.basis.x, frame.basis.y, frame.basis.z, 1e-9);
    if (rotation === null) return { ok: false, reason: 'invalidNumber', lineIndex };
    const start = lines[lineIndex]?.start ?? [0, 0, 0];
    const origin = sub(sub(start, scale(frame.basis.z, startAdjustment)),
      add(scale(frame.basis.x, centerX), scale(frame.basis.y, centerY)));
    members.push({ lineIndex, lengthMm, placement: { position: [round(origin[0]), round(origin[1]), round(origin[2])], rotation },
      startAdjustment, endAdjustment, startMiter: startMiters[lineIndex] ?? null, endMiter: endMiters[lineIndex] ?? null });
  }
  return { ok: true, members, corners };
}
