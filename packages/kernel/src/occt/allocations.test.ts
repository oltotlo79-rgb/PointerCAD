import { describe, expect, it } from 'vitest';

import { createAllocations, type OcctDeletable } from './allocations.js';

/**
 * delete() が呼ばれた順を共有の記録へ書き足すだけの偽の物。
 * 入れ物は中身を見ないので、OCCT を読まずに順序と回数だけを検査できる(所要 1 秒未満)。
 */
function fakeItem(name: string, order: string[]): OcctDeletable {
  return {
    delete(): void {
      order.push(name);
    },
  };
}

/** delete() が必ず例外を投げる偽の物。1 つの失敗で残りを漏らさないことの検査に使う。 */
function throwingItem(name: string, order: string[]): OcctDeletable {
  return {
    delete(): void {
      order.push(name);
      throw new Error(`${name} の解放に失敗しました。`);
    },
  };
}

describe('OCCT の確保の入れ物(作った順の逆にまとめて解放する)', () => {
  it('積んだ順の逆に delete() を 1 回ずつ呼ぶ', () => {
    const order: string[] = [];
    const { keep, release } = createAllocations();
    keep(fakeItem('1', order));
    keep(fakeItem('2', order));
    keep(fakeItem('3', order));

    release();

    // 形は maker の中の実体を指すので、後から積んだものほど先に解放する。
    expect(order).toEqual(['3', '2', '1']);
  });

  it('release を 2 回呼んでも 2 回目は何も解放しない', () => {
    const order: string[] = [];
    const { keep, release } = createAllocations();
    keep(fakeItem('1', order));
    keep(fakeItem('2', order));

    release();
    release();

    expect(order).toEqual(['2', '1']);
  });

  it('何も積まずに release を呼んでも例外にならない', () => {
    const { release } = createAllocations();

    expect(() => {
      release();
    }).not.toThrow();
  });

  it('keep は渡したものをそのまま返す', () => {
    const order: string[] = [];
    const { keep } = createAllocations();
    const item = fakeItem('1', order);

    expect(keep(item)).toBe(item);
    // 積んだだけでは解放しない。
    expect(order).toEqual([]);
  });

  it('途中の delete が例外を投げても、残りをすべて解放してから投げ直す', () => {
    const order: string[] = [];
    const { keep, release } = createAllocations();
    keep(fakeItem('1', order));
    keep(throwingItem('2', order));
    keep(fakeItem('3', order));

    expect(() => {
      release();
    }).toThrow('2 の解放に失敗しました。');
    // 例外の後も残り(番号の小さいほう)まで解放が届いている。
    expect(order).toEqual(['3', '2', '1']);
  });

  it('複数が例外を投げたときは、最初に起きた例外を投げ直す', () => {
    const order: string[] = [];
    const { keep, release } = createAllocations();
    keep(throwingItem('1', order));
    keep(throwingItem('2', order));

    // 解放は後ろから始まるので、最初に起きるのは '2' の失敗。
    expect(() => {
      release();
    }).toThrow('2 の解放に失敗しました。');
    expect(order).toEqual(['2', '1']);
  });

  it('例外が起きた後でも控えは空になり、2 度目の release は何も解放しない', () => {
    const order: string[] = [];
    const { keep, release } = createAllocations();
    keep(fakeItem('1', order));
    keep(throwingItem('2', order));

    expect(() => {
      release();
    }).toThrow();
    order.length = 0;

    expect(() => {
      release();
    }).not.toThrow();
    expect(order).toEqual([]);
  });

  it('入れ物ごとに控えは別になる', () => {
    const order: string[] = [];
    const first = createAllocations();
    const second = createAllocations();
    first.keep(fakeItem('first', order));
    second.keep(fakeItem('second', order));

    first.release();

    expect(order).toEqual(['first']);

    second.release();

    expect(order).toEqual(['first', 'second']);
  });
});
