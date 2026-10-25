import * as THREE from 'three';
import { SOLID_FIELD_POLYGON_OFFSET } from './solidFieldLayer.js';

/** What the one mode-shape overlay draws: a modal preview (SolidModePreview) or a buckling preview
 * (SolidBucklingPreview) both satisfy it; only the drawn triangles and the mode number are read here. */
export type SolidModeDrawing =
  | { readonly kind: 'preview'; readonly modeNumber: number; readonly positions: readonly number[];
      readonly triangleElements: readonly number[] }
  | { readonly kind: 'none' };

/** One neutral colour: a mode shape has no stress, so nothing here suggests a stress or a physical displacement. */
export const SOLID_MODE_COLOR = 0x7a5cc8;

/**
 * The mode-shape overlay of the viewport, parallel to createSolidFieldLayer: one owned mesh and material, the
 * geometry replaced per preview. Anything but a `preview` removes the drawing. Display only; nothing here is saved.
 */
export interface SolidModeLayer {
  readonly group: THREE.Group;
  set(preview: SolidModeDrawing | null): void;
  triangleCount(): number;
  dispose(): void;
}

export function createSolidModeLayer(): SolidModeLayer {
  const group = new THREE.Group();
  group.name = 'solid-analysis-mode';
  const material = new THREE.MeshBasicMaterial({ color: SOLID_MODE_COLOR, side: THREE.DoubleSide, ...SOLID_FIELD_POLYGON_OFFSET });
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
    set(preview) {
      if (disposed) return;
      clear();
      if (preview === null || preview.kind !== 'preview' || preview.triangleElements.length === 0) return;
      if (preview.positions.length !== preview.triangleElements.length * 9 || preview.positions.some(value => !Number.isFinite(value))) return;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(preview.positions, 3));
      mesh = new THREE.Mesh(geometry, material);
      mesh.name = `solid-analysis-mode:${String(preview.modeNumber)}`;
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
