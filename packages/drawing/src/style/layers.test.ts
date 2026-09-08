import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DRAWING_LAYERS,
  isElementPrintable,
  isElementVisible,
  isValidLayerColor,
  resolveStyle,
} from './layers.js';

describe('図面レイヤー', () => {
  it('既定は名前の重ならない7枚である', () => {
    expect(DEFAULT_DRAWING_LAYERS).toHaveLength(7);
    expect(new Set(DEFAULT_DRAWING_LAYERS.map((layer) => layer.name)).size).toBe(7);
  });

  it('個別指定がnullならレイヤーを継ぐ', () => {
    expect(resolveStyle({ layerId: 'layer-2', style: null }, DEFAULT_DRAWING_LAYERS)).toMatchObject({
      color: '#000000', lineType: 'dashed', lineWidth: 0.25,
    });
  });

  it('個別指定した太さと色が優先される', () => {
    expect(resolveStyle({
      layerId: 'layer-2', style: { lineWidth: 0.75, color: '#123ABC' },
    }, DEFAULT_DRAWING_LAYERS)).toMatchObject({ lineWidth: 0.75, color: '#123ABC' });
  });

  it('非表示のレイヤーは表示対象外である', () => {
    const layers = DEFAULT_DRAWING_LAYERS.map((layer) =>
      layer.id === 'layer-1' ? { ...layer, visible: false } : layer,
    );
    expect(isElementVisible({ layerId: 'layer-1' }, layers)).toBe(false);
  });

  it('印刷しないレイヤーは印刷対象外である', () => {
    const layers = DEFAULT_DRAWING_LAYERS.map((layer) =>
      layer.id === 'layer-1' ? { ...layer, printable: false } : layer,
    );
    expect(isElementPrintable({ layerId: 'layer-1' }, layers)).toBe(false);
  });

  it('存在しないレイヤーは解決できない', () => {
    expect(resolveStyle({ layerId: 'missing' }, DEFAULT_DRAWING_LAYERS)).toBeNull();
  });

  it.each(['#000000', '#abcdef', '#ABCDEF'])('%sは有効な色', (color) => {
    expect(isValidLayerColor(color)).toBe(true);
  });

  it.each(['000000', '#fff', '#GG0000', '#00000000'])('%sは無効な色', (color) => {
    expect(isValidLayerColor(color)).toBe(false);
  });
});
