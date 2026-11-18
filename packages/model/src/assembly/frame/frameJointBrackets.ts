/**
 * 締結部品の自動判別(E-07。設計 wip/e07-e09-design.md §2・§5): 部材どうしの接続(frameJoints)に合うブラケットの候補を族の表の値から作り、
 * 選んだ候補で、ブラケットと溝用のナット・ボルトを置く計画と、接続の記録を作る純関数。
 *
 * - L・T: 端で当たる部材(当てる部材)の側の面と、当たられる部材の面がなす内側の角に、L 形のブラケット(寝た脚 a・立つ脚 b)を置く。
 *   内側の角は、当たられる面の上で当てる部材の面の外へ、ブラケットの脚が乗る余りがある所だけ。脚の向きは 2 つ(a を当たられる面に、
 *   または a を当てる部材の面に)。幅は両方の面に収まり、面の中央に置く。
 * - 突き合わせ: 同じ直線の 2 本の、同じ向きの外の面に、平板のブラケットを接続の点の中央に置く。
 * - 板の行の溝幅(record.slot)は、穴の当たる面の溝の呼び(線の nominalWidth → 行の slotWidth)と同じ物だけ。片脚に穴の無い行は候補にしない。
 * - ボルトの呼びの既定: 板の穴の径が通し穴の径の表(CLEARANCE_EVIDENCE、1〜3 級)の範囲に入る呼びがちょうど 1 つで、その溝幅・入れ方・材質の
 *   溝用のナットの行にその呼びがある時だけ(出どころを書ける物だけ。統括の決定 2026-11-18 12:3x)。決まらない時は利用者が選ぶ。
 * - 穴の選択は、族の表の穴の値から部品の座標で作る(形〔kernel〕を待たない)。ナットとボルトは今のフレームの溝への締結の計画(planFrameSlotHoles)で選ぶ。
 * - 当て推量で選ばない: 候補を並べて返し、確定する候補は呼ぶ側(利用者)が決める。
 */
import { expressionValueFromNumber } from '@pointercad/expression';

