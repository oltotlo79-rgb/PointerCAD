/**
 * ツールバーの畳んだ一覧(「作図」「編集」)の決まりごとの検査
 * (計画書 docs/plans/P4-スケッチ拡張.md タスク32、§0.a-0.14)。
 *
 * 画面(DOM)は撮影で確かめるので、ここでは表と純関数だけを見る。
 */

import { describe, expect, it } from 'vitest';

import {
  BASIC_SKETCH_TOOL_COUNT,
  EDIT_MENU_ITEMS,
  ICON_BUTTON_WIDTH_PIXELS,
  MENU_TRIGGER_WIDTH_PIXELS,
  SHAPE_MENU_ITEMS,
  SKETCH_MENU_COUNT,
  nextHighlightIndex,
  rememberRecentTool,
  segmentedWidthPixels,
  triggerItemOf,
} from './toolbarMenus.js';

describe('畳んだ一覧の中身(FR-904、NFR-UX-7)', () => {
  it('「作図」には P4 で足した 7 つの形が並ぶ', () => {
    expect(SHAPE_MENU_ITEMS.map((item) => item.id)).toEqual([
      'circle',
      'twoPointArc',
      'rectangle',
      'polygon',
      'slot',
      'ellipse',
      'spline',
    ]);
  });

  it('「編集」には整形系と複製系が並ぶ(タスク23 のフィレット・面取りがここへ足す)', () => {
    expect(EDIT_MENU_ITEMS.map((item) => item.id)).toEqual([
      'offset',
      // クリックだけで決まる 2 つ(タスク22)。
      'trim',
      'extend',
      // 選んでから確定する複製系(タスク24)。
      'mirror',
      'copy',
      'linearArray',
      'circularArray',
    ]);
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
   * 「スケッチ」区画は、基本の 6 道具+畳んだ一覧 2 つを 1 つの溝へ並べた 1 行。
   * 26×6 + 31×2 + 隙間 2×7 + 内余白 2×2 + 枠 1×2 = 238 画素。
   * 実測(1440 画素・ダーク・拡大率 100%)も 238 画素で一致する(報告に記載)。
   */
  it('基本 6 道具と畳んだ一覧 2 つで 238 画素', () => {
    expect(segmentedWidthPixels(BASIC_SKETCH_TOOL_COUNT, SKETCH_MENU_COUNT)).toBe(238);
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

  it('ボタンが 1 つも無ければ 0(区画を作らない)', () => {
    expect(segmentedWidthPixels(0, 0)).toBe(0);
  });

  it('図柄のボタンと畳んだ一覧のボタンの幅は CSS と同じ値', () => {
    expect(ICON_BUTTON_WIDTH_PIXELS).toBe(26);
    expect(MENU_TRIGGER_WIDTH_PIXELS).toBe(31);
  });
});
