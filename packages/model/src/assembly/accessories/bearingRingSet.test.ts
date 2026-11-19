/**
 * A6 軸受の C 形止め輪の組(bearingRingSet.ts)と、付け直し(accessorySync.ts)の検査。
 * 独立の期待: 深溝玉軸受 6204 は内径 20・外径 47・幅 14(JIS B 1521 の表)で、軸用 C 形止め輪 20 の厚さは 1.2、穴用 47 は 1.75(JIS B 2804 の表)。
 * 6206 へ替えると内径 30・幅 16 で、軸用 30 の厚さは 1.5。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import { beforeAll, describe, expect, it } from 'vitest';

import { addComponent, createComponentFor } from '../assemblyEdit.js';
import { PRODUCT_CATALOG_REGISTRY } from '../catalog/registry.js';
import { createCatalogItemSource } from '../catalog/source.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import { createStandardPartSource } from '../standard/buildStandardPart.js';
import type { AssemblyDocument } from '../types.js';
import { accessoryCandidates, accessoryCandidatesForPart, applyAccessorySet } from './accessorySets.js';
import { accessoryIssues, syncAccessorySets } from './accessorySync.js';
import { bearingRingCandidates } from './bearingRingSet.js';

const REGISTRY = PRODUCT_CATALOG_REGISTRY;
const ANGULAR = 'angular-contact-ball-bearing';

beforeAll(async () => {
  await REGISTRY.ensure(['c-ring-shaft', 'c-ring-bore', ANGULAR, 'needle-roller-bearing-rna']);
});

function withBearing(size: string): { readonly document: AssemblyDocument; readonly hostId: string } {
  const empty = createAssemblyDocument('bearing-rings');
  const host = createComponentFor(empty, createStandardPartSource('deepGrooveBallBearing', size), { placement: {
    position: [expressionValueFromNumber(10), expressionValueFromNumber(20), expressionValueFromNumber(30)], rotation: [0, 0, 0, 1] } });
  return { document: addComponent(empty, host), hostId: host.id };
}

describe('A6 軸受の C 形止め輪', () => {
  it('候補: 6204 は軸用 20(厚さ 1.2)と穴用 47(厚さ 1.75)。軸受でない部品は notBearing', () => {
    const bearing = createStandardPartSource('deepGrooveBallBearing', '6204');
    expect(bearingRingCandidates(bearing, 'bearing-shaft-rings', REGISTRY)).toEqual({ ok: true,
      value: [{ familyId: 'c-ring-shaft', itemKey: '20', size: '軸用 C 形止め輪 20', thicknessMm: 1.2, quarterTurn: 0 }] });
    expect(bearingRingCandidates(bearing, 'bearing-bore-rings', REGISTRY)).toEqual({ ok: true,
      value: [{ familyId: 'c-ring-bore', itemKey: '47', size: '穴用 C 形止め輪 47', thicknessMm: 1.75, quarterTurn: 0 }] });
    const bolt = createStandardPartSource('hexBolt', 'M8', { length: '40', dimensionSeries: 'annexJA', threadSeries: 'coarse' });
    expect(bearingRingCandidates(bolt, 'bearing-shaft-rings', REGISTRY)).toEqual({ ok: false, reason: 'notBearing' });
  });

  it('族の軸受: 外径に合う穴用の行が無ければ noMatchingRing、針状ころ軸受はころの内接円径を軸径にする', () => {
    const angular = REGISTRY.loaded(ANGULAR);
    const large = angular?.rows.find((row) => (row.dims.outsideDiameter ?? 0) > 132);
    if (angular === undefined || large === undefined) throw new Error('angular rows missing');
    expect(accessoryCandidatesForPart(angular, large, {}, 'bearing-bore-rings', REGISTRY)).toEqual({ ok: false, reason: 'noMatchingRing' });
    const needle = REGISTRY.loaded('needle-roller-bearing-rna');
    const row = needle?.rows.find((item) => item.dims.rollerInscribedDiameter === 20);
    if (needle === undefined || row === undefined) throw new Error('needle row missing');
    const shaft = accessoryCandidatesForPart(needle, row, {}, 'bearing-shaft-rings', REGISTRY);
    expect(shaft.ok && shaft.value.map((item) => item.itemKey)).toEqual(['20']);
    expect(bearingRingCandidates(createCatalogItemSource(needle, row, {}), 'bearing-shaft-rings', REGISTRY).ok).toBe(true);
  });

  it('付ける: 6204 の両側に軸用 20 を置く(始点 z = −1.2、終点 z = 14)。一緒に動く組・記録・版 23・材質', () => {
    const { document, hostId } = withBearing('6204');
    expect(accessoryCandidates(document, hostId, 'bearing-shaft-rings', REGISTRY).ok).toBe(true);
    const applied = applyAccessorySet(document, hostId, 'bearing-shaft-rings', { ends: 'both', endReference: 'overall', itemKey: '20' }, REGISTRY);
    if (!applied.ok) throw new Error(applied.reason);
    const next = applied.value.document;
    expect(next.components).toHaveLength(3);
    expect(next.components.slice(1).map((component) => component.placement.position.map((value) => value.value)))
      .toEqual([[10, 20, 30 - 1.2], [10, 20, 30 + 14]]);
    expect(new Set(next.components.map((component) => component.rigidGroupId)).size).toBe(1);
    expect(next.components.slice(1).every((component) => component.materialId === 'steel')).toBe(true);
    expect(next.accessorySets?.[0]).toMatchObject({ setId: 'bearing-shaft-rings', hostComponentId: hostId,
      choices: { ends: 'both', endReference: 'member', itemKey: '20' } });
    expect(next.accessorySets?.[0]?.accessories.map((item) => item.role)).toEqual(['startRing', 'endRing']);
    expect(next.schemaVersion).toBeGreaterThanOrEqual(23);
    expect(applyAccessorySet(document, hostId, 'bearing-shaft-rings', { ends: 'both', endReference: 'member', itemKey: '25' }, REGISTRY))
      .toEqual({ ok: false, reason: 'unknownItem' });
  });

  it('付け直し: 置いた直後は同じ文書。軸受を 6206 に替えると止め輪は軸用 30 へ替わり、終点の側は z = 16 へ動く', () => {
    const { document, hostId } = withBearing('6204');
    const applied = applyAccessorySet(document, hostId, 'bearing-shaft-rings', { ends: 'end', endReference: 'member', itemKey: '' }, REGISTRY);
    if (!applied.ok) throw new Error(applied.reason);
    const placed = applied.value.document;
    expect(syncAccessorySets(placed, REGISTRY)).toEqual({ ok: true, document: placed });
    const changed: AssemblyDocument = { ...placed, components: placed.components.map((component) => component.id === hostId
      ? { ...component, source: createStandardPartSource('deepGrooveBallBearing', '6206') } : component) };
    const synced = syncAccessorySets(changed, REGISTRY);
    if (!synced.ok) throw new Error(synced.reason);
    const ring = synced.document.components[1];
    expect(ring?.source.kind === 'standardPart' ? ring.source.options.item : '').toBe('30');
    expect(ring?.placement.position.map((value) => value.value)).toEqual([10, 20, 46]);
    expect(synced.document.accessorySets?.[0]?.choices.itemKey).toBe('30');
    expect(accessoryIssues(synced.document, REGISTRY)).toEqual([]);
  });
});
