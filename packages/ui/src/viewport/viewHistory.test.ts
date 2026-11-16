import { describe, expect, it } from 'vitest';
import { HOME_ORBIT, type OrbitState } from './cameraMath.js';
import { createViewHistory, VIEW_HISTORY_LIMIT, VIEW_STEP_GAP_MS } from './viewHistory.js';

/* 設計 2-3(B-08c): 視点を変える操作 1 つごとに前の視点を積み、直前の視点へ戻る時は新しい物から取り出す。 */
const at = (distance: number): OrbitState => ({ ...HOME_ORBIT, distance });

function history() {
  let clock = 0;
  const value = createViewHistory(() => clock);
  return { value, advance: (ms: number) => { clock += ms; } };
}

describe('視点の履歴', () => {
  it('間隔の短い変化(1 回のドラッグ・ホイールの連続)は 1 つの操作として、その前の視点を 1 つだけ積む', () => {
    const { value, advance } = history();
    value.beforeChange(at(100));
    for (let frame = 0; frame < 30; frame += 1) { advance(16); value.beforeChange(at(101 + frame)); }
    expect(value.size()).toBe(1);
    advance(VIEW_STEP_GAP_MS);
    value.beforeChange(at(200));
    expect(value.size()).toBe(2);
    expect(value.takePrevious(at(300))).toEqual(at(200));
    expect(value.takePrevious(at(200))).toEqual(at(100));
    expect(value.takePrevious(at(100))).toBeNull();
  });

  it('戻した視点は積まず、続けて戻るとさらに前へ戻る。戻した後の最初の変化は新しい操作として積む', () => {
    const { value, advance } = history();
    for (const distance of [100, 200, 300]) { value.beforeChange(at(distance)); advance(VIEW_STEP_GAP_MS); }
    expect(value.takePrevious(at(400))).toEqual(at(300));
    expect(value.takePrevious(at(300))).toEqual(at(200));
    expect(value.size()).toBe(1);
    // 戻した直後(間隔が短くても)の変化は、戻した視点を新しい 1 つとして積む。
    advance(1);
    value.beforeChange(at(200));
    expect(value.size()).toBe(2);
    expect(value.takePrevious(at(250))).toEqual(at(200));
  });

  it('今と同じ視点は積まず、取り出す時も飛ばす。上向きとズームも同じかどうかに含める', () => {
    const { value, advance } = history();
    value.beforeChange(at(100)); advance(VIEW_STEP_GAP_MS);
    value.beforeChange(at(100)); advance(VIEW_STEP_GAP_MS);
    expect(value.size()).toBe(1);
    value.beforeChange({ ...at(100), zoom: 2 }); advance(VIEW_STEP_GAP_MS);
    value.beforeChange({ ...at(100), up: [0, 1, 0] });
    expect(value.size()).toBe(3);
    expect(value.takePrevious({ ...at(100), up: [0, 1, 0] })).toEqual({ ...at(100), zoom: 2 });
  });

  it(`積めるのは ${String(VIEW_HISTORY_LIMIT)} 個までで、古い物から捨てる`, () => {
    const { value, advance } = history();
    for (let step = 0; step < VIEW_HISTORY_LIMIT + 5; step += 1) { value.beforeChange(at(step + 1)); advance(VIEW_STEP_GAP_MS); }
    expect(value.size()).toBe(VIEW_HISTORY_LIMIT);
    const taken: number[] = [];
    for (let previous = value.takePrevious(at(1000)); previous !== null; previous = value.takePrevious(previous)) taken.push(previous.distance);
    expect(taken).toHaveLength(VIEW_HISTORY_LIMIT);
    expect(taken[0]).toBe(VIEW_HISTORY_LIMIT + 5);
    expect(taken.at(-1)).toBe(6);
  });
});