import type { AngleBracketRecord, FlatPlateRecord, TSlotNutRecord } from '../catalog/families/framePartCatalog.js';
import { createCatalogItemSource } from '../catalog/source.js';
import type { CatalogFamily } from '../catalog/types.js';
import { addComponent, createComponentFor } from '../assemblyEdit.js';
import { CLEARANCE_EVIDENCE } from '../fastening/clearanceEvidence.js';
import { applyFrameSlotFastening, type FrameSlotCandidate, type FrameSlotFasteningResult } from '../fastening/frameSlotFastening.js';
import { planFrameSlotHoles } from '../fastening/frameSlotRequest.js';
import { componentSourceKey } from '../fastening/frames.js';
import type { EntryHoleSelection } from '../fastening/holeEntryTypes.js';
import { quaternionFromBasis, type RigidPlacement } from '../placementMath.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import { withinMagnitude } from '../../numericTolerance.js';
import { addVec3, crossVec3, dotVec3, lengthVec3, normalizeVec3, scaleVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import type { FrameJointFace, FrameJointRecord } from './frameJointRecord.js';
import type { FrameJoint, PlacedFrameMember } from './frameJoints.js';

/** 面と面が当たるとみなす距離(mm)・向きがそろうとみなす内積の 1 からの差・長さの比べの余り(mm)。frameJoints と同じ値。 */
const CONTACT_TOLERANCE_MM = 0.01;
const AXIS_TOLERANCE = 1e-6;
const LENGTH_TOLERANCE_MM = 0.01;
/** 接続の記録を保存できる最小の保存形式の版(io の codecs/frameJointRecords.ts と同じ値)。 */
const FRAME_JOINTS_SCHEMA_VERSION = 23;
/** ブラケットの族の id(族の表は遅れて読み込むので、族の定義を静的に読まない)。 */
const ANGLE_FAMILY_ID = 't-slot-angle-bracket';
const PLATE_FAMILY_ID = 't-slot-flat-plate';

type Face = FrameJointFace;
const FACES: readonly Face[] = ['top', 'left', 'bottom', 'right'];

/** 板の行の表(L 形のブラケットと平板。遅れて読む)。 */
export interface JointBracketRecords {
  readonly angles: readonly AngleBracketRecord[];
  readonly plates: readonly FlatPlateRecord[];
}

/** L 形のブラケットと平板の行の表を、必要な時だけ読む(静的に読むと族の遅れた読み込みが効かなくなる)。 */
export async function loadJointBracketRecords(): Promise<JointBracketRecords> {
  const [rows, hard] = await Promise.all([import('../catalog/families/framePartRows.js'), import('../catalog/families/hardBracketRows.js')]);
  return { angles: [...rows.ANGLE_BRACKET_RECORDS, ...hard.HARD_BRACKET_RECORDS], plates: rows.FLAT_PLATE_RECORDS };
}

// ---- 部材の面の幾何(局所 +Y が上、+X が右。外形の範囲は軸からの局所の座標) ----

function axisOf(member: PlacedFrameMember): Vec3 {
  return normalizeVec3(subVec3(member.end, member.start));
}

function lengthOf(member: PlacedFrameMember): number {
  return lengthVec3(subVec3(member.end, member.start));
}

function faceNormal(member: PlacedFrameMember, face: Face): Vec3 {
  return face === 'top' ? member.yAxis : face === 'bottom' ? scaleVec3(member.yAxis, -1) : face === 'right' ? member.xAxis : scaleVec3(member.xAxis, -1);
}

function faceAcross(member: PlacedFrameMember, face: Face): Vec3 {
  return face === 'top' || face === 'bottom' ? member.xAxis : member.yAxis;
}

/** 面の平面の、軸からの外向きの距離。 */
function faceOffset(member: PlacedFrameMember, face: Face): number {
  const { minX, maxX, minY, maxY } = member.bounds;
  return face === 'top' ? maxY : face === 'bottom' ? -minY : face === 'right' ? maxX : -minX;
}

function faceAcrossRange(member: PlacedFrameMember, face: Face): readonly [number, number] {
  const { minX, maxX, minY, maxY } = member.bounds;
  return face === 'top' || face === 'bottom' ? [minX, maxX] : [minY, maxY];
}

/** 面の、軸の向きの位置 `at`(始点から)での幅の中央の点。 */
function faceCenter(member: PlacedFrameMember, face: Face, at: number): Vec3 {
  const [low, high] = faceAcrossRange(member, face);
  return addVec3(addVec3(member.start, scaleVec3(axisOf(member), at)),
    addVec3(scaleVec3(faceNormal(member, face), faceOffset(member, face)), scaleVec3(faceAcross(member, face), (low + high) / 2)));
}

/** 面の長方形を向き `direction` へ写した範囲。 */
function faceRange(member: PlacedFrameMember, face: Face, direction: Vec3): readonly [number, number] {
  const [low, high] = faceAcrossRange(member, face);
  const base = addVec3(member.start, scaleVec3(faceNormal(member, face), faceOffset(member, face)));
  const values = [0, lengthOf(member)].flatMap((at) => [low, high].map((across) =>
    dotVec3(addVec3(addVec3(base, scaleVec3(axisOf(member), at)), scaleVec3(faceAcross(member, face), across)), direction)));
  return [Math.min(...values), Math.max(...values)];
}

// ---- 当てる部材と当たられる部材 ----

/** 端で当たる部材(当てる部材)の端の面が、相手の外の面に当たる所。 */
interface ButtingContact {
  readonly butting: PlacedFrameMember;
  readonly end: 'start' | 'end';
  readonly base: PlacedFrameMember;
  readonly baseFace: Face;
}

function buttingContact(butting: PlacedFrameMember, end: 'start' | 'end', base: PlacedFrameMember): ButtingContact | null {
  const point = end === 'start' ? butting.start : butting.end;
  const outward = end === 'start' ? scaleVec3(axisOf(butting), -1) : axisOf(butting);
  const face = FACES.find((candidate) => {
    const normal = faceNormal(base, candidate);
    return withinMagnitude(1 + dotVec3(normal, outward), AXIS_TOLERANCE)
      && withinMagnitude(dotVec3(subVec3(point, base.start), normal) - faceOffset(base, candidate), CONTACT_TOLERANCE_MM);
  });
  return face === undefined ? null : { butting, end, base, baseFace: face };
}

function contactOf(joint: FrameJoint, members: ReadonlyMap<string, PlacedFrameMember>): ButtingContact | null {
  for (const own of joint.members) {
    const butting = members.get(own.componentId);
    if (butting === undefined || own.part === 'side') continue;
    for (const other of joint.members) {
      const base = other.componentId === own.componentId ? undefined : members.get(other.componentId);
      const contact = base === undefined ? null : buttingContact(butting, own.part, base);
      if (contact !== null) return contact;
    }
  }
  return null;
}

// ---- 候補 ----

type JointBracketRejection ='noRoom' | 'tooWide' | 'noGroove' | 'slotMismatch' | 'slotUnknown' | 'nominalNeeded' | 'badBasis';

/** 板の 1 つの置き方(族・行の鍵・向き・どの面に乗るか・置く配置)。 */
interface JointBracketPlacement {
  readonly familyId: string;
  readonly key: string;
  readonly orientation: 'aOnBase' | 'aOnButting' | 'plate';
  /** 板が乗る面(L 形は [当たられる面, 当てる部材の面]、平板は [当てる部材の面, 当たられる部材の面])。 */
  readonly faces: readonly { readonly componentId: string; readonly face: Face }[];
  readonly placement: RigidPlacement;
  readonly holes: readonly LocalHole[];
}

/** 部品の座標の通し穴(合わせ面の上の点・板の中へ向く軸・径・長さ)。 */
interface LocalHole {
  readonly origin: Vec3;
  readonly into: Vec3;
  readonly diameter: number;
  readonly length: number;
}

/** 候補 1 つ: 置き方と、使う呼び、計画の結果(断る時は理由)。 */
export interface JointBracketChoice {
  readonly bracket: JointBracketPlacement;
  readonly nominal: string | null;
  readonly result: FrameSlotFasteningResult | { readonly ok: false; readonly reason: JointBracketRejection };
}

export interface JointBracketChoices {
  readonly nominal: string | null;
  readonly nutEntry: string;
  readonly nutMaterial: string;
}

export interface JointBracketInputs {
  readonly joint: FrameJoint;
  readonly members: ReadonlyMap<string, PlacedFrameMember>;
  readonly frames: readonly FrameSlotCandidate[];
  readonly records: JointBracketRecords;
  readonly families: { readonly angle: CatalogFamily; readonly plate: CatalogFamily };
  readonly choices: JointBracketChoices;
  readonly nutFamily: CatalogFamily;
  readonly nutRecords: readonly TSlotNutRecord[];
  readonly partRevisions: ReadonlyMap<string, string>;
}

/** 板の穴の径から決まるボルトの呼び(通し穴の径の表で 1 つに決まり、溝用のナットの行にある時だけ。決まらなければ null)。 */
function defaultJointBoltNominal(holeDiameter: number, slot: number, choices: Pick<JointBracketChoices, 'nutEntry' | 'nutMaterial'>,
  nutRecords: readonly TSlotNutRecord[]): string | null {
  const matches = CLEARANCE_EVIDENCE.filter((row) => row.verified && holeDiameter >= row.minimumHoleDiameter && holeDiameter <= row.maximumHoleDiameter);
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only === undefined) return null;
  return nutRecords.some((record) => record.slot === slot && record.entry === choices.nutEntry && record.material === choices.nutMaterial
    && record.thread === only.nominal) ? only.nominal : null;
}

