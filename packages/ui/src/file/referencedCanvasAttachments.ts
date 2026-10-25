import type { PartDocument } from '@pointercad/model';

/** 保存する文書の参照だけを選ぶ。Undo 用の資産表と元バイト列は変更しない。 */
export function referencedCanvasAttachments(
  document: PartDocument,
  images: ReadonlyMap<string, Uint8Array>,
): ReadonlyMap<string, Uint8Array> {
  const selected = new Map<string, Uint8Array>();
  for (const { imageId } of document.canvases) {
    const bytes = images.get(imageId);
    if (bytes !== undefined) selected.set(imageId, bytes);
  }
  return selected;
}
