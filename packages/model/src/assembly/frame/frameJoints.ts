/**
 * 置いた部材どうしの接続の見分け(E-07 締結部品の自動判別・E-09 接合チェックの共通の土台。設計 wip/e07-e09-design.md §1)。
 *
 * 部材は、長さの欄と断面の外形(`sectionBounds`)を持つ族の部品(溝つきのフレームなど)。部材の形を、断面の外形の長方形を長さだけ
 * 伸ばした向きつきの箱とみなし(留めで切った端も箱のまま見る)、2 本の箱が接するか(離れが許容差以内)を分離軸で確かめる。
 * 接する 2 本の形は、互いの軸の上で相手の箱が当たる所が「端」か「途中」かと、軸の向き(直交・平行・それ以外)で決める:
 * L(端どうし・直交)、T(端と途中・直交)、十字(同じ部材の同じ位置の反対の面に T が 2 つ)、突き合わせ(端どうし・同じ直線)、
 * 交差(途中どうし・直交。重ねて交わる)、並び(平行で横に接する)、斜め(直交でも平行でもない)。
 * 部材は、フレームの溝の締結の候補(`frameSlotCandidates`)の元にもなる(溝の線・溝の呼びの幅・溝の位置の簡略の印を持つ)。
 * 形を作らない純関数(kernel を使わない)。
 */
import { evaluateExpression } from '@pointercad/expression';

