import type { DrawingDocument } from '@pointercad/drawing';

/** 既定のレイヤーを削除した図面でも、存在するレイヤーへ要素を作る。 */
export function drawingCreationLayer(document: DrawingDocument, preferredId: string): string | null {
  return document.layers.find((layer) => layer.id === preferredId)?.id ?? document.layers[0]?.id ?? null;
}
