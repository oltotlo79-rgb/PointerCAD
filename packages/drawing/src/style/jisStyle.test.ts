import { describe, expect, it } from 'vitest';

import {
  ARROW_INCLUDED_ANGLE_DEGREES,
  ARROW_LENGTH_MM,
  ARROW_WIDTH_MM,
  DEFAULT_ANNOTATION_TEXT_HEIGHT_MM,
  DEFAULT_DIMENSION_TEXT_HEIGHT_MM,
  DEFAULT_DRAWING_NUMBER_HEIGHT_MM,
  DIMENSION_EXTENSION_GAP_MM,
  DIMENSION_EXTENSION_OVER_MM,
  DIMENSION_LINE_SPACING_MM,
  LINE_DASH_PATTERNS,
  LINE_WIDTHS_MM,
  TEXT_HEIGHTS_MM,
  lineStyleFor,
} from './jisStyle.js';

describe('JISスタイル候補値', () => {
  it('細線と太線の比は1:2である', () => {
    expect(LINE_WIDTHS_MM.thick / LINE_WIDTHS_MM.thin).toBe(2);
  });

  it.each([
    ['outline', 0.5, 'solid'],
    ['hidden', 0.25, 'dashed'],
    ['center', 0.25, 'chain'],
    ['cutting', 0.25, 'chain'],
    ['dimension', 0.25, 'solid'],
    ['extension', 0.25, 'solid'],
    ['leader', 0.25, 'solid'],
    ['hatching', 0.25, 'solid'],
    ['phantom', 0.25, 'chain2'],
    ['break', 0.25, 'zigzag'],
  ] as const)('%sの線は幅%d、種類%s', (usage, widthMm, lineType) => {
    expect(lineStyleFor(usage)).toEqual({ widthMm, lineType });
  });

  it('文字高さは7段階でほぼ√2系列である', () => {
    expect(TEXT_HEIGHTS_MM).toEqual([2.5, 3.5, 5, 7, 10, 14, 20]);
    expect(TEXT_HEIGHTS_MM[1] / TEXT_HEIGHTS_MM[0]).toBeCloseTo(1.4);
  });

  it('寸法と注記は3.5mm、図番は7mmである', () => {
    expect([
      DEFAULT_DIMENSION_TEXT_HEIGHT_MM,
      DEFAULT_ANNOTATION_TEXT_HEIGHT_MM,
      DEFAULT_DRAWING_NUMBER_HEIGHT_MM,
    ]).toEqual([3.5, 3.5, 7]);
  });

  it('矢印は長さ3.5mm、開き角15度である', () => {
    expect(ARROW_LENGTH_MM).toBe(3.5);
    expect(ARROW_INCLUDED_ANGLE_DEGREES).toBe(15);
    expect(ARROW_WIDTH_MM).toBeCloseTo(0.9215674831117708, 14);
  });

  it('破線と一点鎖線と二点鎖線の刻みを持つ', () => {
    expect(LINE_DASH_PATTERNS.dashed).toEqual([3, 1]);
    expect(LINE_DASH_PATTERNS.chain).toEqual([10, 1, 1, 1]);
    expect(LINE_DASH_PATTERNS.chain2).toEqual([10, 1, 1, 1, 1, 1]);
  });

  it('寸法補助線のすきま・越え・寸法線間隔を持つ', () => {
    expect([
      DIMENSION_EXTENSION_GAP_MM,
      DIMENSION_EXTENSION_OVER_MM,
      DIMENSION_LINE_SPACING_MM,
    ]).toEqual([1, 2, 8]);
  });
});
