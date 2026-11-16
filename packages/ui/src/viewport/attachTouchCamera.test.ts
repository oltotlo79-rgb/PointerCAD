import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VIEW_CONTROLS, type ViewControlSettings, type ViewTrigger } from '../settings/viewControlSettings.js';
import { attachTouchCamera } from './attachTouchCamera.js';
import { HOME_ORBIT, orbit as orbitBy, pan, type OrbitState } from './cameraMath.js';

/*
 * 設計 2-2・B-08g・B-08h: タッチの指の視点の操作。既定は割当なし(今どおり)。受け手の口(出来事を送って結果を見る)から確かめる。
 * 期待の視点は、届いた指の座標から手で求めた量を視点の計算(cameraMath)へ渡して作る。
 */
const OFF = { alt: false, shift: false, ctrl: false, meta: false } as const;
const touch = (gesture: 'oneFinger' | 'twoFinger' | 'pinch'): ViewTrigger => ({ kind: 'touch', gesture, ...OFF });
const base = DEFAULT_VIEW_CONTROLS.bindings;
const withTouch = (orbit: readonly ViewTrigger[], panning: readonly ViewTrigger[], zoom: readonly ViewTrigger[]): ViewControlSettings =>
  ({ ...DEFAULT_VIEW_CONTROLS, bindings: { orbit: [...base.orbit, ...orbit], pan: [...base.pan, ...panning], zoom: [...base.zoom, ...zoom] } });
const PAN_AND_PINCH = withTouch([], [touch('twoFinger')], [touch('pinch')]);

function fixture(settings: ViewControlSettings, canOrbit = true) {
  const canvas = new EventTarget();
  let orbit: OrbitState = HOME_ORBIT;
  const target = {
    getOrbit: () => orbit, setOrbit: vi.fn((next: OrbitState) => { orbit = next; }),
    viewportHeight: () => 600, canOrbit: () => canOrbit, zoomPoint: () => null, focus: vi.fn(),
  };
  const detach = attachTouchCamera(canvas, target, () => settings);
  /** 後ろの受け手(作図・選択の代わり)。捕捉の段の後に届いた出来事を記録する。 */
  const behind: string[] = [];
  /** 後ろへ届いた出来事の座標と種類(送り直しの確かめ)。 */
  const delivered: { readonly type: string; readonly x: unknown; readonly y: unknown; readonly pointerType: unknown }[] = [];
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    canvas.addEventListener(type, event => {
      behind.push(`${type}:${String(Reflect.get(event, 'pointerId'))}`);
      delivered.push({ type, x: Reflect.get(event, 'clientX'), y: Reflect.get(event, 'clientY'), pointerType: Reflect.get(event, 'pointerType') });
    });
  }
  const send = (type: string, pointerId: number, clientX: number, clientY: number, pointerType = 'touch'): Event => {
    const event = Object.assign(new Event(type, { cancelable: true }), { pointerId, pointerType, clientX, clientY });
    canvas.dispatchEvent(event);
    return event;
  };
  return { canvas, target, behind, delivered, send, detach, orbit: () => orbit };
}

describe('2 本指の 1 回の動きの視点', () => {
  it('2 本指を平行移動に当てると、中点の移動だけ注視点が動き、距離は変わらない', () => {
    const app = fixture(withTouch([], [touch('twoFinger')], []));
    app.send('pointerdown', 1, 0, 0); app.send('pointerdown', 2, 100, 0);
    // 2 本目を 100 → 110: 中点は 5 動く(つまむは割り当てていないので距離は変えない)。
    app.send('pointermove', 2, 110, 0);
    expect(app.orbit()).toEqual(pan(HOME_ORBIT, 5, 0, 600));
    app.detach();
  });

  it('つまむを拡大縮小に当てると、2 倍に広げた時に距離が半分になり、注視点は動かない', () => {
    const app = fixture(withTouch([], [], [touch('pinch')]));
    app.send('pointerdown', 1, 0, 0); app.send('pointerdown', 2, 100, 0); app.send('pointermove', 2, 200, 0);
    expect(app.orbit().distance).toBeCloseTo(HOME_ORBIT.distance / 2, 9);
    expect(app.orbit().target).toEqual(HOME_ORBIT.target);
    app.detach();
  });

  it('2 本指を回転に当てると回し、回してはいけない区画では回さない', () => {
    const settings = withTouch([touch('twoFinger')], [], []);
    const turning = fixture(settings);
    turning.send('pointerdown', 1, 0, 0); turning.send('pointerdown', 2, 100, 0); turning.send('pointermove', 2, 110, 0);
    expect(turning.orbit()).toEqual(orbitBy(HOME_ORBIT, 5, 0));
    turning.detach();
    const fixed = fixture(settings, false);
    fixed.send('pointerdown', 1, 0, 0); fixed.send('pointerdown', 2, 100, 0); fixed.send('pointermove', 2, 110, 0);
    expect(fixed.orbit()).toBe(HOME_ORBIT);
    fixed.detach();
  });
});

