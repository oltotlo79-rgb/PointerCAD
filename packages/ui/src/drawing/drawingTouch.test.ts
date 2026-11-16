import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VIEW_CONTROLS, type ViewControlSettings, type ViewTrigger } from '../settings/viewControlSettings.js';
import { INITIAL_DRAWING_NAVIGATION, type DrawingNavigationTransform } from './drawingNavigation.js';
import { attachDrawingTouch } from './drawingTouch.js';

/*
 * 設計 2-2・B-08g の続きと B-08h: 図面の紙の指。紙は回さない。受け手の口(出来事を送って紙の表示を見る)から確かめる。
 * 期待の値は手で求めた物。
 */
const OFF = { alt: false, shift: false, ctrl: false, meta: false } as const;
const touch = (gesture: 'oneFinger' | 'twoFinger' | 'pinch'): ViewTrigger => ({ kind: 'touch', gesture, ...OFF });
const base = DEFAULT_VIEW_CONTROLS.bindings;
const withTouch = (orbit: readonly ViewTrigger[], panning: readonly ViewTrigger[], zoom: readonly ViewTrigger[]): ViewControlSettings =>
  ({ ...DEFAULT_VIEW_CONTROLS, bindings: { orbit: [...base.orbit, ...orbit], pan: [...base.pan, ...panning], zoom: [...base.zoom, ...zoom] } });
const PAN_AND_PINCH = withTouch([], [touch('twoFinger')], [touch('pinch')]);

function fixture(settings: ViewControlSettings) {
  const surface = new EventTarget(), behind: string[] = [];
  let transform: DrawingNavigationTransform = INITIAL_DRAWING_NAVIGATION;
  const setTransform = vi.fn((next: DrawingNavigationTransform) => { transform = next; });
  const focus = vi.fn();
  const detach = attachDrawingTouch(surface, { readSettings: () => settings, sheetBounds: () => ({ left: 10, top: 20 }),
    getTransform: () => transform, setTransform, focus });
  for (const type of ['pointerdown', 'pointerup', 'pointercancel']) surface.addEventListener(type, () => { behind.push(type); });
  const send = (type: string, pointerId: number, clientX: number, clientY: number): Event => {
    const event = Object.assign(new Event(type, { cancelable: true }), { pointerId, pointerType: 'touch', clientX, clientY });
    surface.dispatchEvent(event);
    return event;
  };
  return { send, detach, setTransform, focus, behind, transform: () => transform };
}

describe('紙の 2 本指', () => {
  it('割り当てた時、2 本指で紙を動かし、つまむ中心は紙の面の左上からの画素で求める', () => {
    const app = fixture(PAN_AND_PINCH);
    app.send('pointerdown', 1, 10, 20); app.send('pointerdown', 2, 110, 20);
    // 2 本目の指を 110 → 210 へ離すと、中点は 60 → 110(紙の面の左上から 100)、距離の比は 2。
    app.send('pointermove', 2, 210, 20);
    expect(app.setTransform).toHaveBeenCalledTimes(1);
    const after = app.transform();
    expect(after.scale).toBeCloseTo(2, 9);
    // 平行移動 50 の後、紙の面の左上から (100, 0) を中心に 2 倍: x = 50 + 100·(1 − 2) = -50。
    expect(after.x).toBeCloseTo(-50, 9);
    expect(after.y).toBeCloseTo(0, 9);
    app.detach();
  });

  it('2 本指の平行移動には平行移動の速さを掛ける', () => {
    const fast = { ...withTouch([], [touch('twoFinger')], []), options: { ...DEFAULT_VIEW_CONTROLS.options, panSensitivity: 2 } };
    const app = fixture(fast);
    app.send('pointerdown', 1, 10, 20); app.send('pointerdown', 2, 110, 20); app.send('pointermove', 2, 134, 12);
    // 中点の移動は (12, -4)、速さ 2 倍で (24, -8)。つまむは割り当てていないので倍率は 1。
    expect(app.transform()).toEqual({ x: 24, y: -8, scale: 1 });
    app.detach();
  });

  it('割当が無い・回転の割当だけの時は、紙の上では始めない(今どおり後ろへ渡す)', () => {
    for (const settings of [DEFAULT_VIEW_CONTROLS, withTouch([touch('twoFinger')], [], [])]) {
      const app = fixture(settings);
      app.send('pointerdown', 1, 10, 20);
      expect(app.send('pointerdown', 2, 110, 20).defaultPrevented).toBe(false);
      app.send('pointermove', 2, 210, 20);
      expect(app.setTransform).not.toHaveBeenCalled();
      expect(app.behind).toEqual(['pointerdown', 'pointerdown']);
      app.detach();
    }
  });
});

describe('紙の 1 本指(B-08h)', () => {
  it('1 本指を平行移動に割り当てた時: 閾値を超えたドラッグは紙を動かし、軽く触れた指は押下と離しを 1 回ずつ送り直す', () => {
    const app = fixture(withTouch([], [touch('oneFinger')], []));
    app.send('pointerdown', 1, 0, 0); app.send('pointermove', 1, 20, 0); app.send('pointerup', 1, 20, 0);
    expect(app.transform()).toEqual({ x: 20, y: 0, scale: 1 });
    expect(app.behind).toEqual([]);
    app.send('pointerdown', 1, 50, 0); app.send('pointerup', 1, 52, 0);
    expect(app.behind).toEqual(['pointerdown', 'pointerup']);
    expect(app.focus).toHaveBeenCalledTimes(1);
    expect(app.transform()).toEqual({ x: 20, y: 0, scale: 1 });
    app.detach();
  });

  it('1 本指が回転の割当の時は、紙の上では持たない(紙は回さない。今どおり後ろへ渡す)', () => {
    const app = fixture(withTouch([touch('oneFinger')], [], []));
    expect(app.send('pointerdown', 1, 0, 0).defaultPrevented).toBe(false);
    app.send('pointermove', 1, 30, 0); app.send('pointerup', 1, 30, 0);
    expect(app.setTransform).not.toHaveBeenCalled();
    expect(app.behind).toEqual(['pointerdown', 'pointerup']);
    app.detach();
  });
});
