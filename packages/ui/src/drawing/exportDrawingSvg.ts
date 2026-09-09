import { exportDrawing } from './exportDrawing.js';

/** SVGの直接保存も、他形式と同じ図面・字体・書出し境界を通す。 */
export function exportDrawingSvg(): Promise<boolean> {
  return exportDrawing({ format: 'svg' });
}