describe('canvas の受け手', () => {
  it('既定(割当なし)では指の出来事を全部後ろへ渡し、視点を動かさない(今どおり)', () => {
    const app = fixture(DEFAULT_VIEW_CONTROLS);
    app.send('pointerdown', 1, 0, 0); app.send('pointerdown', 2, 100, 0);
    app.send('pointermove', 2, 200, 0); app.send('pointerup', 2, 200, 0); app.send('pointerup', 1, 0, 0);
    expect(app.behind).toEqual(['pointerdown:1', 'pointerdown:2', 'pointermove:2', 'pointerup:2', 'pointerup:1']);
    expect(app.target.setOrbit).not.toHaveBeenCalled();
    app.detach();
  });

  it('割り当てた時: 2 本目の指で 1 本目の押下を取り消し、2 本指の間の出来事は後ろへ渡さずに視点を動かす', () => {
    const app = fixture(PAN_AND_PINCH);
    app.send('pointerdown', 1, 0, 0);
    app.send('pointermove', 1, 2, 0);
    const second = app.send('pointerdown', 2, 100, 0);
    expect(second.defaultPrevented).toBe(true);
    // 1 本目は今どおり届き、2 本目の時に 1 本目の取り消しが届く。2 本目そのものは届かない。
    expect(app.behind).toEqual(['pointerdown:1', 'pointermove:1', 'pointercancel:1']);
    app.send('pointermove', 2, 198, 0);
    expect(app.target.setOrbit).toHaveBeenCalledTimes(1);
    expect(app.orbit().distance).toBeCloseTo(HOME_ORBIT.distance / 2, 9);
    app.send('pointerup', 2, 198, 0); app.send('pointermove', 1, 50, 0); app.send('pointerup', 1, 50, 0);
    expect(app.behind).toEqual(['pointerdown:1', 'pointermove:1', 'pointercancel:1']);
    expect(app.target.setOrbit).toHaveBeenCalledTimes(1);
    // 全部の指が離れたら、次の 1 本目は今どおり届く。
    app.send('pointerdown', 3, 0, 0);
    expect(app.behind.at(-1)).toBe('pointerdown:3');
    app.detach();
  });

  it('マウスとペンの出来事には触れない', () => {
    const app = fixture(PAN_AND_PINCH);
    app.send('pointerdown', 1, 0, 0, 'mouse'); app.send('pointerdown', 2, 100, 0, 'pen'); app.send('pointermove', 2, 150, 0, 'pen');
    expect(app.behind).toEqual(['pointerdown:1', 'pointerdown:2', 'pointermove:2']);
    expect(app.target.setOrbit).not.toHaveBeenCalled();
    app.detach();
  });

  it('外した後は何も受けない', () => {
    const app = fixture(PAN_AND_PINCH);
    app.detach();
    app.send('pointerdown', 1, 0, 0); const second = app.send('pointerdown', 2, 100, 0);
    expect(second.defaultPrevented).toBe(false);
    expect(app.behind).toEqual(['pointerdown:1', 'pointerdown:2']);
  });
});

