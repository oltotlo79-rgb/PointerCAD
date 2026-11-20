/**
 * 付属の組「鋼管の端の継手」(K-28 束 3。設計 wip/k28-bundle3-g2-design.md §2)の候補・置き方・付け方・付け直しの計画。次の文書を作るだけの純関数。
 *
 * - 本体: 鋼材の配管用炭素鋼鋼管(SGP。JIS G 3452。黒管・白管)。呼び径 A の数で、合う継手の行を引く。
 * - 候補: ねじ込み式管継手(JIS B 2301)のソケット・エルボ・チーズ・キャップと、鋼製管フランジ(JIS B 2220)5K・10K の板のうち、
 *   行の pipeSize が管の呼び径と同じ行(族ごとに 0 か 1)。合う行が無い呼びには組を出さない(近い呼びを推測で選ばない)。
 * - 差し込みの長さ a: 管の呼びのねじ(継手の端部の表)の、管用テーパねじ(JIS B 0203)の基準の長さ。管の端は、ねじ込みの継手へ a だけ入る。
 *   フランジ(差込みの板)は、管の端と外の面を揃える(差込みの隙間は作らない)。
 * - 置き方(管の局所。+Z が長さの向き、始点の端 z = 0、終点の端 z = L): ソケットは終点 z ∈ [L − a, L − a + Ls]・始点 [a − Ls, a]。
 *   キャップは開いた端を管へ向け、終点 [L − a, L − a + H]・始点 [a − H, a]。フランジは終点 [L − t, L]・始点 [0, t]。
 *   エルボ・チーズは、管の入る腕の端面を管の端から a 入った所に置き(中心は終点 L − a + A・始点 a − A)、ほかの腕は管の軸のまわりの
 *   90° ずつの回し(turn)で向ける。チーズは通しの腕の一方に管が入る。
 * - 線の端の意味: 'overall' は線の端を、エルボ・チーズは中心、ソケットは真ん中、キャップは外の面、フランジは外の面にする。管は端ごとに
 *   A − a・Ls ÷ 2 − a・H − a・0 だけ短くする(候補の thicknessMm に持たせる。予告と同じ式)。'member' は管の長さのまま。
 * - 付け直し: 管の長さを替えると継手が端と一緒に動く。呼びを替えると、同じ族の新しい呼びの行へ替える(無ければ理由)。線の端の意味は
 *   置いた時だけに使う(端のキャップと同じ)。
 */
import { expressionValueFromNumber } from '@pointercad/expression';

import { addComponent, createComponentFor } from '../assemblyEdit.js';
import { pipeFittingEndForPipe } from '../catalog/families/pipeFittingEnds.js';
import type { CatalogRegistry } from '../catalog/registry.js';
import { createCatalogItemSource } from '../catalog/source.js';
import type { CatalogFamily, CatalogItemRow } from '../catalog/types.js';
import { planMemberBulkEdit } from '../frame/memberBulkEdit.js';
import { composePlacement, multiplyQuaternion, quaternionFromAxisAngle, type Quaternion, type RigidPlacement } from '../placementMath.js';
import { joinRigidGroup } from '../rigidGroups.js';
import { findPipeThread } from '../../thread/pipeThread.js';
import type { AssemblyComponent, AssemblyDocument, ComponentSource } from '../types.js';
import { accessoryHostOf, type AccessoryHost } from './accessoryHost.js';
import type { AccessoryEnds, AccessoryRole, AccessorySetRecord, AccessoryTurn } from './accessoryRecord.js';
import type { AccessoryCandidate, AccessoryChoices, AccessoryRefusal } from './accessorySets.js';

/** 記録を保存・読み込みできる最小の保存形式の版(accessorySets.ts の ACCESSORY_SETS_SCHEMA_VERSION と同じ値)。 */
const ACCESSORY_SETS_SCHEMA_VERSION = 23;
/** 長さを丸める桁(mm の 1e-6。一括配置・端のキャップと同じ)。 */
const ROUNDING = 1e6;

type FittingKind = 'socket' | 'elbow' | 'tee' | 'cap' | 'flange';

