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
import { commitCatalogItemChoice, MECHANICAL_PICKER_CATEGORY } from './catalogFamilyChoices.js';
import { StandardPartPicker } from './StandardPartPickerPanel.js';

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
/** 今の窓を描き、木の根が機械要素の窓なら、その中身も描いて返す。 */
function render(): Element[] {
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

beforeEach(() => {
  hooks.values = []; hooks.state = 0;
  resetTestStore();
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  useAppStore.getState().openAssembly(createAssemblyDocument('機械要素の選択'));
  expect(useAppStore.getState().openStandardPartPicker()).toBe(true);
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

describe('選ぶ窓の機械要素', () => {
  it('分類の欄の最後に「機械要素」があり、選ぶと機械要素の窓に替わり、分類を戻すと今の窓に戻る', () => {
    const categories = options(select(render(), 'assembly.guide.standardCategory'));
    expect(categories.at(-1)?.props.value).toBe(MECHANICAL_PICKER_CATEGORY);
    expect(categories.at(-1)?.props.children).toBe(t('catalog.mechanical.category'));
    let nodes = mechanical();
    expect(nodes[0]?.type).toBe(CatalogFamilyPicker);
    expect(select(nodes, 'assembly.guide.standardCategory').props.value).toBe(MECHANICAL_PICKER_CATEGORY);
    nodes = change(select(nodes, 'assembly.guide.standardCategory'), 'hexNut');
    expect(nodes.some((item) => item.type === CatalogFamilyPicker)).toBe(false);
    expect(select(nodes, 'assembly.guide.standardCategory').props.value).toBe('hexNut');
  });

  it('表を読み込む前は呼びの欄を出さず「読み込むと選べます」と出し、置かない', () => {
    const nodes = mechanical();
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
    expect(kinds.map((item) => item.props.children)).toEqual([t('catalog.mechanical.kind.camFollower'),
      t('catalog.mechanical.kind.wrappedBush'), t('catalog.mechanical.kind.parallelPin'), t('catalog.mechanical.kind.hexNutStyle1'),
      t('catalog.mechanical.kind.hexNutStyle2'), t('catalog.mechanical.kind.hexNutThin'), t('catalog.mechanical.kind.compressionSpring'),
      t('catalog.mechanical.kind.rollerFollower'), t('catalog.mechanical.kind.angularContactBallBearing'),
      t('catalog.mechanical.kind.thrustBallBearing'), t('catalog.mechanical.kind.cylindricalRollerBearingNU'),
      t('catalog.mechanical.kind.cylindricalRollerBearingNJ'), t('catalog.mechanical.kind.cylindricalRollerBearingNUP'),
      t('catalog.mechanical.kind.cylindricalRollerBearingN'), t('catalog.mechanical.kind.cylindricalRollerBearingNF'),
      t('catalog.mechanical.kind.needleRollerBearing'), t('catalog.mechanical.kind.panHeadScrew'),
      t('catalog.mechanical.kind.countersunkScrew'), t('catalog.mechanical.kind.plainWasherNormal'),
      t('catalog.mechanical.kind.plainWasherSmall'), t('catalog.mechanical.kind.springWasherNumber2'),
      t('catalog.mechanical.kind.springWasherNumber3'), t('catalog.mechanical.kind.socketHeadCapScrew'),
      t('catalog.mechanical.kind.countersunkSocketScrew'), t('catalog.mechanical.kind.hexBoltMain'),
      t('catalog.mechanical.kind.buttonHeadScrew'), t('catalog.mechanical.kind.eRing'),
      t('catalog.mechanical.kind.plainWasherLarge'), t('catalog.mechanical.kind.parallelKey'), t('catalog.mechanical.kind.taperPin'),
      t('catalog.mechanical.kind.splitPin'), t('catalog.mechanical.kind.flangeNut'), t('catalog.mechanical.kind.cheeseHeadScrew'),
      t('catalog.mechanical.kind.setScrewCup'), t('catalog.mechanical.kind.setScrewFlat'), t('catalog.mechanical.kind.setScrewDog'),
      t('catalog.mechanical.kind.setScrewCone'), t('catalog.mechanical.kind.oilSeal'), t('catalog.mechanical.kind.oRingP'),
      t('catalog.mechanical.kind.oRingG')]);
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