/** 面の溝の呼び(線の nominalWidth → 行の slotWidth)が `slot` の溝の線があるか。理由は、溝が無い・呼びが決まらない・違う。 */
function grooveRejection(frames: readonly FrameSlotCandidate[], componentId: string, face: Face, slot: number): JointBracketRejection | null {
  const frame = frames.find((candidate) => candidate.componentId === componentId);
  const lines = frame?.lines.filter((line) => line.face === face) ?? [];
  if (frame === undefined || lines.length === 0) return 'noGroove';
  const nominals = lines.map((line) => (line.nominalWidth === undefined ? frame.slotWidth : line.nominalWidth));
  if (nominals.includes(slot)) return null;
  return nominals.every((nominal) => nominal === null) ? 'slotUnknown' : 'slotMismatch';
}

function placementFromBasis(origin: Vec3, x: Vec3, y: Vec3, z: Vec3): RigidPlacement | null {
  const rotation = quaternionFromBasis(x, y, z, 1e-9);
  return rotation === null ? null : { position: origin, rotation };
}

/** L 形のブラケットの穴(寝た脚 a は軸 +y で y = 0 の面から、立つ脚 b は軸 +x で x = 0 の面から。厚さだけ通す)。 */
function angleHoles(record: AngleBracketRecord): readonly LocalHole[] {
  const base = { diameter: record.holeDiameter, length: record.thickness };
  return [
    ...record.alongA.flatMap((x) => record.acrossA.map((z): LocalHole => ({ ...base, origin: [x, 0, z], into: [0, 1, 0] }))),
    ...record.alongB.flatMap((y) => record.acrossB.map((z): LocalHole => ({ ...base, origin: [0, y, z], into: [1, 0, 0] }))),
  ];
}

