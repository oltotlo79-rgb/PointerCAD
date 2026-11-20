/**
 * 付属の組の後の編集(A3。設計 wip/auto-accessory-design.md §7。統括の決定 2026-11-19 02:08 の Q5: 本体を消すと付属も消す)。次の文書を作るだけの純関数。
 *
 * - 消す: accessoryPrune.ts(removeComponent が読む)。本体を消すと付属と記録も消え、付属だけを消すと記録から外れる。「付属の部品を外す」は
 *   `accessoryIdsOf` の部品を消す(記録は同じ道で消える)。
 * - 付け直す(`syncAccessorySets`): 長さの書き換え・呼びの変更・置換・伸縮・分割の後に、付属を本体の今の端へ置き直す(始点の付属は z ∈ [−t, 0]、終点は [L, L + t])。
 *   本体の断面が変わって前の行が合わない時は、合う行が 1 つならそれへ替え、0 か 2 つ以上なら何も変えずに理由と記録を返す(呼ぶ側は編集そのものを断る)。
 *   置いた後の本体の長さは切る長さそのもので、線の端の意味(全長)は置いた時だけに使う(後で長さを書き換えても付属の厚さを引き直さない)。
 * - 分割(`splitAccessorySets`): 終点の付属を後ろの部材の記録へ移す。統合(`mergeAccessorySets`): 接する端に付属があれば断る(勝手に消さない)。
 *   鋼管の端の継手(startFitting・endFitting)は、端のキャップ(startCap・endCap)と同じに扱う。
 */
import { evaluateExpression, expressionValueFromNumber } from '@pointercad/expression';

import { PRODUCT_CATALOG_REGISTRY, type CatalogRegistry } from '../catalog/registry.js';
import { createCatalogItemSource } from '../catalog/source.js';
import type { CatalogFamily, CatalogItemRow } from '../catalog/types.js';
import { composePlacement, quaternionFromAxisAngle, type RigidPlacement } from '../placementMath.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import { withinMagnitude } from '../../numericTolerance.js';
import type { AccessoryRole, AccessorySetId, AccessorySetRecord } from './accessoryRecord.js';
import { accessoryCandidates, type AccessoryCandidate, type AccessoryRefusal } from './accessorySets.js';
import { planBearingRings, type BearingRingRefusal, type BearingRingSetId } from './bearingRingSet.js';
import { planBoltAccessories, type BoltAccessoryRefusal } from './boltAccessorySet.js';
import { planPipeEndFittings } from './pipeEndFittings.js';

const FAMILY_KEY = 'family', ITEM_KEY = 'item';
/** 線の部材の始点・終点の付属の役目(端のキャップと鋼管の端の継手。分割・統合が使う)。 */
const START_ROLES: ReadonlySet<AccessoryRole> = new Set(['startCap', 'startFitting']);
const END_ROLES: ReadonlySet<AccessoryRole> = new Set(['endCap', 'endFitting']);

/** 本体に付けた付属の部品の id(「付属の部品を外す」が removeComponents へ渡す)。記録が無ければ空。 */
export function accessoryIdsOf(document: AssemblyDocument, hostComponentId: string): readonly string[] {
  return (document.accessorySets ?? []).flatMap((record) => record.hostComponentId === hostComponentId
    ? record.accessories.map((item) => item.componentId) : []);
}

/** 付け直せない理由(端のキャップの組とボルトの座金とナットの組)。 */
type SyncRefusal = AccessoryRefusal | 'ambiguousCap' | BoltAccessoryRefusal | BearingRingRefusal;
type RecordSync = { readonly ok: true; readonly components: ReadonlyMap<string, AssemblyComponent>; readonly record: AccessorySetRecord }
  | { readonly ok: false; readonly reason: SyncRefusal };

type SyncResult = { readonly ok: true; readonly document: AssemblyDocument }
  | { readonly ok: false; readonly reason: SyncRefusal; readonly recordId: string };

