/** Node-only cut oracle. Reads an owned BRep copy; never exported by the browser barrel. */
import { createAllocations } from '../../../kernel/src/occt/allocations.js';
import { readBrepBytes } from '../../../kernel/src/occt/brepBytes.js';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { isValidShape } from '../../../kernel/src/occt/solidMesh.js';

export async function inspectNativeCutShape(bytes: Uint8Array, points: readonly (readonly [number, number, number])[]) {
  const oc = await loadOcctForNode();
  const owned = createAllocations();
  try {
    const shape = owned.keep(readBrepBytes(oc, bytes));
    const map = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, map, true, true);
    type Shape = typeof shape;
    const all: Shape[] = [];
    for (let i = 1; i <= map.Size(); i++) all.push(owned.keep(map.FindKey(i)));
    const solids = all.filter(item => item.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SOLID);
    const shells = all.filter(item => item.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SHELL);
    const faces = all.filter(item => item.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_FACE);
    const edges = all.filter(item => item.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_EDGE);
    const vertices = all.filter(item => item.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_VERTEX);
    // Full incidence in native map order, including isolated/degenerated vertices and seam edges.
    function incidence(parents: readonly Shape[], children: readonly Shape[]) {
      return parents.map(parent => {
        const local = createAllocations();
        try {
          const descendants = local.keep(new oc.TopTools_IndexedMapOfShape_1());
          oc.TopExp.MapShapes_2(parent, descendants, true, true);
          return children.flatMap((child, index) => descendants.Contains(child) ? [index] : []);
        } finally { local.release(); }
      });
    }
    const properties = owned.keep(new oc.GProp_GProps_1());
    const integrationError = oc.BRepGProp.VolumePropertiesGK_1(shape, properties, 1e-12, false, true, false, false, false);
    const states = points.map(point => {
      const local = createAllocations();
      try {
        const classifier = local.keep(new oc.BRepClass3d_SolidClassifier_3(shape,
          local.keep(new oc.gp_Pnt_3(...point)), 1e-7));
        const state = classifier.State();
        return state === oc.TopAbs_State.TopAbs_IN ? 'IN' : state === oc.TopAbs_State.TopAbs_OUT ? 'OUT'
          : state === oc.TopAbs_State.TopAbs_ON ? 'ON' : 'UNKNOWN';
      } finally { local.release(); }
    });
    return { valid: isValidShape(oc, shape), signedVolume: properties.Mass(), integrationError, states,
      topology: { solids: solids.length, shells: shells.length, faces: faces.length, edges: edges.length,
        vertices: vertices.length, solidShells: incidence(solids, shells), shellFaces: incidence(shells, faces),
        faceEdges: incidence(faces, edges), edgeVertices: incidence(edges, vertices) } };
  } finally { owned.release(); }
}
