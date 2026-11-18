/**
 * 規格部品の選ぶ窓の検索の欄(K-07a): 言葉で行を出し、↑↓・Enter・押すで選び直し、言葉がある時の Enter は置かず、Esc は言葉だけを消す事。
 * 選び直しで窓(今の 8 分類・鋼材・族の窓)の欄がその行になる事。Node の検査なので、useState は検査の中で受け取り、本物の受け口を呼ぶ
 * (CatalogFamilyPicker.test.tsx と同じ考え)。
 */
import React, { Children, isValidElement, type ReactElement, type ReactNode, type SetStateAction } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAssemblyDocument, PRODUCT_CATALOG_REGISTRY } from '@pointercad/model';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImportedReactTypes from 'react';

import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { CatalogFamilyPicker, type CatalogFamilyPickerProps } from './CatalogFamilyPicker.js';
import { MECHANICAL_PICKER_CATEGORY } from './catalogFamilyChoices.js';
import { pickerSearchEntries, searchPickerEntries, type PickerJumpTarget } from './catalogSearch.js';
import { PickerSearch } from './PickerSearch.js';
import { rememberPlacedPart } from './recentStandardParts.js';
import { StandardPartPicker } from './StandardPartPickerPanel.js';
import { standardPartChoices } from './standardPartPicker.js';