/** 保存の形が同じか(種類・呼び・欄)。 */
function sameSource(left: AssemblyComponent['source'], right: AssemblyComponent['source']): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * ボルトの座金とナットの記録の付け直し(A4)。ボルトの今の呼び・長さで、記録の締め付ける厚さとばね座金のまま座金とナットを作り直し、ボルトの軸に沿って置き直す。
 * 呼びが変われば座金とナットの呼びも替わる。ねじが 1 ピッチ出ない(ボルトを短くした)時は理由を返す(推測で厚さを変えない)。
 */
function syncBoltRecord(document: AssemblyDocument, record: AccessorySetRecord): RecordSync {
  const host = document.components.find((component) => component.id === record.hostComponentId);
  if (host === undefined) return { ok: false, reason: 'notBolt' };
  const planned = planBoltAccessories(host.source, record.choices.gripMm ?? NaN, record.choices.springWasher === true);
  if (!planned.ok) return planned;
  const components = new Map<string, AssemblyComponent>();
  for (const item of record.accessories) {
    const target = planned.value.find((candidate) => candidate.role === item.role);
    const component = document.components.find((candidate) => candidate.id === item.componentId);
    if (target === undefined || component === undefined) continue;
    const world = composePlacement(rigidOf(host), target.local);
    const keepSource = sameSource(component.source, target.source);
    if (keepSource && samePlacement(rigidOf(component), world)) continue;
    components.set(component.id, { ...component, ...(keepSource ? {} : { source: target.source }),
      placement: { position: [expressionValueFromNumber(world.position[0]), expressionValueFromNumber(world.position[1]),
        expressionValueFromNumber(world.position[2])], rotation: world.rotation } });
  }
  const nominal = host.source.kind === 'standardPart' ? host.source.size : record.choices.itemKey;
  return { ok: true, components, record: nominal === record.choices.itemKey ? record : { ...record, choices: { ...record.choices, itemKey: nominal } } };
}

/** 計画の付属 1 つ: 役目・族・行・本体の局所の置き方(止め輪・鋼管の端の継手の計画が返す形)。 */
interface PlannedCatalogItem {
  readonly role: AccessoryRole;
  readonly family: CatalogFamily;
  readonly row: CatalogItemRow;
  readonly local: RigidPlacement;
}

/**
 * 記録の付属の部品を、計画の役目ごとの族の行と置き方へ置き直す(止め輪・鋼管の端の継手)。置き方と行が今と同じ部品は元のまま。
 * 記録の行の鍵は計画の先頭の行の鍵へ替える(同じなら記録はそのまま)。
 */
function placePlannedItems(document: AssemblyDocument, record: AccessorySetRecord, host: AssemblyComponent,
  planned: readonly PlannedCatalogItem[]): RecordSync {
  const components = new Map<string, AssemblyComponent>();
  for (const item of record.accessories) {
    const target = planned.find((candidate) => candidate.role === item.role);
    const component = document.components.find((candidate) => candidate.id === item.componentId);
    if (target === undefined || component === undefined) continue;
    const world = composePlacement(rigidOf(host), target.local);
    const source = createCatalogItemSource(target.family, target.row, {});
    const keepSource = sameSource(component.source, source);
    if (keepSource && samePlacement(rigidOf(component), world)) continue;
    components.set(component.id, { ...component, ...(keepSource ? {} : { source }),
      placement: { position: [expressionValueFromNumber(world.position[0]), expressionValueFromNumber(world.position[1]),
        expressionValueFromNumber(world.position[2])], rotation: world.rotation } });
  }
  const itemKey = planned[0]?.row.key ?? record.choices.itemKey;
  return { ok: true, components, record: itemKey === record.choices.itemKey ? record : { ...record, choices: { ...record.choices, itemKey } } };
}