/** L・T の内側の角 1 つ(当てる部材の面と、その面の外の当たられる面の余り)。 */
interface InnerCorner {
  readonly face: Face;
  /** 内側の角の稜線の上で、当てる部材の面の幅の中央の点。 */
  readonly corner: Vec3;
  /** 当たられる面の上で当てる部材から離れる向き(寝た脚の向き)と、当てる部材に沿って当たられる面から離れる向き(立つ脚の向き)。 */
  readonly alongBase: Vec3;
  readonly alongButting: Vec3;
  readonly room: number;
}

function innerCorners(contact: ButtingContact): readonly InnerCorner[] {
  const alongButting = faceNormal(contact.base, contact.baseFace);
  const at = contact.end === 'start' ? 0 : lengthOf(contact.butting);
  return FACES.flatMap((face): InnerCorner[] => {
    const alongBase = faceNormal(contact.butting, face);
    const plane = dotVec3(contact.butting.start, alongBase) + faceOffset(contact.butting, face);
    const room = faceRange(contact.base, contact.baseFace, alongBase)[1] - plane;
    return room > LENGTH_TOLERANCE_MM ? [{ face, corner: faceCenter(contact.butting, face, at), alongBase, alongButting, room }] : [];
  });
}

/** L 形のブラケットを内側の角に置く配置(脚が乗らない・幅が収まらない時は理由)。 */
function angleOnCorner(record: AngleBracketRecord, contact: ButtingContact, corner: InnerCorner, aOnBase: boolean):
JointBracketPlacement | JointBracketRejection {
  const legOnBase = aOnBase ? record.legA : record.legB, legOnButting = aOnBase ? record.legB : record.legA;
  if (legOnBase > corner.room + LENGTH_TOLERANCE_MM || legOnButting > lengthOf(contact.butting) + LENGTH_TOLERANCE_MM) return 'noRoom';
  const x = aOnBase ? corner.alongBase : corner.alongButting, y = aOnBase ? corner.alongButting : corner.alongBase, z = crossVec3(x, y);
  const center = dotVec3(corner.corner, z), half = record.width / 2;
  const [buttingLow, buttingHigh] = faceRange(contact.butting, corner.face, z), [baseLow, baseHigh] = faceRange(contact.base, contact.baseFace, z);
  if (center - half < Math.max(buttingLow, baseLow) - LENGTH_TOLERANCE_MM || center + half > Math.min(buttingHigh, baseHigh) + LENGTH_TOLERANCE_MM) {
    return 'tooWide';
  }
  const placement = placementFromBasis(subVec3(corner.corner, scaleVec3(z, half)), x, y, z);
  if (placement === null) return 'badBasis';
  const faces = [{ componentId: contact.base.componentId, face: contact.baseFace }, { componentId: contact.butting.componentId, face: corner.face }];
  return { familyId: ANGLE_FAMILY_ID, key: record.key, orientation: aOnBase ? 'aOnBase' : 'aOnButting', faces: aOnBase ? faces : [...faces].reverse(),
    placement, holes: angleHoles(record) };
}

/** 突き合わせの 2 本の同じ向きの外の面に、平板を接続の点の中央に置く配置。 */
function plateOnButt(record: FlatPlateRecord, contact: ButtingContact, face: Face): JointBracketPlacement | JointBracketRejection {
  const x = axisOf(contact.butting), z = faceNormal(contact.butting, face), y = crossVec3(z, x);
  const half = record.length / 2;
  if (half > lengthOf(contact.butting) + LENGTH_TOLERANCE_MM || half > lengthOf(contact.base) + LENGTH_TOLERANCE_MM) return 'noRoom';
  const [low, high] = faceAcrossRange(contact.butting, face);
  if (record.width > high - low + LENGTH_TOLERANCE_MM) return 'tooWide';
  const placement = placementFromBasis(faceCenter(contact.butting, face, contact.end === 'start' ? 0 : lengthOf(contact.butting)), x, y, z);
  if (placement === null) return 'badBasis';
  const holes = record.holesX.flatMap((hx) => record.holesY.map((hy): LocalHole => ({ origin: [hx - record.length / 2, hy - record.width / 2, 0],
    into: [0, 0, 1], diameter: record.holeDiameter, length: record.thickness })));
  return { familyId: PLATE_FAMILY_ID, key: record.key, orientation: 'plate',
    faces: [{ componentId: contact.butting.componentId, face }, { componentId: contact.base.componentId, face }], placement, holes };
}