const hooks = vi.hoisted(() => ({ values: [] as unknown[], state: 0 }));
vi.mock('react', async (importOriginal) => {
  const original = await importOriginal<typeof ImportedReactTypes>();
  return { ...original, useState: <S,>(initial: S | (() => S)) => {
    const index = hooks.state++;
    if (index === hooks.values.length) hooks.values.push(typeof initial === 'function' ? (initial as () => S)() : initial);
    return [hooks.values[index] as S, (next: SetStateAction<S>) => {
      hooks.values[index] = typeof next === 'function' ? (next as (previous: S) => S)(hooks.values[index] as S) : next;
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
function one(nodes: Element[], predicate: (element: Element) => boolean): Element {
  const matches = nodes.filter(predicate);
  expect(matches).toHaveLength(1);
  return matches[0];
}

interface KeyEvent {
  readonly key: string;
  readonly nativeEvent: { readonly isComposing: boolean };
  readonly preventDefault: ReturnType<typeof vi.fn>;
  readonly stopPropagation: ReturnType<typeof vi.fn>;
}
const keyEvent = (key: string, isComposing = false): KeyEvent => ({ key, nativeEvent: { isComposing }, preventDefault: vi.fn(), stopPropagation: vi.fn() });

/** 検索の欄だけを描く(選んだ行は picked に入る)。 */
function searchHarness() {
  const picked: PickerJumpTarget[] = [];
  const render = (): Element[] => {
    hooks.state = 0;
    let tree: ReactNode = null;
    function Probe(): null { tree = PickerSearch({ onPick: (target) => { picked.push(target); } }); return null; }
    renderToStaticMarkup(<Probe />);
    return [...elements(tree)];
  };
  const input = (nodes: Element[]): Element => one(nodes, (element) => element.type === 'input');
  const typeText = (text: string): Element[] => {
    (input(render()).props.onChange as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value: text } });
    return render();
  };
  const press = (event: KeyEvent): Element[] => {
    (input(render()).props.onKeyDown as (event: KeyEvent) => void)(event);
    return render();
  };
  const optionsOf = (nodes: Element[]): Element[] => nodes.filter((element) => element.type === 'button' && element.props.role === 'option');
  return { picked, render, input, typeText, press, optionsOf };
}

const expected = (query: string) => searchPickerEntries(pickerSearchEntries(), query).entries.map((entry) => entry.target);

beforeAll(async () => { await PRODUCT_CATALOG_REGISTRY.ensure(PRODUCT_CATALOG_REGISTRY.entries.map((entry) => entry.id)); });
beforeEach(() => {
  hooks.values = []; hooks.state = 0;
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  useAppStore.getState().openAssembly(createAssemblyDocument('検索'));
  expect(useAppStore.getState().openStandardPartPicker()).toBe(true);
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('検索の欄', () => {
  it('言葉が無い時は結果を出さず、Enter・Esc は窓の決まり(置く・閉じる)に任せる', () => {
    const harness = searchHarness();
    const nodes = harness.render();
    expect(harness.input(nodes).props['aria-label']).toBe(t('assembly.standardPart.search.label'));
    expect(harness.input(nodes).props.className).not.toContain('pcad-field__input');
    expect(nodes.some((element) => element.props.role === 'listbox')).toBe(false);
    for (const key of ['Enter', 'Escape', 'ArrowDown']) {
      const event = keyEvent(key);
      harness.press(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
    }
    expect(harness.picked).toEqual([]);
  });

  it('言葉で行を出し、↑↓ で選ぶ行を回し、Enter で選び直して言葉を消す(置かない)', () => {
    const harness = searchHarness();
    let nodes = harness.typeText('六角ボルト M10');
    const targets = expected('六角ボルト M10');
    expect(harness.optionsOf(nodes)).toHaveLength(targets.length);
    expect(harness.optionsOf(nodes).map((option) => option.props['aria-selected'])).toEqual(targets.map((_, index) => index === 0));
    nodes = harness.press(keyEvent('ArrowUp'));
    expect(harness.optionsOf(nodes).at(-1)?.props['aria-selected']).toBe(true);
    harness.press(keyEvent('ArrowDown'));
    nodes = harness.press(keyEvent('ArrowDown'));
    expect(harness.optionsOf(nodes)[1]?.props['aria-selected']).toBe(true);
    const enter = keyEvent('Enter');
    nodes = harness.press(enter);
    expect(enter.preventDefault).toHaveBeenCalledOnce();
    expect(harness.picked).toEqual([targets[1]]);
    expect(harness.input(nodes).props.value).toBe('');
    expect(harness.optionsOf(nodes)).toEqual([]);
  });

  it('押した行へ選び直し、押しても欄から焦点を奪わない', () => {
    const harness = searchHarness();
    const nodes = harness.typeText('カムフォロア');
    const option = harness.optionsOf(nodes)[2];
    const mouseDown = { preventDefault: vi.fn() };
    (option?.props.onMouseDown as (event: typeof mouseDown) => void)(mouseDown);
    expect(mouseDown.preventDefault).toHaveBeenCalledOnce();
    (option?.props.onClick as () => void)();
    expect(harness.picked).toEqual([expected('カムフォロア')[2]]);
  });

  it('当てはまらない言葉では「当てはまる部品がありません」と出し、Enter で置かない。Esc は言葉だけを消し、窓へ伝えない', () => {
    const harness = searchHarness();
    let nodes = harness.typeText('当てはまらない zzz');
    expect(nodes.some((element) => element.type === 'p' && element.props.children === t('assembly.standardPart.search.none'))).toBe(true);
    const enter = keyEvent('Enter');
    harness.press(enter);
    expect(enter.preventDefault).toHaveBeenCalledOnce();
    expect(harness.picked).toEqual([]);
    const escape = keyEvent('Escape');
    nodes = harness.press(escape);
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(escape.stopPropagation).toHaveBeenCalledOnce();
    expect(harness.input(nodes).props.value).toBe('');
  });

  it('変換中のキーは扱わず、30 件を超えた分は数を出す', () => {
    const harness = searchHarness();
    harness.typeText('M');
    const composing = keyEvent('Enter', true);
    const nodes = harness.press(composing);
    expect(composing.preventDefault).not.toHaveBeenCalled();
    expect(harness.picked).toEqual([]);
    const total = searchPickerEntries(pickerSearchEntries(), 'M', 100000).entries.length;
    expect(harness.optionsOf(nodes)).toHaveLength(30);
    expect(nodes.some((element) => element.type === 'p' && element.props.children
      === t('assembly.standardPart.search.more').replace('{count}', String(total - 30)))).toBe(true);
  });

  it('欄が空の時は最近使った物を出し、押すと長さの値ごとその物へ選び直す。言葉を入れると隠す(K-07b)', () => {
    const harness = searchHarness();
    expect(harness.render().some((element) => element.props.role === 'group')).toBe(false);
    const [row] = expected('六角ナット M10');
    if (row?.kind !== 'standard') throw new Error('六角ナット M10 の行がありません。');
    const placed: PickerJumpTarget = { ...row, lengthSource: '45' };
    rememberPlacedPart(placed);
    let nodes = harness.render();
    expect(one(nodes, (element) => element.props.role === 'group').props['aria-label']).toBe(t('assembly.standardPart.recent.label'));
    const buttons = nodes.filter((element) => element.type === 'button' && element.props.title === t('assembly.standardPart.recent.guide'));
    expect(buttons).toHaveLength(1);
    (buttons[0]?.props.onClick as () => void)();
    expect(harness.picked).toEqual([placed]);
    nodes = harness.typeText('M10');
    expect(nodes.some((element) => element.props.role === 'group')).toBe(false);
  });
});

/** 今の窓を描き、木の根が族の窓なら、その中身も描いて返す(CatalogFamilyPicker.test.tsx と同じ)。 */
function renderPicker(): Element[] {
  hooks.state = 0;
  let tree: ReactNode = null;
  function Probe(): null { tree = StandardPartPicker(); return null; }
  renderToStaticMarkup(<Probe />);
  const root = elements(tree)[0];
  if (root?.type !== CatalogFamilyPicker) return elements(tree);
  const props = root.props as unknown as CatalogFamilyPickerProps;
  let inner: ReactNode = null;
  function Inner(): null { inner = CatalogFamilyPicker(props); return null; }
  renderToStaticMarkup(<Inner />);
  return [root, ...elements(inner)];
}
const select = (nodes: Element[], title: Parameters<typeof t>[0]): Element =>
  one(nodes, (element) => element.type === 'select' && element.props.title === t(title));
const jump = (nodes: Element[], target: PickerJumpTarget): Element[] => {
  (one(nodes, (element) => element.type === PickerSearch).props.onPick as (target: PickerJumpTarget) => void)(target);
  return renderPicker();
};

describe('選び直した窓の欄', () => {
  it('今の 8 分類の行へ選び直すと、分類・寸法系・呼びの欄がその行になる', () => {
    let nodes = renderPicker();
    const [target] = expected('六角ナット M10');
    expect(target?.kind).toBe('standard');
    if (target?.kind !== 'standard') return;
    nodes = jump(nodes, target);
    expect(select(nodes, 'assembly.guide.standardCategory').props.value).toBe('hexNut');
    expect(select(nodes, 'assembly.guide.standardSize').props.value).toBe(target.choiceKey);
    expect(standardPartChoices('hexNut', target.dimensionSeries ?? undefined).some((choice) => choice.key === target.choiceKey)).toBe(true);
  });

  it('鋼材の行へ選び直すと、材質・断面・呼びの欄がその行になる', () => {
    let nodes = renderPicker();
    nodes = jump(nodes, { kind: 'steel', material: 'SS400', shape: 'flatBar', choiceKey: 'steel:SS400:flatBar:FB 100×28', lengthSource: null });
    expect(select(nodes, 'assembly.guide.standardCategory').props.value).toBe('structuralSection');
    expect(select(nodes, 'assembly.steel.materialGuide').props.value).toBe('SS400');
    expect(select(nodes, 'assembly.steel.shapeGuide').props.value).toBe('flatBar');
    expect(select(nodes, 'assembly.guide.standardSize').props.value).toBe('steel:SS400:flatBar:FB 100×28');
  });

  it('族の行へ選び直すと族の窓が初めの値で作り直され、分類を替えると初めの値を捨てる', () => {
    let nodes = renderPicker();
    const target = expected('カムフォロア')[3];
    expect(target?.kind).toBe('family');
    if (target?.kind !== 'family') return;
    nodes = jump(nodes, target);
    const root = nodes[0];
    expect(root?.type).toBe(CatalogFamilyPicker);
    expect(root?.key).toBe(`${MECHANICAL_PICKER_CATEGORY}:1`);
    expect((root?.props as unknown as CatalogFamilyPickerProps).start).toEqual(target.start);
    expect(select(nodes, 'catalog.mechanical.kindGuide').props.value).toBe(target.start.familyId);
    expect(select(nodes, 'catalog.mechanical.sizeGuide').props.value).toBe(target.start.itemKey);
    (select(nodes, 'assembly.guide.standardCategory').props.onChange as (event: { currentTarget: { value: string } }) => void)(
      { currentTarget: { value: 'aluminumFrame' } });
    const after = renderPicker()[0];
    expect((after?.props as unknown as CatalogFamilyPickerProps).start).toBeNull();
    expect(after?.key).toBe('aluminumFrame:1');
  });

  it('最近使った物へ選び直すと、長さの欄(鋼材)と族の指定の値が置いた時の値に戻る(K-07b)', () => {
    let nodes = jump(renderPicker(),
      { kind: 'steel', material: 'SS400', shape: 'flatBar', choiceKey: 'steel:SS400:flatBar:FB 100×28', lengthSource: '2400' });
    expect(one(nodes, (element) => element.type === 'input' && element.props.title === t('assembly.guide.standardLength')).props.value)
      .toBe('2400');
    const row = expected('平行ピン')[0];
    if (row?.kind !== 'family') throw new Error('平行ピンの行がありません。');
    const spec = PRODUCT_CATALOG_REGISTRY.loaded(row.start.familyId)?.options.find((option) => option.optional !== true && option.kind !== 'choice');
    if (spec === undefined) throw new Error('平行ピンの長さの欄がありません。');
    nodes = jump(nodes, { ...row, start: { ...row.start, values: { [spec.key]: '24' } } });
    // 指定の欄は族の options の順に出るので、最初の入力の欄が spec の欄。
    expect(nodes.filter((element) => element.type === 'input' && element.props.title === t('catalog.mechanical.optionGuide'))[0]?.props.value)
      .toBe('24');
  });
});
