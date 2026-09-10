import {
  isValidLayerColor,
  type DrawingDocument,
  type DrawingLayer,
} from '@pointercad/drawing';

import { nextDrawingLayerId } from './createDrawingDocument.js';

export const INVALID_DRAWING_LAYER_COLOR_MESSAGE = '色は #RRGGBB の形で入力してください。';
export const DUPLICATE_DRAWING_LAYER_NAME_MESSAGE = '同じ名前のレイヤーがあります。';
export const INVALID_DRAWING_LAYER_NAME_MESSAGE = 'レイヤーの名前を入力してください。';
export const INVALID_DRAWING_LAYER_WIDTH_MESSAGE = '線の太さは0より大きい有限の数値で入力してください。';
export const MISSING_DRAWING_LAYER_MESSAGE = '編集するレイヤーが見つかりません。';
export const LAST_DRAWING_LAYER_MESSAGE = '最後のレイヤーは削除できません。';

function validateLayer(document: DrawingDocument, layer: DrawingLayer, replacingId?: string): string | null {
  if (layer.name.trim() === '') return INVALID_DRAWING_LAYER_NAME_MESSAGE;
  if (!isValidLayerColor(layer.color)) return INVALID_DRAWING_LAYER_COLOR_MESSAGE;
  if (!Number.isFinite(layer.lineWidth) || layer.lineWidth <= 0) return INVALID_DRAWING_LAYER_WIDTH_MESSAGE;
  if (!['solid', 'dashed', 'chain', 'chain2', 'zigzag'].includes(layer.lineType)) return '線の種類を選んでください。';
  if (document.layers.some((entry) => entry.id !== replacingId && entry.name.trim() === layer.name.trim())) {
    return DUPLICATE_DRAWING_LAYER_NAME_MESSAGE;
  }
  return null;
}

export type DrawingLayerEditResult =
  | { readonly ok: true; readonly document: DrawingDocument }
  | { readonly ok: false; readonly message: string };

export interface NewDrawingLayer {
  readonly name: string;
  readonly visible?: boolean;
  readonly printable?: boolean;
  readonly color?: string;
  readonly lineType?: DrawingLayer['lineType'];
  readonly lineWidth?: number;
}

export function addDrawingLayer(
  document: DrawingDocument,
  input: NewDrawingLayer,
): DrawingLayerEditResult {
  const layer: DrawingLayer = {
    id: nextDrawingLayerId(document),
    name: input.name.trim(),
    visible: input.visible ?? true,
    printable: input.printable ?? true,
    color: input.color ?? '#000000',
    lineType: input.lineType ?? 'solid',
    lineWidth: input.lineWidth ?? 0.25,
  };
  const message = validateLayer(document, layer);
  if (message !== null) return { ok: false, message };
  return { ok: true, document: { ...document, layers: [...document.layers, layer] } };
}

export function replaceDrawingLayer(
  document: DrawingDocument,
  layerId: string,
  replacement: DrawingLayer,
): DrawingLayerEditResult {
  const existing = document.layers.find((layer) => layer.id === layerId);
  if (existing === undefined || replacement.id !== layerId) return { ok: false, message: MISSING_DRAWING_LAYER_MESSAGE };
  const message = validateLayer(document, replacement, layerId);
  if (message !== null) return { ok: false, message };
  const layer = { ...replacement, name: replacement.name.trim() };
  if (JSON.stringify(existing) === JSON.stringify(layer)) return { ok: true, document };
  return {
    ok: true,
    document: {
      ...document,
      layers: document.layers.map((entry) => entry.id === layerId ? layer : entry),
    },
  };
}

export interface RemoveDrawingLayerResult {
  readonly document: DrawingDocument;
  /** 確認表示へ出すため、削除前に数えた要素数。 */
  readonly removedElementCount: number;
  readonly message?: string;
}

function countLayerElements(
  elements: readonly { readonly layerId: string }[],
  layerId: string,
): number {
  return elements.filter((element) => element.layerId === layerId).length;
}

/** レイヤーと、それを参照する図・寸法・注記・表・風船をまとめて消す(FR-730)。 */
export function removeDrawingLayer(
  document: DrawingDocument,
  layerId: string,
): RemoveDrawingLayerResult {
  const removedElementCount =
    countLayerElements(document.views, layerId)
    + countLayerElements(document.dimensions, layerId)
    + countLayerElements(document.annotations, layerId)
    + countLayerElements(document.tables, layerId)
    + countLayerElements(document.balloons, layerId)
    + countLayerElements(document.datums, layerId)
    + countLayerElements(document.gdtFrames, layerId)
    + countLayerElements(document.weldSymbols, layerId);
  if (!document.layers.some((layer) => layer.id === layerId)) {
    return { document, removedElementCount: 0 };
  }
  if (document.layers.length === 1) return { document, removedElementCount: 0, message: LAST_DRAWING_LAYER_MESSAGE };
  return {
    removedElementCount,
    document: {
      ...document,
      layers: document.layers.filter((layer) => layer.id !== layerId),
      views: document.views.filter((view) => view.layerId !== layerId),
      dimensions: document.dimensions.filter((dimension) => dimension.layerId !== layerId),
      annotations: document.annotations.filter((annotation) => annotation.layerId !== layerId),
      tables: document.tables.filter((table) => table.layerId !== layerId),
      balloons: document.balloons.filter((balloon) => balloon.layerId !== layerId),
      datums: document.datums.filter((datum) => datum.layerId !== layerId),
      gdtFrames: document.gdtFrames.filter((frame) => frame.layerId !== layerId),
      weldSymbols: document.weldSymbols.filter((symbol) => symbol.layerId !== layerId),
    },
  };
}

export function reorderDrawingLayer(
  document: DrawingDocument,
  layerId: string,
  targetIndex: number,
): DrawingDocument {
  const index = document.layers.findIndex((layer) => layer.id === layerId);
  if (index < 0 || !Number.isFinite(targetIndex)) {
    return document;
  }
  const layers = [...document.layers];
  const [moved] = layers.splice(index, 1);
  if (moved === undefined) {
    return document;
  }
  const boundedIndex = Math.max(0, Math.min(layers.length, Math.trunc(targetIndex)));
  if (boundedIndex === index) return document;
  layers.splice(boundedIndex, 0, moved);
  return { ...document, layers };
}