/** 候補の族と種類(候補の並び)。 */
const FITTING_FAMILIES: readonly (readonly [string, FittingKind])[] = [
  ['pipe-fitting-socket', 'socket'], ['pipe-fitting-elbow', 'elbow'], ['pipe-fitting-tee', 'tee'], ['pipe-fitting-cap', 'cap'],
  ['pipe-flange-5k', 'flange'], ['pipe-flange-10k', 'flange'],
];

/** 継手の族の id(8 分類の窓・一括配置が、組を出す前に読み込む)。 */
export const PIPE_END_FITTING_FAMILY_IDS: readonly string[] = FITTING_FAMILIES.map(([id]) => id);

type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: AccessoryRefusal };
const refuse = <T>(reason: AccessoryRefusal): Result<T> => ({ ok: false, reason });
const round = (value: number): number => Math.round(value * ROUNDING) / ROUNDING;

const IDENTITY: Quaternion = [0, 0, 0, 1];
/** 管の軸(Z)を逆へ向ける回し(X のまわりの 180°)。 */
const FLIP: Quaternion = quaternionFromAxisAngle([1, 0, 0], Math.PI);
/** チーズの −X の腕を管へ向ける回し(終点は −Z へ、始点は +Z へ。Y のまわりの ∓90°)。 */
const TEE_AT_END: Quaternion = quaternionFromAxisAngle([0, 1, 0], -Math.PI / 2);
const TEE_AT_START: Quaternion = quaternionFromAxisAngle([0, 1, 0], Math.PI / 2);

/** 候補 1 つの中身(族・行・種類・差し込みの長さ・全長の時に端ごとに管を短くする長さ)。 */
interface Fitting {
  readonly family: CatalogFamily;
  readonly row: CatalogItemRow;
  readonly kind: FittingKind;
  readonly gaugeLength: number;
  readonly shorteningMm: number;
}

/** 管(SGP)の呼び径 A の数。鋼管でない・SGP でない・呼びが読めない時は null。 */
function pipeSizeOf(host: AccessoryHost | null): number | null {
  if (host?.kind !== 'steel' || host.product.catalog !== 'steelPipe' || host.product.materialGrade !== 'SGP') return null;
  const match = /^(\d+)A$/u.exec(host.product.size);
  return match === null ? null : Number(match[1]);
}

/** 全長の時に端ごとに管を短くする長さ(行の寸法が欠ける時は null)。 */
function shorteningOf(kind: FittingKind, dims: Readonly<Record<string, number>>, gaugeLength: number): number | null {
  const length = dims.length, height = dims.height;
  switch (kind) {
    case 'socket': return length === undefined ? null : length / 2 - gaugeLength;
    case 'elbow':
    case 'tee': return length === undefined ? null : length - gaugeLength;
    case 'cap': return height === undefined ? null : height - gaugeLength;
    case 'flange': return 0;
  }
}

/** 管に合う継手(族の並びの順)。 */
function fittingsFor(host: AccessoryHost | null, registry: CatalogRegistry): Result<readonly Fitting[]> {
  const pipeSize = pipeSizeOf(host);
  if (pipeSize === null) return refuse('notPipe');
  const loaded = FITTING_FAMILIES.flatMap(([id, kind]) => {
    const family = registry.loaded(id);
    return family === undefined ? [] : [{ family, kind }];
  });
  if (loaded.length === 0) return refuse('fittingsNotLoaded');
  const end = pipeFittingEndForPipe(pipeSize);
  const gaugeLength = end === undefined ? null : findPipeThread('taper', end.thread)?.gaugeLength ?? null;
  const fittings = gaugeLength === null ? [] : loaded.flatMap(({ family, kind }): Fitting[] => {
    const row = family.rows.find((item) => item.dims.pipeSize === pipeSize);
    const shorteningMm = row === undefined ? null : shorteningOf(kind, row.dims, gaugeLength);
    return row === undefined || shorteningMm === null || shorteningMm < 0 || (kind !== 'flange' && shorteningMm === 0) ? []
      : [{ family, row, kind, gaugeLength, shorteningMm: round(shorteningMm) }];
  });
  return fittings.length === 0 ? refuse('noMatchingFitting') : { ok: true, value: fittings };
}

