import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations } from './allocations.js';
import { readBrepBytes } from './brepBytes.js';
import { shapeBodyKind, type CadBodyKind } from './shapeBodyKind.js';
import { isValidShape } from './solidMesh.js';

type ImportedBrepInspection =
  | { readonly kind: 'checked'; readonly bodyKind: CadBodyKind; readonly valid: boolean }
  | { readonly kind: 'empty' | 'unreadable' | 'failed' };

/** Read a saved base body without touching the display cache or tessellating it. */
export function inspectImportedBrep(oc: OpenCascadeInstance, bytes: Uint8Array): ImportedBrepInspection {
  if (bytes.byteLength === 0) return { kind: 'empty' };
  let shape: TopoDS_Shape;
  try {
    shape = readBrepBytes(oc, bytes);
  } catch {
    return { kind: 'unreadable' };
  }
  const { keep, release } = createAllocations();
  try {
    keep(shape);
    const faces = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_1(shape, oc.TopAbs.ShapeTypeFromString_1('FACE'), faces);
    if (faces.Size() === 0) return { kind: 'empty' };
    return { kind: 'checked', bodyKind: shapeBodyKind(oc, shape), valid: isValidShape(oc, shape) };
  } catch {
    return { kind: 'failed' };
  } finally {
    release();
  }
}
