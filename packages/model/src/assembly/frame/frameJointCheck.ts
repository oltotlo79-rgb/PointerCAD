/**
 * 接合チェック(E-09。設計 wip/e07-e09-design.md §3・§5.3): 部材どうしの接続(frameJoints)ごとに、留めたかを判定する純関数。
 *
 * 留めた(部品どうしのつながり):
 * - 記録: 締結の記録(`boltedJoints` の first・second の部品)と、手で選んだ締結・溶接(`jointOccurrenceConnections` の bolt・weld の、
 *   2 つの道の先頭の部品)。2 本が直接つながるか、2 本の両方に記録でつながる部材でない部品(ブラケット)がある時。
 * - 溝の締結(記録の無いフレームの溝への締結): ナットが部材の溝の中にあり、ボルトの軸がナットのめねじの軸と同じ直線で、ボルトの頭と
 *   ナットの間の軸の上の中点が、部材でない部品(ブラケット)の箱の中にある時、ブラケットと部材がつながる。
 * - 剛体のまとまり(`rigidGroupId` が同じ): 別の印で数える。合致は数えない(位置を決めるだけで留めていない)。
 * 上限(部材 2,000 本・部品 20,000 個)を超える時は、手で起動した時だけ調べる(黙って一部だけを調べない)。
 */
