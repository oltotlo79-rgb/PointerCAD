import { describe, expect, it } from 'vitest';

import {
  enterDialogFocus, forgetMenuOpener, leaveDialogFocus, menuTriggerOf, noteMenuOpener, takeMenuOpener, type FocusTarget,
} from './dialogFocusRules.js';

/* C-03 その場の窓のフォーカス: 開いた時に中へ入れ、閉じた時に開いた元(消えていれば代わり)へ戻し、窓の外へ移した焦点は奪わない。
 * メニューの項目から開いた窓は、そのメニューを開く釦(印 data-menu-trigger)を開いた元にする。 */
interface FakeTarget extends FocusTarget { readonly name: string; isConnected: boolean }

function fakeDom() {
  let active: unknown = null;
  const body = { name: 'body' };
  const target = (name: string): FakeTarget => {
    const fake: FakeTarget = { name, isConnected: true, focus: () => { active = fake; } };
    return fake;
  };
  const opener = target('開いた元'), first = target('窓の最初の欄'), second = target('窓の 2 つ目の欄'), outside = target('3D の画面');
  const members = new Set<unknown>([first, second]);
  const scope = { owns: (node: unknown) => members.has(node), first: () => first };
  return { body, opener, first, second, outside, scope, target, active: () => active, setActive: (next: unknown) => { active = next; } };
}

describe('その場の窓のフォーカス', () => {
  it('開いた時: 焦点が窓の外なら最初の欄(initial があればそれ)へ入れ、開いた元を返す', () => {
    const dom = fakeDom();
    dom.setActive(dom.opener);
    expect(enterDialogFocus(dom.scope, dom.active(), dom.body, null)).toBe(dom.opener);
    expect(dom.active()).toBe(dom.first);
    dom.setActive(dom.opener);
    enterDialogFocus(dom.scope, dom.active(), dom.body, dom.second);
    expect(dom.active()).toBe(dom.second);
  });

  it('開いた時: すでに窓の中に焦点があれば動かさない。body から開いた時は開いた元を持たない', () => {
    const dom = fakeDom();
    dom.setActive(dom.second);
    expect(enterDialogFocus(dom.scope, dom.active(), dom.body, null)).toBeNull();
    expect(dom.active()).toBe(dom.second);
    dom.setActive(dom.body);
    expect(enterDialogFocus(dom.scope, dom.active(), dom.body, null)).toBeNull();
    expect(dom.active()).toBe(dom.first);
  });

  it('閉じた時: 焦点が窓の中か body なら開いた元へ戻し、開いた元が消えていれば代わりへ、どちらも無ければ動かさない', () => {
    const dom = fakeDom();
    dom.setActive(dom.second);
    leaveDialogFocus(dom.scope, dom.active(), dom.body, dom.opener, null);
    expect(dom.active()).toBe(dom.opener);
    dom.setActive(dom.body);
    dom.opener.isConnected = false;
    leaveDialogFocus(dom.scope, dom.active(), dom.body, dom.opener, dom.outside);
    expect(dom.active()).toBe(dom.outside);
    dom.setActive(dom.body);
    leaveDialogFocus(dom.scope, dom.active(), dom.body, dom.opener, null);
    expect(dom.active()).toBe(dom.body);
  });

  it('閉じた時: 利用者が窓の外へ焦点を移していれば奪わない', () => {
    const dom = fakeDom();
    dom.setActive(dom.outside);
    leaveDialogFocus(dom.scope, dom.active(), dom.body, dom.opener, null);
    expect(dom.active()).toBe(dom.outside);
  });
});

describe('メニューの項目から開いた窓', () => {
  /** 項目(.pcad-menu__panel の中)・釦(同じ .pcad-menu の中で印を持つ)の偽物。 */
  function menu(trigger: unknown, inPanel: boolean) {
    const container = { querySelector: (selectors: string) => selectors === '[data-menu-trigger]' ? trigger : null };
    return { closest: (selectors: string) => selectors === '.pcad-menu' ? container
      : selectors === '.pcad-menu__panel' && inPanel ? container : null };
  }

  it('項目を押すと、そのメニューの印のある釦を返す。メニューの外の物・印の無いメニューは null', () => {
    const dom = fakeDom();
    const trigger = dom.target('組む');
    expect(menuTriggerOf(menu(trigger, true))).toBe(trigger);
    expect(menuTriggerOf(menu(trigger, false))).toBeNull();
    expect(menuTriggerOf(menu(null, true))).toBeNull();
  });

  it('覚えた釦は次に開いた窓に 1 回だけ渡り、メニューの外の押下・キー(forget)の後には残らない', () => {
    const dom = fakeDom();
    const trigger = dom.target('組む');
    noteMenuOpener(trigger);
    expect(takeMenuOpener()).toBe(trigger);
    expect(takeMenuOpener()).toBeNull();
    // ファイルを選んでから開く窓のように、押下の後しばらくして開いても使える(間にほかの押下が無ければ)。
    noteMenuOpener(trigger);
    noteMenuOpener(null);
    expect(takeMenuOpener()).toBe(trigger);
    noteMenuOpener(trigger);
    forgetMenuOpener();
    expect(takeMenuOpener()).toBeNull();
  });

  it('関係の無い押下の後に開いた窓は、覚えた釦を使わない(項目の後に別の所を押してから、近道などで窓を開いた時)', () => {
    const dom = fakeDom();
    noteMenuOpener(dom.target('組む'));
    // メニューの外の押下(画面の側で forgetMenuOpener を呼ぶ)。
    forgetMenuOpener();
    dom.setActive(dom.body);
    const opener = enterDialogFocus(dom.scope, dom.active(), dom.body, null) ?? takeMenuOpener();
    expect(opener).toBeNull();
  });

  it('Firefox のように、外した項目が activeElement に残っていても、それを開いた元にせず覚えた釦を使い、閉じた時はその釦へ戻す', () => {
    const dom = fakeDom();
    const trigger = dom.target('組む'), item = dom.target('規格部品(一覧と一緒に外れた項目)');
    noteMenuOpener(trigger);
    item.isConnected = false;
    dom.setActive(item);
    const opener = enterDialogFocus(dom.scope, dom.active(), dom.body, null) ?? takeMenuOpener();
    expect(opener).toBe(trigger);
    expect(dom.active()).toBe(dom.first);
    // 閉じた時も、焦点が外れた欄に残っていれば落ちた物として扱い、開いた元へ戻す。
    const field = dom.target('外れた窓の欄');
    field.isConnected = false;
    dom.setActive(field);
    leaveDialogFocus(dom.scope, dom.active(), dom.body, opener, null);
    expect(dom.active()).toBe(trigger);
  });

  it('ファイルを選ぶ窓をやめた時(窓が開かない)、覚えた釦は、やめた後の最初の押下かキーで忘れ、次の関係の無い窓へ持ち越さない', () => {
    const dom = fakeDom();
    noteMenuOpener(dom.target('組む'));
    // ファイルを選ぶ窓をやめても文書に押下は来ないので、まだ覚えている。やめた後に利用者が押す・打つと忘れる。
    forgetMenuOpener();
    noteMenuOpener(null);
    expect(takeMenuOpener()).toBeNull();
  });
});
