import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createSolidModeLayer } from './solidModeLayer.js';
import { projectSolidMode, type SolidModeResult } from './solidModeView.js';

const source = { documentId: 'doc-1', revision: 1, meshKey: 'mesh-a' };
const result: SolidModeResult = {
  source,
  nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]],
  elements: [{ nodes: [0, 1, 2, 3] }],
  fixed: [[true, true, true], [false, false, false], [false, false, false], [false, false, false]],
  modes: [{ number: 1, frequencyHz: 50, normalizedResidual: 1e-12, massNormalizedShapePerSqrtT: [[0, 0, 0], [0, 0, 1], [0, 0, 1], [1, 0, 0]] }],
};

describe('createSolidModeLayer', () => {
  it('draws the projected boundary triangles and clears for no preview', () => {
    const layer = createSolidModeLayer();
    const preview = projectSolidMode(result, source, { modeNumber: 1, amplitudeMm: 2, phase: 1 });
    layer.set(preview);
    expect(layer.triangleCount()).toBe(4);
    if (preview.kind !== 'preview') throw new Error('expected a preview');
    const mesh = layer.group.children[0];
    if (!(mesh instanceof THREE.Mesh) || !(mesh.geometry instanceof THREE.BufferGeometry)) throw new Error('expected one mesh');
    const position: unknown = mesh.geometry.getAttribute('position');
    if (!(position instanceof THREE.BufferAttribute)) throw new Error('expected a typed position attribute');
    const drawn = Array.from(position.array);
    drawn.forEach((value, index) => expect(value).toBeCloseTo(preview.positions[index], 5));
    layer.set(projectSolidMode(result, { ...source, meshKey: 'mesh-b' }, { modeNumber: 1, amplitudeMm: 2, phase: 1 }));
    expect(layer.triangleCount()).toBe(0);
    expect(layer.group.children).toHaveLength(0);
    layer.set(preview);
    layer.set(null);
    expect(layer.triangleCount()).toBe(0);
    layer.dispose();
  });
});
