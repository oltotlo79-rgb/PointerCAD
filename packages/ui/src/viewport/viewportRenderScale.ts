/** 通常描画で端末の高精細度を使いすぎない上限(NFR-PF-1)。 */
export const MAX_VIEWPORT_PIXEL_RATIO = 2;

/**
 * 視点を動かしている間の解像度倍率。
 * 1440×900 では描画画素を 9% にし、CPU のソフトウェア描画でも操作を 30fps 以上へ保つ。
 * 操作を離した直後に通常解像度で 1 枚描き直すため、静止した形の品質は変わらない。
 */
export const INTERACTIVE_VIEWPORT_SCALE = 0.3;

/** WebGLRenderer へ渡す実効 pixel ratio を 1 か所で決める。 */
export function viewportPixelRatio(devicePixelRatio: number, interactive: boolean): number {
  const normal = Math.min(Math.max(devicePixelRatio, 1), MAX_VIEWPORT_PIXEL_RATIO);
  return normal * (interactive ? INTERACTIVE_VIEWPORT_SCALE : 1);
}