/** 管(本体)に付けられる継手の候補。size は画面に出す部品名(族の部品名)、thicknessMm は全長の時に端ごとに管を短くする長さ。 */
export function pipeEndFittingCandidates(host: AccessoryHost | null, registry: CatalogRegistry): Result<readonly AccessoryCandidate[]> {
  const fittings = fittingsFor(host, registry);
  if (!fittings.ok) return fittings;
  return { ok: true, value: fittings.value.map(({ family, row, kind, shorteningMm }): AccessoryCandidate => ({ familyId: family.id, itemKey: row.key,
    size: family.partName(row, {}), thicknessMm: shorteningMm, quarterTurn: 0, turnable: kind === 'elbow' || kind === 'tee' })) };
}

/** 端の継手 1 つの、管の局所の置き方(管の長さ hostLengthMm の今の形。始点の端が z = 0)。 */
function fittingPlacement(fitting: Fitting, role: AccessoryRole, hostLengthMm: number, turn: AccessoryTurn): RigidPlacement {
  const atEnd = role === 'endFitting';
  const a = fitting.gaugeLength, dims = fitting.row.dims;
  const turned = (base: Quaternion): Quaternion => multiplyQuaternion(quaternionFromAxisAngle([0, 0, 1], turn * Math.PI / 2), base);
  switch (fitting.kind) {
    case 'socket':
      return { position: [0, 0, atEnd ? hostLengthMm - a : a - (dims.length ?? NaN)], rotation: IDENTITY };
    case 'cap':
      return atEnd ? { position: [0, 0, hostLengthMm - a], rotation: IDENTITY } : { position: [0, 0, a], rotation: FLIP };
    case 'flange':
      return { position: [0, 0, atEnd ? hostLengthMm - (dims.thickness ?? NaN) : 0], rotation: IDENTITY };
    case 'elbow':
      return { position: [0, 0, atEnd ? hostLengthMm - a + (dims.length ?? NaN) : a - (dims.length ?? NaN)], rotation: turned(atEnd ? FLIP : IDENTITY) };
    case 'tee':
      return { position: [0, 0, atEnd ? hostLengthMm - a + (dims.length ?? NaN) : a - (dims.length ?? NaN)],
        rotation: turned(atEnd ? TEE_AT_END : TEE_AT_START) };
  }
}

/** 付ける継手: 役目・族・行・管の局所の置き方。 */
interface FittingItem {
  readonly role: AccessoryRole;
  readonly family: CatalogFamily;
  readonly row: CatalogItemRow;
  readonly local: RigidPlacement;
}

const rolesOf = (ends: AccessoryEnds): readonly AccessoryRole[] =>
  ends === 'both' ? ['startFitting', 'endFitting'] : ends === 'start' ? ['startFitting'] : ['endFitting'];

/**
 * 付け直しの計画(記録の役目の継手を、管の今の長さと呼びで置き直す)。呼びが変わった時は同じ族の新しい呼びの行へ替える。
 * 管でない・合う行が無い時は理由。
 */
export function planPipeEndFittings(source: ComponentSource, record: AccessorySetRecord, registry: CatalogRegistry): Result<readonly FittingItem[]> {
  const host = accessoryHostOf(source, registry);
  const fittings = fittingsFor(host, registry);
  if (!fittings.ok) return fittings;
  const lengthMm = host?.kind === 'steel' ? host.lengthMm : null;
  if (lengthMm === null) return refuse('invalidLength');
  const sameFamily = fittings.value.filter((item) => item.family.id === record.choices.familyId);
  const fitting = sameFamily.find((item) => item.row.key === record.choices.itemKey) ?? sameFamily[0];
  if (fitting === undefined) return refuse('noMatchingFitting');
  const turn = record.choices.turn ?? 0;
  return { ok: true, value: record.accessories.map((item) => ({ role: item.role, family: fitting.family, row: fitting.row,
    local: fittingPlacement(fitting, item.role, lengthMm, turn) })) };
}

function rigidOf(component: AssemblyComponent): RigidPlacement {
  const [x, y, z] = component.placement.position;
  return { position: [x.value, y.value, z.value], rotation: component.placement.rotation };
}

function placementOf(rigid: RigidPlacement): AssemblyComponent['placement'] {
  const [x, y, z] = rigid.position;
  return { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)], rotation: rigid.rotation };
}

