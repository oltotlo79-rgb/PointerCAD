import { describe, expect, it } from 'vitest';
import { quadLayout, quadPaneAt, quadPointer } from './quadLayout.js';

describe('4分割の配置と入力座標(FR-113、P8-61)', () => {
  it('1440×900を第三角法で720×450の4面にする', () => {
    expect(quadLayout(1440, 900).map(({ id, rectangle }) => ({ id, ...rectangle }))).toEqual([
      { id: 'top', x: 0, y: 0, width: 720, height: 450 },
      { id: 'isometric', x: 720, y: 0, width: 720, height: 450 },
      { id: 'front', x: 0, y: 450, width: 720, height: 450 },
      { id: 'right', x: 720, y: 450, width: 720, height: 450 },
    ]);
  });
  it('描画時はWebGLの下原点へ変換する', () => {
    expect(quadLayout(1440, 900).map((pane) => pane.scissor.y)).toEqual([450, 450, 0, 0]);
  });
  it('3面は平行投影、等角だけ透視を選べる', () => {
    expect(quadLayout(100, 100).map((pane) => pane.projection)).toEqual(['orthographic', 'perspective', 'orthographic', 'orthographic']);
    expect(quadLayout(100, 100, 'orthographic').every((pane) => pane.projection === 'orthographic')).toBe(true);
  });
  it('奇数幅でも隙間や重複を作らず全ピクセルを覆う', () => {
    const panes = quadLayout(1439, 899);
    expect(panes.reduce((sum, pane) => sum + pane.rectangle.width * pane.rectangle.height, 0)).toBe(1439 * 899);
    expect(panes[0].rectangle.width + panes[1].rectangle.width).toBe(1439);
    expect(panes[0].rectangle.height + panes[2].rectangle.height).toBe(899);
    expect(panes[0].scissor.y).toBe(panes[2].scissor.height);
  });
  it.each([[0, 10], [10, 0], [-1, 10], [NaN, 10], [10, Infinity], [1.5, 10]])('描画できない寸法%s×%sを断る', (width, height) => {
    expect(quadLayout(width, height)).toEqual([]);
  });
  it('各区画中央の入力は対応する1面へ届く', () => {
    const panes = quadLayout(1440, 900);
    expect([[360, 225], [1080, 225], [360, 675], [1080, 675]].map(([x, y]) => quadPaneAt(panes, x, y)?.id)).toEqual(['top', 'isometric', 'front', 'right']);
  });
  it('中央境界の入力は右下だけへ届く', () => {
    expect(quadPaneAt(quadLayout(1440, 900), 720, 450)?.id).toBe('right');
  });
  it('外周の外・負数・無限座標を拾わない', () => {
    const panes = quadLayout(1440, 900);
    expect(quadPaneAt(panes, 1440, 0)).toBeUndefined();
    expect(quadPaneAt(panes, 0, 900)).toBeUndefined();
    expect(quadPaneAt(panes, -0.1, 0)).toBeUndefined();
    expect(quadPaneAt(panes, Infinity, 0)).toBeUndefined();
  });
  it('125%の表示倍率でも局所座標と中央NDCが一致する', () => {
    const client = { width: 1440, height: 900 };
    const buffer = { width: 1800, height: 1125 };
    const layout = quadLayout(buffer.width, buffer.height);
    const pane = layout[3];
    const point = { x: (pane.rectangle.x + pane.rectangle.width / 2) * client.width / buffer.width,
      y: (pane.rectangle.y + pane.rectangle.height / 2) * client.height / buffer.height };
    const result = quadPointer(layout, point, client, buffer);
    expect(result?.pane.id).toBe('right');
    expect(result?.ndcX).toBeCloseTo(0, 12);
    expect(result?.ndcY).toBeCloseTo(0, 12);
  });
  it('非表示で高さ0のキャンバスでは座標を計算しない', () => {
    expect(quadPointer(quadLayout(10, 10), { x: 0, y: 0 }, { width: 10, height: 0 }, { width: 10, height: 10 })).toBeNull();
  });
  it('1pxの縮退でも0幅領域へ入力を送らない', () => {
    expect(quadPaneAt(quadLayout(1, 1), 0, 0)?.id).toBe('right');
  });
});
