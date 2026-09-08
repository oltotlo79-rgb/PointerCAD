import {
  DEFAULT_DRAWING_LAYERS,
  DEFAULT_PAPER_SIZE_ID,
  type Annotation,
  type Balloon,
  type Dimension,
  type DrawingDocument,
  type DrawingLayer,
  type DrawingSource,
  type DrawingTable,
  type DrawingView,
} from '@pointercad/drawing';

import { PART_SCHEMA_VERSION } from '../part/createPartDocument.js';
import { nextSerialId } from '../sketch/createSketchDocument.js';

/** 図面・部品・アセンブリで共有する保存形式の版(要件§8)。 */
export const DRAWING_SCHEMA_VERSION = PART_SCHEMA_VERSION;

/** 参照元だけを持ち、投影図が0個のA3横図面を作る(FR-701)。 */
export function createDrawingDocument(name: string, source: DrawingSource): DrawingDocument {
  return {
    id: 'drawing-1',
    name,
    schemaVersion: DRAWING_SCHEMA_VERSION,
    source,
    sheet: {
      paperSizeId: DEFAULT_PAPER_SIZE_ID,
      orientation: 'landscape',
      scale: 1,
      projectionMethod: 'third',
      frame: { visible: true },
      titleBlock: {
        title: name,
        drawingNumber: '',
        revision: '',
        author: '',
        date: '',
        material: '',
      },
    },
    views: [],
    dimensions: [],
    annotations: [],
    tables: [],
    balloons: [],
    layers: DEFAULT_DRAWING_LAYERS.map((layer) => ({ ...layer })),
    parameters: [],
  };
}

export function nextDrawingViewId(document: DrawingDocument): string {
  return nextSerialId(document.views.map((view) => view.id), 'view-');
}

export function nextDrawingDimensionId(document: DrawingDocument): string {
  return nextSerialId(document.dimensions.map((dimension) => dimension.id), 'dim-');
}

export function nextDrawingAnnotationId(document: DrawingDocument): string {
  return nextSerialId(document.annotations.map((annotation) => annotation.id), 'note-');
}

export function nextDrawingTableId(document: DrawingDocument): string {
  return nextSerialId(document.tables.map((table) => table.id), 'table-');
}

export function nextDrawingBalloonId(document: DrawingDocument): string {
  return nextSerialId(document.balloons.map((balloon) => balloon.id), 'balloon-');
}

export function nextDrawingLayerId(document: DrawingDocument): string {
  return nextSerialId(document.layers.map((layer) => layer.id), 'layer-');
}

/** 以下は Undo/Redo が差分を持てるよう、元の配列を書き換えない追加操作。 */
export function appendDrawingView(document: DrawingDocument, view: DrawingView): DrawingDocument {
  return { ...document, views: [...document.views, view] };
}

export function appendDrawingDimension(
  document: DrawingDocument,
  dimension: Dimension,
): DrawingDocument {
  return { ...document, dimensions: [...document.dimensions, dimension] };
}

export function appendDrawingAnnotation(
  document: DrawingDocument,
  annotation: Annotation,
): DrawingDocument {
  return { ...document, annotations: [...document.annotations, annotation] };
}

export function appendDrawingTable(document: DrawingDocument, table: DrawingTable): DrawingDocument {
  return { ...document, tables: [...document.tables, table] };
}

export function appendDrawingBalloon(
  document: DrawingDocument,
  balloon: Balloon,
): DrawingDocument {
  return { ...document, balloons: [...document.balloons, balloon] };
}

export function appendDrawingLayer(document: DrawingDocument, layer: DrawingLayer): DrawingDocument {
  return { ...document, layers: [...document.layers, layer] };
}
