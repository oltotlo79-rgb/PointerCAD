import type { PcadAttachments } from '@pointercad/io';
import { importedShapeOf, type PartDocument } from '@pointercad/model';
import { loadedCanvasImages } from './loadedCanvasImages.js';
import { partAssetReferences } from './referencedPartAttachments.js';

type AssetKind = 'shape' | 'mesh' | 'canvas';

function mergeAssets<T>(incoming: ReadonlyMap<string, T>, retained: ReadonlyMap<string, T>,
  references: ReadonlySet<string>, createRef: () => string) {
  const replaced = new Map<string, string>();
  if (retained.size === 0) return { assets: incoming, replaced };
  const reserved = new Set([...incoming.keys(), ...retained.keys(), ...references]), assets = new Map(retained);
  for (const [key, value] of incoming) {
    let ref = key;
    if (retained.has(key)) {
      do { ref = createRef(); } while (reserved.has(ref));
      replaced.set(key, ref); reserved.add(ref);
    }
    assets.set(ref, value);
  }
  return { assets, replaced };
}

/** 読込時は全部、新規取込時は指定したfeatureだけの参照と添付を同時に正規化する。 */
export function loadedPartAttachments(document: PartDocument, attachments: PcadAttachments, retained: PcadAttachments,
  createRef: (kind: AssetKind) => string, newFeatureIds?: ReadonlySet<string>,
): { readonly document: PartDocument; readonly attachments: PcadAttachments } {
  const refs = partAssetReferences([document]);
  const shapes = mergeAssets(attachments.shapes, retained.shapes, refs.shapes, () => createRef('shape'));
  const meshes = mergeAssets(attachments.meshes, retained.meshes, refs.meshes, () => createRef('mesh'));
  const solids = document.solids.map(feature => {
    if (newFeatureIds !== undefined && !newFeatureIds.has(feature.id)) return feature;
    if (feature.kind === 'importedSolid') {
      const shapeRef = shapes.replaced.get(feature.shapeRef);
      return shapeRef === undefined ? feature : { ...feature, shapeRef };
    }
    if (feature.kind === 'importedMesh') {
      const meshRef = meshes.replaced.get(feature.meshRef);
      return meshRef === undefined ? feature : { ...feature, meshRef };
    }
    return feature;
  });
  const next = solids.every((feature, index) => feature === document.solids[index]) ? document : { ...document, solids };
  // digestはrefとは別の原本識別。同じbytesなら既存の識別結果を再利用する。
  const shapeDigests = new Map([...shapes.assets].map(([ref, bytes]) => [ref, importedShapeOf(bytes).shapeDigest]));
  const combined = { ...attachments, shapes: shapes.assets, meshes: meshes.assets, shapeDigests };
  return newFeatureIds === undefined
    ? loadedCanvasImages(next, combined, retained.canvases, () => createRef('canvas'))
    : { document: next, attachments: { ...combined, canvases: retained.canvases } };
}
