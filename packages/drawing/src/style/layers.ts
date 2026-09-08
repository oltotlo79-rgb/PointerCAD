import type { DrawingElementStyle, DrawingLayer } from '../types.js';
import { lineStyleFor } from './jisStyle.js';

const OUTLINE = lineStyleFor('outline');
const HIDDEN = lineStyleFor('hidden');
const CENTER = lineStyleFor('center');
const DIMENSION = lineStyleFor('dimension');
const HATCHING = lineStyleFor('hatching');

/** 新しい図面に入る7枚のレイヤー(FR-730)。 */
export const DEFAULT_DRAWING_LAYERS: readonly DrawingLayer[] = [
  { id: 'layer-1', name: '外形線', visible: true, printable: true, color: '#000000', lineType: OUTLINE.lineType, lineWidth: OUTLINE.widthMm },
  { id: 'layer-2', name: '隠れ線', visible: true, printable: true, color: '#000000', lineType: HIDDEN.lineType, lineWidth: HIDDEN.widthMm },
  { id: 'layer-3', name: '中心線', visible: true, printable: true, color: '#000000', lineType: CENTER.lineType, lineWidth: CENTER.widthMm },
  { id: 'layer-4', name: '寸法', visible: true, printable: true, color: '#000000', lineType: DIMENSION.lineType, lineWidth: DIMENSION.widthMm },
  { id: 'layer-5', name: '注記', visible: true, printable: true, color: '#000000', lineType: 'solid', lineWidth: DIMENSION.widthMm },
  { id: 'layer-6', name: 'ハッチング', visible: true, printable: true, color: '#000000', lineType: HATCHING.lineType, lineWidth: HATCHING.widthMm },
  { id: 'layer-7', name: '枠と表題欄', visible: true, printable: true, color: '#000000', lineType: 'solid', lineWidth: OUTLINE.widthMm },
];

export interface LayerStyledElement {
  readonly layerId: string;
  readonly style?: DrawingElementStyle | null;
}

export interface ResolvedDrawingStyle {
  readonly color: string;
  readonly lineType: DrawingLayer['lineType'];
  readonly lineWidth: number;
  readonly visible: boolean;
  readonly printable: boolean;
}

export function isValidLayerColor(color: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(color);
}

/** 要素の個別指定を優先し、無い欄はレイヤーから継ぐ(FR-730)。 */
export function resolveStyle(
  element: LayerStyledElement,
  layers: readonly DrawingLayer[],
): ResolvedDrawingStyle | null {
  const layer = layers.find((candidate) => candidate.id === element.layerId);
  if (layer === undefined) {
    return null;
  }
  return {
    color: element.style?.color ?? layer.color,
    lineType: element.style?.lineType ?? layer.lineType,
    lineWidth: element.style?.lineWidth ?? layer.lineWidth,
    visible: layer.visible,
    printable: layer.printable,
  };
}

export function isElementVisible(element: LayerStyledElement, layers: readonly DrawingLayer[]): boolean {
  return resolveStyle(element, layers)?.visible ?? false;
}

export function isElementPrintable(element: LayerStyledElement, layers: readonly DrawingLayer[]): boolean {
  return resolveStyle(element, layers)?.printable ?? false;
}