/**
 * 軸受の止め輪の記録の付け直し(A6)。軸受の今の呼びで止め輪の行を引き直し、端面の外へ置き直す(軸受の幅が変われば終点の側も動く)。
 * 合う行が無くなった(呼びの変更で軸径・穴径に合う止め輪が無い)時は理由を返す(近い呼びを推測で選ばない)。
 */
function syncBearingRecord(document: AssemblyDocument, record: AccessorySetRecord, setId: BearingRingSetId, registry: CatalogRegistry): RecordSync {
  const host = document.components.find((component) => component.id === record.hostComponentId);
  if (host === undefined) return { ok: false, reason: 'notBearing' };
  const planned = planBearingRings(host.source, setId, record.choices.ends, registry);
  return planned.ok ? placePlannedItems(document, record, host, planned.value) : planned;
}

/**
 * 鋼管の端の継手の記録の付け直し(K-28 束 3)。管の今の長さで継手を端へ置き直し、呼びが変わった時は同じ族の新しい呼びの行へ替える。
 * 合う行が無くなった時は理由を返す(近い呼びを推測で選ばない)。
 */
function syncPipeEndRecord(document: AssemblyDocument, record: AccessorySetRecord, registry: CatalogRegistry): RecordSync {
  const host = document.components.find((component) => component.id === record.hostComponentId);
  if (host === undefined) return { ok: false, reason: 'notPipe' };
  const planned = planPipeEndFittings(host.source, record, registry);
  return planned.ok ? placePlannedItems(document, record, host, planned.value) : planned;
}

/**
 * 付け直しの表(G2 の段 1。組の定義の表 accessorySetDefinitions.ts と対。組を足す時は両方に 1 行ずつ足す)。
 * 計算は段 1 の前のまま(端のキャップ・ボルトの組・軸受の止め輪の付け直し)。段 2 で鋼管の端の継手を足した。
 */
const SYNC_BY_SET: Readonly<Record<AccessorySetId, (document: AssemblyDocument, record: AccessorySetRecord, registry: CatalogRegistry) => RecordSync>> = {
  'frame-end-caps': (document, record, registry) => syncRecord(document, record, registry),
  'bolt-washer-nut': (document, record) => syncBoltRecord(document, record),
  'bearing-shaft-rings': (document, record, registry) => syncBearingRecord(document, record, 'bearing-shaft-rings', registry),
  'bearing-bore-rings': (document, record, registry) => syncBearingRecord(document, record, 'bearing-bore-rings', registry),
  'pipe-end-fittings': (document, record, registry) => syncPipeEndRecord(document, record, registry),
};

function syncAnyRecord(document: AssemblyDocument, record: AccessorySetRecord, registry: CatalogRegistry): RecordSync {
  return SYNC_BY_SET[record.setId](document, record, registry);
}

function rigidOf(component: AssemblyComponent): RigidPlacement {
  const [x, y, z] = component.placement.position;
  return { position: [x.value, y.value, z.value], rotation: component.placement.rotation };
}

