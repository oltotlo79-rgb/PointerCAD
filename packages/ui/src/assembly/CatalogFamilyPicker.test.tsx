/**
 * 選ぶ窓の「機械要素」(登録口の族、K4a のカムフォロア・巻きブシュ): 分類で切り替わり、種類 → 呼び → 置くで、
 * 族の保存の形の部品が店(store)のアセンブリに入る事。Node の検査なので、useState は検査の中で受け取り、
 * 本物の受け口(onChange・onSubmit・onKeyDown)を呼んで、店の変化を見る(StandardPartPickerPanel.test.tsx と同じ考え)。
 */
import React, { Children, isValidElement, type ReactElement, type ReactNode, type SetStateAction } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAssemblyDocument, PRODUCT_CATALOG_REGISTRY, type StandardPartSource } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImportedReactTypes from 'react';

import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { CatalogFamilyPicker, type CatalogFamilyPickerProps } from './CatalogFamilyPicker.js';
import {
  ALUMINUM_FRAME_PICKER_CATEGORY, catalogFamilyEntries, catalogRowLabel, commitCatalogItemChoice, familyKindKey,
  MECHANICAL_PICKER_CATEGORY, PIPING_PICKER_CATEGORY, type FamilyPickerCategory,
} from './catalogFamilyChoices.js';
import { CatalogStockTable } from './CatalogStockTable.js';
import { FramePanelDetails } from './FramePanelDetails.js';
import { FrameMemberTools } from './FrameMemberTools.js';
import { PlacePointButton } from './PlacePointButton.js';
import { StandardPartPicker } from './StandardPartPickerPanel.js';

interface HookState { readonly values: unknown[]; index: number }

const hooks = vi.hoisted(() => ({ current: null as HookState | null }));
const newHookState = (): HookState => ({ values: [], index: 0 });
let pickerHooks = newHookState();
let familyHooks: { readonly key: React.Key | null; readonly state: HookState } | null = null;
vi.mock('react', async (importOriginal) => {
  const original = await importOriginal<typeof ImportedReactTypes>();
  return { ...original, useState: <S,>(initial: S | (() => S)) => {
    const state = hooks.current;
    if (state === null) return original.useState(initial);
    const index = state.index++;
    if (index === state.values.length) state.values.push(typeof initial === 'function' ? (initial as () => S)() : initial);
    return [state.values[index] as S, (next: SetStateAction<S>) => {
      state.values[index] = typeof next === 'function' ? (next as (previous: S) => S)(state.values[index] as S) : next;
    }];
  } };
});

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  const found: Element[] = [];
  Children.forEach(node, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return;
    found.push(child);
    found.push(...elements(child.props.children as ReactNode));
  });
  return found;
}
function renderComponent(state: HookState, component: () => ReactNode): Element[] {
  state.index = 0;
  let tree: ReactNode = null;
  function Probe(): null { tree = component(); return null; }
  hooks.current = state;
  try { renderToStaticMarkup(<Probe />); }
  finally { hooks.current = null; }
  return elements(tree);
}

/** 親と族の窓の状態を分け、React と同じく子の key が変われば作り直す。 */
function render(): Element[] {
  const nodes = renderComponent(pickerHooks, StandardPartPicker);
  const root = nodes[0];
  if (root?.type !== CatalogFamilyPicker) { familyHooks = null; return nodes; }
  if (familyHooks === null || familyHooks.key !== root.key) familyHooks = { key: root.key, state: newHookState() };
  const props = root.props as unknown as CatalogFamilyPickerProps;
  return [root, ...renderComponent(familyHooks.state, () => CatalogFamilyPicker(props))];
}

