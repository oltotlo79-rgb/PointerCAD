import type { PcadAttachments } from '@pointercad/io';
import type { PartDocument } from '@pointercad/model';

export interface PartAssetReferences {
  readonly shapes: ReadonlySet<string>;
  readonly meshes: ReadonlySet<string>;
  readonly canvases: ReadonlySet<string>;
}

/** 所有文書の集合を呼出側が明示する。抑制・非表示も保存とUndoに必要。 */
export function partAssetReferences(documents: Iterable<PartDocument>): PartAssetReferences {
  const shapes = new Set<string>(), meshes = new Set<string>(), canvases = new Set<string>();
  for (const document of documents) {
    for (const feature of document.solids) {
      if (feature.kind === 'importedSolid') shapes.add(feature.shapeRef);
      else if (feature.kind === 'importedMesh') meshes.add(feature.meshRef);
    }
    for (const canvas of document.canvases) canvases.add(canvas.imageId);
  }
  return { shapes, meshes, canvases };
}

/** 除去が無ければ同じ表。元Mapと原本のbytes/typed arraysには触れない。 */
export function retainAssetEntries<T>(entries: ReadonlyMap<string, T>, refs: ReadonlySet<string>): ReadonlyMap<string, T> {
  let retained: Map<string, T> | undefined;
  for (const key of entries.keys()) {
    if (refs.has(key)) continue;
    retained ??= new Map(entries); retained.delete(key);
  }
  return retained ?? entries;
}

/** UIの保存対象1文書だけを選ぶ。汎用IOの未知添付の読書き契約は変更しない。 */
export function referencedPartAttachments(document: PartDocument, assets: PcadAttachments): PcadAttachments {
  const refs = partAssetReferences([document]);
  return { shapes: retainAssetEntries(assets.shapes, refs.shapes), meshes: retainAssetEntries(assets.meshes, refs.meshes),
    canvases: retainAssetEntries(assets.canvases, refs.canvases),
    ...(assets.shapeDigests === undefined ? {} : { shapeDigests: retainAssetEntries(assets.shapeDigests, refs.shapes) }) };
}
