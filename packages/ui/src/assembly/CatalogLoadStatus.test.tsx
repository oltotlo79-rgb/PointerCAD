/**
 * 選ぶ画面の族の表の状態（読み込み中・済み・失敗）の表示と、窓を開いた時に読み込む口。
 * Node の検査なので、React の useState・useEffect は検査の中で受け取り、効果を手で流す（StandardPartPickerPanel.test.tsx と同じ考え）。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { PRODUCT_CATALOG_REGISTRY, type CatalogRegistry } from '@pointercad/model';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImportedReactTypes from 'react';

import { t } from '../i18n/t.js';
import { CatalogLoadStatus, useCatalogFamilies } from './CatalogLoadStatus.js';

interface HookRecord { state: unknown; effect: null | (() => void | (() => void)); deps: unknown[] }
const hooks = vi.hoisted((): HookRecord => ({ state: undefined, effect: null, deps: [] }));
vi.mock('react', async (importOriginal) => {
  const original = await importOriginal<typeof ImportedReactTypes>();
  return { ...original,
    useState: <S,>(initial: S) => {
      if (hooks.state === undefined) hooks.state = initial;
      return [hooks.state as S, (next: S) => { hooks.state = next; }];
    },
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => { hooks.effect = effect; hooks.deps = deps; },
  };
});

type Family = NonNullable<ReturnType<CatalogRegistry['loaded']>>;
const familyOf = (id: string): Family => ({ id, group: 'mechanical', kindKey: `kind.${id}`, catalogRevision: `${id}-r1`,
  generatorRevision: `${id}-1`, options: [], stock: 'count', diagram: 'pin', rows: [],
  build: () => null, nominalVolume: () => null, partName: () => id });

function pendingRegistry(ids: readonly string[]) {
  let settle: { resolve: () => void; reject: () => void } | null = null;
  const ensure = vi.fn(() => new Promise<void>((resolve, reject) => {
    settle = { resolve, reject: () => { reject(new Error('load failed')); } };
  }));
  const registry: CatalogRegistry = {
    entries: ids.map((id) => ({ id, group: 'mechanical', kindKey: `kind.${id}`, load: () => Promise.resolve(familyOf(id)) })),
    entry: (id) => registry.entries.find((entry) => entry.id === id),
    loaded: () => undefined,
    ensure,
  };
  return { registry, ensure, resolve: () => settle?.resolve(), reject: () => settle?.reject() };
}

const flush = async (): Promise<void> => { for (let index = 0; index < 5; index += 1) await Promise.resolve(); };

beforeEach(() => { hooks.state = undefined; hooks.effect = null; hooks.deps = []; });

describe('族の表の状態の 1 行', () => {
  it('なし は何も出さず、読み込み中・済み は status、失敗 は alert で 1 行を出す', () => {
    expect(renderToStaticMarkup(<CatalogLoadStatus state="none" />)).toBe('');
    expect(renderToStaticMarkup(<CatalogLoadStatus state="loading" />))
      .toBe(`<p class="pcad-popover__hint" role="status">${t('catalog.loading.inProgress')}</p>`);
    expect(renderToStaticMarkup(<CatalogLoadStatus state="ready" />))
      .toBe(`<p class="pcad-popover__hint" role="status">${t('catalog.loading.ready')}</p>`);
    expect(renderToStaticMarkup(<CatalogLoadStatus state="failed" />))
      .toBe(`<p class="pcad-popover__hint" role="alert">${t('catalog.loading.failed')}</p>`);
    for (const key of ['catalog.loading.inProgress', 'catalog.loading.ready', 'catalog.loading.failed'] as const) {
      expect(t(key).length).toBeLessThanOrEqual(150);
    }
  });
});

describe('窓で族の分類を選んだ時に、その分類の族の表を読み込む口', () => {
  it('窓が閉じている間は読み込まない', () => {
    const { registry, ensure } = pendingRegistry(['a']);
    expect(useCatalogFamilies(false, 'mechanical', registry)).toBe('none');
    expect(hooks.deps).toEqual([false, 'mechanical', registry]);
    expect(hooks.effect?.()).toBeUndefined();
    expect(ensure).not.toHaveBeenCalled();
  });

  it('従来の分類(六角ボルト・鋼材など。族の分類でない時)は、窓を開いていても族を 1 つも読まず なし のまま', async () => {
    const { registry, ensure } = pendingRegistry(['a']);
    expect(useCatalogFamilies(true, null, registry)).toBe('none');
    expect(hooks.effect?.()).toBeUndefined();
    await flush();
    expect(ensure).not.toHaveBeenCalled();
    expect(useCatalogFamilies(true, null, registry)).toBe('none');
  });

  it('開くと 読み込み中 → 済み になる', async () => {
    const { registry, ensure, resolve } = pendingRegistry(['a', 'b']);
    useCatalogFamilies(true, 'mechanical', registry);
    hooks.effect?.();
    expect(hooks.state).toBe('loading');
    expect(ensure).toHaveBeenCalledTimes(1);
    resolve();
    await flush();
    expect(hooks.state).toBe('ready');
    expect(useCatalogFamilies(true, 'mechanical', registry)).toBe('ready');
  });

  it('断られると 読み込み中 → 失敗 になる', async () => {
    const { registry, reject } = pendingRegistry(['a']);
    useCatalogFamilies(true, 'mechanical', registry);
    hooks.effect?.();
    reject();
    await flush();
    expect(hooks.state).toBe('failed');
  });

  it('閉じた（効果の後始末の）後に終わった読み込みは状態を書かない', async () => {
    const { registry, resolve } = pendingRegistry(['a']);
    useCatalogFamilies(true, 'mechanical', registry);
    const cleanup = hooks.effect?.();
    expect(hooks.state).toBe('loading');
    if (typeof cleanup !== 'function') throw new Error('expected a cleanup');
    cleanup();
    resolve();
    await flush();
    expect(hooks.state).toBe('loading');
  });

  it('族の無い登録口では なし のままで、窓の見た目を変えない', async () => {
    const { registry, ensure } = pendingRegistry([]);
    useCatalogFamilies(true, 'mechanical', registry);
    hooks.effect?.();
    await flush();
    expect(hooks.state).toBe('none');
    expect(ensure).not.toHaveBeenCalled();
  });

  it('製品の登録口では、分類「アルミフレーム」を選ぶとその分類の族だけを読み 読み込み中 → 済み になり、機械要素の族は読まない', async () => {
    const frames = PRODUCT_CATALOG_REGISTRY.entries.filter((entry) => entry.group === 'aluminumFrame').map((entry) => entry.id);
    const mechanical = PRODUCT_CATALOG_REGISTRY.entries.filter((entry) => entry.group === 'mechanical').map((entry) => entry.id);
    expect(frames.length).toBeGreaterThan(0);
    expect(mechanical.length).toBeGreaterThan(0);
    useCatalogFamilies(true, 'aluminumFrame');
    expect(hooks.deps).toEqual([true, 'aluminumFrame', PRODUCT_CATALOG_REGISTRY]);
    hooks.effect?.();
    expect(hooks.state).toBe('loading');
    await PRODUCT_CATALOG_REGISTRY.ensure(frames);
    await flush();
    expect(hooks.state).toBe('ready');
    // 族の鍵の重なりの確かめ(読む時の catalogFamilyIssues)は読んだ族について働き、読んでいない機械要素の族は読まれていない。
    expect(frames.every((id) => PRODUCT_CATALOG_REGISTRY.loaded(id) !== undefined)).toBe(true);
    expect(mechanical.some((id) => PRODUCT_CATALOG_REGISTRY.loaded(id) !== undefined)).toBe(false);
  });
});