describe('1 本指のドラッグ(B-08h。統括の決定: 視点が勝つ)', () => {
  const ONE_ORBIT = withTouch([touch('oneFinger')], [], []);
  const ONE_AND_TWO = withTouch([touch('oneFinger')], [touch('twoFinger')], []);

  it('軽く触れて離すと、押下と離しを同じ宛先・同じ座標・touch で、この順に 1 回ずつ送り直す(二重にならない)', () => {
    const app = fixture(ONE_ORBIT);
    const down = app.send('pointerdown', 1, 30, 40);
    expect(down.defaultPrevented).toBe(true);
    expect(app.behind).toEqual([]);
    app.send('pointermove', 1, 33, 43);
    expect(app.behind).toEqual([]);
    const up = app.send('pointerup', 1, 33, 43);
    expect(up.defaultPrevented).toBe(true);
    expect(app.behind).toEqual(['pointerdown:1', 'pointerup:1']);
    expect(app.delivered).toEqual([{ type: 'pointerdown', x: 30, y: 40, pointerType: 'touch' },
      { type: 'pointerup', x: 33, y: 43, pointerType: 'touch' }]);
    expect(app.target.focus).toHaveBeenCalledTimes(1);
    expect(app.target.setOrbit).not.toHaveBeenCalled();
    app.detach();
  });

  it('送り直しの押下を後ろの受け手が止めた時は焦点を移さない(作図の欄に焦点を残す今の動きと同じ)', () => {
    const app = fixture(ONE_ORBIT);
    app.canvas.addEventListener('pointerdown', event => { event.preventDefault(); });
    app.send('pointerdown', 1, 30, 40); app.send('pointerup', 1, 30, 40);
    expect(app.behind).toEqual(['pointerdown:1', 'pointerup:1']);
    expect(app.target.focus).not.toHaveBeenCalled();
    app.detach();
  });

  it('閾値(6 画素)を超えて動くと、離すまで視点のドラッグになり(閾値までの動きも含める)、後ろへは何も渡さない', () => {
    const app = fixture(ONE_ORBIT);
    app.send('pointerdown', 1, 0, 0);
    app.send('pointermove', 1, 6, 0);
    expect(app.target.setOrbit).not.toHaveBeenCalled();
    app.send('pointermove', 1, 10, 0);
    expect(app.target.setOrbit).toHaveBeenCalledTimes(1);
    const first = orbitBy(HOME_ORBIT, 10, 0);
    expect(app.orbit()).toEqual(first);
    app.send('pointermove', 1, 15, 0);
    expect(app.orbit()).toEqual(orbitBy(first, 5, 0));
    app.send('pointerup', 1, 15, 0);
    expect(app.behind).toEqual([]);
    expect(app.target.focus).not.toHaveBeenCalled();
    app.detach();
  });

  it('回してはいけない区画では、1 本指の回転は動かさない', () => {
    const app = fixture(ONE_ORBIT, false);
    app.send('pointerdown', 1, 0, 0); app.send('pointermove', 1, 20, 0); app.send('pointerup', 1, 20, 0);
    expect(app.orbit()).toBe(HOME_ORBIT);
    expect(app.behind).toEqual([]);
    app.detach();
  });

  it('持っている指が取り消された時は送り直さない', () => {
    const app = fixture(ONE_ORBIT);
    app.send('pointerdown', 1, 0, 0); app.send('pointercancel', 1, 0, 0);
    expect(app.behind).toEqual([]);
    app.send('pointerdown', 2, 5, 5); app.send('pointerup', 2, 5, 5);
    expect(app.behind).toEqual(['pointerdown:2', 'pointerup:2']);
    app.detach();
  });

  it('持っている間に 2 本目の指が来たら 2 本指の操作になり、渡していない指は取り消さない', () => {
    const app = fixture(ONE_AND_TWO);
    app.send('pointerdown', 1, 0, 0); app.send('pointerdown', 2, 100, 0);
    app.send('pointermove', 2, 110, 0);
    expect(app.orbit()).toEqual(pan(HOME_ORBIT, 5, 0, 600));
    app.send('pointerup', 2, 110, 0); app.send('pointerup', 1, 0, 0);
    expect(app.behind).toEqual([]);
    app.detach();
  });

  it('1 本指の割当が無ければ持たない(今どおり)', () => {
    const app = fixture(PAN_AND_PINCH);
    expect(app.send('pointerdown', 1, 0, 0).defaultPrevented).toBe(false);
    app.send('pointermove', 1, 20, 0); app.send('pointerup', 1, 20, 0);
    expect(app.behind).toEqual(['pointerdown:1', 'pointermove:1', 'pointerup:1']);
    app.detach();
  });
});
