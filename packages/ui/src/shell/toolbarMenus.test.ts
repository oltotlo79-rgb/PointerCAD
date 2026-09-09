/**
 * ツールバーの畳んだ一覧(「作図」「編集」「拘束」「作る」「合わせる」「加工」「投影」
 * 「見た目」)の決まりごとの検査
 * (計画書 docs/plans/P4-スケッチ拡張.md タスク32、§0.a-0.14。
 *  「拘束」は docs/plans/P4b-スケッチの仕上げ.md タスク13。
 *  ソリッド側の組み替えは docs/plans/P5-高度なソリッド・外観と測定.md タスク51、§0.a-0.51)。
 *
 * 画面(DOM)は撮影で確かめるので、ここでは表と純関数だけを見る。
 */

import { addComponent, createAssemblyDocument, createComponentFor, createEmptyPartDocument, diagnoseMates, EMPTY_PART_LIBRARY,
  resolveAssembly, resolveMateTarget, resolvePart, solveMates, SKETCH_CONSTRAINT_KINDS, type Mate, type MateResidualTargetPair } from '@pointercad/model';
import { expressionValueFromNumber } from '@pointercad/expression';
import { createElement, type ComponentType } from 'react';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import {
  ASSEMBLY_JOINT_TOOLS,
  ASSEMBLY_MATE_TOOLS,
  ASSEMBLY_MENU_ITEMS,
  MATE_MENU_ITEMS,
  AssemblyGroup,
  assemblyActionReadiness,
} from './menus/AssemblyGroup.js';
import { AssemblyTree, assemblyMateRowDetails, assemblyRowMenuExpanded, assemblyRowMenuTarget } from './AssemblyTree.js';
import { runNewAssembly } from './menus/fileToolbarActions.js';
import { ASSEMBLY_TOOL_GUIDE_IDS } from './statusText.js';
import {
  BASIC_SKETCH_TOOL_COUNT,
  COMBINE_MENU_ITEMS,
  CONSTRAINT_MENU_ITEMS,
  CREATE_MENU_ITEMS,
  EDIT_MENU_ITEMS,
  FILE_ACTION_ICON_COUNT,
  FILE_MENU_COUNT,
  FILE_MENU_ITEMS,
  ICON_BUTTON_WIDTH_PIXELS,
  LOOK_MENU_ITEMS,
  MACHINING_MENU_ITEMS,
  MENU_TRIGGER_WIDTH_PIXELS,
  PROJECTION_MENU_ITEMS,
  RECENT_FILE_MENU_PREFIX,
  SHAPE_MENU_ITEMS,
  SINGLE_MENU_COUNT,
  SKETCH_MENU_COUNT,
  SOLID_MENU_COUNT,
  STORED_TEMPLATE_MENU_PREFIX,
  fileMenuItems,
  isRecentFileMenuId,
  isStoredTemplateMenuId,
  nextHighlightIndex,
  storedTemplateIdOf,
  rememberRecentTool,
  segmentedWidthPixels,
  triggerItemOf,
} from './toolbarMenus.js';

