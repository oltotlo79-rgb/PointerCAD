/**
 * K-28 束 3 の付属の組「鋼管の端の継手」(pipeEndFittings.ts)と、付け直し・分割・統合(accessorySync.ts)の検査。
 * 独立の期待: 配管用炭素鋼鋼管 SGP 25A(JIS G 3452)にはねじの呼び 1 の継手が合い、管用テーパねじ R1 の基準の長さ a は 10.39(JIS B 0203)。
 * JIS B 2301 の品の表で 25A のエルボ・チーズの中心から端面まで A は 38、ソケットの長さ L は 45、キャップの高さ H は 28。
 * JIS B 2220 の 5K・10K の 25A の厚さ t は 10・14。32A(呼び 1 1/4)は a 12.7・エルボの A 46。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import { beforeAll, describe, expect, it } from 'vitest';

import { addComponent, createComponentFor } from '../assemblyEdit.js';
import { createCatalogRegistry, PRODUCT_CATALOG_REGISTRY } from '../catalog/registry.js';
import { createCatalogItemSource } from '../catalog/source.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import { rotateVector } from '../placementMath.js';
import { createStandardPartSource } from '../standard/buildStandardPart.js';
import { ALL_STEEL_PRODUCTS, steelProductOptions } from '../standard/steelCatalog.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { accessoryHostOf } from './accessoryHost.js';
import { accessoryCandidatesForSource, applyAccessorySet } from './accessorySets.js';
import { accessoryIssues, mergeAccessorySets, splitAccessorySets, syncAccessorySets } from './accessorySync.js';
import { PIPE_END_FITTING_FAMILY_IDS, pipeEndFittingCandidates } from './pipeEndFittings.js';

const REGISTRY = PRODUCT_CATALOG_REGISTRY;

beforeAll(async () => { await REGISTRY.ensure([...PIPE_END_FITTING_FAMILY_IDS, 't-slot-frame-s6']); });

function pipeSource(key: string, length: string): ReturnType<typeof createStandardPartSource> {
  const product = ALL_STEEL_PRODUCTS.find((row) => row.key === key);
  if (product === undefined) throw new Error(`steel row missing: ${key}`);
  return createStandardPartSource(product.catalog, product.size, { ...steelProductOptions(product), length });
}

function withPipe(key = 'SGP:steelPipe:25A', length = '1000'): { readonly document: AssemblyDocument; readonly hostId: string } {
  const empty = createAssemblyDocument('pipe-end-fittings');
  const host = createComponentFor(empty, pipeSource(key, length), { placement: {
    position: [expressionValueFromNumber(10), expressionValueFromNumber(20), expressionValueFromNumber(30)], rotation: [0, 0, 0, 1] } });
  return { document: addComponent(empty, host), hostId: host.id };
}

const componentOf = (document: AssemblyDocument, id: string): AssemblyComponent => {
  const found = document.components.find((component) => component.id === id);
  if (found === undefined) throw new Error(`component missing: ${id}`);
  return found;
};
const positionOf = (component: AssemblyComponent): readonly number[] => component.placement.position.map((value) => value.value);
const lengthOf = (component: AssemblyComponent): string => (component.source.kind === 'standardPart' ? component.source.options.length ?? '' : '');
function expectNear(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => { expect(actual[index]).toBeCloseTo(value, 6); });
}
function expectDirection(component: AssemblyComponent, part: Vec3, world: Vec3): void {
  expectNear(rotateVector(component.placement.rotation, part), world);
}

describe('K-28 束 3 鋼管の端の継手の候補', () => {
  it('SGP 25A にはソケット・エルボ・チーズ・キャップ・フランジ 5K・10K の 25A が合い、全長の時の短くする長さは A − a・L ÷ 2 − a・H − a・0', () => {
    const result = accessoryCandidatesForSource(pipeSource('SGP:steelPipe:25A', '1000'), 'pipe-end-fittings', REGISTRY);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.map((item) => [item.familyId, item.itemKey, item.size, item.turnable])).toEqual([
      ['pipe-fitting-socket', 'socket-25A', 'ソケット 25A (Rc1)', false], ['pipe-fitting-elbow', 'elbow-25A', 'エルボ 25A (Rc1)', true],
      ['pipe-fitting-tee', 'tee-25A', 'チーズ 25A (Rc1)', true], ['pipe-fitting-cap', 'cap-25A', 'キャップ 25A (Rc1)', false],
      ['pipe-flange-5k', 'flange-5k-25A', 'フランジ 5K 25A', false], ['pipe-flange-10k', 'flange-10k-25A', 'フランジ 10K 25A', false]]);
    expectNear(result.value.map((item) => item.thicknessMm), [45 / 2 - 10.39, 38 - 10.39, 38 - 10.39, 28 - 10.39, 0, 0]);
    expect(result.value.every((item) => item.quarterTurn === 0)).toBe(true);
  });

  it('6A はキャップとフランジの行が無いので 3 つ、200A は合う継手が無いので noMatchingFitting、族を読む前は fittingsNotLoaded', () => {
    const small = accessoryCandidatesForSource(pipeSource('SGP:steelPipe:6A', '1000'), 'pipe-end-fittings', REGISTRY);
    expect(small.ok ? small.value.map((item) => item.itemKey) : small.reason).toEqual(['socket-6A', 'elbow-6A', 'tee-6A']);
    expect(accessoryCandidatesForSource(pipeSource('SGP:steelPipe:200A', '1000'), 'pipe-end-fittings', REGISTRY))
      .toEqual({ ok: false, reason: 'noMatchingFitting' });
    const host = accessoryHostOf(pipeSource('SGP:steelPipe:25A', '1000'), REGISTRY);
    expect(pipeEndFittingCandidates(host, createCatalogRegistry([]))).toEqual({ ok: false, reason: 'fittingsNotLoaded' });
  });

  it('SGP でない鋼管(STK400)・丸棒・族のフレーム・六角ボルトは notPipe', () => {
    const stk = ALL_STEEL_PRODUCTS.find((row) => row.catalog === 'steelPipe' && row.materialGrade === 'STK400');
    const round = ALL_STEEL_PRODUCTS.find((row) => row.catalog === 'roundBar');
    const frame = REGISTRY.loaded('t-slot-frame-s6');
    const frameRow = frame?.rows[0];
    if (stk === undefined || round === undefined || frame === undefined || frameRow === undefined) throw new Error('rows missing');
    const sources = [pipeSource(stk.key, '1000'), pipeSource(round.key, '1000'), createCatalogItemSource(frame, frameRow, { length: '1000' }),
      createStandardPartSource('hexBolt', 'M8', { length: '40', dimensionSeries: 'annexJA', threadSeries: 'coarse' })];
    for (const source of sources) expect(accessoryCandidatesForSource(source, 'pipe-end-fittings', REGISTRY)).toEqual({ ok: false, reason: 'notPipe' });
  });
});

describe('K-28 束 3 鋼管の端の継手の付け方', () => {
  it('エルボを両端に全長で付けると、管は 1000 − 2 × 27.61 になり、エルボの中心が線の両端に来て、枝は turn 1 で +Y を向く', () => {
    const { document, hostId } = withPipe();
    const applied = applyAccessorySet(document, hostId, 'pipe-end-fittings',
      { ends: 'both', endReference: 'overall', itemKey: 'elbow-25A', familyId: 'pipe-fitting-elbow', turn: 1 }, REGISTRY);
    if (!applied.ok) throw new Error(applied.reason);
    const next = applied.value.document;
    const host = componentOf(next, hostId);
    expect(lengthOf(host)).toBe('944.78');
    expectNear(positionOf(host), [10, 20, 30 + 27.61]);
    const [start, end] = applied.value.componentIds.map((id) => componentOf(next, id));
    if (start === undefined || end === undefined) throw new Error('elbows missing');
    expectNear(positionOf(start), [10, 20, 30]);
    expectNear(positionOf(end), [10, 20, 1030]);
    expectDirection(start, [0, 0, 1], [0, 0, 1]);
    expectDirection(end, [0, 0, 1], [0, 0, -1]);
    expectDirection(start, [1, 0, 0], [0, 1, 0]);
    expectDirection(end, [1, 0, 0], [0, 1, 0]);
    expect([start.name, end.name]).toEqual(['エルボ 25A (Rc1):1', 'エルボ 25A (Rc1):2']);
    expect(next.accessorySets).toEqual([{ id: 'accessory-1', setId: 'pipe-end-fittings', hostComponentId: hostId,
      accessories: [{ componentId: start.id, role: 'startFitting' }, { componentId: end.id, role: 'endFitting' }],
      choices: { ends: 'both', endReference: 'overall', itemKey: 'elbow-25A', familyId: 'pipe-fitting-elbow', turn: 1 } }]);
    expect(next.schemaVersion).toBeGreaterThanOrEqual(23);
    const groups = [host, start, end].map((component) => component.rigidGroupId);
    expect(groups[0]).toBeTruthy();
    expect(new Set(groups).size).toBe(1);
  });

  it('ソケットを本体の長さで付けると管はそのままで、端から a 入った所から外へ出る。記録は枝の向きを持たない', () => {
    const { document, hostId } = withPipe();
    const applied = applyAccessorySet(document, hostId, 'pipe-end-fittings',
      { ends: 'both', endReference: 'member', itemKey: 'socket-25A', familyId: 'pipe-fitting-socket', turn: 2 }, REGISTRY);
    if (!applied.ok) throw new Error(applied.reason);
    const next = applied.value.document;
    expect(lengthOf(componentOf(next, hostId))).toBe('1000');
    const [start, end] = applied.value.componentIds.map((id) => componentOf(next, id));
    if (start === undefined || end === undefined) throw new Error('sockets missing');
    expectNear(positionOf(start), [10, 20, 30 + 10.39 - 45]);
    expectNear(positionOf(end), [10, 20, 30 + 1000 - 10.39]);
    expect(next.accessorySets?.[0]?.choices).toEqual({ ends: 'both', endReference: 'member', itemKey: 'socket-25A', familyId: 'pipe-fitting-socket' });
  });

  it('キャップを始点だけに付けると開いた端が管へ向き、フランジ 10K を終点だけに全長で付けると管は短くならず外の面が管の端に揃う', () => {
    const capped = withPipe();
    const cap = applyAccessorySet(capped.document, capped.hostId, 'pipe-end-fittings',
      { ends: 'start', endReference: 'overall', itemKey: 'cap-25A', familyId: 'pipe-fitting-cap' }, REGISTRY);
    if (!cap.ok) throw new Error(cap.reason);
    const capComponent = componentOf(cap.value.document, cap.value.componentIds[0] ?? '');
    expect(lengthOf(componentOf(cap.value.document, capped.hostId))).toBe('982.39');
    expectNear(positionOf(componentOf(cap.value.document, capped.hostId)), [10, 20, 30 + 17.61]);
    expectNear(positionOf(capComponent), [10, 20, 30 + 17.61 + 10.39]);
    expectDirection(capComponent, [0, 0, 1], [0, 0, -1]);
    const flanged = withPipe();
    const flange = applyAccessorySet(flanged.document, flanged.hostId, 'pipe-end-fittings',
      { ends: 'end', endReference: 'overall', itemKey: 'flange-10k-25A', familyId: 'pipe-flange-10k' }, REGISTRY);
    if (!flange.ok) throw new Error(flange.reason);
    expect(lengthOf(componentOf(flange.value.document, flanged.hostId))).toBe('1000');
    expectNear(positionOf(componentOf(flange.value.document, flange.value.componentIds[0] ?? '')), [10, 20, 30 + 1000 - 14]);
  });

  it('チーズは通しの腕の一方に管が入り、枝は turn 0 で終点は −X・始点は +X を向く', () => {
    const { document, hostId } = withPipe();
    const applied = applyAccessorySet(document, hostId, 'pipe-end-fittings',
      { ends: 'both', endReference: 'member', itemKey: 'tee-25A', familyId: 'pipe-fitting-tee' }, REGISTRY);
    if (!applied.ok) throw new Error(applied.reason);
    const [start, end] = applied.value.componentIds.map((id) => componentOf(applied.value.document, id));
    if (start === undefined || end === undefined) throw new Error('tees missing');
    expectNear(positionOf(start), [10, 20, 30 + 10.39 - 38]);
    expectNear(positionOf(end), [10, 20, 30 + 1000 - 10.39 + 38]);
    expectDirection(start, [-1, 0, 0], [0, 0, 1]);
    expectDirection(end, [-1, 0, 0], [0, 0, -1]);
    expectDirection(start, [0, 0, 1], [1, 0, 0]);
    expectDirection(end, [0, 0, 1], [-1, 0, 0]);
    expect(applied.value.document.accessorySets?.[0]?.choices.turn).toBe(0);
  });

  it('候補に無い行・族の違う行は unknownItem、全長で管が 0 以下になる時は invalidLength(文書は変えない)', () => {
    const { document, hostId } = withPipe('SGP:steelPipe:25A', '50');
    expect(applyAccessorySet(document, hostId, 'pipe-end-fittings',
      { ends: 'both', endReference: 'member', itemKey: 'elbow-25A', familyId: 'pipe-fitting-tee' }, REGISTRY)).toEqual({ ok: false, reason: 'unknownItem' });
    expect(applyAccessorySet(document, hostId, 'pipe-end-fittings',
      { ends: 'both', endReference: 'overall', itemKey: 'elbow-25A', familyId: 'pipe-fitting-elbow' }, REGISTRY)).toEqual({ ok: false, reason: 'invalidLength' });
  });
});

describe('K-28 束 3 鋼管の端の継手の付け直し・分割・統合', () => {
  function elbowed(): { readonly document: AssemblyDocument; readonly hostId: string; readonly ids: readonly string[] } {
    const { document, hostId } = withPipe();
    const applied = applyAccessorySet(document, hostId, 'pipe-end-fittings',
      { ends: 'both', endReference: 'member', itemKey: 'elbow-25A', familyId: 'pipe-fitting-elbow', turn: 1 }, REGISTRY);
    if (!applied.ok) throw new Error(applied.reason);
    return { document: applied.value.document, hostId, ids: applied.value.componentIds };
  }
  const withHostSource = (document: AssemblyDocument, hostId: string, source: AssemblyComponent['source']): AssemblyDocument =>
    ({ ...document, components: document.components.map((component) => (component.id === hostId ? { ...component, source } : component)) });

  it('管の長さを 1200 にすると、終点のエルボだけが新しい端へ動く。何も変えなければ同じ文書を返す', () => {
    const { document, hostId, ids } = elbowed();
    expect(syncAccessorySets(document, REGISTRY)).toEqual({ ok: true, document });
    const longer = syncAccessorySets(withHostSource(document, hostId, pipeSource('SGP:steelPipe:25A', '1200')), REGISTRY);
    if (!longer.ok) throw new Error(longer.reason);
    expectNear(positionOf(componentOf(longer.document, ids[0] ?? '')), [10, 20, 30 + 10.39 - 38]);
    expectNear(positionOf(componentOf(longer.document, ids[1] ?? '')), [10, 20, 30 + 1200 - 10.39 + 38]);
  });

  it('管の呼びを 32A に替えると、同じ族の 32A の行へ替えて置き直す。200A には合う行が無いので理由を出す', () => {
    const { document, hostId, ids } = elbowed();
    const changed = syncAccessorySets(withHostSource(document, hostId, pipeSource('SGP:steelPipe:32A', '1000')), REGISTRY);
    if (!changed.ok) throw new Error(changed.reason);
    const end = componentOf(changed.document, ids[1] ?? '');
    expect(end.source.kind === 'standardPart' ? end.source.options.item : null).toBe('elbow-32A');
    expectNear(positionOf(end), [10, 20, 30 + 1000 - 12.7 + 46]);
    expect(changed.document.accessorySets?.[0]?.choices).toEqual({ ends: 'both', endReference: 'member', itemKey: 'elbow-32A',
      familyId: 'pipe-fitting-elbow', turn: 1 });
    const large = withHostSource(document, hostId, pipeSource('SGP:steelPipe:200A', '1000'));
    expect(syncAccessorySets(large, REGISTRY)).toEqual({ ok: false, reason: 'noMatchingFitting', recordId: 'accessory-1' });
    expect(accessoryIssues(large, REGISTRY)).toEqual([{ recordId: 'accessory-1', hostComponentId: hostId, reason: 'noMatchingFitting' }]);
  });

  it('分割は終点の継手を後ろの管の記録へ移し、統合は接する端に継手があれば断る。指定の違う継手どうしは 1 つの記録にまとめない', () => {
    const { document, hostId, ids } = elbowed();
    const split = splitAccessorySets(document, hostId, 'pipe-2');
    expect(split.accessorySets?.map((record) => [record.hostComponentId, record.choices.ends, record.accessories.map((item) => item.role)]))
      .toEqual([[hostId, 'start', ['startFitting']], ['pipe-2', 'end', ['endFitting']]]);
    expect(mergeAccessorySets(document, hostId, 'pipe-2')).toEqual({ ok: false, reason: 'jointHasAccessory' });
    const startOnly: AssemblyDocument = { ...document, accessorySets: [{ id: 'accessory-1', setId: 'pipe-end-fittings', hostComponentId: hostId,
      accessories: [{ componentId: ids[0] ?? '', role: 'startFitting' }], choices: { ends: 'start', endReference: 'member', itemKey: 'elbow-25A',
        familyId: 'pipe-fitting-elbow', turn: 1 } }, { id: 'accessory-2', setId: 'pipe-end-fittings', hostComponentId: 'pipe-2',
      accessories: [{ componentId: ids[1] ?? '', role: 'endFitting' }], choices: { ends: 'end', endReference: 'member', itemKey: 'socket-25A',
        familyId: 'pipe-fitting-socket' } }] };
    const merged = mergeAccessorySets(startOnly, hostId, 'pipe-2');
    if (!merged.ok) throw new Error(merged.reason);
    expect(merged.document.accessorySets?.map((record) => [record.id, record.hostComponentId, record.choices.familyId]))
      .toEqual([['accessory-1', hostId, 'pipe-fitting-elbow'], ['accessory-2', hostId, 'pipe-fitting-socket']]);
  });
});