/** 突き合わせの当たり(同じ直線の 2 本の端どうし。当たられる部材の面の名前は使わない)。 */
function buttContact(joint: FrameJoint, members: ReadonlyMap<string, PlacedFrameMember>): ButtingContact | null {
  const [first, second] = joint.members;
  const butting = first === undefined ? undefined : members.get(first.componentId), base = second === undefined ? undefined : members.get(second.componentId);
  if (first === undefined || butting === undefined || base === undefined || first.part === 'side') return null;
  return { butting, end: first.part, base, baseFace: 'top' };
}

/** 置き方の候補(溝の呼びの合わない物・寸法の合わない物は理由つき)。 */
function placementsOf(inputs: JointBracketInputs): readonly { readonly slot: number; readonly holeDiameter: number;
  readonly bracket: JointBracketPlacement | JointBracketRejection; readonly key: string; readonly familyId: string }[] {
  const { joint, members, records } = inputs;
  if (joint.kind === 'L' || joint.kind === 'T') {
    const contact = contactOf(joint, members);
    if (contact === null) return [];
    const usable = records.angles.filter((record) => record.alongA.length > 0 && record.acrossA.length > 0 && record.alongB.length > 0
      && record.acrossB.length > 0);
    return innerCorners(contact).flatMap((corner) => usable.flatMap((record) => [true, false].map((aOnBase) =>
      ({ slot: record.slot, holeDiameter: record.holeDiameter, key: record.key, familyId: ANGLE_FAMILY_ID,
        bracket: angleOnCorner(record, contact, corner, aOnBase) }))));
  }
  if (joint.kind === 'butt') {
    const contact = buttContact(joint, members);
    if (contact === null) return [];
    return FACES.flatMap((face) => records.plates.map((record) => ({ slot: record.slot, holeDiameter: record.holeDiameter, key: record.key,
      familyId: PLATE_FAMILY_ID, bracket: plateOnButt(record, contact, face) })));
  }
  return [];
}

/** ブラケットの部品(選んだ行・置き方)を作る。 */
function bracketComponent(document: AssemblyDocument, family: CatalogFamily, bracket: JointBracketPlacement): AssemblyComponent | null {
  const row = family.rows.find((candidate) => candidate.key === bracket.key);
  if (row === undefined) return null;
  const [x, y, z] = bracket.placement.position;
  return createComponentFor(document, createCatalogItemSource(family, row, {}), { partName: family.partName(row, {}),
    placement: { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)],
      rotation: bracket.placement.rotation } });
}

/** 置いたブラケットの穴の選択(部品の座標。合わせ面の参照は記録に残さない締結なので、指紋だけの仮の参照)。 */
function holeSelections(component: AssemblyComponent, bracket: JointBracketPlacement, partRevisions: ReadonlyMap<string, string>):
readonly EntryHoleSelection[] | null {
  const sourceKey = componentSourceKey(component, partRevisions);
  if (sourceKey === null) return null;
  return bracket.holes.map((hole, index): EntryHoleSelection => {
    const normal = scaleVec3(hole.into, -1);
    const matingFace: SubShapeRef = { bodyFeatureId: component.id, index, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1,
      position: hole.origin, axis: normal, radius: null } };
    return { componentId: component.id, sourceKey, holeFeatureId: `${bracket.key}#${String(index)}`, matingFace,
      hole: { kind: 'clearance', diameter: hole.diameter, length: hole.length }, axisOrigin: hole.origin, axisDirection: hole.into,
      matingFaceNormal: normal };
  });
}

/** 1 つの置き方の計画(ブラケットの部品を作り、それを足した文書の写しで、穴ごとに溝用のナットとボルトを選ぶ)。 */
function planPlacement(document: AssemblyDocument, inputs: JointBracketInputs, bracket: JointBracketPlacement, nominal: string):
{ readonly component: AssemblyComponent | null; readonly result: FrameSlotFasteningResult } {
  const family = bracket.familyId === ANGLE_FAMILY_ID ? inputs.families.angle : inputs.families.plate;
  const component = bracketComponent(document, family, bracket);
  const holes = component === null ? null : holeSelections(component, bracket, inputs.partRevisions);
  if (component === null || holes === null) return { component: null, result: { ok: false, failures: [] } };
  return { component, result: planFrameSlotHoles(addComponent(document, component), { holes, frames: inputs.frames,
    choices: { nominal, nutEntry: inputs.choices.nutEntry, nutMaterial: inputs.choices.nutMaterial },
    nutFamily: inputs.nutFamily, nutRecords: inputs.nutRecords, partRevisions: inputs.partRevisions }) };
}

