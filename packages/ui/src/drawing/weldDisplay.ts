import { weldGeometry, type DrawingDocument, type InkBounds } from '@pointercad/drawing';
import { weldDisplaySides, type ResolvedWeldSymbol } from '@pointercad/model';
import type { DrawingGdtDisplay } from './gdtDisplay.js';
import type { OutlineDrawingText } from './dimensionDisplay.js';

export function displayDrawingWelds(document: DrawingDocument, resolution: readonly ResolvedWeldSymbol[], outline: OutlineDrawingText): readonly DrawingGdtDisplay[] {
  return resolution.map((resolved) => {
    const symbol = document.weldSymbols.find((item) => item.id === resolved.symbol.id) ?? resolved.symbol;
    const sides = weldDisplaySides(resolved);
    const geometry = sides === null || resolved.feature === null ? null : weldGeometry({ ...symbol, sides,
      target: resolved.feature.paperPoint, measure: (text, height) => outline(text, height).metrics });
    const messages = resolved.issues.map((issue) => issue.message);
    if (geometry === null && messages.length === 0) messages.push('記号・文字・矢を配置できません。文字高と紙上位置を確認してください。');
    const fallback: InkBounds = { left: symbol.position[0], bottom: symbol.position[1], right: symbol.position[0] + 16, top: symbol.position[1] + 7 };
    return { id: symbol.id, bounds: geometry?.bounds ?? fallback, unresolved: geometry === null, messages,
      element: { ownerId: symbol.id, layerId: symbol.layerId, style: geometry === null ? { color: '#b91c1c' } : symbol.style,
        curves: geometry?.curves ?? [{ kind: 'polyline', points: [[fallback.left, fallback.bottom], [fallback.right, fallback.bottom],
          [fallback.right, fallback.top], [fallback.left, fallback.top]], closed: true }], fills: geometry?.fills,
        texts: geometry?.texts ?? [{ text: '?', sizeMm: 3.5, position: [symbol.position[0] + 2, symbol.position[1] + 2] }] } };
  });
}