/** 記録 1 つの付け直し(フレームの端のキャップ。付属の部品の新しい形と置き方)。 */
function syncRecord(document: AssemblyDocument, record: AccessorySetRecord, registry: CatalogRegistry): RecordSync {
  const host = document.components.find((component) => component.id === record.hostComponentId);
  const candidates = accessoryCandidates(document, record.hostComponentId, record.setId, registry);
  if (host === undefined || !candidates.ok) return { ok: false, reason: candidates.ok ? 'noHost' : candidates.reason };
  const kept = candidates.value.find((item) => item.itemKey === record.choices.itemKey);
  const candidate: AccessoryCandidate | undefined = kept ?? (candidates.value.length === 1 ? candidates.value[0] : undefined);
  if (candidate === undefined) return { ok: false, reason: 'ambiguousCap' };
  const source = host.source;
  const family = source.kind === 'standardPart' ? registry.loaded(source.options[FAMILY_KEY] ?? '') : undefined;
  const row = family?.rows.find((item) => item.key === (source.kind === 'standardPart' ? source.options[ITEM_KEY] : ''));
  const bounds = family === undefined || row === undefined || source.kind !== 'standardPart' ? null
    : family.sectionBounds?.(row, Object.fromEntries(Object.entries(source.options).filter(([key]) => key !== FAMILY_KEY && key !== ITEM_KEY))) ?? null;
  const evaluated = source.kind === 'standardPart' ? evaluateExpression(source.options.length ?? '') : null;
  const length = evaluated?.ok === true ? evaluated.value.value : NaN;
  const caps = registry.loaded(candidate.familyId);
  const capRow = caps?.rows.find((item) => item.key === candidate.itemKey);
  if (bounds === null || !(length > 0) || caps === undefined || capRow === undefined) return { ok: false, reason: 'invalidLength' };
  const rotation = quaternionFromAxisAngle([0, 0, 1], candidate.quarterTurn * Math.PI / 2);
  const center = [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2] as const;
  const components = new Map<string, AssemblyComponent>();
  const changedRow = candidate.itemKey !== record.choices.itemKey;
  for (const item of record.accessories) {
    const component = document.components.find((candidateComponent) => candidateComponent.id === item.componentId);
    if (component === undefined) continue;
    const local: RigidPlacement = { position: [center[0], center[1], item.role === 'startCap' ? -candidate.thicknessMm : length], rotation };
    const world = composePlacement(rigidOf(host), local);
    // 置き方が今と同じ(許容差の中)で行も同じ部品は、元の部品のまま(店が入れるたびに付け直すので、変えない時は同じ文書を返す)。
    if (!changedRow && samePlacement(rigidOf(component), world)) continue;
    components.set(component.id, { ...component,
      ...(changedRow ? { source: createCatalogItemSource(caps, capRow, {}) } : {}),
      placement: { position: [expressionValueFromNumber(world.position[0]), expressionValueFromNumber(world.position[1]),
        expressionValueFromNumber(world.position[2])], rotation: world.rotation } });
  }
  return { ok: true, components, record: changedRow ? { ...record, choices: { ...record.choices, itemKey: candidate.itemKey } } : record };
}

/** 置き方が同じとみなす差(位置は mm、向きは四元数の成分)。 */
const PLACEMENT_TOLERANCE = 1e-9;
function samePlacement(left: RigidPlacement, right: RigidPlacement): boolean {
  return [0, 1, 2].every((index) => withinMagnitude((left.position[index] ?? NaN) - (right.position[index] ?? NaN), PLACEMENT_TOLERANCE))
    && [0, 1, 2, 3].every((index) => withinMagnitude((left.rotation[index] ?? NaN) - (right.rotation[index] ?? NaN), PLACEMENT_TOLERANCE));
}

/**
 * 全部の記録の付属を、本体の今の形へ置き直す(フレームの端のキャップは端へ、ボルトの座金とナットは軸に沿って。A4)。何も変わらない時は同じ文書を返す。
 * 1 つでも付け直せなければ何も変えずに理由と記録の id を返す(店はその時、文書を付け直さずに入れる。理由は accessoryIssues が接合チェックに出す)。
 */
export function syncAccessorySets(document: AssemblyDocument, registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY): SyncResult {
  const records = document.accessorySets ?? [];
  const changed = new Map<string, AssemblyComponent>();
  const nextRecords: AccessorySetRecord[] = [];
  for (const record of records) {
    const synced = syncAnyRecord(document, record, registry);
    if (!synced.ok) return { ok: false, reason: synced.reason, recordId: record.id };
    for (const [id, component] of synced.components) changed.set(id, component);
    nextRecords.push(synced.record);
  }
  if (changed.size === 0 && nextRecords.every((record, index) => record === records[index])) return { ok: true, document };
  return { ok: true, document: { ...document, accessorySets: nextRecords,
    components: document.components.map((component) => changed.get(component.id) ?? component) } };
}