/** 切断の一覧の表(族の窓の中の部品)を描いて、その中身を返す。 */
function stockTable(): Element[] {
  return renderComponent(newHookState(), CatalogStockTable);
}
function one(nodes: Element[], predicate: (element: Element) => boolean): Element {
  const matches = nodes.filter(predicate);
  expect(matches).toHaveLength(1);
  return matches[0];
}
function select(nodes: Element[], title: Parameters<typeof t>[0]): Element {
  return one(nodes, (element) => element.type === 'select' && element.props.title === t(title));
}
function options(element: Element): Element[] {
  return elements(element.props.children as ReactNode).filter((child) => child.type === 'option');
}
function change(element: Element, value: string): Element[] {
  (element.props.onChange as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value } });
  return render();
}
function submit(nodes: Element[]): StandardPartSource | null {
  const before = useAppStore.getState().assembly?.components.length ?? 0;
  const form = one(nodes, (element) => element.type === 'form');
  const preventDefault = vi.fn();
  (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  const components = useAppStore.getState().assembly?.components ?? [];
  if (components.length === before) return null;
  const source = components.at(-1)?.source;
  return source?.kind === 'standardPart' ? source : null;
}
const mechanical = (): Element[] => change(select(render(), 'assembly.guide.standardCategory'), MECHANICAL_PICKER_CATEGORY);
const loadAll = (): Promise<void> => PRODUCT_CATALOG_REGISTRY.ensure(PRODUCT_CATALOG_REGISTRY.entries.map((entry) => entry.id));
/**
 * 分類の族の種類の名前(登録の表の並び)。一覧を手で写さず登録の表から作る(族を足しても、この検査を直さなくてよい)。
 * どの種類の鍵も i18n にある事も確かめる(無い鍵は分類の欄の名前に置き換わってしまう)。
 */
function registeredKindNames(group: FamilyPickerCategory): string[] {
  return catalogFamilyEntries(group).map((entry) => {
    expect(familyKindKey(entry.kindKey), entry.id).toBe(entry.kindKey);
    return t(familyKindKey(entry.kindKey));
  });
}

beforeEach(() => {
  pickerHooks = newHookState(); familyHooks = null;
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  useAppStore.getState().openAssembly(createAssemblyDocument('機械要素の選択'));
  expect(useAppStore.getState().openStandardPartPicker()).toBe(true);
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

it('注文寸法の板だけ枠への配置を表示し、材質の変更に追従する', async () => {
  await PRODUCT_CATALOG_REGISTRY.ensure(['panel-board-order', 'panel-board-fixed']);
  let nodes = change(select(render(), 'assembly.guide.standardCategory'), ALUMINUM_FRAME_PICKER_CATEGORY);
  nodes = change(select(nodes, 'catalog.frame.kindGuide'), 'panel-board-order');
  const materials = options(select(nodes, 'catalog.mechanical.materialGuide'));
  expect(materials.length).toBeGreaterThan(1);
  const initialKey = select(nodes, 'catalog.mechanical.sizeGuide').props.value;
  expect(one(nodes, (item) => item.type === FramePanelDetails).props.catalogItemKey).toBe(initialKey);
  nodes = change(select(nodes, 'catalog.mechanical.materialGuide'), String(materials[1]?.props.value));
  const nextKey = select(nodes, 'catalog.mechanical.sizeGuide').props.value;
  expect(nextKey).not.toBe(initialKey);
  expect(one(nodes, (item) => item.type === FramePanelDetails).props.catalogItemKey).toBe(nextKey);
  nodes = change(select(nodes, 'catalog.frame.kindGuide'), 'panel-board-fixed');
  expect(nodes.some((item) => item.type === FramePanelDetails)).toBe(false);
});

describe('選ぶ窓の機械要素', () => {
  it('族を選び直すと以前の置く点の指定を閉じ、線材の欄を出さない', async () => {
    await loadAll();
    const nodes = mechanical();
    const control = one(nodes, (element) => element.type === PlacePointButton);
    const createPlacement = control.props.placement as NonNullable<React.ComponentProps<typeof PlacePointButton>['placement']>;
    const placement = createPlacement();
    if (!placement.ok) throw new Error(placement.reason);
    const state = useAppStore.getState();
    state.toggleComponentPick('placementPoint', [], placement.value);
    expect(useAppStore.getState().assemblyComponentPick?.placement).toBe(placement.value);
    const form = one(nodes, (element) => element.type === 'form');
    (form.props.onChangeCapture as () => void)();
    const updated = change(select(nodes, 'catalog.mechanical.kindGuide'), 'wrapped-bush');
    expect(updated.some((element) => element.type === FrameMemberTools)).toBe(false);
    expect(useAppStore.getState().answerComponentPickPoint([20, 40, 0])).toBe(false);
    expect(useAppStore.getState().assembly).toBe(state.assembly);
  });

  it('分類の欄の最後に「機械要素」があり、選ぶと機械要素の窓に替わり、分類を戻すと今の窓に戻る', () => {
    const category = select(render(), 'assembly.guide.standardCategory');
    expect(category.props.value).toBe('hexBolt');
    const categories = options(category);
    expect(categories.at(-1)?.props.value).toBe(MECHANICAL_PICKER_CATEGORY);
    expect(categories.at(-1)?.props.children).toBe(t('catalog.mechanical.category'));
    let nodes = mechanical();
    expect(nodes[0]?.type).toBe(CatalogFamilyPicker);
    expect(select(nodes, 'assembly.guide.standardCategory').props.value).toBe(MECHANICAL_PICKER_CATEGORY);
    const initialFamily = catalogFamilyEntries(MECHANICAL_PICKER_CATEGORY)[0]?.id;
    expect(select(nodes, 'catalog.mechanical.kindGuide').props.value).toBe(initialFamily);
    const otherFamily = catalogFamilyEntries(MECHANICAL_PICKER_CATEGORY)[1]?.id;
    if (otherFamily === undefined) throw new Error('Expected a second mechanical family');
    nodes = change(select(nodes, 'catalog.mechanical.kindGuide'), otherFamily);
    expect(select(nodes, 'catalog.mechanical.kindGuide').props.value).toBe(otherFamily);
    nodes = change(select(nodes, 'assembly.guide.standardCategory'), 'hexNut');
    expect(nodes.some((item) => item.type === CatalogFamilyPicker)).toBe(false);
    expect(select(nodes, 'assembly.guide.standardCategory').props.value).toBe('hexNut');
    expect(select(mechanical(), 'catalog.mechanical.kindGuide').props.value).toBe(initialFamily);
  });

  it('選んだ族の表だけが未読込なら、呼びの欄と点指定を出さず置かない', async () => {
    await PRODUCT_CATALOG_REGISTRY.ensure(['wrapped-bush']);
    const other = PRODUCT_CATALOG_REGISTRY.loaded('wrapped-bush');
    expect(other).toBeDefined();
    // Store reset leaves the registry's cache intact. Model this load state for this test only.
    vi.spyOn(PRODUCT_CATALOG_REGISTRY, 'loaded').mockImplementation(id => id === other?.id ? other : undefined);
    const nodes = change(select(mechanical(), 'catalog.mechanical.kindGuide'), 'cam-follower-stud-metric');
    expect(select(nodes, 'catalog.mechanical.kindGuide').props.value).toBe('cam-follower-stud-metric');
    expect(one(nodes, item => item.type === 'button' && item.props.type === 'submit').props.disabled).toBe(true);
    expect(one(nodes, item => item.type === PlacePointButton).props.placement).toBeNull();
    expect(nodes.some((item) => item.type === 'select' && item.props.title === t('catalog.mechanical.sizeGuide'))).toBe(false);
    expect(nodes.some((item) => item.type === 'p' && elements(item.props.children as ReactNode).length === 0
      && item.props.children === t('catalog.mechanical.notLoaded'))).toBe(true);
    expect(submit(nodes)).toBeNull();
    expect(render().some((item) => item.type === 'p' && item.props.role === 'alert'
      && item.props.children === t('assembly.standardPart.unknownChoice'))).toBe(true);
  });

  it('読み込んだ後は、種類の一覧と呼びの一覧が出て、選んだ行が族の保存の形で置かれ、Enter でもう 1 個置ける', async () => {
    await loadAll();
    let nodes = mechanical();
    const kinds = options(select(nodes, 'catalog.mechanical.kindGuide'));
    expect(kinds.map((item) => item.props.children)).toEqual(registeredKindNames(MECHANICAL_PICKER_CATEGORY));
    nodes = change(select(nodes, 'catalog.mechanical.kindGuide'), 'cam-follower-stud-metric');
    // 材質の違う行が無い族では、材質の欄も長さの欄も出さない。
    expect(nodes.some((item) => item.type === 'select' && item.props.title === t('catalog.mechanical.materialGuide'))).toBe(false);
    expect(nodes.some((item) => item.type === 'input')).toBe(false);
    const sizes = options(select(nodes, 'catalog.mechanical.sizeGuide'));
    expect(sizes).toHaveLength(17);
    expect(sizes[2]?.props.children).toBe('外径 16（ねじ M6×1.0、全長 28）');
    // 呼びの一覧は寸法だけで表す(型番を出さない)。
    for (const item of sizes) expect(String(item.props.children)).toMatch(/^外径 [0-9]+（ねじ M[0-9]+×[0-9.]+、全長 [0-9]+）$/u);
    nodes = change(select(nodes, 'catalog.mechanical.sizeGuide'), 'D16');
    const placed = submit(nodes);
    expect(placed).toEqual({ kind: 'standardPart', catalog: 'catalogItem', size: 'D16',
      options: { family: 'cam-follower-stud-metric', item: 'D16' },
      catalogRevision: 'cam-follower-2026-11-r1', generatorRevision: 'cam-follower-1' });
    // 部品の名前は族の partName に、置いた順の番号が付く(今の規格部品と同じ)。
    expect(useAppStore.getState().assembly?.components.at(-1)?.name).toBe('カムフォロア 外径16 M6×1.0:1');
    expect(useAppStore.getState().standardPartPickerOpen).toBe(true);
    expect(submit(render())).toEqual(placed);
    expect(useAppStore.getState().assembly?.components).toHaveLength(2);
  });

  it('種類を巻きブシュに替えると呼びは 116 行になり、内径・外径・長さの組で置ける', async () => {
    await loadAll();
    let nodes = change(select(mechanical(), 'catalog.mechanical.kindGuide'), 'wrapped-bush');
    const sizes = options(select(nodes, 'catalog.mechanical.sizeGuide'));
    expect(sizes).toHaveLength(116);
    expect(sizes[0]?.props.children).toBe('内径 3 × 外径 5 × 長さ 3');
    nodes = change(select(nodes, 'catalog.mechanical.sizeGuide'), 'd15-L8');
    expect(submit(nodes)).toEqual({ kind: 'standardPart', catalog: 'catalogItem', size: '15×17×8',
      options: { family: 'wrapped-bush', item: 'd15-L8' }, catalogRevision: 'wrapped-bush-2026-11-r1', generatorRevision: 'bush-1' });
    expect(useAppStore.getState().assembly?.components.at(-1)?.name).toBe('巻きブシュ 内径15×外径17×長さ8:1');
    // 表に無い行は選べない(欄の値は変わらない)。
    nodes = change(select(nodes, 'catalog.mechanical.sizeGuide'), 'd15-L9');
    expect(select(nodes, 'catalog.mechanical.sizeGuide').props.value).toBe('d15-L8');
  });

  it('Esc で窓を閉じ、IME の変換中の Enter では置かない', async () => {
    await loadAll();
    const nodes = mechanical();
    const form = one(nodes, (element) => element.type === 'form');
    (form.props.onCompositionStart as () => void)();
    const before = useAppStore.getState().assembly;
    (form.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: vi.fn() });
    expect(useAppStore.getState().assembly).toBe(before);
    (form.props.onCompositionEnd as () => void)();
    const preventDefault = vi.fn(), stopPropagation = vi.fn();
    (form.props.onKeyDown as (event: unknown) => void)({ key: 'Escape',
      nativeEvent: { key: 'Escape', keyCode: 27, isComposing: false }, preventDefault, stopPropagation });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(useAppStore.getState().standardPartPickerOpen).toBe(false);
  });

  it('平行ピンは 種類 → 材質 → 呼び → 長さ(自由に入力) で置け、範囲の外の長さは置かずに理由を出す', async () => {
    await loadAll();
    let nodes = change(select(mechanical(), 'catalog.mechanical.kindGuide'), 'parallel-pin');
    const materials = options(select(nodes, 'catalog.mechanical.materialGuide'));
    expect(materials.map((item) => item.props.value)).toEqual(['鋼', 'ステンレス鋼 A1']);
    expect(options(select(nodes, 'catalog.mechanical.sizeGuide'))).toHaveLength(20);
    expect(options(select(nodes, 'catalog.mechanical.sizeGuide'))[10]?.props.children).toBe('呼び径 6（面取り 約 1.2）');
    expect(nodes.some((item) => item.type === 'p' && item.props.children === t('catalog.mechanical.freeLength'))).toBe(true);
    const length = one(nodes, (item) => item.type === 'input' && item.props.title === t('catalog.mechanical.optionGuide'));
    expect(length.props.value).toBe('20');
    nodes = change(select(nodes, 'catalog.mechanical.materialGuide'), 'ステンレス鋼 A1');
    nodes = change(select(nodes, 'catalog.mechanical.sizeGuide'), 'A1-d6');
    nodes = change(one(nodes, (item) => item.type === 'input'), '10*2');
    expect(submit(nodes)).toEqual({ kind: 'standardPart', catalog: 'catalogItem', size: '6',
      options: { family: 'parallel-pin', item: 'A1-d6', length: '10*2' },
      catalogRevision: 'parallel-pin-2026-11-r1', generatorRevision: 'pin-1' });
    expect(useAppStore.getState().assembly?.components.at(-1)?.name).toBe('平行ピン 6×10*2（ステンレス鋼 A1）:1');
    nodes = change(one(render(), (item) => item.type === 'input'), '0');
    expect(submit(nodes)).toBeNull();
    nodes = render();
    expect(nodes.some((item) => item.type === 'p' && item.props.role === 'alert'
      && item.props.children === t('catalog.mechanical.invalidOption'))).toBe(true);
    expect(one(nodes, (item) => item.type === 'input').props['aria-invalid']).toBe(true);
  });

  it('ナットの拡張は種類ごとに呼びの一覧が出て、高さと対辺の文字で選べる', async () => {
    await loadAll();
    const nodes = change(select(mechanical(), 'catalog.mechanical.kindGuide'), 'hex-nut-thin');
    const sizes = options(select(nodes, 'catalog.mechanical.sizeGuide'));
    expect(sizes).toHaveLength(28);
    expect(sizes[0]?.props.children).toBe('M2（高さ 1.2、対辺 4、並目）');
    expect(nodes.some((item) => item.type === 'input')).toBe(false);
    expect(submit(nodes)?.options).toEqual({ family: 'hex-nut-thin', item: 'T-M2' });
  });

  it('ローラフォロアは内径・外径・幅の文字の一覧から選んで置ける(型番は出さない)', async () => {
    await loadAll();
    const nodes = change(select(mechanical(), 'catalog.mechanical.kindGuide'), 'roller-follower-yoke-metric');
    const sizes = options(select(nodes, 'catalog.mechanical.sizeGuide'));
    expect(sizes).toHaveLength(14);
    expect(sizes[0]?.props.children).toBe('内径 5 × 外径 16（幅 12）');
    expect(submit(nodes)?.options).toEqual({ family: 'roller-follower-yoke-metric', item: 'd5' });
  });

  it('アンギュラ玉軸受は呼び番号と寸法・接触角の文字の一覧から選んで置ける', async () => {
    await loadAll();
    let nodes = change(select(mechanical(), 'catalog.mechanical.kindGuide'), 'angular-contact-ball-bearing');
    const sizes = options(select(nodes, 'catalog.mechanical.sizeGuide'));
    expect(sizes).toHaveLength(183);
    expect(sizes.slice(0, 3).map((item) => item.props.children)).toEqual(['7000（内径 10 × 外径 26 × 幅 8、接触角 30°）',
      '7000B（内径 10 × 外径 26 × 幅 8、接触角 40°）', '7000C（内径 10 × 外径 26 × 幅 8、接触角 15°）']);
    nodes = change(select(nodes, 'catalog.mechanical.sizeGuide'), '7205B');
    expect(submit(nodes)).toEqual({ kind: 'standardPart', catalog: 'catalogItem', size: '7205B',
      options: { family: 'angular-contact-ball-bearing', item: '7205B' },
      catalogRevision: 'angular-contact-ball-bearing-2026-11-r1', generatorRevision: 'radial-bearing-1' });
    expect(useAppStore.getState().assembly?.components.at(-1)?.name).toBe('アンギュラ玉軸受 7205B:1');
  });

  it('スラスト玉軸受は呼び番号と内径・外径・高さの文字の一覧から選んで置ける', async () => {
    await loadAll();
    let nodes = change(select(mechanical(), 'catalog.mechanical.kindGuide'), 'thrust-ball-bearing-flat-seat');
    const sizes = options(select(nodes, 'catalog.mechanical.sizeGuide'));
    expect(sizes).toHaveLength(40);
    expect(sizes[0]?.props.children).toBe('51100（内径 10 × 外径 24 × 高さ 9）');
    nodes = change(select(nodes, 'catalog.mechanical.sizeGuide'), '51205');
    expect(submit(nodes)?.options).toEqual({ family: 'thrust-ball-bearing-flat-seat', item: '51205' });
    expect(useAppStore.getState().assembly?.components.at(-1)?.name).toBe('スラスト玉軸受 51205:1');
  });

  it('円筒ころ軸受は形式ごとの種類で、JIS の呼び番号と内径・外径・幅の文字の一覧から選んで置ける', async () => {
    await loadAll();
    let nodes = change(select(mechanical(), 'catalog.mechanical.kindGuide'), 'cylindrical-roller-bearing-nj');
    const sizes = options(select(nodes, 'catalog.mechanical.sizeGuide'));
    expect(sizes).toHaveLength(83);
    expect(sizes[0]?.props.children).toBe('NJ204（内径 20 × 外径 47 × 幅 14）');
    nodes = change(select(nodes, 'catalog.mechanical.sizeGuide'), 'NJ2306');
    expect(submit(nodes)?.options).toEqual({ family: 'cylindrical-roller-bearing-nj', item: 'NJ2306' });
    expect(useAppStore.getState().assembly?.components.at(-1)?.name).toBe('円筒ころ軸受 NJ2306:1');
  });

  it('内輪なしの針状ころ軸受は呼び番号ところの内接円径・外径・幅の文字の一覧から選んで置ける', async () => {
    await loadAll();
    let nodes = change(select(mechanical(), 'catalog.mechanical.kindGuide'), 'needle-roller-bearing-rna');
    const sizes = options(select(nodes, 'catalog.mechanical.sizeGuide'));
    expect(sizes).toHaveLength(34);
    expect(sizes[0]?.props.children).toBe('RNA4822（ころの内接円径 120 × 外径 140 × 幅 30）');
    nodes = change(select(nodes, 'catalog.mechanical.sizeGuide'), 'RNA49/22');
    expect(submit(nodes)?.options).toEqual({ family: 'needle-roller-bearing-rna', item: 'RNA49/22' });
    expect(useAppStore.getState().assembly?.components.at(-1)?.name).toBe('針状ころ軸受 RNA49/22:1');
  });

  it('皿小ねじは呼びと頭の寸法の文字の一覧と長さの欄で置け、頭の高さ以下の長さは置かずに理由を出す', async () => {
    await loadAll();
    let nodes = change(select(mechanical(), 'catalog.mechanical.kindGuide'), 'cross-recessed-countersunk-screw');
    const sizes = options(select(nodes, 'catalog.mechanical.sizeGuide'));
    expect(sizes).toHaveLength(9);
    expect(sizes[2]?.props.children).toBe('M3（頭の径 5.5 × 高さ 1.65、並目 ピッチ 0.5）');
    expect(nodes.some((item) => item.type === 'p' && item.props.children === t('catalog.mechanical.screw.hint'))).toBe(true);
    nodes = change(select(nodes, 'catalog.mechanical.sizeGuide'), 'M3');
    nodes = change(one(nodes, (item) => item.type === 'input'), '12');
    expect(submit(nodes)?.options).toEqual({ family: 'cross-recessed-countersunk-screw', item: 'M3', length: '12' });
    expect(useAppStore.getState().assembly?.components.at(-1)?.name).toBe('十字穴付き皿小ねじ M3×12（本体規格）:1');
    nodes = change(one(render(), (item) => item.type === 'input'), '1.65');
    expect(submit(nodes)).toBeNull();
    expect(render().some((item) => item.type === 'p' && item.props.role === 'alert'
      && item.props.children === t('catalog.mechanical.invalidOption'))).toBe(true);
  });

  it('止めねじは先の形ごとの種類で、呼びと六角穴・長さの範囲の文字の一覧から選び、範囲の外の長さは置かずに理由を出す', async () => {
    await loadAll();
    let nodes = change(select(mechanical(), 'catalog.mechanical.kindGuide'), 'set-screw-dog-point');
    const sizes = options(select(nodes, 'catalog.mechanical.sizeGuide'));
    expect(sizes).toHaveLength(12);
    expect(sizes[2]?.props.children).toBe('M3（六角穴の対辺 1.5、長さ 4〜16、並目 ピッチ 0.5）');
    expect(nodes.some((item) => item.type === 'p' && item.props.children === t('catalog.mechanical.setScrew.hint'))).toBe(true);
    // 長さを入れていない間は、選んだ呼びの範囲の最も短い長さを出し、そのまま置ける。
    expect(one(nodes, (item) => item.type === 'input').props.value).toBe('2.5');
    nodes = change(select(nodes, 'catalog.mechanical.sizeGuide'), 'M24');
    expect(one(nodes, (item) => item.type === 'input').props.value).toBe('25');
    expect(submit(nodes)?.options).toEqual({ family: 'set-screw-dog-point', item: 'M24', length: '25' });
    nodes = change(select(render(), 'catalog.mechanical.sizeGuide'), 'M3');
    nodes = change(one(nodes, (item) => item.type === 'input'), '5');
    expect(submit(nodes)?.options).toEqual({ family: 'set-screw-dog-point', item: 'M3', length: '5' });
    expect(useAppStore.getState().assembly?.components.at(-1)?.name).toBe('六角穴付き止めねじ 棒先 M3×5:1');
    nodes = change(one(render(), (item) => item.type === 'input'), '3');
    expect(submit(nodes)).toBeNull();
    expect(render().some((item) => item.type === 'p' && item.props.role === 'alert'
      && item.props.children === t('catalog.mechanical.invalidOption'))).toBe(true);
  });

  it('オイルシールは寸法指定の 1 行と 3 つの寸法の欄で作り、寸法は自由に入力と分かる説明を出し、作れない組は置かない', async () => {
    await loadAll();
    let nodes = change(select(mechanical(), 'catalog.mechanical.kindGuide'), 'oil-seal-specified');
    expect(options(select(nodes, 'catalog.mechanical.sizeGuide')).map((item) => item.props.children))
      .toEqual([t('catalog.mechanical.row.spring')]);
    expect(nodes.some((item) => item.type === 'p' && item.props.children === t('catalog.mechanical.sealRing.hint'))).toBe(true);
    const inputs = nodes.filter((item) => item.type === 'input');
    expect(inputs.map((item) => item.props.value)).toEqual(['30', '50', '10']);
    nodes = change(inputs[0], '35');
    expect(submit(nodes)?.options).toEqual({ family: 'oil-seal-specified', item: 'specified', innerDiameter: '35',
      outerDiameter: '50', width: '10' });
    expect(useAppStore.getState().assembly?.components.at(-1)?.name).toBe('オイルシール(寸法指定) 内径35×外径50×幅10:1');
    nodes = change(render().filter((item) => item.type === 'input')[0], '50');
    expect(submit(nodes)).toBeNull();
  });

  it('分類「アルミフレーム」は T スロットフレームを 8 つの欄で作り、置いた部品は切断の一覧の表に出て、作れない組は置かない', async () => {
    await loadAll();
    const categories = options(select(render(), 'assembly.guide.standardCategory')).map((item) => item.props.value);
    expect(categories.slice(-2)).toEqual([ALUMINUM_FRAME_PICKER_CATEGORY, MECHANICAL_PICKER_CATEGORY]);
    let nodes = change(select(render(), 'assembly.guide.standardCategory'), ALUMINUM_FRAME_PICKER_CATEGORY);
    expect(nodes[0]?.type).toBe(CatalogFamilyPicker);
    expect(select(nodes, 'assembly.guide.standardCategory').props.value).toBe(ALUMINUM_FRAME_PICKER_CATEGORY);
    // 種類の欄の名前はアルミフレームの分類の物(「機械要素の種類」と出さない)。
    expect(nodes.filter((item) => item.type === 'span' && item.props.className === 'pcad-field__label')
      .map((item) => item.props.children)).toContain(t('catalog.frame.kind'));
    expect(nodes.some((item) => item.type === 'span' && item.props.children === t('catalog.mechanical.kind'))).toBe(false);
    expect(options(select(nodes, 'catalog.frame.kindGuide')).map((item) => item.props.children))
      .toEqual(registeredKindNames(ALUMINUM_FRAME_PICKER_CATEGORY));
    expect(nodes.some((item) => item.type === 'p' && item.props.children === t('catalog.frame.tSlot.hint'))).toBe(true);
    expect(nodes.some((item) => item.type === CatalogStockTable)).toBe(true);
    const inputs = nodes.filter((item) => item.type === 'input');
    expect(inputs.map((item) => item.props.value)).toEqual(['40', '8', '4', '18', '7', '8', '2', '1000']);
    expect(submit(nodes)?.options).toEqual({ family: 't-slot-frame-specified', item: 'specified', width: '40', slotOpening: '8',
      shoulder: '4', slotInnerWidth: '18', slotDepth: '7', centerHole: '8', cornerRadius: '2', length: '1000' });
    expect(useAppStore.getState().assembly?.components.at(-1)?.name).toBe('アルミフレーム(寸法指定) 40角×1000:1');
    expect(useAppStore.getState().assembly?.components.at(-1)?.materialId).toBe('aluminum');
    nodes = change(render().filter((item) => item.type === 'input')[7], '500*2');
    expect(submit(nodes)?.options.length).toBe('500*2');
    const cells = stockTable().filter((item) => item.type === 'td').map((item) => item.props.children);
    expect(cells.slice(0, 5)).toEqual([t('catalog.frame.kind.tSlotSpecified'), '寸法指定', '1000', '2', '2000']);
    expect(String(cells[5])).toMatch(/^[0-9.]+ (g|kg)$/u);
    nodes = change(render().filter((item) => item.type === 'input')[1], '18');
    expect(submit(nodes)).toBeNull();
  });

  it('製造元の寸法に合わせたフレームの系列は、呼びと溝・単位質量の文字の一覧から選んで長さを入れて置け、切断の一覧の質量は単位質量 × 長さ', async () => {
    await loadAll();
    let nodes = change(select(render(), 'assembly.guide.standardCategory'), ALUMINUM_FRAME_PICKER_CATEGORY);
    nodes = change(select(nodes, 'catalog.frame.kindGuide'), 't-slot-frame-series');
    const sizes = options(select(nodes, 'catalog.mechanical.sizeGuide'));
    expect(sizes.map((item) => item.props.value)).toEqual(['s6-20x20', 's6-20x40', 's8-30x30', 's8-30x60', 's10-40x40', 's10-40x80']);
    expect(sizes[0]?.props.children).toBe('溝幅 6 20×20（溝の口 6・中の幅 12、単位質量 0.49 kg/m）');
    expect(nodes.some((item) => item.type === 'p' && item.props.children === t('catalog.frame.series.hint'))).toBe(true);
    expect(nodes.some((item) => item.type === CatalogStockTable)).toBe(true);
    expect(submit(nodes)?.options).toEqual({ family: 't-slot-frame-series', item: 's6-20x20', length: '1000' });
    expect(useAppStore.getState().assembly?.components.at(-1)?.name).toBe('アルミフレーム 溝幅 6 20×20×1000:1');
    const cells = stockTable().filter((item) => item.type === 'td').map((item) => item.props.children);
    expect(cells).toEqual([t('catalog.frame.kind.tSlotSeries'), '溝幅 6 20×20', '1000', '1', '1000', '490 g']);
  });

  it('コネクタの族は、選ぶ窓に出さない行(listed: false)を呼びの欄に出さず、材質の欄の材質も出す行だけから作る', async () => {
    await loadAll();
    let nodes = change(select(render(), 'assembly.guide.standardCategory'), ALUMINUM_FRAME_PICKER_CATEGORY);
    nodes = change(select(nodes, 'catalog.frame.kindGuide'), 'connector-box');
    const shown = PRODUCT_CATALOG_REGISTRY.loaded('connector-box')?.rows.filter((row) => row.listed !== false) ?? [];
    expect(PRODUCT_CATALOG_REGISTRY.loaded('connector-box')?.rows.length).toBeGreaterThan(shown.length);
    const materials = options(select(nodes, 'catalog.mechanical.materialGuide')).map((item) => item.props.value);
    expect(materials).toEqual([...new Set(shown.map((row) => row.materialLabel))]);
    for (const material of materials) {
      nodes = change(select(nodes, 'catalog.mechanical.materialGuide'), String(material));
      expect(options(select(nodes, 'catalog.mechanical.sizeGuide')).map((item) => item.props.value), String(material))
        .toEqual(shown.filter((row) => row.materialLabel === material).map((row) => row.key));
    }
  });

  it('アルミフレームの汎用の部品(直角のブラケット・T 溝用のナット)は欄で作って置け、部品に材質が付き、作れない組は置かない', async () => {
    await loadAll();
    let nodes = change(select(mechanical(), 'assembly.guide.standardCategory'), ALUMINUM_FRAME_PICKER_CATEGORY);
    nodes = change(select(nodes, 'catalog.frame.kindGuide'), 'angle-bracket-specified');
    expect(nodes.some((item) => item.type === 'p' && item.props.children === t('catalog.frame.bracket.hint'))).toBe(true);
    expect(nodes.some((item) => item.type === CatalogStockTable)).toBe(false);
    expect(nodes.filter((item) => item.type === 'input').map((item) => item.props.value)).toEqual(['40', '40', '20', '5', '10', '6', '25']);
    expect(submit(nodes)?.options.family).toBe('angle-bracket-specified');
    expect(useAppStore.getState().assembly?.components.at(-1)?.name).toBe('直角のブラケット(寸法指定) 40×40×幅20:1');
    expect(useAppStore.getState().assembly?.components.at(-1)?.materialId).toBe('aluminum');
    nodes = change(render().filter((item) => item.type === 'input')[6], '16');
    expect(submit(nodes)).toBeNull();
    nodes = change(select(render(), 'catalog.frame.kindGuide'), 'slot-nut-specified');
    const thread = one(nodes, (item) => item.type === 'select' && item.props.title === t('catalog.mechanical.optionGuide'));
    expect(thread.props.value).toBe('M5');
    nodes = change(thread, 'M6');
    expect(submit(nodes)?.options).toEqual({ family: 'slot-nut-specified', item: 'specified', thread: 'M6', flangeWidth: '16',
      nutLength: '16', flangeThickness: '4', neckWidth: '7', neckHeight: '2' });
    expect(useAppStore.getState().assembly?.components.at(-1)?.materialId).toBe('steel');
  });

  it('O リングは系列ごとの種類で、呼び番号と内径・太さの文字の一覧から選んで置ける', async () => {
    await loadAll();
    let nodes = change(select(mechanical(), 'catalog.mechanical.kindGuide'), 'o-ring-p');
    const sizes = options(select(nodes, 'catalog.mechanical.sizeGuide'));
    expect(sizes).toHaveLength(122);
    expect(sizes[8]?.props.children).toBe('P10A（内径 9.8 × 太さ 2.4）');
    expect(nodes.some((item) => item.type === 'input')).toBe(false);
    nodes = change(select(nodes, 'catalog.mechanical.sizeGuide'), 'P22.4');
    expect(submit(nodes)?.options).toEqual({ family: 'o-ring-p', item: 'P22.4' });
    expect(useAppStore.getState().assembly?.components.at(-1)?.name).toBe('O リング P22.4:1');
  });

  it('平座金は形ごとの種類で、呼び径と内径・外径・厚さの文字の一覧から選んで置ける', async () => {
    await loadAll();
    let nodes = change(select(mechanical(), 'catalog.mechanical.kindGuide'), 'plain-washer-small');
    const sizes = options(select(nodes, 'catalog.mechanical.sizeGuide'));
    expect(sizes).toHaveLength(21);
    expect(sizes[8]?.props.children).toBe('呼び径 8（内径 8.4 × 外径 15 × 厚さ 1.6）');
    nodes = change(select(nodes, 'catalog.mechanical.sizeGuide'), '8');
    expect(submit(nodes)?.options).toEqual({ family: 'plain-washer-small', item: '8' });
    expect(useAppStore.getState().assembly?.components.at(-1)?.name).toBe('平座金 小形 8:1');
  });

  it('圧縮コイルばねは 4 つの寸法の欄で作り、形が作れない組は置かずに理由を出す', async () => {
    await loadAll();
    let nodes = change(select(mechanical(), 'catalog.mechanical.kindGuide'), 'compression-spring');
    const inputs = nodes.filter((item) => item.type === 'input');
    expect(inputs.map((item) => item.props.value)).toEqual(['2', '16', '50', '8']);
    expect(nodes.some((item) => item.type === 'p' && item.props.children === t('catalog.mechanical.spring.hint'))).toBe(true);
    expect(submit(nodes)?.options).toEqual({ family: 'compression-spring', item: 'specified',
      wireDiameter: '2', meanDiameter: '16', freeLength: '50', totalCoils: '8' });
    nodes = change(render().filter((item) => item.type === 'input')[0], '16');
    expect(submit(nodes)).toBeNull();
    expect(render().some((item) => item.type === 'p' && item.props.role === 'alert'
      && item.props.children === t('catalog.mechanical.invalidOption'))).toBe(true);
  });

  it('置く中身の口は、読み込んでいない族・無い行・窓が閉じている時は置かない', async () => {
    await loadAll();
    expect(commitCatalogItemChoice('future-family', 'x')).toEqual({ ok: false, reason: 'unknownChoice' });
    expect(commitCatalogItemChoice('wrapped-bush', 'd15-L9')).toEqual({ ok: false, reason: 'unknownChoice' });
    expect(commitCatalogItemChoice('parallel-pin', 'St-d6', { length: '2' })).toEqual({ ok: false, reason: 'invalidOption' });
    useAppStore.getState().closeStandardPartPicker();
    expect(useAppStore.getState().placeCatalogItem('wrapped-bush', 'd15-L8')).toBe(false);
    expect(useAppStore.getState().assembly?.components).toHaveLength(0);
  });
});

describe('選ぶ窓の配管(K-28)', () => {
  it('分類「配管」はアルミフレームの前にあり、選ぶと継手 7 種類とフランジ 2 種類の 9 種類と、エルボの 14 の呼びを出す', async () => {
    await loadAll();
    const categories = options(select(render(), 'assembly.guide.standardCategory')).map((item) => item.props.value);
    expect(categories.slice(-3)).toEqual([PIPING_PICKER_CATEGORY, ALUMINUM_FRAME_PICKER_CATEGORY, MECHANICAL_PICKER_CATEGORY]);
    const nodes = change(select(render(), 'assembly.guide.standardCategory'), PIPING_PICKER_CATEGORY);
    expect(nodes[0]?.type).toBe(CatalogFamilyPicker);
    expect(select(nodes, 'assembly.guide.standardCategory').props.value).toBe(PIPING_PICKER_CATEGORY);
    expect(options(select(nodes, 'catalog.piping.kindGuide')).map((item) => item.props.children))
      .toEqual(registeredKindNames(PIPING_PICKER_CATEGORY));
    expect(options(select(nodes, 'catalog.mechanical.sizeGuide'))).toHaveLength(14);
  });

  it('配管の行の文字: キャップは高さと外径、プラグは頭の二面幅と高さ、ニップル・ブッシングは長さと二面幅、フランジは外径・厚さ・ボルト穴', async () => {
    const ids = ['pipe-fitting-cap', 'pipe-fitting-plug', 'pipe-fitting-nipple', 'pipe-fitting-bushing', 'pipe-flange-10k'];
    await PRODUCT_CATALOG_REGISTRY.ensure(ids);
    const label = (id: string, key: string): string => {
      const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
      const row = family?.rows.find((item) => item.key === key);
      return family === undefined || row === undefined ? '' : catalogRowLabel(family, row);
    };
    expect(label('pipe-fitting-cap', 'cap-25A')).toBe('25A (Rc1)（高さ 28 × 外径 41）');
    expect(label('pipe-fitting-plug', 'plug-25A')).toBe('25A (R1)（頭の二面幅 19 × 高さ 12）');
    expect(label('pipe-fitting-nipple', 'nipple-50A')).toBe('50A (R2)（長さ 66 × 二面幅 63）');
    expect(label('pipe-fitting-bushing', 'bushing-25x15A')).toBe('25A×15A (R1×Rc1/2)（長さ 27 × 二面幅 38）');
    expect(label('pipe-flange-10k', 'flange-10k-25A')).toBe('25A（外径 125 × 厚さ 14、ボルト穴 4-φ19、M16）');
  });
});
