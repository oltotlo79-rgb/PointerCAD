/**
 * 接合チェック(E-09)の 3D の印: 留めていない・片側だけの接続の点を、半透明の立方体で囲む層。形は作り直さず、印だけを重ねる
 * (干渉の層と同じ形)。選んだ行の印は濃く、ほかの物の後ろでも見える。色は 3D プリントの点検の「せり出し」と同じ橙の系統(注意の色)。
 */
import * as THREE from 'three';

import type { FrameJointMarker } from '../assembly/frameJointCheckView.js';
import { DEFAULT_THEME_COLORS, type ThemeColors } from './themeColors.js';

export interface JointCheckLayer {
  readonly group: THREE.Group;
  update(markers: readonly FrameJointMarker[]): void;
  setThemeColors(colors: ThemeColors): void;
  setSectionPlanes(planes: readonly THREE.Plane[]): void;
  dispose(): void;
}

export function createJointCheckLayer(): JointCheckLayer {
  const group = new THREE.Group();
  group.name = 'assembly-joint-check';
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const normalMaterial = new THREE.MeshBasicMaterial({ color: DEFAULT_THEME_COLORS.printOverhang, transparent: true, opacity: 0.35,
    depthWrite: false });
  const selectedMaterial = normalMaterial.clone();
  selectedMaterial.opacity = 0.8;
  selectedMaterial.depthTest = false;
  let lastMarkers: readonly FrameJointMarker[] = [];

  function clear(): void {
    for (const child of [...group.children]) group.remove(child);
  }

  return {
    group,
    update(markers): void {
      if (markers === lastMarkers) return;
      lastMarkers = markers;
      clear();
      for (const marker of markers) {
        const mesh = new THREE.Mesh(geometry, marker.selected ? selectedMaterial : normalMaterial);
        mesh.position.set(marker.center[0], marker.center[1], marker.center[2]);
        mesh.scale.setScalar(marker.size);
        mesh.renderOrder = marker.selected ? 3 : 2;
        mesh.name = `joint-check:${marker.key}`;
        group.add(mesh);
      }
    },
    setThemeColors(colors): void {
      normalMaterial.color.setHex(colors.printOverhang);
      selectedMaterial.color.setHex(colors.printOverhang);
    },
    setSectionPlanes(planes): void {
      normalMaterial.clippingPlanes = [...planes];
      selectedMaterial.clippingPlanes = [...planes];
    },
    dispose(): void {
      clear();
      geometry.dispose();
      normalMaterial.dispose();
      selectedMaterial.dispose();
    },
  };
}
