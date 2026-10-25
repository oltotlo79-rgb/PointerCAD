import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createSolidFieldLayer, solidFieldColor, solidFieldCssColor } from './solidFieldLayer.js';
import type { SolidFieldMesh } from './solidFieldView.js';

/** Two triangles: triangle 0 owned by element 0 (-40 MPa), triangle 1 by element 1 (100 MPa). */
const FIELD: SolidFieldMesh = { quantity: 'xx', deformationScale: 0,
  positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0], triangleElements: [0, 1], elementValues: [-40, 100],
  legend: { minimumMPa: -40, maximumMPa: 100, constant: false } };

/** Runtime check of the mesh, geometry and material classes (a bare instanceof Mesh is Mesh<any, any, any>). */
function isFieldMesh(object: THREE.Object3D | undefined): object is THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
  return object instanceof THREE.Mesh && object.geometry instanceof THREE.BufferGeometry
    && object.material instanceof THREE.MeshBasicMaterial;
}

function meshOf(layer: ReturnType<typeof createSolidFieldLayer>): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
  const child = layer.group.children[0];
  if (!isFieldMesh(child)) throw new Error('field mesh expected');
  return child;
}

describe('solid field layer (owned overlay)', () => {
  it('colours every corner of a triangle with its owning element only (flat, no interpolation)', () => {
    const layer = createSolidFieldLayer();
    layer.set(FIELD);
    const colors = meshOf(layer).geometry.getAttribute('color');
    const low = solidFieldColor(0), high = solidFieldColor(1);
    for (let corner = 0; corner < 3; corner += 1) {
      expect([colors.getX(corner), colors.getY(corner), colors.getZ(corner)]).toEqual([low.r, low.g, low.b].map(Math.fround));
      expect([colors.getX(3 + corner), colors.getY(3 + corner), colors.getZ(3 + corner)])
        .toEqual([high.r, high.g, high.b].map(Math.fround));
    }
    expect(layer.triangleCount()).toBe(2);
    layer.dispose();
  });

  it('pulls the overlay in front of coplanar solid faces like the interference overlay, with depth testing kept on', () => {
    const layer = createSolidFieldLayer();
    layer.set(FIELD);
    const material = meshOf(layer).material;
    expect(material.polygonOffset).toBe(true);
    expect(material.polygonOffsetFactor).toBe(-2);
    expect(material.polygonOffsetUnits).toBe(-2);
    expect(material.depthTest).toBe(true);
    layer.dispose();
  });

  it('uses the same ramp for the panel legend colours as for the drawn triangles', () => {
    expect(solidFieldCssColor(0)).toBe(`#${solidFieldColor(0).getHexString()}`);
    expect(solidFieldCssColor(1)).toBe(`#${solidFieldColor(1).getHexString()}`);
    expect(solidFieldCssColor(0)).not.toBe(solidFieldCssColor(1));
    expect(solidFieldCssColor(-5)).toBe(solidFieldCssColor(0));
  });

  it('disposes only its own previous geometry on replace and null, and its material once on dispose', () => {
    const layer = createSolidFieldLayer();
    layer.set(FIELD);
    const first = meshOf(layer), firstGeometry = vi.spyOn(first.geometry, 'dispose'), material = vi.spyOn(first.material, 'dispose');
    layer.set({ ...FIELD, quantity: 'vonMises' });
    expect(firstGeometry).toHaveBeenCalledTimes(1);
    expect(layer.group.children).toHaveLength(1);
    const second = meshOf(layer), secondGeometry = vi.spyOn(second.geometry, 'dispose');
    expect(second.material).toBe(first.material);
    layer.set(null);
    expect(secondGeometry).toHaveBeenCalledTimes(1);
    expect(layer.group.children).toHaveLength(0);
    expect(layer.triangleCount()).toBe(0);
    expect(material).not.toHaveBeenCalled();
    layer.dispose(); layer.dispose();
    expect(material).toHaveBeenCalledTimes(1);
    layer.set(FIELD); // after disposal nothing is created again
    expect(layer.group.children).toHaveLength(0);
  });

  it('draws nothing for a field whose positions do not match its triangles or are not finite', () => {
    const layer = createSolidFieldLayer();
    layer.set({ ...FIELD, positions: FIELD.positions.slice(1) });
    expect(layer.group.children).toHaveLength(0);
    layer.set({ ...FIELD, positions: FIELD.positions.map((value, index) => index === 4 ? Number.NaN : value) });
    expect(layer.group.children).toHaveLength(0);
    layer.dispose();
  });
});
