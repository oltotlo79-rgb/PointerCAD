/**
 * 定尺への割り付け(J-01 包み 7)の設定の読み込みと文字の検査: 初めは 定尺 なし・切断代 0 で、壊れた欄は欄ごとに初めの値へ戻り、
 * 定尺が無い時は割り付けず、ある時は組(同じ断面)ごとに棒の本数・歩留まり・棒ごとの切り出しの文字になる事。
 */
import { describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';
import { DEFAULT_DISPLAY_SETTINGS, loadSettings } from '../settings/settings.js';
import { DEFAULT_STOCK_CUTTING, readStockCuttingSettings } from './stockCuttingSettings.js';
import { stockCuttingView, type StockCuttingRow } from './stockCuttingView.js';

const ROWS: readonly StockCuttingRow[] = [
  { group: 'a', label: '溝幅 6 20×20', lengthMm: 2500, quantity: 2 }, { group: 'a', label: '溝幅 6 20×20', lengthMm: 1500, quantity: 3 },
  { group: 'a', label: '溝幅 6 20×20', lengthMm: 900, quantity: 1 }, { group: 'b', label: 'SS400 FB 50×6', lengthMm: 1000, quantity: 1 },
];

function storage(value: unknown): { getItem: () => string; setItem: () => void } {
  return { getItem: () => JSON.stringify(value), setItem: () => undefined };
}

describe('定尺への割り付けの設定と文字', () => {
  it('初めは 定尺 なし・切断代 0 で、壊れた欄・範囲の外の欄は欄ごとに初めの値へ戻る', () => {
    expect(DEFAULT_DISPLAY_SETTINGS.stockCutting).toEqual({ stockLengthMm: null, kerfMm: 0 });
    expect(readStockCuttingSettings(undefined)).toBe(DEFAULT_STOCK_CUTTING);
    expect(readStockCuttingSettings({ stockLengthMm: 6000, kerfMm: 3 })).toEqual({ stockLengthMm: 6000, kerfMm: 3 });
    expect(readStockCuttingSettings({ stockLengthMm: -1, kerfMm: 'x' })).toEqual({ stockLengthMm: null, kerfMm: 0 });
    expect(readStockCuttingSettings({ stockLengthMm: 4000, kerfMm: -2 })).toEqual({ stockLengthMm: 4000, kerfMm: 0 });
  });

  it('端末に保存した値を読み、無い時(前の版の保存)はほかの設定を変えずに初めの値になる', () => {
    const saved = { theme: 'light', uiScale: 110, stockCutting: { stockLengthMm: 5500, kerfMm: 2 } };
    expect(loadSettings(storage(saved)).stockCutting).toEqual({ stockLengthMm: 5500, kerfMm: 2 });
    const before = loadSettings(storage({ theme: 'light', uiScale: 110 }));
    expect([before.theme, before.uiScale, before.stockCutting]).toEqual(['light', 110, { stockLengthMm: null, kerfMm: 0 }]);
  });

  it('定尺が無い時は割り付けない(案内を出す)', () => {
    expect(stockCuttingView(ROWS, DEFAULT_STOCK_CUTTING)).toEqual({ kind: 'noStock' });
  });

  it('定尺 6000・切断代 3: 組 a は 2 本・歩留まり 86.7%、組 b は 1 本・16.7%、棒ごとの切り出しと残り', () => {
    const view = stockCuttingView(ROWS, { stockLengthMm: 6000, kerfMm: 3 });
    if (view.kind !== 'groups') throw new Error('not grouped');
    const summary = (label: string, count: number, percent: string): string => t('catalog.stockCutting.summary')
      .replace('{label}', label).replace('{count}', String(count)).replace('{yield}', percent);
    const bar = (n: number, cuts: string, offcut: number): string => t('catalog.stockCutting.bar')
      .replace('{n}', String(n)).replace('{cuts}', cuts).replace('{offcut}', String(offcut));
    expect(view.groups).toEqual([
      { summary: summary('溝幅 6 20×20', 2, '86.7'), bars: [bar(1, '2500 + 2500 + 900', 94), bar(2, '1500 + 1500 + 1500', 1494)] },
      { summary: summary('SS400 FB 50×6', 1, '16.7'), bars: [bar(1, '1000', 5000)] }]);
  });

  it('定尺より長い部材のある組は割り付けず、長さつきの理由を出す', () => {
    const view = stockCuttingView([{ group: 'a', label: '長い', lengthMm: 7000, quantity: 1 }], { stockLengthMm: 6000, kerfMm: 0 });
    expect(view).toEqual({ kind: 'groups', groups: [{ summary: t('catalog.stockCutting.tooLong').replace('{label}', '長い')
      .replace('{length}', '7000'), bars: [] }] });
  });
});
