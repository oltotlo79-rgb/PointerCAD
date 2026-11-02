import type { TetraMeshInput } from './tetraMesh.js';

/** Fixed physical geometry: 8 × 4 × 1 mm, central 2 × 2 mm through-hole.
 * Explicit graded surface cells resolve hole corners without changing the hole.
 * Each stage input is declared before solving; neither uses a computed stress.
 */
export function locallyGradedPlateBoundary(stage: 1 | 2 | 3): TetraMeshInput {
  const x = stage === 1
    ? [0, 1, 2, 2.5, 2.8, 3, 3.25, 3.5, 4, 4.5, 4.75, 5, 5.2, 5.5, 6, 6.25, 6.5, 7, 8]
    : [0, .8, 1.6, 2.2, 2.6, 2.85, 3, 3.15, 3.4, 3.7, 4, 4.3, 4.6, 4.85, 5, 5.15, 5.4, 5.8, 6.2, 6.45, 6.7, 7.2, 8];
  const y = stage === 1
    ? [-2, -1.6, -1.25, -1, -.5, 0, .5, 1, 1.25, 1.6, 2]
    : [-2, -1.7, -1.4, -1.15, -1, -.7, 0, .7, 1, 1.15, 1.4, 1.7, 2];
  const z = stage === 1 ? [0, .5, 1] : [0, .25, .75, 1];
  const axes = [x, y, z], dimensions = axes.map(axis => axis.length - 1);
  const active = (cell: readonly number[]): boolean => cell.every((value, axis) => value >= 0 && value < dimensions[axis])
    && !(x[cell[0]] >= 3 && x[cell[0] + 1] <= 5 && y[cell[1]] >= -1 && y[cell[1] + 1] <= 1);
  const coordinates: number[] = [], triangles: number[] = [], tags: number[] = [];
  const localSizeConstraints = [3, 5].flatMap(holeX => [-1, 1].flatMap(holeY => [0, .5, 1].map(holeZ => ({
    positionMm: [holeX, holeY, holeZ] as const, targetSizeMm: stage === 1 ? .24 : stage === 2 ? .12 : .08,
  }))));
  // The previously observed stress jump is near this fixed probe neighbourhood.
  // The actual probe remains [6.37, 1.42, .43]; no result is sampled here.
  localSizeConstraints.push({ positionMm: [6.3, 1.4, .5], targetSizeMm: stage === 1 ? .22 : stage === 2 ? .11 : .11 * 2 / 3 });
  const vertices = new Map<string, number>(), faces = new Map<string, number>();
  const vertex = (position: readonly number[]): number => {
    const key = position.join(','), found = vertices.get(key);
    if (found !== undefined) return found;
    const index = coordinates.length / 3;
    coordinates.push(...position.map((value, axis) => axes[axis][value]));
    vertices.set(key, index); return index;
  };
  for (let i = 0; i < dimensions[0]; i++) for (let j = 0; j < dimensions[1]; j++) for (let k = 0; k < dimensions[2]; k++) {
    const cell = [i, j, k];
    if (!active(cell)) continue;
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      const neighbour = [...cell]; neighbour[axis] += sign;
      if (active(neighbour)) continue;
      const a = [...cell]; if (sign > 0) a[axis]++;
      const u = (axis + 1) % 3, v = (axis + 2) % 3;
      const b = [...a], c = [...a], d = [...a]; b[u]++; c[u]++; c[v]++; d[v]++;
      const corners = (sign > 0 ? [a, b, c, d] : [a, d, c, b]).map(vertex);
      const key = `${axis},${sign},${a[axis]}`, tag = faces.get(key) ?? faces.size;
      faces.set(key, tag); tags.push(tag, tag);
      triangles.push(corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]);
    }
  }
  return { schema: 'pointercad-plc/2', units: 'mm',
    source: { documentId: 'convergence-local-perforated-plate', revision: stage,
      featureId: 'perforated-plate', bodyKey: 'perforated-plate:local' },
    coordinates, triangles, tags, tagCount: faces.size,
    shells: [{ role: 'outer', triangles: tags.map((_, index) => index) }],
    meshing: { targetSizeMm: stage === 1 ? .5 : stage === 2 ? .3 : .2, grading: .4, maximumOptimizationPasses: 2, localSizeConstraints,
      quality: { minimumMeanRatio: .01, maximumEdgeRatio: 100 } } };
}
