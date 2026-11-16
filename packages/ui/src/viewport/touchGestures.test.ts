import { describe, expect, it } from 'vitest';
import { createTouchGestureTracker } from './touchGestures.js';

/* 設計 2-2・B-08g: タッチの 2 本指の読み取り。期待の値は座標から手で求めた物(製品の式を使わない)。 */
/** 2 本の指を置いた追跡(1 本目 a、2 本目 b)。 */
function twoFingers(a: readonly [number, number], b: readonly [number, number]) {
  const tracker = createTouchGestureTracker();
  tracker.down({ id: 1, x: a[0], y: a[1] }); tracker.down({ id: 2, x: b[0], y: b[1] });
  return tracker;
}

describe('2 本指の 1 回の動き', () => {
  it('2 本とも右へ 10 動かすと(1 本ずつ動く)、中点の移動の和は 10、距離の比の積は 1', () => {
    const tracker = twoFingers([0, 0], [100, 0]);
    const first = tracker.move({ id: 1, x: 10, y: 0 }), second = tracker.move({ id: 2, x: 110, y: 0 });
    expect(first).toEqual({ dx: 5, dy: 0, scale: 0.9, centerX: 55, centerY: 0 });
    expect(second?.centerX).toBe(60);
    expect((first?.dx ?? 0) + (second?.dx ?? 0)).toBe(10);
    expect((first?.scale ?? 0) * (second?.scale ?? 0)).toBeCloseTo(1, 12);
  });

  it('2 本目を 100 から 200 へ離すと比は 2、中点は 50 動く', () => {
    expect(twoFingers([50, 50], [150, 50]).move({ id: 2, x: 250, y: 50 })).toEqual({ dx: 50, dy: 0, scale: 2, centerX: 150, centerY: 50 });
  });

  it('斜めにつまむ(3・4・5 の直角三角形の 10 倍から 5 倍へ)と比は 0.5', () => {
    const step = twoFingers([0, 0], [30, 40]).move({ id: 2, x: 15, y: 20 });
    expect(step?.scale).toBeCloseTo(0.5, 12);
    expect(step?.dx).toBeCloseTo(-7.5, 12);
    expect(step?.dy).toBeCloseTo(-10, 12);
  });

  it('指が重なっている時(距離 1 画素未満)は比を 1 にする(跳ねない)', () => {
    expect(twoFingers([5, 5], [5.5, 5]).move({ id: 2, x: 40, y: 5 })?.scale).toBe(1);
    expect(twoFingers([0, 5], [40, 5]).move({ id: 2, x: 0.2, y: 5 })?.scale).toBe(1);
  });
});

describe('指の追跡', () => {
  it('1 本目は first、2 本目は second、3 本目は数えない', () => {
    const tracker = createTouchGestureTracker();
    expect(tracker.down({ id: 1, x: 0, y: 0 })).toBe('first');
    expect(tracker.active()).toBe(false);
    expect(tracker.down({ id: 2, x: 100, y: 0 })).toBe('second');
    expect(tracker.active()).toBe(true);
    expect(tracker.down({ id: 3, x: 50, y: 50 })).toBe('ignored');
  });

  it('1 本だけの間は動きを返さない(今どおり作図・選択へ届く)', () => {
    const tracker = createTouchGestureTracker();
    tracker.down({ id: 1, x: 0, y: 0 });
    expect(tracker.move({ id: 1, x: 30, y: 0 })).toBeNull();
  });

  it('2 本指の間は、動かした指の今と前の位置から動きを返し、3 本目の指の動きは返さない', () => {
    const tracker = createTouchGestureTracker();
    tracker.down({ id: 1, x: 0, y: 0 }); tracker.down({ id: 2, x: 100, y: 0 }); tracker.down({ id: 3, x: 50, y: 80 });
    expect(tracker.move({ id: 2, x: 200, y: 0 })).toEqual({ dx: 50, dy: 0, scale: 2, centerX: 100, centerY: 0 });
    expect(tracker.move({ id: 1, x: 20, y: 0 })).toEqual({ dx: 10, dy: 0, scale: 0.9, centerX: 110, centerY: 0 });
    expect(tracker.move({ id: 3, x: 0, y: 0 })).toBeNull();
    expect(tracker.move({ id: 9, x: 0, y: 0 })).toBeNull();
  });

  it('2 本のどちらかが離れたら、全部が離れるまで動きを返さず、全部が離れたら最初からやり直す', () => {
    const tracker = createTouchGestureTracker();
    tracker.down({ id: 1, x: 0, y: 0 }); tracker.down({ id: 2, x: 100, y: 0 });
    tracker.up(2);
    expect(tracker.active()).toBe(true);
    expect(tracker.move({ id: 1, x: 40, y: 0 })).toBeNull();
    expect(tracker.down({ id: 4, x: 10, y: 10 })).toBe('ignored');
    tracker.up(4); tracker.up(1);
    expect(tracker.active()).toBe(false);
    expect(tracker.down({ id: 5, x: 0, y: 0 })).toBe('first');
  });

  it('3 本目の指が離れても 2 本指の操作は続く', () => {
    const tracker = createTouchGestureTracker();
    tracker.down({ id: 1, x: 0, y: 0 }); tracker.down({ id: 2, x: 100, y: 0 }); tracker.down({ id: 3, x: 50, y: 80 });
    tracker.up(3);
    expect(tracker.move({ id: 1, x: 10, y: 0 })).toEqual({ dx: 5, dy: 0, scale: 0.9, centerX: 55, centerY: 0 });
  });
});