import { PRODUCT_CATALOG_REGISTRY, type CatalogRegistry } from '../catalog/registry.js';
import { applyPlacementToDirection, applyPlacementToPoint, type RigidPlacement } from '../placementMath.js';
import type { AssemblyDocument } from '../types.js';
import { withinMagnitude } from '../../numericTolerance.js';
import { dotVec3, lengthVec3, scaleVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import { frameJointRecordStatus, splitCrossJoints, type FrameJoint, type FrameJointRecordStatus, type PlacedFrameMember } from './frameJoints.js';
import type { FrameSlotLine } from './frameSlots.js';

/** 上限(統括の決定 2026-11-18 12:3x)。 */
const MEMBER_LIMIT = 2_000;
const COMPONENT_LIMIT = 20_000;
/** ボルトとナットの軸を同じ直線とみなす距離(mm)と、向きの内積の大きさの 1 からの差。置く処理は同じ点から作るので丸めの桁で一致する。 */
const FASTENER_AXIS_TOLERANCE_MM = 0.01;
const FASTENER_DIRECTION_TOLERANCE = 1e-6;
/** 部品の箱の中とみなす余り(mm)。 */
const PART_BOX_TOLERANCE_MM = 0.01;
/** ブラケットを探す点の、部材の外の面からの外への距離(mm。板の厚さ〔資料の板は 2 mm 以上〕より小さく、面の上の丸めより大きい)。 */
const BRACKET_PROBE_MM = 0.5;

/** 溝用のナットとボルト(世界の座標。めねじ・ねじの軸の上の 1 点と、軸の向き)。 */
interface SlotFastenerPart {
  readonly componentId: string;
  readonly kind: 'nut' | 'bolt';
  /** ナット: めねじの軸の上の点(溝の線の上の穴の点から、肩とつばの深さだけ中)。ボルト: 頭の上の面の中心(置く処理の原点)。 */
  readonly point: Vec3;
  /** ナット: めねじの軸の向き。ボルト: 頭から先へ向く軸。どちらも単位の長さ。 */
  readonly axis: Vec3;
}

/** 部材でない部品の、世界の座標の外接の箱(表示のボディから作る。無い部品は位置の判定に使わない)。 */
export interface PartBox {
  readonly min: Vec3;
  readonly max: Vec3;
}

interface FrameJointCheckInput {
  readonly document: AssemblyDocument;
  readonly members: readonly PlacedFrameMember[];
  readonly joints: readonly FrameJoint[];
  readonly fasteners: readonly SlotFastenerPart[];
  readonly partBoxes: ReadonlyMap<string, PartBox>;
  /** 手で起動した時は上限を超えても調べる。 */
  readonly force?: boolean;
}

/** 接続の留め方: 記録・溝の締結・剛体のまとまり・片側だけ(十字の 2 組のうち 1 組だけ)・留めていない。 */
export type FrameJointFastening = 'recorded' | 'slot' | 'rigidGroup' | 'oneSided' | 'none';

interface FrameJointStatus {
  readonly joint: FrameJoint;
  readonly fastening: FrameJointFastening;
}

/** 部品が欠けた・部材が無い・接続が見つからない記録(E-13。一覧から作り直すか、記録を外す)。 */
interface BrokenFrameJointRecord {
  readonly id: string;
  readonly status: Exclude<FrameJointRecordStatus, 'ok'>;
}

export type FrameJointCheckResult =
  | { readonly ok: true; readonly statuses: readonly FrameJointStatus[]; readonly unfastenedMembers: readonly string[];
    readonly brokenRecords: readonly BrokenFrameJointRecord[] }
  | { readonly ok: false; readonly reason: 'tooManyMembers' | 'tooManyComponents'; readonly count: number; readonly limit: number };

/**
 * 溝用のナットとボルトの族の id(族の表は遅れて読み込むので、族の定義を静的に読まずに id で見分ける。frameSlotFastening と同じ考え方)。
 * ナットのめねじの軸は、部品の局所 x = holeOffset − 長さ / 2(holeOffset が無い行は中央)を通る局所 +Z。ボルトは置く処理の原点(頭の上の面の中心)を
 * 通る局所 +Z(頭から先へ)。どちらも置く処理(frameSlotFastening の nutPlacement・fastenerPlacements の placementOnAxis)の決まり。
 */
const SLOT_NUT_FAMILY_IDS: ReadonlySet<string> = new Set(['t-slot-nut']);
const BOLT_FAMILY_IDS: ReadonlySet<string> = new Set(['socket-head-cap-screw', 'countersunk-socket-screw']);

/** 組立の溝用のナットとボルト(抑制した部品は入れない。隠した部品は、あるので入れる)。配置は表示中の配置を渡す。 */
export function slotFastenerParts(document: AssemblyDocument, placements: ReadonlyMap<string, RigidPlacement>,
  registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY): readonly SlotFastenerPart[] {
  return document.components.flatMap((component): SlotFastenerPart[] => {
    const source = component.source, placement = placements.get(component.id);
    if (source.kind !== 'standardPart' || source.catalog !== 'catalogItem' || placement === undefined || component.suppressed) return [];
    const familyId = source.options.family ?? '';
    const axis = applyPlacementToDirection(placement, [0, 0, 1]);
    if (BOLT_FAMILY_IDS.has(familyId)) return [{ componentId: component.id, kind: 'bolt', point: applyPlacementToPoint(placement, [0, 0, 0]), axis }];
    if (!SLOT_NUT_FAMILY_IDS.has(familyId)) return [];
    const row = registry.loaded(familyId)?.rows.find((candidate) => candidate.key === source.options.item);
    const length = row?.dims.length;
    if (row === undefined || length === undefined) return [];
    const offset = (Object.hasOwn(row.dims, 'holeOffset') ? row.dims.holeOffset : undefined) ?? length / 2;
    return [{ componentId: component.id, kind: 'nut', point: applyPlacementToPoint(placement, [offset - length / 2, 0, 0]), axis }];
  });
}

type LinkKind = 'recorded' | 'slot';
/** 部品どうしのつながり(向きの無い辺。同じ組に記録と溝の締結の両方があれば記録)。 */
type Links = Map<string, Map<string, LinkKind>>;

function addDirected(links: Links, from: string, to: string, kind: LinkKind): void {
  const row = links.get(from) ?? new Map<string, LinkKind>();
  if (row.get(to) !== 'recorded') row.set(to, kind);
  links.set(from, row);
}

function addLink(links: Links, a: string, b: string, kind: LinkKind): void {
  if (a === b) return;
  addDirected(links, a, b, kind);
  addDirected(links, b, a, kind);
}

/**
 * 記録のつながり: 締結の記録の 2 つの部品、手で選んだ締結・溶接の 2 つの道の先頭の部品。締結部品の自動判別の記録は、状態がそのまま
 * (部材・板・ナット・ボルトが全部あり、記録の接続が今もある)で、板・ナット・ボルトを抑制していない物だけを数え、そうでない記録を返す。
 */
function addRecordedLinks(document: AssemblyDocument, joints: readonly FrameJoint[], links: Links): readonly BrokenFrameJointRecord[] {
  for (const record of document.boltedJoints ?? []) addLink(links, record.first.componentId, record.second.componentId, 'recorded');
  for (const connection of document.jointOccurrenceConnections ?? []) {
    addLink(links, connection.firstPath[0], connection.secondPath[0], 'recorded');
  }
  const bracketable = splitCrossJoints(joints);
  const active = new Set(document.components.filter((component) => !component.suppressed).map((component) => component.id));
  const broken: BrokenFrameJointRecord[] = [];
  for (const record of document.frameJoints ?? []) {
    const status = frameJointRecordStatus(document, record, bracketable);
    if (status !== 'ok') { broken.push({ id: record.id, status }); continue; }
    if (![record.bracket.componentId, ...record.fastenerIds].every((id) => active.has(id))) continue;
    for (const member of record.members) addLink(links, record.bracket.componentId, member.componentId, 'recorded');
  }
  return broken;
}

/** 点 `point` から、点 `origin` を通る向き `axis`(単位)の直線までの距離。 */
function distanceToLine(point: Vec3, origin: Vec3, axis: Vec3): number {
  const gap = subVec3(point, origin);
  return lengthVec3(subVec3(gap, scaleVec3(axis, dotVec3(gap, axis))));
}

/** ナットのめねじの軸の点が溝の線の中にあるか(横は口の幅の半分以内、深さは口から部屋の底まで、長さの向きは線の内)。 */
function nutInSlot(nut: SlotFastenerPart, line: FrameSlotLine): boolean {
  const along = subVec3(line.end, line.start), length = lengthVec3(along);
  if (!(length > 0)) return false;
  const gap = subVec3(nut.point, line.start);
  const at = dotVec3(gap, scaleVec3(along, 1 / length)), lateral = dotVec3(gap, line.across), depth = dotVec3(gap, line.inward);
  return at >= -FASTENER_AXIS_TOLERANCE_MM && at <= length + FASTENER_AXIS_TOLERANCE_MM
    && withinMagnitude(lateral, line.opening / 2 + FASTENER_AXIS_TOLERANCE_MM)
    && depth >= -FASTENER_AXIS_TOLERANCE_MM && depth <= line.shoulder + line.slotDepth + FASTENER_AXIS_TOLERANCE_MM;
}

function insideBox(point: Vec3, box: PartBox): boolean {
  const [x, y, z] = point, [minX, minY, minZ] = box.min, [maxX, maxY, maxZ] = box.max;
  const inside = (value: number, low: number, high: number): boolean =>
    value >= low - PART_BOX_TOLERANCE_MM && value <= high + PART_BOX_TOLERANCE_MM;
  return inside(x, minX, maxX) && inside(y, minY, maxY) && inside(z, minZ, maxZ);
}

/** 溝のナットの持ち主の部材と、その溝の線。 */
function slotOwner(nut: SlotFastenerPart, members: readonly PlacedFrameMember[]):
{ readonly member: PlacedFrameMember; readonly line: FrameSlotLine } | null {
  for (const member of members) {
    const line = member.slotLines.find((candidate) => nutInSlot(nut, candidate));
    if (line !== undefined) return { member, line };
  }
  return null;
}

/**
 * 溝の締結のつながり: 部材の溝の中のナットと同じ軸のボルトがあり、ボルトの軸が部材の外の面を通る点から外へ `BRACKET_PROBE_MM` の点が、
 * 部材でない部品の箱の中にある時、その部品(ブラケット)と部材をつなぐ。
 */
function addSlotLinks(input: FrameJointCheckInput, memberIds: ReadonlySet<string>, links: Links): void {
  const bolts = input.fasteners.filter((part) => part.kind === 'bolt');
  for (const nut of input.fasteners.filter((part) => part.kind === 'nut')) {
    const owner = slotOwner(nut, input.members);
    if (owner === null) continue;
    const surface = subVec3(nut.point, scaleVec3(owner.line.inward, dotVec3(subVec3(nut.point, owner.line.start), owner.line.inward)));
    const probe = subVec3(surface, scaleVec3(owner.line.inward, BRACKET_PROBE_MM));
    for (const bolt of bolts) {
      if (!withinMagnitude(1 - Math.abs(dotVec3(bolt.axis, nut.axis)), FASTENER_DIRECTION_TOLERANCE)
        || !withinMagnitude(distanceToLine(nut.point, bolt.point, bolt.axis), FASTENER_AXIS_TOLERANCE_MM)) continue;
      for (const [componentId, box] of input.partBoxes) {
        if (memberIds.has(componentId) || componentId === bolt.componentId || componentId === nut.componentId) continue;
        if (insideBox(probe, box)) addLink(links, componentId, owner.member.componentId, 'slot');
      }
    }
  }
}

/** 2 本の部材の留め方(直接のつながりか、部材でない部品を 1 つ挟むつながり。記録だけの道があれば記録)。 */
function pairFastening(a: string, b: string, links: Links, memberIds: ReadonlySet<string>, groups: ReadonlyMap<string, string>):
FrameJointFastening {
  const fromA = links.get(a) ?? new Map<string, LinkKind>();
  let best: LinkKind | null = fromA.get(b) ?? null;
  for (const [middle, first] of fromA) {
    const second = memberIds.has(middle) ? undefined : links.get(middle)?.get(b);
    if (second === undefined || best === 'recorded') continue;
    best = first === 'recorded' && second === 'recorded' ? 'recorded' : 'slot';
  }
  if (best !== null) return best;
  const group = groups.get(a);
  return group !== undefined && group === groups.get(b) ? 'rigidGroup' : 'none';
}

/** 弱い順(まとめた留め方は、組の中で一番弱い物)。 */
const STRENGTH: readonly FrameJointFastening[] = ['rigidGroup', 'slot', 'recorded'];

/** 接続の留め方と、留めた部材。十字は通す部材と当てる 2 本の 2 組を見て、両方なら弱い方、片方だけなら片側だけ。 */
function jointStatus(joint: FrameJoint, links: Links, memberIds: ReadonlySet<string>, groups: ReadonlyMap<string, string>):
{ readonly fastening: FrameJointFastening; readonly fastenedMembers: readonly string[] } {
  const [first, ...others] = joint.members;
  if (first === undefined) return { fastening: 'none', fastenedMembers: [] };
  const pairs = others.map((other) => ({ other: other.componentId,
    fastening: pairFastening(first.componentId, other.componentId, links, memberIds, groups) }));
  const fastened = pairs.filter((pair) => pair.fastening !== 'none');
  const fastenedMembers = fastened.length === 0 ? [] : [first.componentId, ...fastened.map((pair) => pair.other)];
  if (fastened.length === 0) return { fastening: 'none', fastenedMembers };
  if (fastened.length < pairs.length) return { fastening: 'oneSided', fastenedMembers };
  return { fastening: STRENGTH.find((kind) => fastened.some((pair) => pair.fastening === kind)) ?? 'none', fastenedMembers };
}

/** 接合チェック。上限を超え、手で起動していない時は、調べずに理由を返す。 */
export function checkFrameJoints(input: FrameJointCheckInput): FrameJointCheckResult {
  if (input.force !== true && input.members.length > MEMBER_LIMIT) {
    return { ok: false, reason: 'tooManyMembers', count: input.members.length, limit: MEMBER_LIMIT };
  }
  if (input.force !== true && input.document.components.length > COMPONENT_LIMIT) {
    return { ok: false, reason: 'tooManyComponents', count: input.document.components.length, limit: COMPONENT_LIMIT };
  }
  const memberIds = new Set(input.members.map((member) => member.componentId));
  const links: Links = new Map();
  const brokenRecords = addRecordedLinks(input.document, input.joints, links);
  addSlotLinks(input, memberIds, links);
  const groups = new Map(input.document.components.flatMap((component): (readonly [string, string])[] =>
    (component.rigidGroupId === undefined || component.rigidGroupId === '' || component.suppressed ? [] : [[component.id, component.rigidGroupId]])));
  const fastenedMembers = new Set<string>();
  const statuses = input.joints.map((joint): FrameJointStatus => {
    const status = jointStatus(joint, links, memberIds, groups);
    status.fastenedMembers.forEach((id) => fastenedMembers.add(id));
    return { joint, fastening: status.fastening };
  });
  const touched = new Set(input.joints.flatMap((joint) => joint.members.map((member) => member.componentId)));
  return { ok: true, statuses, unfastenedMembers: [...touched].filter((id) => !fastenedMembers.has(id)).sort(), brokenRecords };
}