function nextRecordId(document: AssemblyDocument): string {
  const used = new Set((document.accessorySets ?? []).map((record) => record.id));
  let index = 1;
  while (used.has(`accessory-${index}`)) index += 1;
  return `accessory-${index}`;
}

/** 記録の指定(族の id を必ず持ち、枝の向きはエルボ・チーズの時だけ持つ)。 */
function recordChoices(fitting: Fitting, choices: AccessoryChoices): AccessorySetRecord['choices'] {
  return { ends: choices.ends, endReference: choices.endReference, itemKey: fitting.row.key, familyId: fitting.family.id,
    ...(fitting.kind === 'elbow' || fitting.kind === 'tee' ? { turn: choices.turn ?? 0 } : {}) };
}

/**
 * 置いた管に端の継手を付けた次の文書。全長の時は管の長さと位置を直し、継手を足し、一緒に動く組へ入れ、記録を足し、版を 23 以上にする。
 * 付けられない時は何も変えずに理由を返す。
 */
export function applyPipeEndFittings(document: AssemblyDocument, hostComponentId: string, choices: AccessoryChoices, registry: CatalogRegistry):
Result<{ readonly document: AssemblyDocument; readonly componentIds: readonly string[] }> {
  const component = document.components.find((item) => item.id === hostComponentId);
  const host = component === undefined ? null : accessoryHostOf(component.source, registry);
  const fittings = fittingsFor(host, registry);
  if (component === undefined || !fittings.ok) return fittings.ok ? refuse('noHost') : fittings;
  const lengthMm = host?.kind === 'steel' ? host.lengthMm : null;
  const fitting = fittings.value.find((item) => item.row.key === choices.itemKey && (choices.familyId === undefined || item.family.id === choices.familyId));
  if (fitting === undefined) return refuse('unknownItem');
  if (lengthMm === null) return refuse('invalidLength');
  const roles = rolesOf(choices.ends);
  const overall = choices.endReference === 'overall';
  const hostLengthMm = round(overall ? lengthMm - fitting.shorteningMm * roles.length : lengthMm);
  if (!(hostLengthMm > 0)) return refuse('invalidLength');
  const hostShiftMm = overall && roles.includes('startFitting') ? fitting.shorteningMm : 0;
  // 長さの書き換えは一括の書き換えと同じ作り方と確かめ(鋼材は長さだけ。部品名の長さも付け直す。端のキャップと同じ)。
  const resized = hostLengthMm === lengthMm ? null : planMemberBulkEdit(document, [hostComponentId], { length: String(hostLengthMm) }, registry);
  const entry = resized?.ok === true ? resized.entries[0] : undefined;
  if (resized !== null && entry === undefined) return refuse('lengthOutOfRange');
  const hostRigid = composePlacement(rigidOf(component), { position: [0, 0, hostShiftMm], rotation: IDENTITY });
  let next: AssemblyDocument = { ...document, components: document.components.map((item) => (item.id === hostComponentId
    ? { ...item, ...(entry === undefined ? {} : { source: entry.nextSource, name: entry.nextName }), placement: placementOf(hostRigid) }
    : item)) };
  const turn = choices.turn ?? 0;
  const accessories: { componentId: string; role: AccessoryRole }[] = [];
  for (const role of roles) {
    const created = createComponentFor(next, createCatalogItemSource(fitting.family, fitting.row, {}), { partName: fitting.family.partName(fitting.row, {}),
      placement: placementOf(composePlacement(hostRigid, fittingPlacement(fitting, role, hostLengthMm, turn))) });
    const withMaterial = fitting.row.densityMaterialId === undefined ? created : { ...created, materialId: fitting.row.densityMaterialId };
    next = addComponent(next, { ...withMaterial, fixed: false });
    accessories.push({ componentId: created.id, role });
  }
  next = joinRigidGroup(next, [hostComponentId, ...accessories.map((item) => item.componentId)]);
  const record: AccessorySetRecord = { id: nextRecordId(next), setId: 'pipe-end-fittings', hostComponentId, accessories,
    choices: recordChoices(fitting, choices) };
  return { ok: true, value: { componentIds: accessories.map((item) => item.componentId), document: { ...next,
    accessorySets: [...(next.accessorySets ?? []), record], schemaVersion: Math.max(next.schemaVersion, ACCESSORY_SETS_SCHEMA_VERSION) } } };
}
