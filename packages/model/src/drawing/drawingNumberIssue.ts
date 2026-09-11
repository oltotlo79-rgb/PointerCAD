/** R09: 既知欄の型を確認した後、数値の意味だけを検証する。 */
import { drawingViewBasis, type DrawingDocument, type DrawingElementStyle } from '@pointercad/drawing';

export interface DrawingNumberIssue {
  readonly path: string;
  readonly message: string;
}

function issue(path: string, reason: string): DrawingNumberIssue { return { path, message: `図面の${path}を読み込めません。${reason}` }; }
function positive(value: number): boolean { return Number.isFinite(value) && value > 0; }
function nonnegative(value: number): boolean { return Number.isFinite(value) && value >= 0; }
function styleIssue(style: DrawingElementStyle | null | undefined, path: string): DrawingNumberIssue | null {
  return style?.lineWidth !== undefined && !nonnegative(style.lineWidth)
    ? issue(`${path}.lineWidth`, '線の太さには0以上の値が必要です。') : null;
}

/** 未解決の形状参照や式を削除・修復しない。ゼロ座標・符号付き偏差は正常値として残す。 */
export function drawingNumberIssue(document: DrawingDocument): DrawingNumberIssue | null {
  for (const [index, view] of document.views.entries()) {
    const path = `views[${String(index)}]`;
    if (drawingViewBasis({ normal: view.direction, xDir: view.xDir }) === null) {
      return issue(`${path}.direction/xDir`, '図の向きと横方向は、ゼロでなく平行でない組が必要です。');
    }
    if (view.detail !== undefined) {
      if (!positive(view.detail.radius)) return issue(`${path}.detail.radius`, '詳細図の半径には0より大きい値が必要です。');
      if (!positive(view.detail.scale)) return issue(`${path}.detail.scale`, '詳細図の縮尺には0より大きい値が必要です。');
    }
  }
  for (const [index, annotation] of document.annotations.entries()) {
    if (!positive(annotation.height)) return issue(`annotations[${String(index)}].height`, '文字の高さには0より大きい値が必要です。');
  }
  for (const [index, layer] of document.layers.entries()) {
    if (!nonnegative(layer.lineWidth)) return issue(`layers[${String(index)}].lineWidth`, '線の太さには0以上の値が必要です。');
  }
  for (const [name, elements] of [
    ['views', document.views], ['dimensions', document.dimensions], ['annotations', document.annotations],
    ['tables', document.tables], ['balloons', document.balloons], ['datums', document.datums],
    ['gdtFrames', document.gdtFrames], ['weldSymbols', document.weldSymbols],
  ] as const) {
    for (const [index, element] of elements.entries()) {
      const invalid = styleIssue(element.style, `${name}[${String(index)}].style`);
      if (invalid !== null) return invalid;
    }
  }
  return null;
}
