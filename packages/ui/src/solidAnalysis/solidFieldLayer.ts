import * as THREE from 'three';
import { solidFieldFraction, type SolidFieldMesh } from './solidFieldView.js';

/** Legend colour ramp (blue low -> red high), shared by the viewport layer and the panel legend. */
export const SOLID_FIELD_LOW_COLOR = 0x2b5cd8;
export const SOLID_FIELD_HIGH_COLOR = 0xd8342b;
export function solidFieldColor(fraction: number): THREE.Color {
  const clamped = Math.min(1, Math.max(0, fraction));
  return new THREE.Color(SOLID_FIELD_LOW_COLOR).lerp(new THREE.Color(SOLID_FIELD_HIGH_COLOR), clamped);
}
/** CSS colour of a legend position, from the same ramp the viewport uses. */
export function solidFieldCssColor(fraction: number): string {
  return `#${solidFieldColor(fraction).getHexString()}`;
}
/**
 * Same depth offset as the interference overlay (createInterferenceLayer.ts): the solid faces are pushed back by +1, so
 * a coplanar overlay (deformation scale 0, or constrained faces) is pulled forward by -2 instead of z-fighting. Depth
 * testing stays on, so the overlay is never drawn through geometry in front of it.
 */
export const SOLID_FIELD_POLYGON_OFFSET = { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 } as const;

/**
 * The analysis-field overlay of the viewport: one owned mesh, one owned material, the geometry replaced per field.
 * Every corner of a triangle takes the colour of the triangle's owning element, so a constant Tet4 stress is drawn
 * flat per element and never interpolated between elements. Display only; nothing here is saved.
 */
export interface SolidFieldLayer {
  readonly group: THREE.Group;
  /** Replaces the shown field; null removes it. Only this layer's geometry is disposed. */
  set(field: SolidFieldMesh | null): void;
  /** Number of drawn triangles (0 when nothing is shown). */
  triangleCount(): number;
  dispose(): void;
}

export function createSolidFieldLayer(): SolidFieldLayer {
  const group = new THREE.Group();
  group.name = 'solid-analysis-field';
  const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, ...SOLID_FIELD_POLYGON_OFFSET });
  let mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null = null;
  let disposed = false;
  const clear = (): void => {
    if (mesh === null) return;
    group.remove(mesh);
    mesh.geometry.dispose();
    mesh = null;
  };
  return {
    group,
    set(field) {
      if (disposed) return;
      clear();
      if (field === null || field.triangleElements.length === 0) return;
      const corners = field.triangleElements.length * 3;
      if (field.positions.length !== corners * 3 || field.positions.some(value => !Number.isFinite(value))) return;
      const colors = new Float32Array(corners * 3);
      field.triangleElements.forEach((element, triangle) => {
        const value = field.elementValues[element];
        const color = solidFieldColor(value === undefined ? 0 : solidFieldFraction(value, field.legend));
        for (let corner = 0; corner < 3; corner += 1) color.toArray(colors, (triangle * 3 + corner) * 3);
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(field.positions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      mesh = new THREE.Mesh(geometry, material);
      mesh.name = `solid-analysis-field:${field.quantity}`;
      group.add(mesh);
    },
    triangleCount: () => mesh === null ? 0 : mesh.geometry.getAttribute('position').count / 3,
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      material.dispose();
    },
  };
}
