/** 単一の描画面を第三角法の順に4分割する(FR-113)。座標は描画バッファのpx。 */
export type QuadViewId = 'top' | 'isometric' | 'front' | 'right';
export interface QuadRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface QuadPane {
  readonly id: QuadViewId;
  /** DOMと同じ左上原点。入力の振り分けに使う。 */
  readonly rectangle: QuadRectangle;
  /** WebGLと同じ左下原点。setViewport/setScissorへそのまま渡せる。 */
  readonly scissor: QuadRectangle;
  readonly projection: 'perspective' | 'orthographic';
}

export function quadLayout(
  width: number, height: number, isometricProjection: QuadPane['projection'] = 'perspective',
): readonly QuadPane[] {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return [];
  const left = Math.floor(width / 2);
  const top = Math.floor(height / 2);
  const pane = (id: QuadViewId, x: number, y: number, paneWidth: number, paneHeight: number): QuadPane => ({
    id, rectangle: { x, y, width: paneWidth, height: paneHeight },
    scissor: { x, y: height - y - paneHeight, width: paneWidth, height: paneHeight },
    projection: id === 'isometric' ? isometricProjection : 'orthographic',
  });
  return [
    pane('top', 0, 0, left, top),
    pane('isometric', left, 0, width - left, top),
    pane('front', 0, top, left, height - top),
    pane('right', left, top, width - left, height - top),
  ];
}

/** 境界を半開区間にし、境界上の入力が2カメラを同時に動かすことを防ぐ。 */
export function quadPaneAt(layout: readonly QuadPane[], x: number, y: number): QuadPane | undefined {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return layout.find(({ rectangle: box }) => x >= box.x && x < box.x + box.width
    && y >= box.y && y < box.y + box.height);
}

/** CSSのポインタ位置を実バッファへ移す。OSの拡大率を仮定しない。 */
export function quadPointer(
  layout: readonly QuadPane[], point: { readonly x: number; readonly y: number },
  client: { readonly width: number; readonly height: number },
  buffer: { readonly width: number; readonly height: number },
): { readonly pane: QuadPane; readonly x: number; readonly y: number; readonly ndcX: number; readonly ndcY: number } | null {
  if (![client.width, client.height, buffer.width, buffer.height].every((value) => Number.isFinite(value) && value > 0)) return null;
  const x = point.x * buffer.width / client.width;
  const y = point.y * buffer.height / client.height;
  const pane = quadPaneAt(layout, x, y);
  if (pane === undefined) return null;
  const localX = x - pane.rectangle.x;
  const localY = y - pane.rectangle.y;
  return { pane, x: localX, y: localY,
    ndcX: 2 * localX / pane.rectangle.width - 1,
    ndcY: 1 - 2 * localY / pane.rectangle.height };
}
