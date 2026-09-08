import {
  isValidLayerColor,
  type DrawingDocument,
  type DrawingLayer,
} from '@pointercad/drawing';

import { nextDrawingLayerId } from './createDrawingDocument.js';

export const INVALID_DRAWING_LAYER_COLOR_MESSAGE = '色は #RRGGBB の形で入力してください。';
export const DUPLICATE_DRAWING_LAYER_NAME_MESSAGE = '同じ名前のレイヤーがあります。';

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
  const color = input.color ?? '#000000';
  if (!isValidLayerColor(color)) {
    return { ok: false, message: INVALID_DRAWING_LAYER_COLOR_MESSAGE };
  }
  if (document.layers.some((layer) => layer.name === input.name)) {
    return { ok: false, message: DUPLICATE_DRAWING_LAYER_NAME_MESSAGE };
  }
  const layer: DrawingLayer = {
    id: nextDrawingLayerId(document),
    name: input.name,
    visible: input.visible ?? true,
    printable: input.printable ?? true,
    color,
    lineType: input.lineType ?? 'solid',
    lineWidth: input.lineWidth ?? 0.25,
  };
  return { ok: true, document: { ...document, layers: [...document.layers, layer] } };
}

export function replaceDrawingLayer(
  document: DrawingDocument,
  layerId: string,
  replacement: DrawingLayer,
): DrawingLayerEditResult {
  if (!isValidLayerColor(replacement.color)) {
    return { ok: false, message: INVALID_DRAWING_LAYER_COLOR_MESSAGE };
  }
  if (
    document.layers.some((layer) => layer.id !== layerId && layer.name === replacement.name)
  ) {
    return { ok: false, message: DUPLICATE_DRAWING_LAYER_NAME_MESSAGE };
  }
  return {
    ok: true,
    document: {
      ...document,
      layers: document.layers.map((layer) => layer.id === layerId ? replacement : layer),
    },
  };
}

export interface RemoveDrawingLayerResult {
  readonly document: DrawingDocument;
  /** 確認表示へ出すため、削除前に数えた要素数。 */
  readonly removedElementCount: number;
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
    + countLayerElements(document.balloons, layerId);
  if (!document.layers.some((layer) => layer.id === layerId)) {
    return { document, removedElementCount: 0 };
  }
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
    },
  };
}

export function reorderDrawingLayer(
  document: DrawingDocument,
  layerId: string,
  targetIndex: number,
): DrawingDocument {
  const index = document.layers.findIndex((layer) => layer.id === layerId);
  if (index < 0) {
    return document;
  }
  const layers = [...document.layers];
  const [moved] = layers.splice(index, 1);
  if (moved === undefined) {
    return document;
  }
  const boundedIndex = Math.max(0, Math.min(layers.length, Math.trunc(targetIndex)));
  layers.splice(boundedIndex, 0, moved);
  return { ...document, layers };
}
