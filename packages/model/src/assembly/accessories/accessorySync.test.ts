import { expressionValueFromNumber } from '@pointercad/expression';
import { beforeAll, describe, expect, it } from 'vitest';

import { addComponent, createComponentFor, removeComponent } from '../assemblyEdit.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import { PRODUCT_CATALOG_REGISTRY } from '../catalog/registry.js';
import { createCatalogItemSource } from '../catalog/source.js';
import { planMemberBulkEdit } from '../frame/memberBulkEdit.js';
import { planMemberSplit } from '../frame/memberSplitMerge.js';
import type { AssemblyDocument } from '../types.js';
import { applyAccessorySet } from './accessorySets.js';
import { accessoryIdsOf, accessoryIssues, mergeAccessorySets, splitAccessorySets, syncAccessorySets } from './accessorySync.js';

const registry = PRODUCT_CATALOG_REGISTRY;
beforeAll(async () => { await registry.ensure(['t-slot-frame-s6', 't-slot-frame-cap']); });

/** 溝幅 6 の 20×20 を 1000 で置き、全長・両端のキャップを付けた文書(本体 994・キャップ 0〜3 と 997〜1000)。 */
function capped(): { readonly document: AssemblyDocument; readonly hostId: string; readonly capIds: readonly string[] } {
  const family = registry.loaded('t-slot-frame-s6');
  const row = family?.rows.find((candidate) => candidate.key === 's6-20x20');
  if (family === undefined || row === undefined) throw new Error('frame family not loaded');
  const empty = createAssemblyDocument('accessory-sync');
  const host = createComponentFor(empty, createCatalogItemSource(family, row, { length: '1000' }), { partName: 'host',
    placement: { position: [expressionValueFromNumber(0), expressionValueFromNumber(0), expressionValueFromNumber(0)], rotation: [0, 0, 0, 1] } });
  const applied = applyAccessorySet(addComponent(empty, host), host.id, 'frame-end-caps', { ends: 'both', endReference: 'overall', itemKey: 's6-20x20' }, registry);
  if (!applied.ok) throw new Error(applied.reason);
  return { document: applied.value.document, hostId: host.id, capIds: applied.value.componentIds };
}

const zOf = (document: AssemblyDocument): number[] => document.components.map((component) => component.placement.position[2].value);
const withEntries = (document: AssemblyDocument, plan: ReturnType<typeof planMemberBulkEdit>): AssemblyDocument => (!plan.ok ? document
  : { ...document, components: document.components.map((component) => {
    const entry = plan.entries.find((item) => item.componentId === component.id);
    return entry === undefined ? component : { ...component, source: entry.nextSource, name: entry.nextName };
  }) });

describe('付属の組の後の編集', () => {
  it('置いた直後の付け直しは同じ文書を返し、付け直せない記録は無い', () => {
    const { document } = capped();
    const synced = syncAccessorySets(document, registry);
    expect(synced.ok && synced.document).toBe(document);
    expect(accessoryIssues(document, registry)).toEqual([]);
  });

  it('本体を消すと付属と記録も消え、キャップだけ消すと記録から外れ、外すと本体だけ残る', () => {
    const { document, hostId, capIds } = capped();
    const withoutHost = removeComponent(document, hostId);
    expect([withoutHost.components.length, withoutHost.accessorySets]).toEqual([0, []]);
    const withoutCap = removeComponent(document, capIds[0] ?? '');
    expect(withoutCap.accessorySets?.[0]?.accessories.map((item) => item.role)).toEqual(['endCap']);
    expect(accessoryIdsOf(document, hostId).reduce(removeComponent, document).components.map((component) => component.id)).toEqual([hostId]);
  });

  it('長さの書き換えの後は終点のキャップを新しい端へ、断面の変更は合う 1 つの行へ替える', () => {
    const { document, hostId } = capped();
    const longer = syncAccessorySets(withEntries(document, planMemberBulkEdit(document, [hostId], { length: '1500' }, registry)), registry);
    expect(longer.ok && zOf(longer.document)).toEqual([3, 0, 1503]);
    const wider = syncAccessorySets(withEntries(document, planMemberBulkEdit(document, [hostId], { itemKey: 's6-40x40' }, registry)), registry);
    expect(wider.ok && wider.document.accessorySets?.[0]?.choices.itemKey).toBe('s6-40x40');
  });

  it('分けると終点のキャップは後ろの部材の記録へ移り、まとめると記録は 1 つに戻り、接する端にキャップがあればまとめない', () => {
    const { document, hostId } = capped();
    const split = planMemberSplit(document, hostId, 600);
    if (!split.ok) throw new Error(split.reason);
    const newId = split.componentIds[1] ?? '';
    const moved = splitAccessorySets(split.document, hostId, newId);
    expect(moved.accessorySets?.map((record) => [record.hostComponentId, record.accessories.map((item) => item.role), record.choices.ends]))
      .toEqual([[hostId, ['startCap'], 'start'], [newId, ['endCap'], 'end']]);
    const synced = syncAccessorySets(moved, registry);
    // 分けた後ろの部材は元の部材の直後に並ぶ(planMemberSplit)。終点のキャップは後ろの部材の端(603 + 394 = 997)のまま。
    expect(synced.ok && zOf(synced.document)).toEqual([3, 603, 0, 997]);
    const merged = mergeAccessorySets(moved, hostId, newId);
    expect(merged.ok && merged.document.accessorySets?.map((record) => [record.hostComponentId, record.choices.ends])).toEqual([[hostId, 'both']]);
    expect(mergeAccessorySets(document, hostId, 'component-9')).toEqual({ ok: false, reason: 'jointHasAccessory' });
  });
});
