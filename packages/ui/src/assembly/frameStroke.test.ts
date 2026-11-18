import { describe, expect, it } from 'vitest';

import { INITIAL_FRAME_LAYOUT, type FrameLayoutState } from './frameLayoutInput.js';
import {
  appendFrameStrokePoint, framePointsOrNull, frameStrokeFromLayout, frameStrokeLevelPlane, nextFrameStrokePoint,
  removeLastFrameStrokePoint, withStrokePoints, type FrameStroke,
} from './frameStroke.js';

/* 一筆書きの配置(E-08)の点の列。頂点に吸い付き、無ければ前の点の高さの面、Shift で軸に縛る。閉じる・消す・欄の文字。 */
const stroke = (...points: readonly (readonly [number, number, number])[]): FrameStroke => ({ points, closed: false });
const EMPTY_FRAME_STROKE: FrameStroke = { points: [], closed: false };
/** 点の列を窓の点の欄へ入れた時の文字(空の欄から)。 */
const frameStrokeText = (value: FrameStroke): string =>
  withStrokePoints({ ...INITIAL_FRAME_LAYOUT, source: 'stroke' }, value).pointsText;
const level = (point: readonly [number, number, number]) => ({ kind: 'level', point } as const);

describe('次の点', () => {
  it('当たらない時に点を置く面は、前の点(最初は原点)を通り上の軸に垂直', () => {
    expect(frameStrokeLevelPlane(EMPTY_FRAME_STROKE, 'z')).toMatchObject({ origin: [0, 0, 0], normal: [0, 0, 1] });
    expect(frameStrokeLevelPlane(stroke([7, 8, 40]), 'z')).toMatchObject({ origin: [0, 0, 40], normal: [0, 0, 1] });
    expect(frameStrokeLevelPlane(stroke([7, 25, 9]), 'y')).toMatchObject({ origin: [0, 25, 0], normal: [0, -1, 0] });
    expect(frameStrokeLevelPlane(stroke([5, 6, 7]), 'x')).toMatchObject({ origin: [5, 0, 0], normal: [1, 0, 0] });
  });

  it('頂点に当たればその点(上の軸の高さに関わらない)。面の上の点は高さの端数を面に揃える', () => {
    expect(nextFrameStrokePoint(stroke([0, 0, 0]), { kind: 'vertex', point: [10, 20, 30] }, 'z', false)).toEqual([10, 20, 30]);
    expect(nextFrameStrokePoint(stroke([0, 0, 40]), level([12, 34, 40.0000001]), 'z', false)).toEqual([12, 34, 40]);
    expect(nextFrameStrokePoint(stroke([0, 25, 0]), level([5, 24.9999999, 7]), 'y', false)).toEqual([5, 25, 7]);
  });

  it('Shift の縛りは、前の点から一番大きく動いた軸の向きだけを残す', () => {
    expect(nextFrameStrokePoint(stroke([0, 0, 0]), level([300, 20, 0]), 'z', true)).toEqual([300, 0, 0]);
    expect(nextFrameStrokePoint(stroke([0, 0, 0]), level([-5, -80, 0]), 'z', true)).toEqual([0, -80, 0]);
    expect(nextFrameStrokePoint(stroke([0, 0, 0]), { kind: 'vertex', point: [3, 4, 90] }, 'z', true)).toEqual([0, 0, 90]);
    // 最初の点には縛る相手が無い。
    expect(nextFrameStrokePoint(EMPTY_FRAME_STROKE, level([300, 20, 0]), 'z', true)).toEqual([300, 20, 0]);
  });

  it('欄に書ける桁(小数 3 桁)に丸め、-0 は 0 にする', () => {
    expect(nextFrameStrokePoint(EMPTY_FRAME_STROKE, level([1.23456, -0.0001, 0]), 'z', false)).toEqual([1.235, 0, 0]);
    expect(Object.is(nextFrameStrokePoint(EMPTY_FRAME_STROKE, level([1, -0.0001, 0]), 'z', false)[1], 0)).toBe(true);
  });
});

