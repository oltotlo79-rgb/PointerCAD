import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { addComponent, createComponentFor } from '../assemblyEdit.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import { quaternionFromAxisAngle } from '../placementMath.js';
import { buildStandardPartFromSource, createStandardPartSource } from '../standard/buildStandardPart.js';
import { findHexBolt, findHexNut, findPlainWasher, findSpringWasher } from '../standard/fasteners.js';
import { accessoryIssues, syncAccessorySets } from './accessorySync.js';
import { applyBoltAccessorySet, defaultBoltGrip, planBoltAccessories } from './boltAccessorySet.js';

const bolt = (size: string, length: string) => createStandardPartSource('hexBolt', size, { length, dimensionSeries: 'annexJA', threadSeries: 'coarse' });

describe('ボルトの座金とナットの組(A4)', () => {
  it('既定の締め付ける厚さは、座金 2 枚・ばね座金・ナットとねじの 2 ピッチを引いて 0.5 mm に切り下げる', () => {
    const [b, n, p, s] = [findHexBolt('M8'), findHexNut('M8'), findPlainWasher('M8'), findSpringWasher('M8')];
    if (b === undefined || n === undefined || p === undefined || s === undefined) throw new Error('M8 rows missing');
    const expected = (spring: number): number => Math.floor((40 - 2 * p.thickness - spring - n.mMax - 2 * b.pitch) / 0.5) * 0.5;
    expect(defaultBoltGrip(bolt('M8', '40'), false)).toEqual({ ok: true, value: expected(0) });
    expect(defaultBoltGrip(bolt('M8', '40'), true)).toEqual({ ok: true, value: expected(s.thickness) });
    expect(defaultBoltGrip(createStandardPartSource('hexNut', 'M8', {}), false)).toEqual({ ok: false, reason: 'notBolt' });
  });

  it('頭側の座金を裏返して座面の下に、ナット側の座金・ばね座金・ナットを締め付ける厚さの先へ積み、ねじが 1 ピッチ出ない厚さは断る', () => {
    const p = findPlainWasher('M8'), s = findSpringWasher('M8');
    if (p === undefined || s === undefined) throw new Error('M8 rows missing');
    const planned = planBoltAccessories(bolt('M8', '40'), 20, true);
    if (!planned.ok) throw new Error(planned.reason);
    expect(planned.value.map((item) => [item.role, item.source.catalog, item.local.position[2], item.local.rotation]))
      .toEqual([['headWasher', 'plainWasher', p.thickness, [1, 0, 0, 0]], ['nutWasher', 'plainWasher', p.thickness + 20, [0, 0, 0, 1]],
        ['springWasher', 'springWasher', 2 * p.thickness + 20, [0, 0, 0, 1]], ['nut', 'hexNut', 2 * p.thickness + 20 + s.thickness, [0, 0, 0, 1]]]);
    expect(planned.value.every((item) => buildStandardPartFromSource(item.source) !== null)).toBe(true);
    expect(planBoltAccessories(bolt('M8', '40'), 30, true)).toEqual({ ok: false, reason: 'gripTooLong' });
    expect(planBoltAccessories(bolt('M8', '40'), 0, false)).toEqual({ ok: false, reason: 'invalidGrip' });
  });

  it('置いたボルトに付けると、回したボルトの軸に沿って並び、組・記録(締め付ける厚さとばね座金)・版 23 を足す', () => {
    const empty = createAssemblyDocument('bolt-accessories');
    const host = createComponentFor(empty, bolt('M8', '40'), { partName: 'M8', placement: {
      position: [expressionValueFromNumber(10), expressionValueFromNumber(20), expressionValueFromNumber(30)],
      rotation: quaternionFromAxisAngle([1, 0, 0], Math.PI / 2) } });
    const applied = applyBoltAccessorySet(addComponent(empty, host), host.id, { springWasher: true });
    if (!applied.ok) throw new Error(applied.reason);
    const next = applied.value.document;
    expect(next.components).toHaveLength(5);
    expect(new Set(next.components.map((component) => component.rigidGroupId)).size).toBe(1);
    expect(next.components.every((component) => Math.abs(component.placement.position[0].value - 10) < 1e-9
      && Math.abs(component.placement.position[2].value - 30) < 1e-9)).toBe(true);
    expect(next.accessorySets?.[0]).toMatchObject({ setId: 'bolt-washer-nut', hostComponentId: host.id,
      choices: { ends: 'both', endReference: 'member', itemKey: 'M8', springWasher: true } });
    expect(next.schemaVersion).toBeGreaterThanOrEqual(23);
  });

  it('付け直し: 置いた直後は同じ文書、ボルトを長くしても座金とナットはそのまま、短くしてねじが出なければ付け直さずに理由', () => {
    const empty = createAssemblyDocument('bolt-sync');
    const host = createComponentFor(empty, bolt('M8', '40'), { partName: 'M8' });
    const applied = applyBoltAccessorySet(addComponent(empty, host), host.id, { springWasher: true });
    if (!applied.ok) throw new Error(applied.reason);
    const document = applied.value.document;
    const synced = syncAccessorySets(document);
    expect(synced.ok && synced.document).toBe(document);
    const withBolt = (length: string) => ({ ...document, components: document.components.map((component) => (component.id === host.id
      ? { ...component, source: bolt('M8', length) } : component)) });
    const longer = withBolt('50');
    const kept = syncAccessorySets(longer);
    expect(kept.ok && kept.document).toBe(longer);
    const shorter = withBolt('20');
    expect(syncAccessorySets(shorter)).toMatchObject({ ok: false, reason: 'gripTooLong' });
    expect(accessoryIssues(shorter)).toEqual([{ recordId: 'accessory-1', hostComponentId: host.id, reason: 'gripTooLong' }]);
  });
});
