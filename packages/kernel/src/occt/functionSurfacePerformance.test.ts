import { beforeAll, expect, it } from 'vitest';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeUnclassifiedFunctionSurface } from './makeFunctionSurface.js';
import { classifyFunctionSurface } from './classifyFunctionSurface.js';
import { isValidShape } from './solidMesh.js';
import { tessellate } from './tessellate.js';
import { extractEdges } from './extractEdges.js';
import { collectSubShapes } from './subShapes.js';
import type { Vec3Tuple } from '../types.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);
it('密な放物面をXYZで切り、開面の実面積と描画を保って工程別の所要を記録する', () => {
  const divisions = 64, vertices: Vec3Tuple[] = [], triangles: [number, number, number][] = [];
  for (let y = 0; y <= divisions; y++) for (let x = 0; x <= divisions; x++) {
    const px = -2 + 4*x/divisions, py = -2 + 4*y/divisions;
    vertices.push([px, py, px*px + py*py]);
  }
  for (let y = 0; y < divisions; y++) for (let x = 0; x < divisions; x++) {
    const a = y*(divisions + 1) + x, b = a + 1, d = a + divisions + 1, c = d + 1;
    triangles.push([a, b, c], [a, c, d]);
  }
  const started = performance.now();
  const source = makeUnclassifiedFunctionSurface(oc, { vertices, triangles, bounds: { minimum: [-2,-2,-2], maximum: [2,2,2] } });
  const created = performance.now();
  if (source.status !== 'shape') throw new Error('Expected clipped paraboloid faces');
  try {
    expect(source.projection).toBeDefined();
    const result = classifyFunctionSurface(oc, source.shape, undefined, source.projection), classified = performance.now();
    if (result.status !== 'bodies') throw new Error('Expected classified paraboloid');
    try {
      expect(result.bodies).toHaveLength(1);
      expect(result.bodies[0].bodyKind).toBe('shell');
      expect(result.bodies[0].volume).toBe(0);
      expect(Math.abs(result.bodies[0].area - 13*Math.PI/3)).toBeLessThan(0.1);
      // The production mesh pipeline uses these same three stages, with known area/volume.
      const mesh = tessellate(oc, result.bodies[0].shape), tessellated = performance.now();
      const edges = extractEdges(oc, result.bodies[0].shape), edged = performance.now();
      const tables = collectSubShapes(oc, result.bodies[0].shape, mesh.faceRanges, edges.edgeRanges), meshed = performance.now();
      expect(mesh.triangleCount).toBeGreaterThan(3000);
      expect(mesh.missingTriangulationFaces).toBe(0);
      expect(tables.faces).toHaveLength(source.count);
      expect(tables.edges).toHaveLength(edges.edgeCount);
      expect(isValidShape(oc, result.bodies[0].shape)).toBe(true);
      console.log(JSON.stringify({ faces: source.count, makeMs: created-started,
        classifyMs: classified-created, tessellateMs: tessellated-classified,
        edgesMs: edged-tessellated, subShapesMs: meshed-edged, meshMs: meshed-classified, totalMs: meshed-started }));
      // Independent native self-intersection analysis must accept precisely the same dense shape.
      const native=classifyFunctionSurface(oc,source.shape);
      if(native.status!=='bodies') throw new Error('Native comparison did not complete');
      try {
        expect(native.bodies.map(body=>({kind:body.bodyKind,area:body.area,volume:body.volume})))
          .toEqual(result.bodies.map(body=>({kind:body.bodyKind,area:body.area,volume:body.volume})));
      } finally { native.delete(); }
    } finally { result.delete(); }
  } finally { source.delete(); }
}, 180_000);