describe('点の列', () => {
  it('足す・同じ点は足さない・3 点以上で最初の点を押し直すと閉じる・閉じた後は足さない', () => {
    let current = EMPTY_FRAME_STROKE;
    for (const point of [[0, 0, 0], [500, 0, 0], [500, 300, 0]] as const) current = appendFrameStrokePoint(current, point).stroke;
    expect(appendFrameStrokePoint(current, [500, 300, 0]).change).toBe('unchanged');
    const closed = appendFrameStrokePoint(current, [0, 0, 0]);
    expect(closed).toEqual({ stroke: { points: current.points, closed: true }, change: 'closed' });
    expect(appendFrameStrokePoint(closed.stroke, [9, 9, 0]).change).toBe('unchanged');
    // 2 点の時に最初の点を押しても閉じない(戻る線が 1 本と重なるため)。
    const two = stroke([0, 0, 0], [500, 0, 0]);
    expect(appendFrameStrokePoint(two, [0, 0, 0]))
      .toEqual({ stroke: { points: [[0, 0, 0], [500, 0, 0], [0, 0, 0]], closed: false }, change: 'added' });
  });

  it('最後を消す: 閉じていれば閉じるのをやめ、そうでなければ最後の点を消す', () => {
    const closed: FrameStroke = { points: [[0, 0, 0], [1, 0, 0], [1, 1, 0]], closed: true };
    expect(removeLastFrameStrokePoint(closed)).toEqual({ points: closed.points, closed: false });
    expect(removeLastFrameStrokePoint(removeLastFrameStrokePoint(closed))).toEqual({ points: [[0, 0, 0], [1, 0, 0]], closed: false });
    expect(removeLastFrameStrokePoint(EMPTY_FRAME_STROKE)).toEqual(EMPTY_FRAME_STROKE);
  });

  it('欄の文字は 1 行に X Y Z(「点を入れる」欄と同じ読み方)', () => {
    expect(frameStrokeText(stroke([0, 0, 0], [500, 0, 12.5]))).toBe('0 0 0\n500 0 12.5');
    expect(frameStrokeText(EMPTY_FRAME_STROKE)).toBe('');
    expect(framePointsOrNull(frameStrokeText(stroke([0, 0, 0], [500, 0, 12.5])))).toEqual([[0, 0, 0], [500, 0, 12.5]]);
    expect(framePointsOrNull('0 0 0\n5')).toBeNull();
  });
});

describe('窓の欄との行き来', () => {
  const layout = (pointsText: string, closed = false): FrameLayoutState => ({ ...INITIAL_FRAME_LAYOUT, source: 'stroke', pointsText, closed });

  it('打ち始めは欄の点を引き継ぎ、閉じるは 3 点以上の時だけ。読めない欄なら空から', () => {
    expect(frameStrokeFromLayout(layout('0 0 0\n500 0 0', true))).toEqual({ points: [[0, 0, 0], [500, 0, 0]], closed: false });
    expect(frameStrokeFromLayout(layout('0 0 0\n500 0 0\n500 300 0', true)).closed).toBe(true);
    expect(frameStrokeFromLayout(layout('0 0 0\nx'))).toEqual(EMPTY_FRAME_STROKE);
  });

  it('同じ点の列を表す文字(カンマ区切り・行末の改行)はそのまま残し、同じ値を返す', () => {
    const typed = { ...layout('0,0,0\n500,0,0\n'), swapThrough: [1] };
    expect(withStrokePoints(typed, stroke([0, 0, 0], [500, 0, 0]))).toBe(typed);
  });

  it('3D の画面で点が増えた・閉じた時は文字を書き直し、角の入れ替えを初めに戻す', () => {
    const typed = { ...layout('0 0 0\n500 0 0'), swapThrough: [0] };
    expect(withStrokePoints(typed, stroke([0, 0, 0], [500, 0, 0], [500, 300, 0])))
      .toEqual({ ...typed, pointsText: '0 0 0\n500 0 0\n500 300 0', swapThrough: [] });
    const closed: FrameStroke = { points: [[0, 0, 0], [500, 0, 0], [500, 300, 0]], closed: true };
    const three = layout('0 0 0\n500 0 0\n500 300 0');
    expect(withStrokePoints(three, closed)).toEqual({ ...three, closed: true, swapThrough: [] });
    // 読めない途中の文字は、店の点の列で書き直す。
    expect(withStrokePoints(layout('0 0 0\n5'), stroke([0, 0, 0])).pointsText).toBe('0 0 0');
  });
});
