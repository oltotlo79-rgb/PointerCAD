/** 干渉の共通形状を、アセンブリの共有材質へ触れず赤く重ねる層(P7 タスク26)。 */
import type { AssemblyInterferenceResult } from '@pointercad/model';
import * as THREE from 'three';
import { interferencePairKey } from '../assembly/interferenceView.js';
import { DEFAULT_THEME_COLORS, type ThemeColors } from './themeColors.js';

export interface InterferenceLayer {
  readonly group: THREE.Group;
  update(result: AssemblyInterferenceResult | null, selectedKey: string | null): void;
  setThemeColors(colors: ThemeColors): void;
  setSectionPlanes(planes: readonly THREE.Plane[]): void;
  dispose(): void;
}

type InterferenceMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

export function createInterferenceLayer(): InterferenceLayer {
  const group = new THREE.Group();
  group.name = 'assembly-interference';
  group.matrixAutoUpdate = false;
  const normalMaterial = new THREE.MeshBasicMaterial({
    color: DEFAULT_THEME_COLORS.interference,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const selectedMaterial = normalMaterial.clone();
  selectedMaterial.opacity = 0.9;
  selectedMaterial.depthTest = false;
  const meshes = new Map<string, InterferenceMesh>();
  let lastResult: AssemblyInterferenceResult | null = null;
  let lastSelectedKey: string | null = null;
  let sectionPlanes: THREE.Plane[] = [];

  function clear(): void {
    for (const mesh of meshes.values()) {
      group.remove(mesh);
      mesh.geometry.dispose();
    }
    meshes.clear();
  }

  function select(key: string | null): void {
    if (lastSelectedKey === key) return;
    lastSelectedKey = key;
    for (const [meshKey, mesh] of meshes) mesh.material = meshKey === key ? selectedMaterial : normalMaterial;
  }

  return {
    group,
    update(result, selectedKey): void {
      if (lastResult !== result) {
        clear();
        lastResult = result;
        lastSelectedKey = null;
        if (result !== null) for (const pair of result.pairs) {
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', new THREE.BufferAttribute(pair.mesh.positions, 3));
          geometry.setAttribute('normal', new THREE.BufferAttribute(pair.mesh.normals, 3));
          geometry.setIndex(new THREE.BufferAttribute(pair.mesh.indices, 1));
          const key = interferencePairKey(pair.aComponentId, pair.bComponentId);
          const mesh = new THREE.Mesh(geometry, normalMaterial);
          mesh.name = key;
          mesh.renderOrder = 30;
          mesh.matrixAutoUpdate = false;
          meshes.set(key, mesh);
          group.add(mesh);
        }
      }
      select(selectedKey);
      group.visible = result !== null && result.pairs.length > 0;
    },
    setThemeColors(colors): void {
      normalMaterial.color.setHex(colors.interference);
      selectedMaterial.color.setHex(colors.interference);
    },
    setSectionPlanes(planes): void {
      const countChanged = sectionPlanes.length !== planes.length;
      sectionPlanes = [...planes];
      normalMaterial.clippingPlanes = sectionPlanes;
      selectedMaterial.clippingPlanes = sectionPlanes;
      if (countChanged) {
        normalMaterial.needsUpdate = true;
        selectedMaterial.needsUpdate = true;
      }
    },
    dispose(): void {
      clear();
      normalMaterial.dispose();
      selectedMaterial.dispose();
    },
  };
}