/**
 * 接続に合う板の候補の全部(合わない物も理由つきで並べる)。並びは、通る物を先に、同じ中は脚(平板は長さ)の短い順 → 行の鍵の順
 * (並びは見せるための物で、選ぶのは利用者)。
 */
export function jointBracketChoices(document: AssemblyDocument, inputs: JointBracketInputs): readonly JointBracketChoice[] {
  const choices = placementsOf(inputs).flatMap((item): JointBracketChoice[] => {
    if (typeof item.bracket === 'string') return [];
    const bracket = item.bracket;
    const groove = bracket.faces.map((face) => grooveRejection(inputs.frames, face.componentId, face.face, item.slot)).find((reason) => reason !== null);
    const nominal = inputs.choices.nominal ?? defaultJointBoltNominal(item.holeDiameter, item.slot, inputs.choices, inputs.nutRecords);
    if (groove !== undefined && groove !== null) return [{ bracket, nominal, result: { ok: false, reason: groove } }];
    if (nominal === null) return [{ bracket, nominal, result: { ok: false, reason: 'nominalNeeded' } }];
    return [{ bracket, nominal, result: planPlacement(document, inputs, bracket, nominal).result }];
  });
  const size = (choice: JointBracketChoice): number => {
    const angle = inputs.records.angles.find((record) => record.key === choice.bracket.key && choice.bracket.familyId === ANGLE_FAMILY_ID);
    const plate = inputs.records.plates.find((record) => record.key === choice.bracket.key && choice.bracket.familyId === PLATE_FAMILY_ID);
    return angle !== undefined ? Math.max(angle.legA, angle.legB) : plate?.length ?? Number.POSITIVE_INFINITY;
  };
  return [...choices].sort((left, right) => Number(!left.result.ok) - Number(!right.result.ok) || size(left) - size(right)
    || (left.bracket.key < right.bracket.key ? -1 : left.bracket.key > right.bracket.key ? 1 : 0));
}

/**
 * 選んだ候補を確定する: 同じ入力で計画を作り直し、通った時だけ、ブラケット・溝用のナット・ボルトの部品と接続の記録を 1 回の文書で足す
 * (Undo 1 回)。計画が通らない時は、文書を変えずに理由を返す。
 */
export function applyJointBracket(document: AssemblyDocument, inputs: JointBracketInputs, choice: JointBracketChoice):
{ readonly ok: true; readonly document: AssemblyDocument; readonly componentIds: readonly string[]; readonly record: FrameJointRecord }
| { readonly ok: false; readonly result: JointBracketChoice['result'] } {
  const kind = inputs.joint.kind;
  if (choice.nominal === null || (kind !== 'L' && kind !== 'T' && kind !== 'butt')) return { ok: false, result: choice.result };
  const { component, result: planned } = planPlacement(document, inputs, choice.bracket, choice.nominal);
  if (component === null || !planned.ok) return { ok: false, result: planned };
  const fastened = applyFrameSlotFastening(addComponent(document, component), planned.entries);
  const record: FrameJointRecord = { id: `frame-joint:${inputs.joint.id}:${component.id}`, kind,
    members: inputs.joint.members.map((member) => ({ componentId: member.componentId, part: member.part })),
    bracket: { componentId: component.id, orientation: choice.bracket.orientation, faces: choice.bracket.faces },
    fastenerIds: fastened.componentIds, choices: { nominal: choice.nominal, nutEntry: inputs.choices.nutEntry, nutMaterial: inputs.choices.nutMaterial } };
  // 記録を使った文書は保存形式の版 23 以上で保存する(穴つきの面と同じ V-b。版 22 までの読み手は版の数で断る)。
  return { ok: true, document: { ...fastened.document, schemaVersion: Math.max(fastened.document.schemaVersion, FRAME_JOINTS_SCHEMA_VERSION),
    frameJoints: [...(fastened.document.frameJoints ?? []), record] },
    componentIds: [component.id, ...fastened.componentIds], record };
}
