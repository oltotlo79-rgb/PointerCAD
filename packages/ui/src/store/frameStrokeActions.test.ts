/**
 * 一筆書きの配置(E-08)の「点を打つ」状態: 初めは無く、打ち始めると押した所から点が増え、上の軸・欄の直し・最後を消す・
 * やめる(点は残り、押下では増えない)・打ち直す・捨てるが効き、状態が無い時は何もしない事。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { createAssemblyInitialState } from './assemblySlice.js';
import { resetTestStore } from './testing/createTestStore.js';
import { useAppStore } from './useAppStore.js';

const level = (point: readonly [number, number, number]) => ({ kind: 'level', point } as const);

beforeEach(resetTestStore);

describe('点を打つ状態', () => {
  it('初めは無く、足す・直す・消す・やめる・捨てるは何もしない', () => {
    expect(createAssemblyInitialState().frameStroke).toBeNull();
    const app = useAppStore.getState();
    expect(app.addFrameStrokeHit(level([1, 2, 0]), false)).toBe('unchanged');
    app.updateFrameStroke({ points: [[1, 2, 3]] });
    app.undoFrameStrokePoint();
    app.pauseFrameStroke();
    app.endFrameStroke();
    expect(useAppStore.getState().frameStroke).toBeNull();
  });

  it('打ち始めた点の列に、押した所から足し、Shift で縛り、最初の点を押し直すと閉じる', () => {
    useAppStore.getState().beginFrameStroke({ points: [[0, 0, 0]], closed: false }, 'z');
    expect(useAppStore.getState().addFrameStrokeHit(level([500, 30, 0]), true)).toBe('added');
    expect(useAppStore.getState().addFrameStrokeHit({ kind: 'vertex', point: [500, 300, 0] }, false)).toBe('added');
    expect(useAppStore.getState().addFrameStrokeHit({ kind: 'vertex', point: [0, 0, 0] }, false)).toBe('closed');
    expect(useAppStore.getState().frameStroke)
      .toEqual({ points: [[0, 0, 0], [500, 0, 0], [500, 300, 0]], closed: true, up: 'z', active: true, owner: 'layout' });
    // 閉じた後は足さず、最後を消すと閉じるのをやめる。
    expect(useAppStore.getState().addFrameStrokeHit(level([9, 9, 0]), false)).toBe('unchanged');
    useAppStore.getState().undoFrameStrokePoint();
    expect(useAppStore.getState().frameStroke?.closed).toBe(false);
  });

  it('持ち主(E-12 第 2 段): 安全柵の欄が打ち始めた点は、一括配置の欄の直しと捨てるでは変わらず、安全柵の欄なら変わる', () => {
    useAppStore.getState().beginFrameStroke({ points: [[1, 2, 0]], closed: false }, 'z', 'fence');
    useAppStore.getState().updateFrameStroke({ points: [] });
    useAppStore.getState().endFrameStroke();
    expect(useAppStore.getState().frameStroke).toMatchObject({ points: [[1, 2, 0]], owner: 'fence' });
    useAppStore.getState().updateFrameStroke({ points: [[3, 4, 0]] }, 'fence');
    expect(useAppStore.getState().frameStroke?.points).toEqual([[3, 4, 0]]);
    // 3D の押下は持ち主に関わらず、打っている点の列へ足す。
    expect(useAppStore.getState().addFrameStrokeHit({ kind: 'level', point: [9, 9, 0] }, false)).toBe('added');
    useAppStore.getState().endFrameStroke('fence');
    expect(useAppStore.getState().frameStroke).toBeNull();
  });

  it('やめると点は残って押下では増えず、打ち始めると続きから足す。捨てると null', () => {
    useAppStore.getState().beginFrameStroke({ points: [], closed: false }, 'z');
    useAppStore.getState().updateFrameStroke({ points: [[0, 40, 0]], up: 'y' });
    useAppStore.getState().pauseFrameStroke();
    expect(useAppStore.getState().addFrameStrokeHit(level([7, 40, 9]), false)).toBe('unchanged');
    expect(useAppStore.getState().frameStroke).toEqual({ points: [[0, 40, 0]], closed: false, up: 'y', active: false, owner: 'layout' });
    useAppStore.getState().updateFrameStroke({ active: true });
    // 上が +Y なので、面の上の点の Y は前の点の Y(40)に揃える。
    expect(useAppStore.getState().addFrameStrokeHit(level([7, 40.0000002, 9]), false)).toBe('added');
    expect(useAppStore.getState().frameStroke?.points).toEqual([[0, 40, 0], [7, 40, 9]]);
    useAppStore.getState().endFrameStroke();
    expect(useAppStore.getState().frameStroke).toBeNull();
  });
});
