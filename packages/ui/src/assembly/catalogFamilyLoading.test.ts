/**
 * 規格部品の族の表の読み込みを待つ口（文書を開く道・図面・選ぶ画面）。登録口は検査の中だけの物を使う
 * （製品の登録口 PRODUCT_CATALOG_REGISTRY には、まだ族が無い）。
 */
import { createStandardPartSource, type CatalogRegistry, type ComponentSource } from '@pointercad/model';
import { describe, expect, it, vi } from 'vitest';

import { t } from '../i18n/t.js';
import {
  catalogFamilyIdsOf, ensureDocumentCatalogFamilies, loadRegisteredCatalogFamilies, type CatalogLoadState,
} from './catalogFamilyLoading.js';

type StandardPartSource = Extract<ComponentSource, { readonly kind: 'standardPart' }>;

const catalogItem = (family: string, item = `${family}:1`): StandardPartSource => ({
  kind: 'standardPart', catalog: 'catalogItem', size: '1', options: { family, item },
  catalogRevision: `${family}-r1`, generatorRevision: `${family}-1`,
});

type Family = NonNullable<ReturnType<CatalogRegistry['loaded']>>;
/** 読み込み済みを表すだけの最小の族（行は持たない）。 */
const familyOf = (id: string): Family => ({ id, group: 'mechanical', kindKey: `kind.${id}`, catalogRevision: `${id}-r1`,
  generatorRevision: `${id}-1`, options: [], stock: 'count', diagram: 'pin', rows: [],
  build: () => null, nominalVolume: () => null, partName: () => id });

/** 族の表を読む約束を外から決められる、検査の中だけの登録口。 */
function fakeRegistry(ids: readonly string[], loaded: readonly string[] = []) {
  const done = new Set(loaded);
  let settle: { resolve: () => void; reject: (error: Error) => void } | null = null;
  const ensure = vi.fn((requested: Iterable<string>) => new Promise<void>((resolve, reject) => {
    settle = { resolve: () => { for (const id of requested) done.add(id); resolve(); }, reject };
  }));
  const registry: CatalogRegistry = {
    entries: ids.map((id) => ({ id, group: 'mechanical', kindKey: `kind.${id}`, load: () => Promise.resolve(familyOf(id)) })),
    entry: (id) => registry.entries.find((entry) => entry.id === id),
    loaded: (id) => (done.has(id) ? familyOf(id) : undefined),
    ensure,
  };
  return { registry, ensure, resolve: () => settle?.resolve(), reject: (message: string) => settle?.reject(new Error(message)) };
}

describe('文書の族の部品の族を読み込んで待つ', () => {
  it('族の部品の族の id を重なり無く出てきた順に集め、ほかの規格部品と族の id の無い保存は飛ばす', () => {
    const bolt = createStandardPartSource('hexBolt', 'M8', { length: '30' });
    const empty: StandardPartSource = { ...catalogItem('x'), options: { item: 'x:1' } };
    expect(catalogFamilyIdsOf([catalogItem('b'), bolt, catalogItem('a'), catalogItem('b', 'b:2'), empty])).toEqual(['b', 'a']);
  });

  it('族の部品が無い文書では登録口を呼ばず、待たない', async () => {
    const { registry, ensure } = fakeRegistry(['a']);
    const bolt = createStandardPartSource('hexBolt', 'M8', { length: '30' });
    await expect(ensureDocumentCatalogFamilies([bolt], registry)).resolves.toEqual([]);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('族の部品の族を 1 回の ensure で待ってから終わる', async () => {
    const { registry, ensure, resolve } = fakeRegistry(['a', 'b']);
    let finished = false;
    const waiting = ensureDocumentCatalogFamilies([catalogItem('a'), catalogItem('b'), catalogItem('a')], registry)
      .then((failures) => { finished = true; return failures; });
    await Promise.resolve();
    expect(ensure).toHaveBeenCalledTimes(1);
    expect([...ensure.mock.calls[0][0]]).toEqual(['a', 'b']);
    expect(finished).toBe(false);
    resolve();
    await expect(waiting).resolves.toEqual([]);
  });

  it('読み込みが断られた時は、帯に出す 150 字以内の文を 1 つ返し、例外にしない', async () => {
    const { registry, reject } = fakeRegistry(['a']);
    const waiting = ensureDocumentCatalogFamilies([catalogItem('a')], registry);
    await Promise.resolve();
    reject('network');
    const failures = await waiting;
    expect(failures).toEqual([t('catalog.loading.documentFailed')]);
    expect(failures[0].length).toBeLessThanOrEqual(150);
    // 帯は頭に「計算に失敗しました:」などを付けて出すので、文そのものは余裕を持って短い。
    expect(failures[0].length).toBeLessThanOrEqual(100);
    expect(failures[0]).not.toMatch(/catalogItem|family|network/u);
  });
});

describe('選ぶ画面を開いた時に登録口の全ての族を読み込む', () => {
  const run = (registry: CatalogRegistry, alive = () => true) => {
    const states: CatalogLoadState[] = [];
    const done = loadRegisteredCatalogFamilies(registry, (state) => { states.push(state); }, alive);
    return { states, done };
  };

  it('登録された族が無い時は何も読まず「なし」（窓に何も出さない）', async () => {
    const { registry, ensure } = fakeRegistry([]);
    const { states, done } = run(registry);
    await done;
    expect(states).toEqual(['none']);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('全て読み込み済みなら待たずに「済み」', async () => {
    const { registry, ensure } = fakeRegistry(['a', 'b'], ['a', 'b']);
    const { states, done } = run(registry);
    await done;
    expect(states).toEqual(['ready']);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('読み込み中 → 済み の順に知らせ、登録された全ての族を 1 回で読む', async () => {
    const { registry, ensure, resolve } = fakeRegistry(['a', 'b'], ['a']);
    const { states, done } = run(registry);
    expect(states).toEqual(['loading']);
    expect([...ensure.mock.calls[0][0]]).toEqual(['a', 'b']);
    resolve();
    await done;
    expect(states).toEqual(['loading', 'ready']);
  });

  it('断られた時は 読み込み中 → 失敗 の順に知らせる', async () => {
    const { registry, reject } = fakeRegistry(['a']);
    const { states, done } = run(registry);
    reject('definition');
    await done;
    expect(states).toEqual(['loading', 'failed']);
  });

  it('窓を閉じた後に終わった読み込みは、済みも失敗も知らせない', async () => {
    let open = true;
    const first = fakeRegistry(['a']);
    const ok = run(first.registry, () => open);
    open = false;
    first.resolve();
    await ok.done;
    expect(ok.states).toEqual(['loading']);
    const second = fakeRegistry(['a']);
    const ng = run(second.registry, () => false);
    second.reject('late');
    await ng.done;
    expect(ng.states).toEqual(['loading']);
  });
});