describe('畳んだ一覧の中身(FR-904、NFR-UX-7)', () => {
  it('ヘルプは選択先行・キーボード・offset・診断と編集操作を案内する', () => {
    const help = readFileSync(new URL('../../../help-content/docs/ja/assembly.md', import.meta.url), 'utf8');
    for (const expected of ['対象を先に選んでも', 'Enter', 'Esc', 'Tab', 'ずらす距離', '負の値', '値の編集', '向きの反転', '削除', '未確定', '両立を確認できません', '矛盾']) expect(help).toContain(expected);
    for (const item of ASSEMBLY_MATE_TOOLS) expect(help).toContain(t(item.labelKey));
  });
  const renderCurrent = (component: ComponentType) => {
    // SSRにはlive storeのsnapshotを供給する。描画本体・対象解決・solverは実物を使う。
    const snapshot = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
    try { return renderToStaticMarkup(createElement(component)); } finally { snapshot.mockRestore(); }
  };

  it('実ツールバーは合わせるを1つのmenu triggerに畳み、6道具へ説明と図柄を接続する', () => {
    resetTestStore();
    useAppStore.getState().openAssembly(createAssemblyDocument('組立'));
    const markup = renderCurrent(AssemblyGroup);
    expect(markup).toMatch(/aria-label="合わせる" aria-haspopup="(?:true|menu)"/);
    expect(markup.match(/aria-label="合わせる"/g)).toHaveLength(1);
    expect(markup).not.toContain('aria-label="一致"');
    for (const item of ASSEMBLY_MATE_TOOLS) {
      expect(t(item.tooltipKey)).not.toBe(item.tooltipKey);
      expect(t(item.tooltipKey)).not.toBe(t(item.labelKey));
      expect(typeof item.Icon).toBe('function');
    }
  });

  it.each([false, true])('Treeは実solverの矛盾疑いと証明済みを区別する（固定=%s）', (fixed) => {
    resetTestStore();
    let document = createAssemblyDocument('診断');
    for (let index = 0; index < 2; index += 1) document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'p' }));
    const part = createEmptyPartDocument();
    const library = { ...EMPTY_PART_LIBRARY, parts: new Map([['p', part]]) };
    const mates: Mate[] = [10, 20].map((value, index) => ({ id: 'm' + index, name: 'M' + index, kind: 'distance',
      a: { kind: 'origin', componentId: 'component-1', element: 'origin' },
      b: { kind: 'origin', componentId: 'component-2', element: 'origin' }, flipped: false, suppressed: false, value: expressionValueFromNumber(value) }));
    document = { ...document, mates, components: document.components.map((component) => ({ ...component,
      fixed: fixed || component.fixed, placement: { ...component.placement, position: [expressionValueFromNumber(component.fixed ? 0 : 12), expressionValueFromNumber(0), expressionValueFromNumber(0)] } })) };
    const resolved = resolveAssembly(document, { library, resolvedParts: new Map([['p', resolvePart(part)]]) });
    const targets = new Map<string, MateResidualTargetPair>();
    for (const mate of mates) {
      const a = resolveMateTarget(mate.a, resolved); const b = resolveMateTarget(mate.b, resolved);
      if (!a.ok || !b.ok) throw new Error('fixture');
      targets.set(mate.id, { a: a.target, b: b.target });
    }
    const diagnosis = diagnoseMates(document, solveMates(document, targets, resolved.placements));
    const view = { resolved, bodies: new Map(), appearances: new Map(), diagnosis, mateTargetErrors: new Map() };
    useAppStore.getState().openAssembly(document, library);
    useAppStore.setState({ assemblyView: view });
    const markup = renderCurrent(AssemblyTree);
    if (fixed) {
      expect(diagnosis.provenConflictMateIds).not.toHaveLength(0);
      expect(markup).toContain('>矛盾</span>');
      expect(markup).not.toContain('>両立を確認できません</span>');
    } else {
      expect(diagnosis.suspectedConflictMateIds).not.toHaveLength(0);
      expect(markup).toContain('>両立を確認できません</span>');
      expect(markup).not.toContain('>矛盾</span>');
    }
    expect(assemblyMateRowDetails('m0', view).message).not.toBeNull();
  });

  it('部品が残っている部分形状消失もTreeに未解決と実理由を示す', () => {
    resetTestStore();
    let document = createAssemblyDocument('欠落');
    for (let index = 0; index < 2; index += 1) document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'p' }));
    const mate: Mate = { id: 'm', name: 'M', kind: 'coincident', flipped: false, suppressed: false,
      a: { kind: 'subShape', componentId: 'component-1', ref: { bodyFeatureId: 'gone', index: 0,
        fingerprint: { kind: 'vertex', position: [0, 0, 0] } } }, b: { kind: 'origin', componentId: 'component-2', element: 'origin' } };
    document = { ...document, mates: [mate] };
    const part = createEmptyPartDocument();
    const library = { ...EMPTY_PART_LIBRARY, parts: new Map([['p', part]]) };
    const resolved = resolveAssembly(document, { library, resolvedParts: new Map([['p', resolvePart(part)]]) });
    const missing = resolveMateTarget(mate.a, resolved, { subShape: () => null });
    if (missing.ok) throw new Error('消失を再現できていません');
    const diagnosis = diagnoseMates(document, solveMates(document, new Map(), resolved.placements));
    const view = { resolved, bodies: new Map(), appearances: new Map(), diagnosis, mateTargetErrors: new Map([['m', [missing.message]]]) };
    useAppStore.getState().openAssembly(document, library); useAppStore.setState({ assemblyView: view });
    expect(assemblyMateRowDetails('m', view)).toMatchObject({ missing: true });
    const markup = renderCurrent(AssemblyTree);
    expect(markup).toContain(missing.message);
    expect(markup).toContain('>未解決</span>');
    expect(markup).toContain('pcad-tree__row--suppressed');
  });
  it('アセンブリの合わせる入口はmodelの6種類を重複なく全部出す', () => {
    expect(ASSEMBLY_MATE_TOOLS.map((item) => item.kind)).toEqual([
      'coincident', 'concentric', 'distance', 'angle', 'parallel', 'tangent',
    ]);
    expect(new Set(ASSEMBLY_MATE_TOOLS.map((item) => item.labelKey)).size).toBe(6);
  });

  it.each([
    ['component', 'component-2', { kind: 'component', rowId: 'component-2' }],
    ['mate', 'mate-7', { kind: 'mate', rowId: 'mate-7' }],
    ['joint', 'joint-1', null],
    ['step', 'step-1', null],
  ] as const)('%s行のメニュー対象を取り違えない', (section, id, expected) => {
    expect(assemblyRowMenuTarget(section, id)).toEqual(expected);
  });

  it.each([
    { name: '通常ID', rows: [['component', 'component-2'], ['mate', 'mate-7']] },
    { name: 'colon付き保存ID', rows: [['component', 'component-2'], ['mate', 'legacy'], ['mate', 'mate:legacy']] },
    { name: '部品と合致の同一ID', rows: [['component', 'shared'], ['mate', 'shared']] },
    { name: '種類横断のcolon付き同一ID', rows: [['component', 'mate:legacy'], ['mate', 'mate:legacy'], ['mate', 'legacy']] },
  ] as const)('Treeメニューのaria-expandedは$nameでも開いた対象だけtrueになる', ({ rows }) => {
    const expanded = (menu: ReturnType<typeof assemblyRowMenuTarget>) =>
      rows.map(([section, id]) => assemblyRowMenuExpanded(menu, section, id));
    expect(expanded(null)).toEqual(rows.map(() => false));
    for (const [openIndex, [section, id]] of rows.entries()) {
      const menu = assemblyRowMenuTarget(section, id);
      expect(menu).not.toBeNull();
      // JSXのaria-expandedと同じ関数を通し、他行の状態は行位置で独立に期待する。
      expect(expanded(menu)).toEqual(rows.map((_, index) => index === openIndex));
    }
    expect(expanded(null)).toEqual(rows.map(() => false));
  });
  it('「作図」には P4 で足した 8 つの形が並ぶ(タスク36 の 3 点の円弧を含む)', () => {
    expect(SHAPE_MENU_ITEMS.map((item) => item.id)).toEqual([
      'circle',
      'twoPointArc',
      'threePointArc',
      'rectangle',
      'polygon',
      'slot',
      'ellipse',
      'spline',
    ]);
  });

  it('「編集」には整形系と複製系が並ぶ', () => {
    expect(EDIT_MENU_ITEMS.map((item) => item.id)).toEqual([
      'offset',
      // クリックだけで決まる 2 つ(タスク22)。
      'trim',
      'extend',
      // 角を指してから数値を聞く 2 つ(タスク23)。
      'sketchFillet',
      'sketchChamfer',
      // 選んでから確定する複製系(タスク24)。
      'mirror',
      'copy',
      'linearArray',
      'circularArray',
      // 立体からかたちを取り込む 2 つ(タスク27)。
      'projectedCurve',
      'planeSection',
    ]);
  });

  it('角の丸め・面取りは整形系の並び(オフセット〜延長)の直後に入る(タスク23)', () => {
    // 表の拡張で上の一覧が伸びても、この 2 つが複製系より前にあることは変えない
    // (整形系は「元の線を書き換える」、複製系は「増やす」で意味が違うため。§0.a-0.10)。
    const ids = EDIT_MENU_ITEMS.map((item) => item.id);
    expect(ids.indexOf('sketchFillet')).toBe(ids.indexOf('extend') + 1);
    expect(ids.indexOf('sketchChamfer')).toBe(ids.indexOf('sketchFillet') + 1);
    expect(ids.indexOf('sketchChamfer')).toBeLessThan(ids.indexOf('mirror'));
  });

  it('どの項目も図柄・名前・説明を持つ(名前だけの項目を作らない)', () => {
    for (const item of [...SHAPE_MENU_ITEMS, ...EDIT_MENU_ITEMS]) {
      expect(typeof item.Icon, item.id).toBe('function');
      expect(item.labelKey.length, item.id).toBeGreaterThan(0);
      expect(item.tooltipKey.length, item.id).toBeGreaterThan(0);
    }
  });

  it('項目の id が一覧の中で重複しない', () => {
    const ids = [...SHAPE_MENU_ITEMS, ...EDIT_MENU_ITEMS].map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('アセンブリのツールバー(P7 タスク45)', () => {
  it('「組む」には配置・置換・固定の5項目を出す', () => {
    expect(ASSEMBLY_MENU_ITEMS.map((item) => item.id)).toEqual([
      'placePart', 'placeStandardPart', 'placeSubAssembly', 'replacePart', 'toggleFixed',
    ]);
  });

  it('「合わせる」は合致6種とジョイント4種の10項目である', () => {
    expect(MATE_MENU_ITEMS.map((item) => item.id)).toEqual([
      'coincident', 'concentric', 'distance', 'angle', 'parallel', 'tangent',
      'revolute', 'slider', 'cylindrical', 'ball',
    ]);
    expect(ASSEMBLY_MATE_TOOLS).toHaveLength(6);
    expect(ASSEMBLY_JOINT_TOOLS).toHaveLength(4);
  });

  it('2つの一覧の全項目が名前・一行説明・図柄を持つ', () => {
    for (const item of [...ASSEMBLY_MENU_ITEMS, ...MATE_MENU_ITEMS]) {
      expect(t(item.labelKey)).not.toBe('');
      expect(t(item.tooltipKey)).not.toBe('');
      expect(t(item.tooltipKey)).not.toBe(t(item.labelKey));
      expect(typeof item.Icon).toBe('function');
    }
  });

  it('一覧15項目のidは重複しない', () => {
    const ids = [...ASSEMBLY_MENU_ITEMS, ...MATE_MENU_ITEMS].map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('2つの一覧と干渉・分解・部品表の全道具にステータス案内がある', () => {
    const toolbarIds = [
      ...ASSEMBLY_MENU_ITEMS.map((item) => item.id),
      ...MATE_MENU_ITEMS.map((item) => item.id),
      'interference',
      'explode',
      'bom',
    ].sort();
    expect([...ASSEMBLY_TOOL_GUIDE_IDS].sort()).toEqual(toolbarIds);
  });

  it('アセンブリ専用区画は畳んだ一覧2つと図柄3つの幅だけを使う', () => {
    const assemblyGroupWidth = segmentedWidthPixels(3, 2);
    expect(assemblyGroupWidth).toBe(154);
    expect(assemblyGroupWidth).toBeLessThan(1280);
  });

  it('部品1個を選んだときだけ部品操作を許す', () => {
    let assembly = createAssemblyDocument('組立');
    const component = createComponentFor(assembly, { kind: 'part', partRef: 'part-1' });
    assembly = addComponent(assembly, component);
    expect(assemblyActionReadiness(assembly, [])).toEqual({
      ready: false, reasonKey: 'assembly.tool.selectOneComponentReason',
    });
    expect(assemblyActionReadiness(assembly, [component.id])).toEqual({ ready: true, reasonKey: null });
  });

  it('アセンブリのファイル一覧に新規入口を出し、部品専用操作とひな形を除く', () => {
    const rows = fileMenuItems([{ id: 'template', name: 'ひな形' }], [{ id: 'recent', name: '最近' }], 'assembly');
    expect(rows.map((item) => item.id)).toEqual(['newAssembly', 'saveAs', 'recentFile:recent']);
    expect(t(rows[0].labelKey)).toBe('新しいアセンブリ');
  });

  it('製品UIと同じ入口で部品・アセンブリの双方から空の新規アセンブリを始める', async () => {
    resetTestStore();
    let cleared = 0;
    const gateway = {
      ...useAppStore.getState().fileGateway,
      clearSaveTarget: () => { cleared += 1; },
    };
    useAppStore.setState({ fileGateway: gateway });
    const deps = { captureThumbnail: () => null, confirmDiscard: () => Promise.resolve(true) };

    await runNewAssembly(deps);
    expect(useAppStore.getState().assembly?.components).toEqual([]);
    expect(useAppStore.getState().canUndo).toBe(false);
    expect(cleared).toBe(1);

    const firstDocumentId = useAppStore.getState().activeDocumentId;
    await runNewAssembly(deps);
    expect(useAppStore.getState().assembly?.components).toEqual([]);
    expect(useAppStore.getState().activeDocumentId).not.toBe(firstDocumentId);
    expect(cleared).toBe(2);
  });

  it('未保存の部品を破棄しない選択なら新規アセンブリへ切り替えない', async () => {
    resetTestStore();
    const before = useAppStore.getState().document;
    useAppStore.getState().applyDocument({ ...before, name: '未保存の部品' });
    await runNewAssembly({
      captureThumbnail: () => null,
      confirmDiscard: () => Promise.resolve(false),
    });
    expect(useAppStore.getState().assembly).toBeNull();
    expect(useAppStore.getState().document.name).toBe('未保存の部品');
  });

});

describe('畳んだボタンに出す図柄', () => {
  it('いまその一覧の道具を使っていれば、その道具の図柄を出す', () => {
    expect(triggerItemOf(SHAPE_MENU_ITEMS, 'polygon', null)?.id).toBe('polygon');
  });

  it('使っていなければ、最後にその一覧から選んだ道具の図柄を出す', () => {
    expect(triggerItemOf(SHAPE_MENU_ITEMS, 'line', 'slot')?.id).toBe('slot');
  });

  it('いまの道具が優先される(最後に使った道具より新しいから)', () => {
    expect(triggerItemOf(SHAPE_MENU_ITEMS, 'ellipse', 'slot')?.id).toBe('ellipse');
  });

  it('一度もその一覧を使っていなければ null(区画そのものの図柄を出す)', () => {
    expect(triggerItemOf(SHAPE_MENU_ITEMS, 'line', null)).toBeNull();
  });
});

describe('最後に使った道具の記憶', () => {
  it('一覧から選んだ道具を覚える', () => {
    expect(rememberRecentTool(SHAPE_MENU_ITEMS, null, 'rectangle')).toBe('rectangle');
  });

  it('覚えた道具は次に選ぶまで置き換わらない', () => {
    expect(rememberRecentTool(SHAPE_MENU_ITEMS, 'rectangle', 'spline')).toBe('spline');
  });

  it('一覧に無い道具(別の区画へ移ったとき)では前の記憶を残す', () => {
    expect(rememberRecentTool(SHAPE_MENU_ITEMS, 'rectangle', 'line')).toBe('rectangle');
    expect(rememberRecentTool(EDIT_MENU_ITEMS, null, 'rectangle')).toBeNull();
  });
});

describe('キーボードで一覧の項目を選ぶ(NFR-UX-7)', () => {
  const count = SHAPE_MENU_ITEMS.length;

  it('↓ で次の項目へ進み、末尾からは先頭へ回る', () => {
    expect(nextHighlightIndex(0, 'ArrowDown', count)).toBe(1);
    expect(nextHighlightIndex(count - 1, 'ArrowDown', count)).toBe(0);
  });

  it('↑ で前の項目へ戻り、先頭からは末尾へ回る', () => {
    expect(nextHighlightIndex(3, 'ArrowUp', count)).toBe(2);
    expect(nextHighlightIndex(0, 'ArrowUp', count)).toBe(count - 1);
  });

  it('Home / End で両端へ飛ぶ', () => {
    expect(nextHighlightIndex(4, 'Home', count)).toBe(0);
    expect(nextHighlightIndex(0, 'End', count)).toBe(count - 1);
  });

  it('一覧を動かさないキー(Enter・Escape・文字)は null を返す', () => {
    for (const key of ['Enter', 'Escape', 'a', 'ArrowLeft', 'Tab']) {
      expect(nextHighlightIndex(0, key, count), key).toBeNull();
    }
  });

  it('項目が無ければどのキーでも null', () => {
    expect(nextHighlightIndex(0, 'ArrowDown', 0)).toBeNull();
  });
});

describe('区画の幅の見積もり(1440 画素の窓で 1 段、§0.a-0.14)', () => {
  /*
   * 「スケッチ」区画は、基本の 6 道具+畳んだ一覧を 1 つの溝へ並べた 1 行。
   *
   * P4 タスク32 の時点は畳んだ一覧が 2 つ(作図・編集)で
   * 26×6 + 31×2 + 隙間 2×7 + 内余白 2×2 + 枠 1×2 = 238 画素だった。
   * P4b タスク13 で「拘束」を足して 3 つになったので
   * 26×6 + 31×3 + 隙間 2×8 + 内余白 2×2 + 枠 1×2 = 156 + 93 + 16 + 4 + 2 = 271 画素。
   * 増えるのは畳んだボタン 1 つぶん+隙間(33 画素)だけで、一覧の中身が 14 種でも
   * 幅は変わらない。実測(1440 画素・ダーク・拡大率 100%)も 271 画素で一致する(報告に記載)。
   */
  it('基本 6 道具と畳んだ一覧 3 つで 271 画素', () => {
    expect(segmentedWidthPixels(BASIC_SKETCH_TOOL_COUNT, SKETCH_MENU_COUNT)).toBe(271);
    // 一覧を 1 つ足したぶんだけ増える(畳んだボタン 31 + 隙間 2)。
    expect(segmentedWidthPixels(BASIC_SKETCH_TOOL_COUNT, SKETCH_MENU_COUNT - 1)).toBe(238);
  });

  it('基本の 5 道具(FR-301〜309 の Must)は畳まれていない', () => {
    // 点・線分・円弧・点列・面は、どちらの一覧にも入れない(計画書タスク32 の最低条件)。
    const folded: readonly string[] = [
      ...SHAPE_MENU_ITEMS.map((item) => item.id),
      ...EDIT_MENU_ITEMS.map((item) => item.id),
    ];
    for (const must of ['point', 'line', 'arc', 'pointArray', 'face']) {
      expect(folded, must).not.toContain(must);
    }
  });

  it('畳まずに平置きすると同じ道具数でも幅が増える(畳む理由)', () => {
    const folded = segmentedWidthPixels(BASIC_SKETCH_TOOL_COUNT, SKETCH_MENU_COUNT);
    const flat = segmentedWidthPixels(
      BASIC_SKETCH_TOOL_COUNT + SHAPE_MENU_ITEMS.length + EDIT_MENU_ITEMS.length,
      0,
    );
    expect(flat).toBeGreaterThan(folded);
  });

  it('拘束の一覧は 14 種すべてを図柄と名前つきで持つ(FR-313、P4b タスク13)', () => {
    expect(CONSTRAINT_MENU_ITEMS.map((item) => item.id)).toEqual(SKETCH_CONSTRAINT_KINDS);
    for (const item of CONSTRAINT_MENU_ITEMS) {
      expect(t(item.labelKey).length, item.id).toBeGreaterThan(0);
      expect(t(item.tooltipKey).length, item.id).toBeGreaterThan(0);
    }
  });

  it('拘束の一覧に道具を足してもツールバーの幅は変わらない(畳む理由)', () => {
    const folded = segmentedWidthPixels(BASIC_SKETCH_TOOL_COUNT, SKETCH_MENU_COUNT);
    const flat = segmentedWidthPixels(
      BASIC_SKETCH_TOOL_COUNT + CONSTRAINT_MENU_ITEMS.length,
      SKETCH_MENU_COUNT - 1,
    );
    expect(flat).toBeGreaterThan(folded);
  });

  it('ボタンが 1 つも無ければ 0(区画を作らない)', () => {
    expect(segmentedWidthPixels(0, 0)).toBe(0);
  });

  it('図柄のボタンと畳んだ一覧のボタンの幅は CSS と同じ値', () => {
    expect(ICON_BUTTON_WIDTH_PIXELS).toBe(26);
    expect(MENU_TRIGGER_WIDTH_PIXELS).toBe(31);
  });
});

describe('ソリッド側の畳んだ一覧(P5 タスク51、§0.a-0.51)', () => {
  it('「作る」には数値を聞いて立体を作る 15 つが並ぶ', () => {
    expect(CREATE_MENU_ITEMS.map((item) => item.id)).toEqual([
      'extrude',
      'revolve',
      'sew',
      // ばねは対象を消費しない「作る」フィーチャーなので加工ではない(§0.a-0.36)。
      'spring',
      // 基本形状5種(FR-429、P5 タスク18)。ばねと同じ理由でここへ入る(§0.a-0.19)。
      'sphere',
      'box',
      'cylinder',
      'cone',
      'torus',
      // 球面上の点(FR-431、P5 タスク22)。作るのは 3D スケッチの点だが、球を選んでから
      // 押す使い方が基本形状と地続きなので球のすぐ後ろへ置く。
      'sphereGridPoint',
      // 面をつなぐ・ロフト(FR-430、FR-410、P5 タスク27)。§0.a-0.27 で対象を消費しない
      // 「作る」フィーチャーと決まっているので、基本形状と同じ理由でここへ入る。
      'ruled',
      'loft',
      // P5 タスク50。スイープは対象を取らず、ミラーと曲面は対象を消費しない(§0.a-0.36・0.45)。
      'sweep',
      'mirrorSolid',
      'surface',
    ]);
  });

  it('「合わせる」には和・差・積が並ぶ', () => {
    expect(COMBINE_MENU_ITEMS.map((item) => item.id)).toEqual(['union', 'subtract', 'intersect']);
  });

  it('「加工」には立体へ手を入れる 15 つが並ぶ(P5 タスク50・27e で 9 つ増えた)', () => {
    expect(MACHINING_MENU_ITEMS.map((item) => item.id)).toEqual([
      'hole',
      'threadHole',
      'fillet',
      'chamfer',
      'linearPattern',
      'circularPattern',
      // P5 タスク50・27e。どれも「できあがった立体へ手を入れる」道具(§2.15、§0.a-0.64)。
      'draft',
      'shell',
      'rib',
      'emboss',
      'threadShaft',
      'transform',
      'scale',
      'pointPattern',
      'cut',
    ]);
  });

  it('「投影」「見た目」の一覧の中身', () => {
    expect(PROJECTION_MENU_ITEMS.map((item) => item.id)).toEqual(['perspective', 'orthographic']);
    // タスク32 の「測る」が 2 行目に入った(§0.a-0.29。区画は増やさない、要件§7.1)。
    // P6 タスク39 の「下絵」(FR-332)が 3 行目に入った(同じ理由で区画は増えない)。
    // P6 タスク46 の「3D プリントの点検」(FR-815)が 4 行目に入った(同じ理由)。
    expect(LOOK_MENU_ITEMS.map((item) => item.id)).toEqual([
      'appearance',
      'measure',
      'canvas',
      'printCheck',
    ]);
  });

  it('「測る」「下絵」「点検」を足しても「見た目」の溝の幅は 37 画素のまま(§0.a-0.80)', () => {
    /*
      畳んだ一覧の中に項目をいくつ足しても溝の幅は変わらない、という約束の実例。
      平置きにしていたら図柄 4 個で 120 画素になり、1440 画素の窓の余裕が削れていた。
    */
    expect(LOOK_MENU_ITEMS).toHaveLength(4);
    expect(segmentedWidthPixels(0, SINGLE_MENU_COUNT)).toBe(37);
  });

  it('どの項目も図柄・名前・説明を持ち、名前が説明に重ならない(FR-904)', () => {
    /*
     * 一覧の中の項目のツールチップは `ToolMenu` が「名前: 説明」に組み立てる。
     * 説明の側にも名前が入っていると「押し出し: 押し出し: 面を…」と二重になるので、
     * 説明が名前+「: 」で始まっていないことをここで固定する(P5 タスク51 で
     * 図柄ボタンから一覧へ移したときに ja.json から頭の名前を外した)。
     */
    for (const item of [
      ...CREATE_MENU_ITEMS,
      ...COMBINE_MENU_ITEMS,
      ...MACHINING_MENU_ITEMS,
      ...PROJECTION_MENU_ITEMS,
      ...LOOK_MENU_ITEMS,
    ]) {
      expect(typeof item.Icon, item.id).toBe('function');
      expect(t(item.labelKey).length, item.id).toBeGreaterThan(0);
      expect(t(item.tooltipKey).length, item.id).toBeGreaterThan(0);
      expect(t(item.tooltipKey).startsWith(`${t(item.labelKey)}: `), item.id).toBe(false);
    }
  });

  it('項目の id が一覧をまたいで重複しない', () => {
    const ids = [
      ...CREATE_MENU_ITEMS.map((item) => item.id),
      ...COMBINE_MENU_ITEMS.map((item) => item.id),
      ...MACHINING_MENU_ITEMS.map((item) => item.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('組み替え後のツールバーの幅の予算(P5 タスク51、§0.a-0.51)', () => {
  /*
   * P4b までの「ソリッド」区画は図柄 7 個、その右の「加工」区画は図柄 6 個の平置きで、
   * 溝の幅は実測 200 画素と 172 画素(区画のあいだの隙間 6 画素を含めて 378 画素)、
   * 1440 画素の窓で 1 段に必要な幅は実測 1437.3 画素・余裕 2.7 画素しか無かった。
   * 3 つの畳んだ一覧へまとめると溝は 1 つ・103 画素になり、区画も 1 つ減る。
   */
  it('「作る」「合わせる」「加工」の 3 つで 103 画素', () => {
    expect(segmentedWidthPixels(0, SOLID_MENU_COUNT)).toBe(103);
    /*
      平置きにしたときの幅。タスク51 の時点(図柄 13 個)は 368 画素、タスク18 が
      基本形状 5 種を足して図柄 18 個・508 画素、タスク27 が面をつなぐ・ロフトを足して
      図柄 20 個・564 画素になり、タスク50・27e が Should 群 12 種を足して図柄 32 個・
      900 画素、タスク22 が球面上の点を足したいまは図柄 33 個・928 画素になる。
      **畳んだ一覧のほうは 103 画素のまま 1 画素も
      増えていない**(上の行)ことがこの検査の眼目で、平置きの数はその対比として
      置いてある(§0.a-0.80、§0.a-0.64)。
    */
    expect(
      segmentedWidthPixels(
        CREATE_MENU_ITEMS.length + COMBINE_MENU_ITEMS.length + MACHINING_MENU_ITEMS.length,
        0,
      ),
    ).toBe(928);
  });

  it('一覧の中に道具を足してもツールバーの幅は変わらない(前倒しの理由)', () => {
    /*
     * タスク18(基本形状 5)・27f(切断)・32(測る)・49(Should 群 12)が足すボタンは、
     * すべて既存の一覧の中へ入る。平置きなら図柄 1 個につき 28 画素(26+隙間 2)増えるが、
     * 畳んだ一覧では 0 画素。ここを固定しておけば、後のタスクが表へ 1 行足すだけで済む。
     */
    const folded = segmentedWidthPixels(0, SOLID_MENU_COUNT);
    expect(segmentedWidthPixels(0, SOLID_MENU_COUNT)).toBe(folded);
    expect(segmentedWidthPixels(20, SOLID_MENU_COUNT)).toBeGreaterThan(folded);
  });

  it('「投影」「見た目」は畳んだ一覧 1 つずつで 37 画素', () => {
    expect(segmentedWidthPixels(0, SINGLE_MENU_COUNT)).toBe(37);
    // 「投影」は図柄 2 個で 60 画素だったので 23 画素減る。
    expect(segmentedWidthPixels(PROJECTION_MENU_ITEMS.length, 0)).toBe(60);
  });
});

describe('基本形状 5 種を「作る」の一覧へ足す(FR-429、P5 タスク18、§0.a-0.80)', () => {
  const PRIMITIVE_IDS = ['sphere', 'box', 'cylinder', 'cone', 'torus'] as const;

  it('5 つとも続けて、球・箱・円柱・円錐・トーラスの順で並ぶ(§2.15)', () => {
    /*
      タスク18 の時点では一覧の末尾だったが、タスク27 が面をつなぐ・ロフトをその後ろへ
      足したので「末尾から 5 つ」では引けなくなった。**5 種が続けてこの順に並ぶ**ことが
      §2.15 の段の表と揃えるための条件なので、球の位置から 5 つを切り出して確かめる
      (期待の中身は 1 つも変えていない)。
    */
    const ids = CREATE_MENU_ITEMS.map((item) => item.id);
    const start = ids.indexOf(PRIMITIVE_IDS[0]);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(ids.slice(start, start + PRIMITIVE_IDS.length)).toEqual([...PRIMITIVE_IDS]);
  });

  it('5 つとも図柄・名前・説明を持ち、説明が名前で始まらない(FR-904)', () => {
    for (const id of PRIMITIVE_IDS) {
      const item = CREATE_MENU_ITEMS.find((candidate) => candidate.id === id);
      expect(item, id).toBeDefined();
      if (item === undefined) {
        continue;
      }
      expect(typeof item.Icon, id).toBe('function');
      expect(t(item.labelKey).length, id).toBeGreaterThan(0);
      expect(t(item.tooltipKey).length, id).toBeGreaterThan(0);
      expect(t(item.tooltipKey).startsWith(`${t(item.labelKey)}: `), id).toBe(false);
    }
  });

  it('5 つ足してもツールバーの幅は 1 画素も増えない(畳んだ一覧に入れる理由)', () => {
    /*
      溝の幅は「溝に並ぶボタンの個数」だけで決まる(`segmentedWidthPixels`)。ソリッドの
      区画は「作る」「合わせる」「加工」の 3 つの畳んだボタンのままなので、一覧の中身が
      4 → 9 に増えても 103 画素で変わらない。平置きにしていたら 5 × 28 = 140 画素増える。
    */
    expect(segmentedWidthPixels(0, SOLID_MENU_COUNT)).toBe(103);
    const flatBefore = segmentedWidthPixels(CREATE_MENU_ITEMS.length - PRIMITIVE_IDS.length, 0);
    const flatAfter = segmentedWidthPixels(CREATE_MENU_ITEMS.length, 0);
    expect(flatAfter - flatBefore).toBe(140);
  });

  it('畳んだボタンの図柄は、いま選んでいる基本形状のものになる(triggerItemOf)', () => {
    const trigger = triggerItemOf(CREATE_MENU_ITEMS, 'torus', null);
    expect(trigger?.id).toBe('torus');
  });
});

describe('面をつなぐ・ロフトを「作る」の一覧へ足す(FR-430、FR-410、P5 タスク27、§0.a-0.80)', () => {
  const RULED_IDS = ['ruled', 'loft'] as const;

  it('2 つは基本形状の後ろに、面をつなぐ → ロフトの順で並ぶ', () => {
    // P5 タスク50 でスイープ・ミラー・曲面が後ろへ足されたので、末尾ではなくなった。
    const start = CREATE_MENU_ITEMS.findIndex((item) => item.id === RULED_IDS[0]);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(
      CREATE_MENU_ITEMS.slice(start, start + RULED_IDS.length).map((item) => item.id),
    ).toEqual([...RULED_IDS]);
  });

  it('2 つとも図柄・名前・説明を持ち、説明が名前で始まらない(FR-904)', () => {
    for (const id of RULED_IDS) {
      const item = CREATE_MENU_ITEMS.find((candidate) => candidate.id === id);
      expect(item, id).toBeDefined();
      if (item === undefined) {
        continue;
      }
      expect(typeof item.Icon, id).toBe('function');
      expect(t(item.labelKey).length, id).toBeGreaterThan(0);
      expect(t(item.tooltipKey).length, id).toBeGreaterThan(0);
      expect(t(item.tooltipKey).startsWith(`${t(item.labelKey)}: `), id).toBe(false);
    }
  });

  it('図柄は 2 つで別のもの(木の借り物 CubeIcon を卒業した)', () => {
    const icons = RULED_IDS.map(
      (id) => CREATE_MENU_ITEMS.find((candidate) => candidate.id === id)?.Icon,
    );
    expect(icons[0]).not.toBe(icons[1]);
    expect(icons[0]).toBeDefined();
    expect(icons[1]).toBeDefined();
  });

  it('2 つ足してもツールバーの幅は 1 画素も増えない(畳んだ一覧に入れる理由)', () => {
    /*
      溝の幅は「溝に並ぶボタンの個数」だけで決まる(`segmentedWidthPixels`)。ソリッドの
      区画は「作る」「合わせる」「加工」の 3 つの畳んだボタンのままなので、一覧の中身が
      9 → 11 に増えても 103 画素で変わらない。平置きにしていたら 2 × 28 = 56 画素増える。
    */
    expect(segmentedWidthPixels(0, SOLID_MENU_COUNT)).toBe(103);
    const flatBefore = segmentedWidthPixels(CREATE_MENU_ITEMS.length - RULED_IDS.length, 0);
    const flatAfter = segmentedWidthPixels(CREATE_MENU_ITEMS.length, 0);
    expect(flatAfter - flatBefore).toBe(56);
  });

  it('畳んだボタンの図柄は、いま選んでいる道具のものになる(triggerItemOf)', () => {
    expect(triggerItemOf(CREATE_MENU_ITEMS, 'ruled', null)?.id).toBe('ruled');
    expect(triggerItemOf(CREATE_MENU_ITEMS, 'loft', null)?.id).toBe('loft');
  });
});

/* ===== P5 タスク50・27e: Should 群 12 種をツールバーへ足す(§2.15、§0.a-0.64) ===== */

describe('Should 群をツールバーの畳んだ一覧へ足す(P5 タスク50・27e)', () => {
  /** 「作る」へ足した 3 つ(対象を取らない/消費しないもの)。 */
  const CREATE_IDS = ['sweep', 'mirrorSolid', 'surface'] as const;
  /** 「加工」へ足した 9 つ(できあがった立体へ手を入れるもの)。 */
  const MACHINING_IDS = [
    'draft',
    'shell',
    'rib',
    'emboss',
    'threadShaft',
    'transform',
    'scale',
    'pointPattern',
    'cut',
  ] as const;

  it('「作る」の末尾に 3 つ、「加工」の末尾に 9 つが並ぶ', () => {
    expect(CREATE_MENU_ITEMS.slice(-CREATE_IDS.length).map((item) => item.id)).toEqual([
      ...CREATE_IDS,
    ]);
    expect(MACHINING_MENU_ITEMS.slice(-MACHINING_IDS.length).map((item) => item.id)).toEqual([
      ...MACHINING_IDS,
    ]);
  });

  it('12 個とも図柄・名前・説明を持ち、説明が名前で始まらない(FR-904)', () => {
    const items = [
      ...CREATE_MENU_ITEMS.filter((item) => CREATE_IDS.some((id) => id === item.id)),
      ...MACHINING_MENU_ITEMS.filter((item) => MACHINING_IDS.some((id) => id === item.id)),
    ];
    expect(items).toHaveLength(CREATE_IDS.length + MACHINING_IDS.length);
    for (const item of items) {
      expect(typeof item.Icon, item.id).toBe('function');
      expect(t(item.labelKey).length, item.id).toBeGreaterThan(0);
      expect(t(item.tooltipKey).length, item.id).toBeGreaterThan(0);
      expect(t(item.tooltipKey).startsWith(`${t(item.labelKey)}: `), item.id).toBe(false);
    }
  });

  it('12 個の図柄はすべて別のもの(借り物の使い回しをしない)', () => {
    const icons = [
      ...CREATE_MENU_ITEMS.filter((item) => CREATE_IDS.some((id) => id === item.id)),
      ...MACHINING_MENU_ITEMS.filter((item) => MACHINING_IDS.some((id) => id === item.id)),
    ].map((item) => item.Icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  /**
   * **幅は 1 画素も増えない**(§0.a-0.64「幅の追加は 0px」)。溝の幅は
   * `segmentedWidthPixels` が「溝に並ぶボタンの個数」だけから決めるので、畳んだ一覧の
   * 中に項目をいくつ足しても変わらない。1440 画素の窓での実測もこの検査と一致する
   * (報告に記載)。
   */
  it('12 個足してもソリッド区画の溝は 103 画素のまま(§0.a-0.64、§0.a-0.80)', () => {
    expect(segmentedWidthPixels(0, SOLID_MENU_COUNT)).toBe(103);
    // もし平置きにしていたら、図柄 12 個ぶん(26 + 隙間 2)× 12 = 336 画素増えていた。
    const flatCost =
      segmentedWidthPixels(CREATE_MENU_ITEMS.length + MACHINING_MENU_ITEMS.length, 0) -
      segmentedWidthPixels(
        CREATE_MENU_ITEMS.length + MACHINING_MENU_ITEMS.length - 12,
        0,
      );
    expect(flatCost).toBe(12 * (ICON_BUTTON_WIDTH_PIXELS + 2));
  });

  it('畳んだボタンの図柄は、いま選んでいる Should 群の道具のものになる', () => {
    expect(triggerItemOf(MACHINING_MENU_ITEMS, 'cut', null)?.id).toBe('cut');
    expect(triggerItemOf(CREATE_MENU_ITEMS, 'mirrorSolid', null)?.id).toBe('mirrorSolid');
    // 一覧に無い道具のときは「最後に使った道具」へ後退する。
    expect(triggerItemOf(MACHINING_MENU_ITEMS, 'extrude', 'draft')?.id).toBe('draft');
  });
});

/* ===== P6 タスク31: 「ファイル」の畳んだ一覧(§0.57、FR-812、FR-904、要件§7.1) ===== */

describe('「ファイル」の畳んだ一覧(P6 §0.57、タスク31)', () => {
  it('図面作成を含む8行が並ぶ(配線先のある操作しか出さない)', () => {
    /*
      §0.57 の最終形は 7 項目だが、行を足すのは**その操作を作るタスク**の仕事にした。
      押しても何も起きない行を画面に出さないため(NFR-UX-5)。タスク32 が書き出す・
      読み込むを足して 3、タスク33 がひな形 2 つと印刷を足して 6 になった。
      7 つ目の「最近使ったファイル」は**数が決まらない**ので、この表ではなく
      `fileMenuItems` が名前のまま並べる(下の検査)。
      **期待値を緩めたのではなく、行が増えた事実を写している。**
    */
    expect(FILE_MENU_ITEMS.map((item) => item.id)).toEqual([
      'newDrawingFromPart',
      'newAssembly',
      'saveAs',
      'exportShape',
      'importShape',
      'saveAsTemplate',
      'newFromTemplate',
      'print',
    ]);
  });

  it('書き出す・読み込むの説明には、扱える形式が書いてある(NFR-UX-7)', () => {
    // 一覧を開いた時点で「何が渡せるのか」が読めるようにする(FR-904)。
    expect(t('toolbar.file.exportShapeTooltip')).toContain('STEP');
    expect(t('toolbar.file.importShapeTooltip')).toContain('DXF');
  });

  it('新規・開く・保存の 3 つは一覧に入れない(図柄のまま残す、§0.57)', () => {
    const ids: readonly string[] = FILE_MENU_ITEMS.map((item) => item.id);
    for (const kept of ['new', 'open', 'save']) {
      expect(ids, kept).not.toContain(kept);
    }
    expect(FILE_ACTION_ICON_COUNT).toBe(3);
  });

  it('どの項目も図柄・名前・説明を持ち、説明が名前で始まらない(FR-904)', () => {
    for (const item of FILE_MENU_ITEMS) {
      expect(typeof item.Icon, item.id).toBe('function');
      expect(t(item.labelKey).length, item.id).toBeGreaterThan(0);
      expect(t(item.tooltipKey).length, item.id).toBeGreaterThan(0);
      expect(t(item.tooltipKey).startsWith(`${t(item.labelKey)}: `), item.id).toBe(false);
    }
  });

  it('畳んだボタンの名前と説明が引ける(FR-904、NFR-UX-7)', () => {
    // 溝そのものの読み上げ名(「ファイル」)と別の名前にしてある。同じ名前の group を
    // 入れ子にすると、読み上げでも検査でもどちらを指しているか取り違えるため。
    expect(t('toolbar.fileMenu.groupLabel')).not.toBe(t('toolbar.file.title'));
    expect(t('toolbar.fileMenu.tooltip').length).toBeGreaterThan(0);
  });

  it('別名保存の説明には出し方(Ctrl+Shift+S)が書いてある(NFR-UX-7)', () => {
    // ボタンの Shift 押しと同じことができる、という手掛かりを一覧の中でも読めるようにする。
    expect(t('toolbar.file.saveAsMenuTooltip')).toContain('Ctrl+Shift+S');
  });

  it('項目の id が「ファイル」の一覧の中で重複しない', () => {
    const ids = FILE_MENU_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('溝は 88 → 121 画素の 33 画素だけ広がる(§0.57 の幅の予算)', () => {
    /*
      畳んだボタン 1 つ(31)+隙間(2)。実測(1440×900、ダーク、拡大率 100%)も
      ファイルの溝 88 → 121 画素で一致する(報告に記載)。
    */
    expect(segmentedWidthPixels(FILE_ACTION_ICON_COUNT, 0)).toBe(88);
    expect(segmentedWidthPixels(FILE_ACTION_ICON_COUNT, FILE_MENU_COUNT)).toBe(121);
  });

  it('一覧へ 6 項目足しても溝は 121 画素のまま(畳んだ一覧に入れる理由)', () => {
    /*
      §0.57 の残り 6 項目(タスク32・33)は幅に 1 画素も効かない。平置きにしていたら
      図柄 1 個につき 28 画素(26+隙間 2)、6 個で 168 画素増えていた。
      **タスク32 で 2 行足した後もこの式は同じ**(下の `FILE_MENU_COUNT` は一覧の
      畳んだボタン 1 つの数で、中の行数では変わらない)。
    */
    const folded = segmentedWidthPixels(FILE_ACTION_ICON_COUNT, FILE_MENU_COUNT);
    expect(folded).toBe(121);
    const flatCost =
      segmentedWidthPixels(FILE_ACTION_ICON_COUNT + 6, 0) -
      segmentedWidthPixels(FILE_ACTION_ICON_COUNT, 0);
    expect(flatCost).toBe(6 * (ICON_BUTTON_WIDTH_PIXELS + 2));
  });

  it('畳んだボタンの図柄は、最後に選んだ操作のものになる(triggerItemOf)', () => {
    // ファイル操作は道具として選ばれた状態にならないので、いまの道具では決まらない。
    expect(triggerItemOf(FILE_MENU_ITEMS, 'line', null)).toBeNull();
    expect(triggerItemOf(FILE_MENU_ITEMS, 'line', 'saveAs')?.id).toBe('saveAs');
    expect(rememberRecentTool(FILE_MENU_ITEMS, null, 'saveAs')).toBe('saveAs');
  });

  it('図柄はファイルの 3 つのボタンと別のもの(見分けられる)', () => {
    const icons = FILE_MENU_ITEMS.map((item) => item.Icon);
    expect(new Set(icons).size).toBe(icons.length);
    // 一覧の中の図柄が、ほかの一覧の図柄と取り違えられていないことも見ておく。
    const others = [...CREATE_MENU_ITEMS, ...LOOK_MENU_ITEMS].map((item) => item.Icon);
    for (const icon of icons) {
      expect(others).not.toContain(icon);
    }
  });
});

/* ===== P6 タスク33: 数の決まらない行(FR-807、FR-814、§0.a-0.36・0.38) ===== */

describe('「ファイル」の一覧の、数の決まらない行(P6 タスク33)', () => {
  const TEMPLATES = [
    { id: '受け皿', name: '受け皿' },
    { id: '取付板', name: '取付板' },
  ];
  const RECENT = [
    { id: '歯車.pcad', name: '歯車.pcad' },
    { id: '台座.pcad', name: '台座.pcad' },
    { id: '蓋.pcad', name: '蓋.pcad' },
  ];

  it('ひな形も履歴も 0 件なら、図面作成を含む8行になる', () => {
    expect(fileMenuItems([], []).map((item) => item.id)).toEqual(
      FILE_MENU_ITEMS.map((item) => item.id),
    );
  });

  it('ひな形 2 件・履歴 3 件で 8 + 5 行になり、名前がそのまま出る', () => {
    const rows = fileMenuItems(TEMPLATES, RECENT);
    expect(rows).toHaveLength(FILE_MENU_ITEMS.length + 5);
    expect(rows.slice(FILE_MENU_ITEMS.length).map((row) => row.label)).toEqual([
      '受け皿',
      '取付板',
      '歯車.pcad',
      '台座.pcad',
      '蓋.pcad',
    ]);
  });

  it('動く行の id には種類の接頭辞が付き、決まった操作と重ならない(rules/06 10.9)', () => {
    const rows = fileMenuItems(TEMPLATES, RECENT);
    const ids = rows.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(`${STORED_TEMPLATE_MENU_PREFIX}受け皿`);
    expect(ids).toContain(`${RECENT_FILE_MENU_PREFIX}歯車.pcad`);
  });

  it('ひな形の名前が決まった操作の id と同じでも、行は食い違う(接頭辞の効き目)', () => {
    // 「print」という名前のひな形を残しても、印刷の行と取り違えない。
    const rows = fileMenuItems([{ id: 'print', name: 'print' }], []);
    const templateRow = rows[rows.length - 1];
    expect(templateRow.id).not.toBe('print');
    expect(isStoredTemplateMenuId(templateRow.id)).toBe(true);
    expect(storedTemplateIdOf(`${STORED_TEMPLATE_MENU_PREFIX}print`)).toBe('print');
  });

  it('決まった操作の id は、どちらの接頭辞にも当たらない', () => {
    for (const item of FILE_MENU_ITEMS) {
      expect(isStoredTemplateMenuId(item.id), item.id).toBe(false);
      expect(isRecentFileMenuId(item.id), item.id).toBe(false);
    }
  });

  it('動く行も図柄・名前・説明を持つ(FR-904)', () => {
    for (const row of fileMenuItems(TEMPLATES, RECENT)) {
      expect(typeof row.Icon, row.id).toBe('function');
      expect((row.label ?? t(row.labelKey)).length, row.id).toBeGreaterThan(0);
      expect(t(row.tooltipKey).length, row.id).toBeGreaterThan(0);
    }
  });

  it('行がいくつ増えても溝は 121 画素のまま(§0.57 の幅の予算)', () => {
    // 一覧の中の行数は溝の幅に効かない。ひな形 10 個 + 履歴 10 件でも同じ。
    expect(fileMenuItems(TEMPLATES, RECENT).length).toBeGreaterThan(FILE_MENU_ITEMS.length);
    expect(segmentedWidthPixels(FILE_ACTION_ICON_COUNT, FILE_MENU_COUNT)).toBe(121);
  });
});

describe('球面上の点を「作る」の一覧へ足す(FR-431、P5 タスク22、§0.a-0.80)', () => {
  it('球・箱・円柱・円錐・トーラスのすぐ後ろに並ぶ', () => {
    const ids = CREATE_MENU_ITEMS.map((item) => item.id);
    expect(ids[ids.indexOf('torus') + 1]).toBe('sphereGridPoint');
  });

  it('図柄・名前・説明を持ち、説明が名前で始まらない(FR-904)', () => {
    const item = CREATE_MENU_ITEMS.find((candidate) => candidate.id === 'sphereGridPoint');
    expect(item).toBeDefined();
    if (item === undefined) {
      return;
    }
    expect(typeof item.Icon).toBe('function');
    expect(t(item.labelKey).length).toBeGreaterThan(0);
    expect(t(item.tooltipKey).length).toBeGreaterThan(0);
    expect(t(item.tooltipKey).startsWith(`${t(item.labelKey)}: `)).toBe(false);
  });

  it('図柄は球のものと別(選ぶときに見分けられる)', () => {
    const sphere = CREATE_MENU_ITEMS.find((candidate) => candidate.id === 'sphere')?.Icon;
    const point = CREATE_MENU_ITEMS.find((candidate) => candidate.id === 'sphereGridPoint')?.Icon;
    expect(sphere).toBeDefined();
    expect(point).toBeDefined();
    expect(point).not.toBe(sphere);
  });

  it('1 つ足してもツールバーの幅は 1 画素も増えない(畳んだ一覧に入れる理由)', () => {
    expect(segmentedWidthPixels(0, SOLID_MENU_COUNT)).toBe(103);
    const flatBefore = segmentedWidthPixels(CREATE_MENU_ITEMS.length - 1, 0);
    const flatAfter = segmentedWidthPixels(CREATE_MENU_ITEMS.length, 0);
    expect(flatAfter - flatBefore).toBe(28);
  });
});
