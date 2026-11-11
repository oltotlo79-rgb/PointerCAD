import type { ExportMesh } from '../occt/exportMesh.js';
import { TESSELLATION_ADMISSION_MESSAGE } from '../occt/tessellate.js';
import { checkedExportAdd, checkedExportMultiply, type ExportWorkBudget } from './exportWorkLimits.js';

/** Identity reuse is local to this synchronous request, never to a body key or another quality.
 * Each occurrence still owns its arrays and contributes its full logical payload to the budget.
 * Native copies remain owned and released by the existing mesh builder.
 */
export function buildRequestExportMeshes<Shape extends object>(
  shapes: readonly Shape[],
  work: ExportWorkBudget,
  build: (shape: Shape) => ExportMesh,
): ExportMesh[] {
  const originals = new Map<Shape, ExportMesh>();
  const meshes: ExportMesh[] = [];
  for (const shape of shapes) {
    work.checkDeadline();
    const original = originals.get(shape);
    let mesh: ExportMesh;
    if (original === undefined) {
      mesh = build(shape);
      originals.set(shape, mesh);
    } else {
      const bytes = checkedExportAdd(
        checkedExportAdd(original.positions.byteLength, original.normals.byteLength),
        checkedExportAdd(original.indices.byteLength,
          checkedExportMultiply(original.faceRanges?.length ?? 0, 64)),
      );
      // Preserve tessellation admission's refusal before allocating this occurrence.
      if (work.remainingTriangles <= 0 || work.remainingJsBytes <= 0 ||
          original.triangleCount > work.remainingTriangles || bytes > work.remainingJsBytes) {
        throw new Error(TESSELLATION_ADMISSION_MESSAGE);
      }
      mesh = {
        positions: original.positions.slice(),
        normals: original.normals.slice(),
        indices: original.indices.slice(),
        triangleCount: original.triangleCount,
        ...(original.faceRanges === undefined ? {} : {
          faceRanges: original.faceRanges.map((range) => ({ ...range })),
        }),
      };
    }
    work.admitMesh(mesh.triangleCount, mesh.positions.byteLength, mesh.normals.byteLength,
      mesh.indices.byteLength, mesh.faceRanges?.length ?? 0);
    meshes.push(mesh);
  }
  return meshes;
}
