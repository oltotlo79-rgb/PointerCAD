/**
 * 置いた部材の分割と統合(E-11)の店の側: 選んだ 1 本を分けると 2 本になって両方が選ばれ、Undo 1 回で戻り、2 本をまとめると
 * 1 本に戻る事。選んでいない・2 本以上を分けようとした・位置が数でない時は何も変えずに理由を返し、理由の文に数が入る事。
 */
import {
  addComponent, createAssemblyDocument, createCatalogItemSource, createComponentFor, EMPTY_PART_LIBRARY, PRODUCT_CATALOG_REGISTRY,
} from '@pointercad/model';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { memberSplitMergeMessage, mergeSelectedMembers, splitSelectedMember } from './memberSplitMergeActions.js';

const FAMILY_ID = 't-slot-frame-series';

/** 長さ 1000 の系列の溝幅 6 20×20 を 1 本置いたアセンブリを開き、その部品を選ぶ。 */
function openWithFrame(): string {
  const family = PRODUCT_CATALOG_REGISTRY.loaded(FAMILY_ID);
  const row = family?.rows.find((candidate) => candidate.key === 's6-20x20');
  if (family === undefined || row === undefined) throw new Error('族が読めません');
  const empty = createAssemblyDocument('分割');
  useAppStore.getState().openAssembly(empty, EMPTY_PART_LIBRARY);
  const member = createComponentFor(empty, createCatalogItemSource(family, row, { length: '1000' }), { partName: '溝幅 6 20×20' });
  useAppStore.getState().applyAssembly(addComponent(empty, member));
  useAppStore.getState().setSelection([member.id]);
  return member.id;
}

beforeAll(async () => { await PRODUCT_CATALOG_REGISTRY.ensure([FAMILY_ID]); });
beforeEach(resetTestStore);

describe('部材を分ける・まとめる(店の側)', () => {
  it('分けると 400 と 600 の 2 本になって両方が選ばれ、Undo 1 回で戻り、やり直して 2 本をまとめると 1000 の 1 本', () => {
    const id = openWithFrame();
    expect(splitSelectedMember('200*2')).toEqual({ kind: 'split', lengths: [400, 600] });
    const after = useAppStore.getState();
    expect(after.assembly?.components).toHaveLength(2);
    expect(after.selection).toEqual(after.assembly?.components.map((component) => component.id));
    useAppStore.getState().undoAssembly();
    expect(useAppStore.getState().assembly?.components.map((component) => component.id)).toEqual([id]);
    useAppStore.getState().redoAssembly();
    useAppStore.getState().setSelection(useAppStore.getState().assembly?.components.map((component) => component.id) ?? []);
    expect(mergeSelectedMembers()).toEqual({ kind: 'merged', lengths: [1000] });
    expect(useAppStore.getState().assembly?.components.map((component) => component.id)).toEqual([id]);
  });

  it('選んでいない・2 本を分けようとした・位置が数でない時は何も変えずに理由', () => {
    openWithFrame();
    const before = useAppStore.getState().assembly;
    expect(splitSelectedMember('abc')).toMatchObject({ kind: 'refused', reason: 'badNumber' });
    useAppStore.getState().setSelection([]);
    expect(splitSelectedMember('400')).toMatchObject({ kind: 'refused', reason: 'noSelection' });
    expect(mergeSelectedMembers()).toMatchObject({ kind: 'refused', reason: 'noSelection' });
    expect(useAppStore.getState().assembly).toBe(before);
  });

  it('結果の文: 分けた長さ・まとめた長さ・指されている記録の数が入る', () => {
    expect(memberSplitMergeMessage({ kind: 'split', lengths: [400, 600] }))
      .toEqual({ role: 'status', text: t('catalog.memberSplit.split').replace('{first}', '400').replace('{second}', '600') });
    expect(memberSplitMergeMessage({ kind: 'merged', lengths: [1000] }).text).toBe(t('catalog.memberSplit.merged').replace('{length}', '1000'));
    expect(memberSplitMergeMessage({ kind: 'refused', reason: 'referenced', count: 2 }))
      .toEqual({ role: 'alert', text: t('catalog.memberSplit.reason.referenced').replace('{count}', '2') });
  });
});
