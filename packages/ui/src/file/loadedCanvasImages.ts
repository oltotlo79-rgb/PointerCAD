import type { PcadAttachments } from '@pointercad/io';
import type { PartDocument } from '@pointercad/model';

/** 部品を開く境界でだけ画像IDを正規化する。埋込み部品はそれぞれ別の添付所有者。 */
export function loadedCanvasImages(
  document: PartDocument,
  attachments: PcadAttachments,
  retained: ReadonlyMap<string, Uint8Array>,
  createImageId: () => string,
): { readonly document: PartDocument; readonly attachments: PcadAttachments } {
  if (retained.size === 0) return { document, attachments };
  const images = new Map(retained);
  // 読込側の未処理IDにも重ならないよう、割当ての前に全て予約する。
  const reserved = new Set([...retained.keys(), ...attachments.canvases.keys(),
    ...document.canvases.map(canvas => canvas.imageId)]);
  const replaced = new Map<string, string>();
  for (const [id, bytes] of attachments.canvases) {
    let imageId = id;
    if (retained.has(id)) {
      do { imageId = createImageId(); } while (reserved.has(imageId));
      reserved.add(imageId); replaced.set(id, imageId);
    }
    images.set(imageId, bytes);
  }
  return {
    document: replaced.size === 0 ? document : { ...document, canvases: document.canvases.map(canvas => {
      const imageId = replaced.get(canvas.imageId);
      return imageId === undefined ? canvas : { ...canvas, imageId };
    }) },
    attachments: { ...attachments, canvases: images },
  };
}
