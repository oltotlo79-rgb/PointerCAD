import { describe, expect, it } from 'vitest';

import {
  INTERACTIVE_VIEWPORT_SCALE,
  MAX_VIEWPORT_PIXEL_RATIO,
  viewportPixelRatio,
} from './viewportRenderScale.js';

describe('ビューポートの操作中解像度(P7 タスク48)', () => {
  it('通常時は端末のpixel ratioを使う', () => {
    expect(viewportPixelRatio(1, false)).toBe(1);
    expect(viewportPixelRatio(1.5, false)).toBe(1.5);
  });

  it('高精細端末でも通常時の上限は2', () => {
    expect(MAX_VIEWPORT_PIXEL_RATIO).toBe(2);
    expect(viewportPixelRatio(3, false)).toBe(2);
  });

  it('視点操作中だけ縦横を0.4倍にする', () => {
    expect(INTERACTIVE_VIEWPORT_SCALE).toBe(0.4);
    expect(viewportPixelRatio(1, true)).toBe(0.4);
    expect(viewportPixelRatio(2, true)).toBe(0.8);
  });

  it('壊れた0以下の端末値でも正の描画比を返す', () => {
    expect(viewportPixelRatio(0, false)).toBe(1);
    expect(viewportPixelRatio(-2, true)).toBe(0.4);
  });
});
