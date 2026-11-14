import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHoverHintTimer, HOVER_HINT_DELAY_MS } from './controlHintHover.js';

/*
 * マウスのホバーの案内の箱(報告の指摘 6、統括の決定 1)。図柄だけのボタンに 0.3 秒置くと、キーボードの焦点の時と
 * 同じ箱を出す。押したら消え、同じボタンの上にいる間は出し直さない。時間は偽の時計で確かめる。
 */
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function setup() {
  const shown: string[] = [], hidden: number[] = [];
  const timer = createHoverHintTimer<string>({
    delayMs: HOVER_HINT_DELAY_MS,
    show: control => { shown.push(control); },
    hide: () => { hidden.push(hidden.length); },
  });
  return { timer, shown, hidden };
}

describe('ホバーの案内の箱の時間', () => {
  it('遅れは 0.3 秒で、0.3 秒たつ前には出さない', () => {
    expect(HOVER_HINT_DELAY_MS).toBe(300);
    const { timer, shown } = setup();
    timer.enter('save');
    vi.advanceTimersByTime(299);
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(shown).toEqual(['save']);
  });

  it('0.3 秒たつ前に離れると出さず、出た後に離れると消す', () => {
    const { timer, shown, hidden } = setup();
    timer.enter('save'); vi.advanceTimersByTime(200); timer.leave('save'); vi.advanceTimersByTime(500);
    expect(shown).toEqual([]);
    timer.enter('open'); vi.advanceTimersByTime(300); timer.leave('open');
    expect(shown).toEqual(['open']);
    expect(hidden.length).toBeGreaterThanOrEqual(1);
  });

  it('別のボタンへ移ると、その時から数え直してそのボタンの箱を出す', () => {
    const { timer, shown } = setup();
    timer.enter('save'); vi.advanceTimersByTime(250); timer.enter('open'); vi.advanceTimersByTime(250);
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(50);
    expect(shown).toEqual(['open']);
  });

  it('押したら消し、同じボタンの上にいる間は出し直さず、一度離れて戻れば出す', () => {
    const { timer, shown, hidden } = setup();
    timer.enter('undo'); vi.advanceTimersByTime(300);
    timer.press(); const hides = hidden.length;
    expect(hides).toBeGreaterThanOrEqual(1);
    timer.enter('undo'); vi.advanceTimersByTime(1000);
    expect(shown).toEqual(['undo']);
    timer.leave('undo'); timer.enter('undo'); vi.advanceTimersByTime(300);
    expect(shown).toEqual(['undo', 'undo']);
  });

  it('止めると待っている箱を出さない(キーボードの案内が先に出る時、部品を外す時)', () => {
    const { timer, shown } = setup();
    timer.enter('save'); timer.cancel(); vi.advanceTimersByTime(1000);
    expect(shown).toEqual([]);
  });
});
