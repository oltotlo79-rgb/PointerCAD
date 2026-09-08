import { describe, expect, it } from 'vitest';

import { createPaperFrame } from './frame.js';

describe('用紙の枠と中心マーク', () => {
  const frame = createPaperFrame('A3-landscape');

  it('A3横の内枠は390×277mmである', () => {
    expect(frame.inner).toEqual({
      left: 20, bottom: 10, right: 410, top: 287, width: 390, height: 277,
    });
  });

  it('内枠は4本の太い線で閉じる', () => {
    expect(frame.border).toHaveLength(4);
    expect(frame.border.every((line) => line.widthMm === 0.5)).toBe(true);
  });

  it('中心マークは4辺に1本ずつある', () => {
    expect(frame.centerMarks).toHaveLength(4);
  });

  it('上の中心マークは用紙端から内枠の内側5mmまで届く', () => {
    expect(frame.centerMarks[0]).toEqual({
      from: [210, 297], to: [210, 282], widthMm: 0.5,
    });
  });

  it('左右の中心マークは用紙高さの中央にある', () => {
    expect(frame.centerMarks[2]?.from[1]).toBe(148.5);
    expect(frame.centerMarks[3]?.from[1]).toBe(148.5);
  });

  it('A4縦もとじ代を左に取る', () => {
    expect(createPaperFrame('A4-portrait').inner).toMatchObject({
      left: 20, right: 200, bottom: 10, top: 287,
    });
  });
});