import { PRODUCT_CATALOG_REGISTRY, type CatalogRegistry } from '../catalog/registry.js';
import type { CatalogItemRow } from '../catalog/types.js';
import { applyPlacementToDirection, applyPlacementToPoint, type RigidPlacement } from '../placementMath.js';
import { miterEndsOf } from '../standard/profileMiter.js';
import type { AssemblyDocument } from '../types.js';
import { withinMagnitude } from '../../numericTolerance.js';
import { addVec3, crossVec3, dotVec3, lengthVec3, normalizeVec3, scaleVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import type { FrameJointRecord } from './frameJointRecord.js';
import type { FrameSectionBounds } from './frameMembers.js';
import { frameSlotLines, type FrameSlotLine } from './frameSlots.js';

const FAMILY_KEY = 'family', ITEM_KEY = 'item';
/** 行の鍵の頭の溝の呼びの幅(資料の族・系列の族の鍵 `s6-20x20` の形)。 */
const SLOT_WIDTH_KEY_PATTERN = /^s([0-9]+)-/u;

/** 2 本の部材の箱が接するとみなす離れ(mm)。置いた部材の配置は式の値から作るので、接する面は丸めの桁で一致する。 */
const FRAME_JOINT_CONTACT_TOLERANCE_MM = 0.01;
/** 軸を直交・平行とみなす、内積の大きさ(直交)と、内積の大きさの 1 からの差(平行)。配置の回転は四元数で、成分に丸めの桁の誤差が残る。 */
const FRAME_JOINT_AXIS_TOLERANCE = 1e-6;
/** 分離軸に使わない外積の長さ(2 本の軸がほぼ平行な時の外積は向きが決まらない)。 */
const DEGENERATE_AXIS_LENGTH = 1e-9;

/** 断面の外の面(局所 +Y が上、+X が右。溝の面の名前と同じ)。 */
type FrameFace ='top' | 'left' | 'bottom' | 'right';

/** 置いた部材 1 本(世界の座標)。 */
export interface PlacedFrameMember {
  readonly componentId: string;
  /** 軸の始点(局所 z = 0)と終点(局所 z = 長さ)。 */
  readonly start: Vec3;
  readonly end: Vec3;
  /** 断面の局所 x・y の世界の向き(単位の長さ)。 */
  readonly xAxis: Vec3;
  readonly yAxis: Vec3;
  /** 断面の外形の範囲(局所)。 */
  readonly bounds: FrameSectionBounds;
  /** 溝の中心線(溝の無い部材は空)。 */
  readonly slotLines: readonly FrameSlotLine[];
  /**
   * 溝の呼びの幅(行の dims の slotWidth、無ければ行の鍵の頭。どちらも無い汎用の形は null)と、溝の位置の簡略の印。族が溝を出さない
   * 部材は null(溝を出す部材は、留めの切りで線が全部切れても入れる)。
   */
  readonly slotSpec: { readonly width: number | null; readonly positionSimplified: boolean } | null;
}

export type FrameJointKind = 'L' | 'T' | 'cross' | 'butt' | 'crossing' | 'parallel' | 'angled';

/** 接続の部材 1 本: 相手が当たる所(始点の端・終点の端・途中)と、途中の時は相手の側の面。 */
interface FrameJointMember {
  readonly componentId: string;
  readonly part: 'start' | 'end' | 'side';
  readonly face: FrameFace | null;
}

/** 接続 1 つ。`id` は形と部材と当たる所から作り、部品の並びに依らない。 */
export interface FrameJoint {
  readonly id: string;
  readonly kind: FrameJointKind;
  readonly members: readonly FrameJointMember[];
  /** 接続の位置(端で当たる部材があればその端の点、無ければ 2 本の箱の中心の中点)。 */
  readonly point: Vec3;
}

/** 溝の呼びの幅: 行の dims の slotWidth、無ければ行の鍵の頭。どちらも無ければ null(寸法を指定する汎用の形)。 */
function frameSlotWidthOf(row: CatalogItemRow): number | null {
  const own = Object.hasOwn(row.dims, 'slotWidth') ? row.dims.slotWidth : undefined;
  if (own !== undefined && Number.isFinite(own) && own > 0) return own;
  const match = SLOT_WIDTH_KEY_PATTERN.exec(row.key);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * 組立の部材の全部(長さの欄と断面の外形を持つ族の部品)。配置は表示中の配置を渡す。隠した・抑制した部品と、族を読み込んでいない部品は入れない。
 */
export function placedFrameMembers(document: AssemblyDocument, placements: ReadonlyMap<string, RigidPlacement>,
  registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY): readonly PlacedFrameMember[] {
  return document.components.flatMap((component): PlacedFrameMember[] => {
    const source = component.source;
    const placement = placements.get(component.id);
    if (source.kind !== 'standardPart' || source.catalog !== 'catalogItem' || placement === undefined || component.suppressed
      || !component.visible) return [];
    const family = registry.loaded(source.options[FAMILY_KEY] ?? '');
    const row = family?.rows.find((candidate) => candidate.key === source.options[ITEM_KEY]);
    if (family === undefined || row === undefined) return [];
    const values = Object.fromEntries(Object.entries(source.options).filter(([key]) => key !== FAMILY_KEY && key !== ITEM_KEY));
    const bounds = family.sectionBounds?.(row, values) ?? null;
    const length = evaluateExpression(Object.hasOwn(values, 'length') ? values.length : '');
    if (bounds === null || !length.ok || !(length.value.value > 0)) return [];
    const lengthMm = length.value.value;
    const slots = family.sectionSlots?.(row, values) ?? null;
    const slotted = slots !== null && slots.length > 0;
    return [{ componentId: component.id, start: applyPlacementToPoint(placement, [0, 0, 0]), end: applyPlacementToPoint(placement, [0, 0, lengthMm]),
      xAxis: applyPlacementToDirection(placement, [1, 0, 0]), yAxis: applyPlacementToDirection(placement, [0, 1, 0]), bounds,
      slotLines: slotted ? frameSlotLines(slots, placement, lengthMm, bounds, miterEndsOf(values)) : [],
      slotSpec: slotted ? { width: frameSlotWidthOf(row), positionSimplified: row.simplifiedKinds?.includes('slotPositionSymmetric') === true }
        : null }];
  });
}

/** 部材の向きつきの箱(中心・3 本の軸・半分の大きさ)と、軸の長さ。 */
interface MemberBox {
  readonly member: PlacedFrameMember;
  readonly center: Vec3;
  readonly axes: readonly [Vec3, Vec3, Vec3];
  readonly half: readonly [number, number, number];
  readonly length: number;
  /** 世界の座標の外接の箱(先に絞るため)。 */
  readonly min: Vec3;
  readonly max: Vec3;
}

function boxOf(member: PlacedFrameMember): MemberBox {
  const along = subVec3(member.end, member.start), length = lengthVec3(along), z = normalizeVec3(along);
  const { minX, maxX, minY, maxY } = member.bounds;
  const center = addVec3(addVec3(member.start, scaleVec3(member.xAxis, (minX + maxX) / 2)),
    addVec3(scaleVec3(member.yAxis, (minY + maxY) / 2), scaleVec3(z, length / 2)));
  const axes: readonly [Vec3, Vec3, Vec3] = [member.xAxis, member.yAxis, z];
  const half: readonly [number, number, number] = [(maxX - minX) / 2, (maxY - minY) / 2, length / 2];
  const reach = (k: 0 | 1 | 2): number => half[0] * Math.abs(axes[0][k]) + half[1] * Math.abs(axes[1][k]) + half[2] * Math.abs(axes[2][k]);
  return { member, center, axes, half, length, min: [center[0] - reach(0), center[1] - reach(1), center[2] - reach(2)],
    max: [center[0] + reach(0), center[1] + reach(1), center[2] + reach(2)] };
}

/** 箱を向き `axis`(単位)へ写した半分の長さ。 */
function radiusAlong(box: MemberBox, axis: Vec3): number {
  const [u, v, w] = box.axes, [hu, hv, hw] = box.half;
  return hu * Math.abs(dotVec3(u, axis)) + hv * Math.abs(dotVec3(v, axis)) + hw * Math.abs(dotVec3(w, axis));
}

/** 2 つの箱が、許容差より離れているか(分離軸: 箱の軸 6 本と、軸どうしの外積 9 本)。 */
function separated(a: MemberBox, b: MemberBox): boolean {
  const gap = subVec3(b.center, a.center);
  const candidates = [...a.axes, ...b.axes, ...a.axes.flatMap((own) => b.axes.map((other) => crossVec3(own, other)))];
  return candidates.some((raw) => {
    const size = lengthVec3(raw);
    if (size < DEGENERATE_AXIS_LENGTH) return false;
    const axis = scaleVec3(raw, 1 / size);
    const separation = Math.abs(dotVec3(gap, axis)) - radiusAlong(a, axis) - radiusAlong(b, axis);
    return separation > FRAME_JOINT_CONTACT_TOLERANCE_MM;
  });
}

/** 部材 `own` の軸の上で、相手の箱が当たる所。両方の端にかかる(相手が全長に当たる)時は途中とする。 */
function partOf(own: MemberBox, other: MemberBox): FrameJointMember['part'] {
  const axis = own.axes[2];
  const at = dotVec3(subVec3(other.center, own.member.start), axis), reach = radiusAlong(other, axis);
  const coversStart = at - reach <= FRAME_JOINT_CONTACT_TOLERANCE_MM;
  const coversEnd = at + reach >= own.length - FRAME_JOINT_CONTACT_TOLERANCE_MM;
  if (coversStart && coversEnd) return 'side';
  return coversStart ? 'start' : coversEnd ? 'end' : 'side';
}

/** 部材 `own` の、相手の箱の中心の側の外の面。 */
function faceToward(own: MemberBox, other: MemberBox): FrameFace {
  const gap = subVec3(other.center, own.center);
  const x = dotVec3(gap, own.member.xAxis), y = dotVec3(gap, own.member.yAxis);
  if (x * x > y * y) return x > 0 ? 'right' : 'left';
  return y > 0 ? 'top' : 'bottom';
}

function endPoint(box: MemberBox, part: FrameJointMember['part']): Vec3 | null {
  return part === 'start' ? box.member.start : part === 'end' ? box.member.end : null;
}

/** 2 本の箱の中心が、同じ軸の直線の上にあるか(突き合わせ)。 */
function collinear(a: MemberBox, b: MemberBox): boolean {
  const gap = subVec3(b.center, a.center);
  const off = subVec3(gap, scaleVec3(a.axes[2], dotVec3(gap, a.axes[2])));
  return withinMagnitude(lengthVec3(off), FRAME_JOINT_CONTACT_TOLERANCE_MM);
}

function jointId(kind: FrameJointKind, members: readonly FrameJointMember[]): string {
  return `${kind}:${members.map((member) => `${member.componentId}@${member.part}`).sort().join('|')}`;
}

function memberOf(own: MemberBox, other: MemberBox, part: FrameJointMember['part']): FrameJointMember {
  return { componentId: own.member.componentId, part, face: part === 'side' ? faceToward(own, other) : null };
}

/** 接する 2 本の形(接しない時は null)。 */
function classifyPair(a: MemberBox, b: MemberBox): FrameJoint | null {
  if (separated(a, b)) return null;
  const partA = partOf(a, b), partB = partOf(b, a);
  const dot = dotVec3(a.axes[2], b.axes[2]);
  const ends = partA !== 'side' && partB !== 'side', sides = partA === 'side' && partB === 'side';
  let kind: FrameJointKind;
  if (withinMagnitude(dot, FRAME_JOINT_AXIS_TOLERANCE)) kind = ends ? 'L' : sides ? 'crossing' : 'T';
  else if (withinMagnitude(1 - Math.abs(dot), FRAME_JOINT_AXIS_TOLERANCE)) kind = ends && collinear(a, b) ? 'butt' : 'parallel';
  else kind = 'angled';
  const members = [memberOf(a, b, partA), memberOf(b, a, partB)]
    .sort((left, right) => (left.componentId < right.componentId ? -1 : left.componentId > right.componentId ? 1 : 0));
  const point = endPoint(a, partA) ?? endPoint(b, partB) ?? scaleVec3(addVec3(a.center, b.center), 0.5);
  return { id: jointId(kind, members), kind, members, point };
}

const OPPOSITE: Readonly<Record<FrameFace, FrameFace>> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
/** 外接の箱の、掃く向き(x)以外の 2 つの向き。 */
const LATERAL_AXES: readonly (1 | 2)[] = [1, 2];

/** 途中で当たる部材(T の通す部材)と、軸の上の当たる位置。 */
function throughOf(joint: FrameJoint, boxes: ReadonlyMap<string, MemberBox>): { readonly side: FrameJointMember; readonly at: number } | null {
  const side = joint.members.find((member) => member.part === 'side');
  const box = side === undefined ? undefined : boxes.get(side.componentId);
  if (side === undefined || box === undefined) return null;
  return { side, at: dotVec3(subVec3(joint.point, box.member.start), box.axes[2]) };
}

/** 同じ通す部材の同じ位置の反対の面に当たる T を 2 つずつ、十字にまとめる。 */
function mergeCrosses(joints: readonly FrameJoint[], boxes: ReadonlyMap<string, MemberBox>): FrameJoint[] {
  const used = new Set<number>();
  const out: FrameJoint[] = [];
  joints.forEach((joint, index) => {
    if (used.has(index)) return;
    const through = joint.kind === 'T' ? throughOf(joint, boxes) : null;
    const partner = through === null ? -1 : joints.findIndex((other, at) => {
      if (at <= index || used.has(at) || other.kind !== 'T') return false;
      const next = throughOf(other, boxes), face = through.side.face;
      return next !== null && face !== null && next.side.componentId === through.side.componentId && next.side.face === OPPOSITE[face]
        && withinMagnitude(next.at - through.at, FRAME_JOINT_CONTACT_TOLERANCE_MM);
    });
    const other = partner < 0 ? undefined : joints[partner];
    if (through === null || other === undefined) { out.push(joint); return; }
    used.add(partner);
    const members = [through.side, ...[...joint.members, ...other.members].filter((member) => member.part !== 'side')];
    out.push({ id: jointId('cross', members), kind: 'cross', members, point: joint.point });
  });
  return out;
}

/**
 * 部材の全部から接続を作る。外接の箱で先に絞り(x の小さい順に並べて掃く)、残った組だけを向きつきの箱で照らす。
 * 返す並びは、接続の id の順(同じ入力なら同じ並び)。
 */
export function classifyFrameJoints(members: readonly PlacedFrameMember[]): readonly FrameJoint[] {
  const boxes = members.map(boxOf).sort((left, right) => left.min[0] - right.min[0]);
  const byId = new Map(boxes.map((box) => [box.member.componentId, box]));
  const pairs: FrameJoint[] = [];
  boxes.forEach((box, index) => {
    for (const other of boxes.slice(index + 1)) {
      if (other.min[0] - box.max[0] > FRAME_JOINT_CONTACT_TOLERANCE_MM) break;
      if (LATERAL_AXES.some((k) => other.min[k] - box.max[k] > FRAME_JOINT_CONTACT_TOLERANCE_MM
        || box.min[k] - other.max[k] > FRAME_JOINT_CONTACT_TOLERANCE_MM)) continue;
      const joint = classifyPair(box, other);
      if (joint !== null) pairs.push(joint);
    }
  });
  return mergeCrosses(pairs.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)), byId);
}

