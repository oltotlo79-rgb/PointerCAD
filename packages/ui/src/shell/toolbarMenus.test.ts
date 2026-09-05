/**
 * ツールバーの畳んだ一覧(「作図」「編集」「拘束」「作る」「合わせる」「加工」「投影」
 * 「見た目」)の決まりごとの検査
 * (計画書 docs/plans/P4-スケッチ拡張.md タスク32、§0.a-0.14。
 *  「拘束」は docs/plans/P4b-スケッチの仕上げ.md タスク13。
 *  ソリッド側の組み替えは docs/plans/P5-高度なソリッド・外観と測定.md タスク51、§0.a-0.51)。
 *
 * 画面(DOM)は撮影で確かめるので、ここでは表と純関数だけを見る。
 */

import { SKETCH_CONSTRAINT_KINDS } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';
import {
  BASIC_SKETCH_TOOL_COUNT,
  COMBINE_MENU_ITEMS,
  CONSTRAINT_MENU_ITEMS,
  CREATE_MENU_ITEMS,
  EDIT_MENU_ITEMS,
  ICON_BUTTON_WIDTH_PIXELS,
  LOOK_MENU_ITEMS,
  MACHINING_MENU_ITEMS,
  MENU_TRIGGER_WIDTH_PIXELS,
  PROJECTION_MENU_ITEMS,
  SHAPE_MENU_ITEMS,
  SINGLE_MENU_COUNT,
  SKETCH_MENU_COUNT,
  SOLID_MENU_COUNT,
  nextHighlightIndex,
  rememberRecentTool,
  segmentedWidthPixels,
  triggerItemOf,
} from './toolbarMenus.js';

describe('畳んだ一覧の中身(FR-904、NFR-UX-7)', () => {
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
    expect(LOOK_MENU_ITEMS.map((item) => item.id)).toEqual(['appearance', 'measure']);
  });

  it('「測る」を足しても「見た目」の溝の幅は 37 画素のまま(§0.a-0.80)', () => {
    /*
      畳んだ一覧の中に項目をいくつ足しても溝の幅は変わらない、という約束の実例。
      平置きにしていたら図柄 2 個で 60 画素になり、1440 画素の窓の余裕が削れていた。
    */
    expect(LOOK_MENU_ITEMS).toHaveLength(2);
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
