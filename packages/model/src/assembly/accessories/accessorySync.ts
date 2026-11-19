/**
 * 付属の組の後の編集(A3。設計 wip/auto-accessory-design.md §7。統括の決定 2026-11-19 02:08 の Q5: 本体を消すと付属も消す)。次の文書を作るだけの純関数。
 *
 * - 消す: accessoryPrune.ts(removeComponent が読む)。本体を消すと付属と記録も消え、付属だけを消すと記録から外れる。「付属の部品を外す」は
 *   `accessoryIdsOf` の部品を消す(記録は同じ道で消える)。
 * - 付け直す(`syncAccessorySets`): 長さの書き換え・呼びの変更・置換・伸縮・分割の後に、付属を本体の今の端へ置き直す(始点の付属は z ∈ [−t, 0]、終点は [L, L + t])。
 *   本体の断面が変わって前の行が合わない時は、合う行が 1 つならそれへ替え、0 か 2 つ以上なら何も変えずに理由と記録を返す(呼ぶ側は編集そのものを断る)。
 *   置いた後の本体の長さは切る長さそのもので、線の端の意味(全長)は置いた時だけに使う(後で長さを書き換えても付属の厚さを引き直さない)。
 * - 分割(`splitAccessorySets`): 終点の付属を後ろの部材の記録へ移す。統合(`mergeAccessorySets`): 接する端に付属があれば断る(勝手に消さない)。
 */
import { evaluateExpression, expressionValueFromNumber } from '@pointercad/expression';

import { PRODUCT_CATALOG_REGISTRY, type CatalogRegistry } from '../catalog/registry.js';
import { createCatalogItemSource } from '../catalog/source.js';
import { composePlacement, quaternionFromAxisAngle, type RigidPlacement } from '../placementMath.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import { withinMagnitude } from '../../numericTolerance.js';
import type { AccessorySetRecord } from './accessoryRecord.js';
import { accessoryCandidates, type AccessoryCandidate, type AccessoryRefusal } from './accessorySets.js';

const FAMILY_KEY = 'family', ITEM_KEY = 'item';

/** 本体に付けた付属の部品の id(「付属の部品を外す」が removeComponents へ渡す)。記録が無ければ空。 */
export function accessoryIdsOf(document: AssemblyDocument, hostComponentId: string): readonly string[] {
  return (document.accessorySets ?? []).flatMap((record) => record.hostComponentId === hostComponentId
    ? record.accessories.map((item) => item.componentId) : []);
}

type SyncResult = { readonly ok: true; readonly document: AssemblyDocument }
  | { readonly ok: false; readonly reason: AccessoryRefusal | 'ambiguousCap'; readonly recordId: string };

function rigidOf(component: AssemblyComponent): RigidPlacement {
  const [x, y, z] = component.placement.position;
  return { position: [x.value, y.value, z.value], rotation: component.placement.rotation };
}

/** 記録 1 つの付け直し(付属の部品の新しい形と置き方)。 */
function syncRecord(document: AssemblyDocument, record: AccessorySetRecord, registry: CatalogRegistry):
{ readonly ok: true; readonly components: ReadonlyMap<string, AssemblyComponent>; readonly record: AccessorySetRecord }
  | { readonly ok: false; readonly reason: AccessoryRefusal | 'ambiguousCap' } {
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
 * 全部の記録の付属を、本体の今の端へ置き直す(フレームの端のキャップの組だけ。ほかの組の記録はそのまま)。何も変わらない時は同じ文書を返す。
 * 1 つでも付け直せなければ何も変えずに理由と記録の id を返す(店はその時、文書を付け直さずに入れる。理由は accessoryIssues が接合チェックに出す)。
 */
export function syncAccessorySets(document: AssemblyDocument, registry: CatalogRegistry = PRODUCT_CATALOG_REGISTRY): SyncResult {
  const records = document.accessorySets ?? [];
  const changed = new Map<string, AssemblyComponent>();
  const nextRecords: AccessorySetRecord[] = [];
  for (const record of records) {
    const synced = record.setId === 'frame-end-caps' ? syncRecord(document, record, registry)
      : { ok: true as const, components: new Map<string, AssemblyComponent>(), record };
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
readonly { readonly recordId: string; readonly hostComponentId: string; readonly reason: AccessoryRefusal | 'ambiguousCap' }[] {
  return (document.accessorySets ?? []).flatMap((record) => {
    if (record.setId !== 'frame-end-caps') return [];
    const synced = syncRecord(document, record, registry);
    return synced.ok ? [] : [{ recordId: record.id, hostComponentId: record.hostComponentId, reason: synced.reason }];
  });
}

/** 分割の後: 元の部材の記録の終点の付属を、後ろの部材(newHostId)の新しい記録へ移す。終点の付属が無ければそのまま。 */
export function splitAccessorySets(document: AssemblyDocument, hostId: string, newHostId: string): AssemblyDocument {
  const records = document.accessorySets ?? [];
  const index = records.findIndex((record) => record.hostComponentId === hostId);
  const record = records[index];
  const ends = record?.accessories.filter((item) => item.role === 'endCap') ?? [];
  if (record === undefined || ends.length === 0) return document;
  const starts = record.accessories.filter((item) => item.role !== 'endCap');
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
 */
export function mergeAccessorySets(document: AssemblyDocument, keptId: string, removedId: string):
{ readonly ok: true; readonly document: AssemblyDocument } | { readonly ok: false; readonly reason: 'jointHasAccessory' } {
  const records = document.accessorySets ?? [];
  const kept = records.find((record) => record.hostComponentId === keptId);
  const removed = records.find((record) => record.hostComponentId === removedId);
  if (kept?.accessories.some((item) => item.role === 'endCap') === true || removed?.accessories.some((item) => item.role === 'startCap') === true) {
    return { ok: false, reason: 'jointHasAccessory' };
  }
  if (removed === undefined) return { ok: true, document };
  const merged: AccessorySetRecord = kept === undefined ? { ...removed, hostComponentId: keptId }
    : { ...kept, accessories: [...kept.accessories, ...removed.accessories], choices: { ...kept.choices, ends: 'both' } };
  return { ok: true, document: { ...document, accessorySets: records.flatMap((record) => record === removed ? []
    : record === kept ? [merged] : [record]).concat(kept === undefined ? [merged] : []) } };
}