/** 付け直せない記録の一覧(接合チェックの一覧に出す)。記録ごとに確かめる。 */
export function accessoryIssues(document: AssemblyDocument, registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY):
readonly { readonly recordId: string; readonly hostComponentId: string; readonly reason: SyncRefusal }[] {
  return (document.accessorySets ?? []).flatMap((record) => {
    const synced = syncAnyRecord(document, record, registry);
    return synced.ok ? [] : [{ recordId: record.id, hostComponentId: record.hostComponentId, reason: synced.reason }];
  });
}

/** 分割の後: 元の部材の記録の終点の付属を、後ろの部材(newHostId)の新しい記録へ移す。終点の付属が無ければそのまま。 */
export function splitAccessorySets(document: AssemblyDocument, hostId: string, newHostId: string): AssemblyDocument {
  const records = document.accessorySets ?? [];
  const index = records.findIndex((record) => record.hostComponentId === hostId);
  const record = records[index];
  const ends = record?.accessories.filter((item) => END_ROLES.has(item.role)) ?? [];
  if (record === undefined || ends.length === 0) return document;
  const starts = record.accessories.filter((item) => !END_ROLES.has(item.role));
  const used = new Set(records.map((item) => item.id));
  let serial = 1;
  while (used.has(`accessory-${serial}`)) serial += 1;
  const moved: AccessorySetRecord = { ...record, id: `accessory-${serial}`, hostComponentId: newHostId, accessories: ends,
    choices: { ...record.choices, ends: 'end' } };
  const remaining = starts.length === 0 ? [] : [{ ...record, accessories: starts, choices: { ...record.choices, ends: 'start' as const } }];
  return { ...document, accessorySets: [...records.slice(0, index), ...remaining, ...records.slice(index + 1), moved] };
}

/**
 * 統合の後: 残す部材(keptId)の終点側に、消える部材(removedId)の記録の終点の付属を移す。接する端(残す部材の終点・消える部材の始点)に
 * 付属があれば断る(理由 'jointHasAccessory')。統合の前の文書と、残す部材・消える部材の id を渡す。
 * 鋼管の端の継手で、残す部材の始点の継手と消える部材の終点の継手の指定(族・行・枝の向き)が違う時は、1 つの記録にまとめずに、
 * 消える部材の記録の本体を残す部材へ替える(1 つの記録は 1 つの指定しか持てないので、まとめると継手の種類が変わってしまうため)。
 */
export function mergeAccessorySets(document: AssemblyDocument, keptId: string, removedId: string):
{ readonly ok: true; readonly document: AssemblyDocument } | { readonly ok: false; readonly reason: 'jointHasAccessory' } {
  const records = document.accessorySets ?? [];
  const kept = records.find((record) => record.hostComponentId === keptId);
  const removed = records.find((record) => record.hostComponentId === removedId);
  if (kept?.accessories.some((item) => END_ROLES.has(item.role)) === true || removed?.accessories.some((item) => START_ROLES.has(item.role)) === true) {
    return { ok: false, reason: 'jointHasAccessory' };
  }
  if (removed === undefined) return { ok: true, document };
  const differentFittings = kept !== undefined && removed.setId === 'pipe-end-fittings' && (kept.choices.familyId !== removed.choices.familyId
    || kept.choices.itemKey !== removed.choices.itemKey || kept.choices.turn !== removed.choices.turn);
  if (differentFittings) {
    return { ok: true, document: { ...document, accessorySets: records.map((record) => (record === removed ? { ...removed, hostComponentId: keptId } : record)) } };
  }
  const merged: AccessorySetRecord = kept === undefined ? { ...removed, hostComponentId: keptId }
    : { ...kept, accessories: [...kept.accessories, ...removed.accessories], choices: { ...kept.choices, ends: 'both' } };
  return { ok: true, document: { ...document, accessorySets: records.flatMap((record) => record === removed ? []
    : record === kept ? [merged] : [record]).concat(kept === undefined ? [merged] : []) } };
}