/** 十字を、通す部材と当てる部材 1 本ずつの T 2 つに分ける(板を付ける・記録を照らす時の接続。ほかの形はそのまま)。 */
export function splitCrossJoints(joints: readonly FrameJoint[]): readonly FrameJoint[] {
  return joints.flatMap((joint): FrameJoint[] => {
    if (joint.kind !== 'cross') return [joint];
    const [through, ...ends] = joint.members;
    if (through === undefined) return [];
    return ends.map((end) => {
      const members = [through, end];
      return { id: jointId('T', members), kind: 'T', members, point: joint.point };
    });
  });
}

/** 接続の記録の状態(E-13): そのまま・板かナット・ボルトが欠けた・部材が無い・接続が見つからない(部材が動いた・長さや行が変わった)。 */
export type FrameJointRecordStatus = 'ok' | 'missingParts' | 'missingMember' | 'jointChanged';

/** 部材の id と当たる所の組の鍵(並びに依らない)。 */
function recordMembersKey(members: readonly { readonly componentId: string; readonly part: string }[]): string {
  return members.map((member) => `${member.componentId}@${member.part}`).sort().join('|');
}

/** 記録の接続を、今の接続(十字は T 2 つに分けた物。`splitCrossJoints`)から、形と部材の id と当たる所が同じ物で探す。無ければ null。 */
export function recordedFrameJoint(record: FrameJointRecord, joints: readonly FrameJoint[]): FrameJoint | null {
  const key = recordMembersKey(record.members);
  return joints.find((joint) => joint.kind === record.kind && recordMembersKey(joint.members) === key) ?? null;
}

/** 記録の状態(部材が無い → 接続が見つからない → 部品が欠けた、の順に見る)。`joints` は十字を分けた今の接続。 */
export function frameJointRecordStatus(document: AssemblyDocument, record: FrameJointRecord, joints: readonly FrameJoint[]):
FrameJointRecordStatus {
  const present = new Set(document.components.map((component) => component.id));
  if (record.members.some((member) => !present.has(member.componentId))) return 'missingMember';
  if (recordedFrameJoint(record, joints) === null) return 'jointChanged';
  return [record.bracket.componentId, ...record.fastenerIds].every((id) => present.has(id)) ? 'ok' : 'missingParts';
}
